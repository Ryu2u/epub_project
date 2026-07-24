// EPUB 后端（Rust/axum 版）—— main.rs
//
// 这是 Python/FastAPI 后端的 Rust 重写，与前端 React 完全兼容（byte-for-byte API）。
// 启动后监听 EPUB_PORT（默认 8001，区别于 Python 的 8000，便于并行验证）。

mod api;
mod config;
mod db;
mod epub;
mod epub_writer;
mod service;
mod storage;

use std::sync::Arc;

use axum::extract::{DefaultBodyLimit, Multipart, Path, State};
use axum::http::{HeaderName, HeaderValue, StatusCode};
use axum::{routing::get, Json, Router};
use tower_http::cors::CorsLayer;
use tower_http::trace::TraceLayer;

/// 共享状态：handler 通过 State 提取
#[derive(Clone)]
pub struct AppState {
    pub config: Arc<config::Config>,
    pub service: Arc<service::BookService>,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // 初始化日志（tracing）
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "epub_backend_rs=debug,tower_http=debug".into()),
        )
        .init();

    let cfg = config::Config::from_env();

    // 确保存储目录存在
    std::fs::create_dir_all(&cfg.storage_dir)?;

    // 初始化数据库（连接池 + 自动迁移）
    tracing::info!("connecting to {}", cfg.database_url);
    let pool = db::init_pool(&cfg.database_url).await?;

    let port = cfg.port;
    let service = Arc::new(service::BookService::new(pool.clone(), cfg.storage_dir.clone()));
    let state = AppState {
        config: Arc::new(cfg),
        service,
    };

    // CORS：允许前端源（开发期默认 localhost:5173）
    // allow_credentials(true) 时 origin 必须是精确值（不能用 Any），parse 成 HeaderValue
    let origins: Vec<HeaderValue> = state
        .config
        .cors_origins
        .iter()
        .filter_map(|s| s.parse().ok())
        .collect();
    let cors = CorsLayer::new()
        .allow_origin(origins)
        .allow_credentials(true)
        // credentials=true 时 methods/headers 都不能用 Any（CORS 规范），用精确列表
        .allow_methods([
            axum::http::Method::GET,
            axum::http::Method::POST,
            axum::http::Method::PATCH,
            axum::http::Method::DELETE,
            axum::http::Method::OPTIONS,
        ])
        .allow_headers(
            ["Content-Type", "Authorization", "Accept", "Origin", "X-Requested-With"]
                .into_iter()
                .map(|h| h.parse::<HeaderName>().unwrap())
                .collect::<Vec<_>>(),
        );

    let app = Router::new()
        .route("/api/health", get(health))
        // 正式读端点
        .route("/api/books", get(api::books::list_books).post(api::books::upload_book))
        // batch 必须在 /:id 之前注册（否则 "batch" 被当成 book_id）
        .route("/api/books/batch", axum::routing::post(api::books::upload_books_batch))
        .route("/api/books/:id", get(api::books::get_book).patch(api::books::update_book).delete(api::books::delete_book))
        // search 必须在 /chapters/:cid 之前注册
        .route("/api/books/:id/search", get(api::books::search_in_book))
        // reorder 必须在 /chapters/:cid 之前注册
        .route("/api/books/:id/chapters/reorder", axum::routing::patch(api::books::reorder_chapters))
        .route("/api/books/:id/chapters/:cid", get(api::books::get_chapter).patch(api::books::update_chapter))
        .route("/api/books/:id/assets/:aid", get(api::books::get_asset))
        // 导出 EPUB
        .route("/api/books/:id/export", get(api::books::export_book))
        // 封面管理
        .route("/api/books/:id/cover", axum::routing::post(api::books::upload_cover).delete(api::books::delete_cover))
        // 临时验证路由（Phase 5b 会替换为正式写端点）
        .route("/api/debug/books", get(debug_list_books))
        .route("/api/debug/parse/:book_id", get(debug_parse_book))
        .route("/api/debug/upload", axum::routing::post(debug_upload))
        .layer(cors)
        // 提升上传 body 限制到 200MB（默认 2MB 不够 EPUB）
        .layer(DefaultBodyLimit::max(200 * 1024 * 1024))
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let addr = format!("0.0.0.0:{port}");
    tracing::info!("EPUB backend (Rust) listening on http://{addr}");
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}

