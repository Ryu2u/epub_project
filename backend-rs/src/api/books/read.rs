// Books API 读端点：list_books / get_book / get_chapter / get_asset。
// 对应 Python api/books.py 的 GET 路由。

use std::collections::HashMap;

use axum::body::Body;
use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;

use super::{batch_counts};
use crate::api::schema::{
    AssetOut, BookDetail, BookListResponse, BookSummary, ChapterContent, ChapterOut,
};
use crate::error::AppError;
use crate::AppState;

#[derive(Deserialize)]
pub struct ListParams {
    pub q: Option<String>,
    pub page: Option<i64>,
    pub size: Option<i64>,
}

/// GET /api/books?q=&page=&size=
pub async fn list_books(
    State(state): State<AppState>,
    Query(params): Query<ListParams>,
) -> Result<Json<BookListResponse>, AppError> {
    let q = params.q.unwrap_or_default();
    let page = params.page.unwrap_or(1).max(1);
    let size = params.size.unwrap_or(20).clamp(1, 100);

    let (books, total) = state
        .service
        .list_books(&q, page, size)
        .await
        .map_err(AppError::from)?;

    // 批量查 counts（避免 N+1）
    let ids: Vec<String> = books.iter().map(|b| b.id.clone()).collect();
    let (ch_counts, as_counts, cover_ids, word_counts) = batch_counts(&state, &ids).await?;

    let items = books
        .iter()
        .map(|b| BookSummary {
            chapter_count: *ch_counts.get(&b.id).unwrap_or(&0),
            asset_count: *as_counts.get(&b.id).unwrap_or(&0),
            word_count: *word_counts.get(&b.id).unwrap_or(&0),
            cover_id: cover_ids.get(&b.id).cloned(),
            has_cover: cover_ids.contains_key(&b.id),
            id: b.id.clone(),
            title: b.title.clone(),
            authors: b.authors.clone(),
            language: b.language.clone(),
            file_size: b.file_size,
            created_at: b.created_at,
        })
        .collect();

    Ok(Json(BookListResponse {
        items,
        total,
        page,
        size,
    }))
}

/// GET /api/books/:id
pub async fn get_book(
    State(state): State<AppState>,
    Path(book_id): Path<String>,
) -> Result<Json<BookDetail>, AppError> {
    let book = state
        .service
        .get_book_orm(&book_id)
        .await
        .map_err(AppError::from)?
        .ok_or(AppError::NotFound("book not found".into()))?;

    let chapters = state
        .service
        .get_chapters(&book_id)
        .await
        .map_err(AppError::from)?;
    let assets = state
        .service
        .get_assets(&book_id)
        .await
        .map_err(AppError::from)?;

    Ok(Json(BookDetail {
        id: book.id,
        title: book.title,
        authors: book.authors,
        language: book.language,
        publisher: book.publisher,
        description: book.description,
        pub_date: book.pub_date,
        identifier: book.identifier,
        file_size: book.file_size,
        created_at: book.created_at,
        chapters: chapters
            .into_iter()
            .map(|c| ChapterOut {
                id: c.id,
                title: c.title,
                spine_order: c.spine_order,
                word_count: c.word_count,
            })
            .collect(),
        assets: assets
            .into_iter()
            .map(|a| {
                let is_cover = a.is_cover_bool();
                AssetOut {
                    is_cover,
                    id: a.id,
                    href: a.href,
                    media_type: a.media_type,
                    size: a.size,
                }
            })
            .collect(),
    }))
}

#[derive(Deserialize)]
pub struct ChapterParams {
    pub format: Option<String>,
}

/// GET /api/books/:id/chapters/:cid?format=text|html
pub async fn get_chapter(
    State(state): State<AppState>,
    Path((book_id, chapter_id)): Path<(String, String)>,
    Query(params): Query<ChapterParams>,
) -> Result<Json<ChapterContent>, AppError> {
    let format = params.format.unwrap_or_else(|| "text".to_string());

    let ch = state
        .service
        .get_chapter(&book_id, &chapter_id)
        .await
        .map_err(AppError::from)?
        .ok_or(AppError::NotFound("chapter not found".into()))?;

    let content = if format == "html" {
        // html 真值在 storage 文件里，从 service 层单独读
        let html = state.service.read_chapter_html(&book_id, &chapter_id);
        // 重写 img src 为 /api/books/{id}/assets/{aid}
        let assets = state
            .service
            .get_assets(&book_id)
            .await
            .map_err(AppError::from)?;
        let asset_map: HashMap<String, String> = assets
            .iter()
            .map(|a| (a.href.clone(), a.id.clone()))
            .collect();
        let to_url = |aid: &str| format!("/api/books/{book_id}/assets/{aid}");
        // 先重写图片（已有逻辑），再重写 CSS url()（@font-face src 等）
        let rewritten = crate::epub::html_rewrite::rewrite_img_refs(
            &html,
            &ch.href,
            &asset_map,
            to_url,
        );
        crate::epub::html_rewrite::rewrite_url_refs(
            &rewritten,
            &ch.href,
            &asset_map,
            to_url,
        )
    } else {
        ch.text
    };

    Ok(Json(ChapterContent {
        title: ch.title,
        content,
        format,
    }))
}

/// GET /api/books/:id/assets/:aid（二进制资源）
///
/// COS 启用时：返回 302 重定向到 5 分钟有效的预签名 URL（浏览器直接读 COS，不走后端流量）。
/// COS 未启用时：保持旧行为，直接返回本地存储的字节。
pub async fn get_asset(
    State(state): State<AppState>,
    Path((book_id, asset_id)): Path<(String, String)>,
) -> Result<Response, AppError> {
    let assets = state
        .service
        .get_assets(&book_id)
        .await
        .map_err(AppError::from)?;
    let asset = assets
        .iter()
        .find(|a| a.id == asset_id)
        .ok_or(AppError::NotFound("asset not found".into()))?;

    // COS 路径：302 跳到预签名 URL（img.src 自动跟随）
    if state.cos.is_some() {
        let url = state.service.asset_storage_url(&book_id, &asset.id);
        let mut headers = HeaderMap::new();
        headers.insert(header::LOCATION, url.parse().unwrap());
        headers.insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
        return Ok((StatusCode::FOUND, headers).into_response());
    }

    // 本地路径
    let book = state
        .service
        .get_book_orm(&book_id)
        .await
        .map_err(AppError::from)?
        .ok_or(AppError::NotFound("book not found".into()))?;

    let bytes = state
        .service
        .read_asset_bytes(asset, &book)
        .map_err(AppError::from)?;

    let mut headers = HeaderMap::new();
    if let Ok(ct) = asset.media_type.parse() {
        headers.insert(header::CONTENT_TYPE, ct);
    }
    headers.insert(header::CACHE_CONTROL, "public, max-age=86400".parse().unwrap());

    Ok((StatusCode::OK, headers, Body::from(bytes)).into_response())
}
