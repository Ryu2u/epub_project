// EPUB 后端（Rust/axum 版）—— main.rs
//
// 启动入口：初始化配置/DB/服务，挂载 API 路由，监听 EPUB_PORT（默认 8001）。

mod api;
mod config;
mod db;
mod epub;
mod epub_writer;
mod error;
mod service;
mod storage;

use std::sync::Arc;

use axum::extract::DefaultBodyLimit;
use axum::http::{HeaderName, HeaderValue};
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
    let service = Arc::new(service::BookService::new(pool.clone(), cfg.storage_dir.clone()));
    let state = AppState {
        config: Arc::new(cfg),
        service,
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

    let app = Router::new()
        .route("/api/health", get(health))
        // 正式 API（路由顺序：字面量段必须在通配 :id/:cid 之前）
        .route(
            "/api/books",
            get(api::books::list_books).post(api::books::upload_book),
        )
        .route("/api/books/batch", axum::routing::post(api::books::upload_books_batch))
        .route(
            "/api/books/:id",
            get(api::books::get_book)
                .patch(api::books::update_book)
                .delete(api::books::delete_book),
        )
        .route("/api/books/:id/search", get(api::books::search_in_book))
        .route(
            "/api/books/:id/chapters/reorder",
            axum::routing::patch(api::books::reorder_chapters),
        )
        .route(
            "/api/books/:id/chapters/:cid",
            get(api::books::get_chapter).patch(api::books::update_chapter),
        )
        .route("/api/books/:id/assets/:aid", get(api::books::get_asset))
        .route("/api/books/:id/export", get(api::books::export_book))
        .route(
            "/api/books/:id/cover",
            axum::routing::post(api::books::upload_cover).delete(api::books::delete_cover),
        )
        .layer(cors)
        .layer(DefaultBodyLimit::max(200 * 1024 * 1024))
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let addr = format!("0.0.0.0:{port}");
    tracing::info!("EPUB backend (Rust) listening on http://{addr}");
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}

/// GET /api/health → {"status":"ok"}
async fn health() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "status": "ok" }))
}