/// 健康检查端点：返回 {"status":"ok"}
async fn health() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "status": "ok" }))
}

/// 临时调试端点：读前 5 本书验证 DB 连接
async fn debug_list_books(State(state): State<AppState>) -> Result<Json<Vec<db::Book>>, String> {
    let books = sqlx::query_as::<_, db::Book>(
        "SELECT id, title, authors, language, publisher, description, pub_date, \
         identifier, file_path, file_size, file_sha256, created_at \
         FROM books ORDER BY created_at DESC LIMIT 5",
    )
    .fetch_all(&state.service.pool)
    .await
    .map_err(|e| format!("DB error: {e}"))?;

    Ok(Json(books))
}

/// 临时调试端点：解析指定 book_id 的 EPUB 文件，验证整个解析链路
async fn debug_parse_book(
    State(state): State<AppState>,
    Path(book_id): Path<String>,
) -> Result<Json<serde_json::Value>, String> {
    let book = sqlx::query_as::<_, db::Book>(
        "SELECT id, title, authors, language, publisher, description, pub_date, \
         identifier, file_path, file_size, file_sha256, created_at \
         FROM books WHERE id = ?",
    )
    .bind(&book_id)
    .fetch_optional(&state.service.pool)
    .await
    .map_err(|e| format!("DB error: {e}"))?
    .ok_or_else(|| format!("book {book_id} not found"))?;

    let path = state.service.storage_dir.join(&book.file_path);
    let bytes = std::fs::read(&path).map_err(|e| format!("read {}: {e}", path.display()))?;

    // EPUB 解析是 CPU 密集，放 spawn_blocking 不阻塞 tokio runtime
    let parsed = tokio::task::spawn_blocking(move || epub::parse_epub(bytes))
        .await
        .map_err(|e| format!("join error: {e}"))?
        .map_err(|e| format!("parse error: {e}"))?;

    Ok(Json(serde_json::json!({
        "db_title": book.title,
        "parsed_title": parsed.title,
        "authors": parsed.authors,
        "language": parsed.language,
        "identifier": parsed.identifier,
        "chapter_count": parsed.chapters.len(),
        "asset_count": parsed.assets.len(),
        "warnings": parsed.warnings,
        "sample_chapters": parsed.chapters.iter().take(5).map(|c| serde_json::json!({
            "id": c.id,
            "title": c.title,
            "word_count": c.word_count,
        })).collect::<Vec<_>>(),
    })))
}

/// 临时调试端点：上传 EPUB 验证完整入库链路（解析 → 去重 → 写文件 → DB insert）
async fn debug_upload(
    State(state): State<AppState>,
    mut multipart: Multipart,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| (StatusCode::BAD_REQUEST, format!("multipart: {e}")))?
    {
        if field.name() == Some("file") {
            let filename = field.file_name().unwrap_or("unknown.epub").to_string();
            let bytes = field
                .bytes()
                .await
                .map_err(|e| (StatusCode::BAD_REQUEST, format!("read body: {e}")))?;
            let svc = service::BookService::new(state.service.pool.clone(), state.service.storage_dir.clone());
            let book = svc
                .add_book(bytes.to_vec(), &filename)
                .await
                .map_err(|e| (StatusCode::BAD_REQUEST, format!("add_book: {e}")))?;
            return Ok(Json(serde_json::json!({
                "id": book.id,
                "title": book.title,
                "file_path": book.file_path,
                "file_sha256": book.file_sha256,
            })));
        }
    }
    Err((StatusCode::BAD_REQUEST, "no 'file' field".to_string()))
}
