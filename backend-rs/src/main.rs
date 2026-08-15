// EPUB 后端（Rust/axum 版）—— main.rs
//
// 启动入口：初始化配置/DB/服务，挂载 API 路由，监听 EPUB_PORT（默认 8001）。

mod api;
mod config;
mod cos;
mod db;
mod epub;
mod epub_writer;
mod error;
mod progress;
mod service;
mod storage;

use std::sync::Arc;

use axum::extract::DefaultBodyLimit;
use axum::http::{HeaderName, HeaderValue};
use axum::{routing::get, Json};
use tower_http::cors::CorsLayer;
use tower_http::trace::TraceLayer;

/// 共享状态：handler 通过 State 提取
#[derive(Clone)]
pub struct AppState {
    pub config: Arc<config::Config>,
    pub service: Arc<service::BookService>,
    pub tasks: progress::TaskRegistry,
    /// 腾讯云 COS 客户端。未配置 EPUB_COS_* 时为 None，资源走本地存储。
    pub cos: Option<Arc<cos::CosClient>>,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "epub_backend_rs=debug,tower_http=debug".into()),
        )
        .init();

    let cfg = config::Config::from_env();
    std::fs::create_dir_all(&cfg.storage_dir)?;

    tracing::info!("connecting to {}", cfg.database_url);
    let pool = db::init_pool(&cfg.database_url).await?;

    let port = cfg.port;
    // COS 客户端：未配置时为 None，service 层 fallback 到本地存储
    let cos_client = match &cfg.cos {
        Some(cos_cfg) => {
            tracing::info!(
                "COS enabled: bucket={} region={} prefix={}",
                cos_cfg.bucket,
                cos_cfg.region,
                cos_cfg.key_prefix
            );
            match cos::CosClient::new(
                cos_cfg.secret_id.clone(),
                cos_cfg.secret_key.clone(),
                cos_cfg.bucket.clone(),
                cos_cfg.region.clone(),
                cos_cfg.key_prefix.clone(),
            ) {
                Ok(c) => Some(Arc::new(c)),
                Err(e) => {
                    tracing::error!("COS client init failed: {e}; falling back to local storage");
                    None
                }
            }
        }
        None => {
            tracing::info!("COS not configured, image assets will use local storage");
            None
        }
    };

    let mut service = service::BookService::new(pool.clone(), cfg.storage_dir.clone());
    if let Some(c) = cos_client.clone() {
        service = service.with_cos(c);
    }
    let service = Arc::new(service);

    let state = AppState {
        config: Arc::new(cfg),
        service,
        tasks: progress::TaskRegistry::new(),
        cos: cos_client,
    };

    // CORS：allow_credentials(true) 时 origin/methods/headers 都不能用通配，用精确列表
    let origins: Vec<HeaderValue> = state
        .config
        .cors_origins
        .iter()
        .filter_map(|s| s.parse().ok())
        .collect();
    let cors = CorsLayer::new()
        .allow_origin(origins)
        .allow_credentials(true)
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

    let app = api::books::router()
        .route("/api/health", get(health))
        .route(
            "/api/progress/:task_id",
            get(api::progress::progress_stream),
        )
        .route(
            "/api/tasks/:task_id/download",
            get(api::progress::download_task),
        )
        .layer(cors)
        .layer(DefaultBodyLimit::max(200 * 1024 * 1024))
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    // Bind to loopback only: avoids WSAEACCES (os error 10013) that Windows triggers
    // when binding 0.0.0.0 to ports inside the dynamic port range (1024-15000).
    let addr = format!("127.0.0.1:{port}");
    tracing::info!("EPUB backend (Rust) listening on http://{addr}");
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}

/// GET /api/health → {"status":"ok"}
async fn health() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "status": "ok" }))
}
