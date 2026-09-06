// EPUB Library 桌面客户端(Tauri 2)。
//
// 架构:复用 epub-backend-rs 业务库(service / epub 解析 / 进度任务),
// axum HTTP 层被替换为:
//   - #[tauri::command] 命令(src/commands.rs,前端 invoke 调用)
//   - epubasset:// 自定义协议服务图片/字体资源(替代 GET /api/books/:id/assets/:aid)
//   - get_progress 轮询替代 SSE 进度流(节奏同为 200ms)
//
// 数据位置:默认 AppData/EPUB Library/(storage/ + library.db),
// 可用 EPUB_STORAGE_DIR / EPUB_DATABASE_URL 环境变量覆盖(与 Web 版共用数据)。

pub mod commands;

use std::path::PathBuf;
use std::sync::Arc;

use epub_backend_rs::config::{Config, CosConfig};
use epub_backend_rs::cos::CosClient;
use epub_backend_rs::{db, progress, service, AppState};

/// 构建 AppData 目录(标识符 com.ryu2u.epublibrary → AppData/EPUB Library)
fn app_data_dir(app: &tauri::AppHandle) -> PathBuf {
    use tauri::Manager;
    app.path()
        .app_data_dir()
        .expect("app data dir should be resolvable")
}

/// 组装配置:桌面默认落 AppData;EPUB_* 环境变量可覆盖;
/// COS 沿用与 Web 版相同的环境变量约定。
fn build_config(app: &tauri::AppHandle) -> Config {
    let data_dir = app_data_dir(app);

    let storage_dir = std::env::var("EPUB_STORAGE_DIR")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| data_dir.join("storage"));

    let database_url = std::env::var("EPUB_DATABASE_URL")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| format!("sqlite:{}", data_dir.join("library.db").display()));

    let cos = match (
        std::env::var("EPUB_COS_SECRET_ID").ok().filter(|s| !s.trim().is_empty()),
        std::env::var("EPUB_COS_SECRET_KEY").ok().filter(|s| !s.trim().is_empty()),
        std::env::var("EPUB_COS_BUCKET").ok().filter(|s| !s.trim().is_empty()),
        std::env::var("EPUB_COS_REGION").ok().filter(|s| !s.trim().is_empty()),
    ) {
        (Some(secret_id), Some(secret_key), Some(bucket), Some(region)) => Some(CosConfig {
            secret_id,
            secret_key,
            bucket,
            region,
            key_prefix: std::env::var("EPUB_COS_KEY_PREFIX")
                .unwrap_or_else(|_| "books/{book_id}/assets/{asset_id}".to_string()),
        }),
        _ => None,
    };

    Config {
        storage_dir,
        database_url,
        max_upload_bytes: 200 * 1024 * 1024,
        bind: "127.0.0.1".to_string(),
        port: 0,
        cors_origins: Vec::new(),
        cos,
    }
}

/// 初始化共享状态(连接池 + 迁移 + BookService + 任务表)。
/// setup 是同步回调,内部用 block_on 驱动一次性的异步初始化。
fn build_state(cfg: Config) -> Result<AppState, String> {
    std::fs::create_dir_all(&cfg.storage_dir).map_err(|e| e.to_string())?;

    tracing::info!("connecting to {}", cfg.database_url);
    let pool =
        tauri::async_runtime::block_on(db::init_pool(&cfg.database_url))
            .map_err(|e| e.to_string())?;

    let cos_client = match &cfg.cos {
        Some(cos_cfg) => match CosClient::new(
            cos_cfg.secret_id.clone(),
            cos_cfg.secret_key.clone(),
            cos_cfg.bucket.clone(),
            cos_cfg.region.clone(),
            cos_cfg.key_prefix.clone(),
        ) {
            Ok(c) => {
                tracing::info!(
                    "COS enabled: bucket={} region={}",
                    cos_cfg.bucket,
                    cos_cfg.region
                );
                Some(Arc::new(c))
            }
            Err(e) => {
                tracing::error!("COS client init failed: {e}; falling back to local storage");
                None
            }
        },
        None => None,
    };

    let mut svc = service::BookService::new(pool, cfg.storage_dir.clone());
    if let Some(c) = cos_client.clone() {
        svc = svc.with_cos(c);
    }

    Ok(AppState {
        config: Arc::new(cfg),
        service: Arc::new(svc),
        tasks: progress::TaskRegistry::new(),
        cos: cos_client,
    })
}

/// 解析 epubasset 请求路径:/books/{book_id}/assets/{asset_id}
fn parse_asset_path(path: &str) -> Option<(String, String)> {
    let segs: Vec<&str> = path.trim_matches('/').split('/').collect();
    if segs.len() == 4 && segs[0] == "books" && segs[2] == "assets" {
        Some((segs[1].to_string(), segs[3].to_string()))
    } else {
        None
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "epub_library_app=debug".into()),
        )
        .init();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            use tauri::Manager;
            let cfg = build_config(app.handle());
            let state = build_state(cfg)?;
            app.manage(state);
            Ok(())
        })
        // 资源服务:替代 GET /api/books/:id/assets/:aid。
        // COS 启用时 read_asset_bytes 自带 COS 读取 + 本地回退。
        .register_uri_scheme_protocol("epubasset", |ctx, request| {
            use tauri::http::StatusCode;
            use tauri::Manager;
            type AssetResponse = tauri::http::Response<std::borrow::Cow<'static, [u8]>>;

            let not_found = |msg: String| -> AssetResponse {
                tauri::http::Response::builder()
                    .status(StatusCode::NOT_FOUND)
                    .body(msg.into_bytes().into())
                    .expect("404 response should build")
            };

            let Some((book_id, asset_id)) = parse_asset_path(request.uri().path()) else {
                return not_found("invalid asset path".to_string());
            };

            let state = ctx.app_handle().state::<AppState>();
            let result = tauri::async_runtime::block_on(async {
                let assets = state
                    .service
                    .get_assets(&book_id)
                    .await
                    .map_err(|e| e.to_string())?;
                let Some(asset) = assets.into_iter().find(|a| a.id == asset_id) else {
                    return Err("asset not found".to_string());
                };
                let media_type = asset.media_type.clone();
                let book = state
                    .service
                    .get_book_orm(&book_id)
                    .await
                    .map_err(|e| e.to_string())?
                    .ok_or_else(|| "book not found".to_string())?;
                let bytes = state
                    .service
                    .read_asset_bytes(&asset, &book)
                    .map_err(|e| e.to_string())?;
                Ok::<_, String>((bytes, media_type))
            });

            match result {
                Ok((bytes, media_type)) => tauri::http::Response::builder()
                    .header("Content-Type", media_type)
                    .header("Cache-Control", "public, max-age=86400")
                    .body(bytes.into())
                    .expect("asset response should build"),
                Err(msg) => not_found(format!("asset read failed: {msg}")),
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_books,
            commands::get_book,
            commands::get_chapter,
            commands::search_in_book,
            commands::upload_book,
            commands::upload_books_batch,
            commands::upload_book_async,
            commands::delete_book,
            commands::delete_book_async,
            commands::update_book,
            commands::update_chapter,
            commands::reorder_chapters,
            commands::upload_cover,
            commands::delete_cover,
            commands::export_book_async,
            commands::get_export_filename,
            commands::take_export_bytes,
            commands::get_progress,
            commands::export_library_async,
            commands::import_library_async,
            commands::get_migration_result,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
