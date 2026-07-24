// Books API 写端点：upload / batch / delete / update / reorder / chapter update /
// cover upload+delete / search_in_book / export_book。

use axum::body::Body;
use axum::extract::{Multipart, Path, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;

use super::{fetch_book_detail, ALLOWED_COVER_TYPES, ALLOWED_EXT};
use crate::api::schema::{
    BatchUploadResult, BatchUploadResultItem, BookDetail, BookUpdate, ChapterContent,
    ChapterReorder, ChapterUpdate, SearchResponse, UploadResult,
};
use crate::error::AppError;
use crate::epub::EpubError;
use crate::AppState;

/// 取扩展名（小写），filename 为 None 返回 ""
fn suffix_of(filename: Option<&str>) -> String {
    let name = filename.unwrap_or("");
    let lower = name.to_lowercase();
    match lower.rsplit_once('.') {
        Some((_, ext)) => format!(".{ext}"),
        None => String::new(),
    }
}

/// POST /api/books — 单文件上传（multipart field `file`）。
pub async fn upload_book(
    State(state): State<AppState>,
    mut multipart: Multipart,
) -> Result<Json<UploadResult>, AppError> {
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| AppError::BadRequest(format!("multipart: {e}")))?
    {
        if field.name() == Some("file") {
            let filename = field.file_name().unwrap_or("unknown.epub").to_string();

            // 扩展名校验
            let suffix = suffix_of(Some(&filename));
            if !ALLOWED_EXT.contains(&suffix.as_str()) {
                return Err(AppError::UnsupportedMedia(format!(
                    "仅支持扩展名 {ALLOWED_EXT:?}，收到 {suffix:?}"
                )));
            }

            let bytes = field
                .bytes()
                .await
                .map_err(|e| AppError::BadRequest(format!("read body: {e}")))?;

            let book = state
                .service
                .add_book(bytes.to_vec(), &filename)
                .await
                .map_err(AppError::from)?;

            let detail = fetch_book_detail(&state, &book.id)
                .await?
                .ok_or(AppError::Internal("刚写入的书读不回来".into()))?;

            return Ok(Json(UploadResult {
                book: detail,
                warnings: Vec::new(),
            }));
        }
    }
    Err(AppError::BadRequest("no 'file' field".into()))
}

/// POST /api/books/batch — 多文件上传（multipart field `files`，多个）。
/// 即使部分失败也返回 200。
pub async fn upload_books_batch(
    State(state): State<AppState>,
    mut multipart: Multipart,
) -> Result<Json<BatchUploadResult>, AppError> {
    let mut items: Vec<BatchUploadResultItem> = Vec::new();

    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| AppError::BadRequest(format!("multipart: {e}")))?
    {
        // 接受名为 "files" 或 "file" 的字段（前端批量通常用 files）
        let name_ok = matches!(field.name(), Some("files") | Some("file"));
        if !name_ok {
            // 跳过未知字段
            continue;
        }

        let filename = field.file_name().unwrap_or("unknown.epub").to_string();
        let suffix = suffix_of(Some(&filename));

        if !ALLOWED_EXT.contains(&suffix.as_str()) {
            items.push(BatchUploadResultItem {
                filename,
                status: "error".to_string(),
                book_id: None,
                title: None,
                error_code: Some("UNSUPPORTED_MEDIA".to_string()),
                error_message: Some(format!("仅支持 {ALLOWED_EXT:?}")),
            });
            continue;
        }

        let bytes = match field.bytes().await {
            Ok(b) => b,
            Err(e) => {
                items.push(BatchUploadResultItem {
                    filename,
                    status: "error".to_string(),
                    book_id: None,
                    title: None,
                    error_code: Some("INTERNAL".to_string()),
                    error_message: Some(format!("read body: {e}")),
                });
                continue;
            }
        };

        match state.service.add_book(bytes.to_vec(), &filename).await {
            Ok(book) => items.push(BatchUploadResultItem {
                filename,
                status: "success".to_string(),
                book_id: Some(book.id.clone()),
                title: Some(book.title.clone()),
                error_code: None,
                error_message: None,
            }),
            Err(EpubError::DuplicateFile { existing_book_id }) => {
                items.push(BatchUploadResultItem {
                    filename,
                    status: "duplicate".to_string(),
                    book_id: Some(existing_book_id),
                    title: None,
                    error_code: None,
                    error_message: None,
                });
            }
            Err(e) => items.push(BatchUploadResultItem {
                filename,
                status: "error".to_string(),
                book_id: None,
                title: None,
                error_code: Some(e.code().to_string()),
                error_message: Some(e.to_string()),
            }),
        }
    }

    let succeeded = items.iter().filter(|i| i.status == "success").count() as i64;
    let skipped = items.iter().filter(|i| i.status == "duplicate").count() as i64;
    let failed = items.iter().filter(|i| i.status == "error").count() as i64;
    let total = items.len() as i64;

    Ok(Json(BatchUploadResult {
        items,
        total,
        succeeded,
        skipped,
        failed,
    }))
}

/// DELETE /api/books/:id — 删除书。成功 204，书不存在 404。
pub async fn delete_book(
    State(state): State<AppState>,
    Path(book_id): Path<String>,
) -> Result<StatusCode, AppError> {
    let ok = state
        .service
        .delete_book(&book_id)
        .await
        .map_err(AppError::from)?;
    if ok {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(AppError::NotFound("book not found".into()))
    }
}

#[derive(Deserialize)]
pub struct SearchParams {
    pub q: Option<String>,
    pub page: Option<i64>,
    pub size: Option<i64>,
}

/// GET /api/books/:id/search?q=&page=&size=
pub async fn search_in_book(
    State(state): State<AppState>,
    Path(book_id): Path<String>,
    Query(params): Query<SearchParams>,
) -> Result<Json<SearchResponse>, AppError> {
    let q = params.q.unwrap_or_default();
    let page = params.page.unwrap_or(1).max(1);
    let size = params.size.unwrap_or(20).clamp(1, 100);

    // q < 2 字符返回空（与 Python 一致）
    if q.trim().chars().count() < 2 {
        return Ok(Json(SearchResponse {
            items: Vec::new(),
            total: 0,
            query: q,
        }));
    }

    // 书必须存在
    let book = state
        .service
        .get_book_orm(&book_id)
        .await
        .map_err(AppError::from)?;
    if book.is_none() {
        return Err(AppError::NotFound("book not found".into()));
    }

    let (items, total) = state
        .service
        .search_in_book(&book_id, &q, page, size)
        .await
        .map_err(AppError::from)?;

    Ok(Json(SearchResponse {
        items,
        total,
        query: q,
    }))
}

/// PATCH /api/books/:id — 部分更新元数据。空 body 返回 400。
pub async fn update_book(
    State(state): State<AppState>,
    Path(book_id): Path<String>,
    body: axum::body::Bytes,
) -> Result<Json<BookDetail>, AppError> {
    // 空 body 或无字段返回 400
    if body.is_empty() {
        return Err(AppError::BadRequest(
            "EMPTY_UPDATE: 至少需要传入一个要修改的字段".into(),
        ));
    }

    let data: BookUpdate = serde_json::from_slice(&body)
        .map_err(|e| AppError::BadRequest(format!("请求体解析失败：{e}")))?;

    // 全部字段为 None（无实际更新）也返回 400
    let has_update = data.title.is_some()
        || data.authors.is_some()
        || data.language.is_some()
        || data.publisher.is_some()
        || data.description.is_some()
        || data.pub_date.is_some()
        || data.identifier.is_some();
    if !has_update {
        return Err(AppError::BadRequest(
            "EMPTY_UPDATE: 至少需要传入一个要修改的字段".into(),
        ));
    }

    let book = state
        .service
        .update_book(&book_id, &data)
        .await
        .map_err(AppError::from)?
        .ok_or(AppError::NotFound("book not found".into()))?;

    let detail = fetch_book_detail(&state, &book.id)
        .await?
        .ok_or(AppError::Internal("更新后的书读不回来".into()))?;

    Ok(Json(detail))
}

/// PATCH /api/books/:id/chapters/reorder — 批量重排章节顺序。
pub async fn reorder_chapters(
    State(state): State<AppState>,
    Path(book_id): Path<String>,
    body: axum::body::Bytes,
) -> Result<StatusCode, AppError> {
    let data: ChapterReorder = serde_json::from_slice(&body)
        .map_err(|e| AppError::BadRequest(format!("请求体解析失败：{e}")))?;

    // 书必须存在
    let book = state
        .service
        .get_book_orm(&book_id)
        .await
        .map_err(AppError::from)?;
    if book.is_none() {
        return Err(AppError::NotFound("book not found".into()));
    }

    state
        .service
        .reorder_chapters(&book_id, &data.chapter_ids)
        .await
        .map_err(AppError::from)?;

    Ok(StatusCode::NO_CONTENT)
}

/// PATCH /api/books/:id/chapters/:cid — 更新章节标题/html。
/// html 变了后端自动重算 text + word_count。返回 ChapterContent（html）。
pub async fn update_chapter(
    State(state): State<AppState>,
    Path((book_id, chapter_id)): Path<(String, String)>,
    body: axum::body::Bytes,
) -> Result<Json<ChapterContent>, AppError> {
    if body.is_empty() {
        return Err(AppError::BadRequest(
            "EMPTY_UPDATE: 至少需要传入 title 或 html".into(),
        ));
    }

    let data: ChapterUpdate = serde_json::from_slice(&body)
        .map_err(|e| AppError::BadRequest(format!("请求体解析失败：{e}")))?;

    if data.title.is_none() && data.html.is_none() {
        return Err(AppError::BadRequest(
            "EMPTY_UPDATE: 至少需要传入 title 或 html".into(),
        ));
    }

    let ch = state
        .service
        .update_chapter(&book_id, &chapter_id, &data)
        .await
        .map_err(AppError::from)?
        .ok_or(AppError::NotFound("chapter not found".into()))?;

    Ok(Json(ChapterContent {
        title: ch.title,
        content: ch.html,
        format: "html".to_string(),
    }))
}

/// POST /api/books/:id/cover — 上传封面（multipart `file`，图片 MIME 白名单）。
pub async fn upload_cover(
    State(state): State<AppState>,
    Path(book_id): Path<String>,
    mut multipart: Multipart,
) -> Result<Json<BookDetail>, AppError> {
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| AppError::BadRequest(format!("multipart: {e}")))?
    {
        if field.name() == Some("file") {
            let media_type = field
                .content_type()
                .unwrap_or("")
                .to_lowercase();

            if !ALLOWED_COVER_TYPES.contains(&media_type.as_str()) {
                return Err(AppError::UnsupportedMedia(format!(
                    "封面仅支持图片 {ALLOWED_COVER_TYPES:?}，收到 {media_type:?}"
                )));
            }

            let bytes = field
                .bytes()
                .await
                .map_err(|e| AppError::BadRequest(format!("read body: {e}")))?;

            let asset = state
                .service
                .set_cover(&book_id, &bytes, &media_type)
                .await
                .map_err(AppError::from)?
                .ok_or(AppError::NotFound("book not found".into()))?;

            let _ = asset; // 已入库，detail 会重新查
            let detail = fetch_book_detail(&state, &book_id)
                .await?
                .ok_or(AppError::Internal("更新后的书读不回来".into()))?;

            return Ok(Json(detail));
        }
    }
    Err(AppError::BadRequest("no 'file' field".into()))
}

/// DELETE /api/books/:id/cover — 删除上传封面。
/// EPUB 自带封面只取消标记。无书或无上传封面返回 404。
pub async fn delete_cover(
    State(state): State<AppState>,
    Path(book_id): Path<String>,
) -> Result<StatusCode, AppError> {
    let ok = state
        .service
        .delete_cover(&book_id)
        .await
        .map_err(AppError::from)?;
    if ok {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(AppError::NotFound(
            "book not found or no uploaded cover".into(),
        ))
    }
}

/// GET /api/books/:id/export —— 导出 EPUB（重建为标准 EPUB 3）
pub async fn export_book(
    State(state): State<AppState>,
    Path(book_id): Path<String>,
) -> Result<Response, AppError> {
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

    // 重建 EPUB（CPU 密集，放 spawn_blocking）
    // 先取出 title 用于 Content-Disposition（book 会被 move 进闭包）
    let title = book.title.clone();
    let svc_clone = state.service.clone();
    let epub_bytes = tokio::task::spawn_blocking(move || {
        svc_clone.export_epub(&book, chapters, &assets)
    })
    .await
    .map_err(|e| AppError::Internal(format!("join: {e}")))?
    .map_err(AppError::from)?;

    // Content-Disposition：ASCII fallback + UTF-8 filename*
    let safe = title
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect::<String>();
    let safe = if safe.is_empty() { "book".to_string() } else { safe };
    // filename* 编码原始（含中文）标题字节
    let quoted = percent_encoding(title.as_bytes());
    let disposition = format!(
        "attachment; filename=\"{safe}.epub\"; filename*=UTF-8''{quoted}.epub"
    );

    let mut headers = HeaderMap::new();
    headers.insert(header::CONTENT_TYPE, "application/epub+zip".parse().unwrap());
    headers.insert(
        header::CONTENT_DISPOSITION,
        disposition.parse().unwrap(),
    );

    Ok((StatusCode::OK, headers, Body::from(epub_bytes)).into_response())
}

/// 简单 percent-encoding（RFC 5987 用于 Content-Disposition filename*）
fn percent_encoding(input: &[u8]) -> String {
    let mut out = String::new();
    for &b in input {
        if b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.' || b == b'~' {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}
