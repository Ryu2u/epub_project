// Books API 读端点：list / get_detail / get_chapter / get_asset。
// 对应 Python api/books.py 的 GET 路由。
//
// 写端点（upload/edit/delete/search）在 Phase 5b 补。

use std::collections::HashMap;

use axum::body::Body;
use axum::extract::{Multipart, Path, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;

use crate::api::schema::{
    AssetOut, BatchUploadResult, BatchUploadResultItem, BookDetail, BookListResponse, BookSummary,
    BookUpdate, ChapterContent, ChapterOut, ChapterReorder, ChapterUpdate, SearchResponse,
    UploadResult,
};
use crate::error::AppError;
use crate::epub::EpubError;
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
    let (ch_counts, as_counts, cover_ids) = batch_counts(&state, &ids).await?;

    let items = books
        .iter()
        .map(|b| BookSummary {
            chapter_count: *ch_counts.get(&b.id).unwrap_or(&0),
            asset_count: *as_counts.get(&b.id).unwrap_or(&0),
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
        let rewritten = crate::epub::html_rewrite::rewrite_img_refs(
            &ch.html,
            &ch.href,
            &asset_map,
            |aid| format!("/api/books/{book_id}/assets/{aid}"),
        );
        rewritten
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
    // 资源的 media_type 可能是 "image/jpeg" 等
    if let Ok(ct) = asset.media_type.parse() {
        headers.insert(header::CONTENT_TYPE, ct);
    }
    headers.insert(header::CACHE_CONTROL, "public, max-age=86400".parse().unwrap());

    Ok((StatusCode::OK, headers, Body::from(bytes)).into_response())
}

// ---------- 写端点 ----------

/// 允许上传的扩展名
const ALLOWED_EXT: [&str; 2] = [".epub", ".epb"];

/// 允许的封面 MIME
const ALLOWED_COVER_TYPES: [&str; 4] = ["image/jpeg", "image/png", "image/webp", "image/gif"];

/// 取扩展名（小写），filename 为 None 返回 ""
fn suffix_of(filename: Option<&str>) -> String {
    let name = filename.unwrap_or("");
    let lower = name.to_lowercase();
    match lower.rsplit_once('.') {
        Some((_, ext)) => format!(".{ext}"),
        None => String::new(),
    }
}

/// 把 ORM Book（含 chapters/assets）转 BookDetail
fn book_to_detail(book: &crate::db::Book, chapters: &[crate::db::Chapter], assets: &[crate::db::Asset]) -> BookDetail {
    let mut ch_out: Vec<ChapterOut> = chapters
        .iter()
        .map(|c| ChapterOut {
            id: c.id.clone(),
            title: c.title.clone(),
            spine_order: c.spine_order,
            word_count: c.word_count,
        })
        .collect();
    ch_out.sort_by_key(|c| c.spine_order);

    BookDetail {
        id: book.id.clone(),
        title: book.title.clone(),
        authors: book.authors.clone(),
        language: book.language.clone(),
        publisher: book.publisher.clone(),
        description: book.description.clone(),
        pub_date: book.pub_date,
        identifier: book.identifier.clone(),
        file_size: book.file_size,
        created_at: book.created_at,
        chapters: ch_out,
        assets: assets
            .iter()
            .map(|a| AssetOut {
                is_cover: a.is_cover_bool(),
                id: a.id.clone(),
                href: a.href.clone(),
                media_type: a.media_type.clone(),
                size: a.size,
            })
            .collect(),
    }
}

/// 读取并返回某 book 的完整 detail（含 chapters/assets）。
/// 书不存在返回 None。
async fn fetch_book_detail(
    state: &AppState,
    book_id: &str,
) -> Result<Option<BookDetail>, AppError> {
    let book = state
        .service
        .get_book_orm(book_id)
        .await
        .map_err(AppError::from)?;
    let Some(book) = book else {
        return Ok(None);
    };
    let chapters = state
        .service
        .get_chapters(book_id)
        .await
        .map_err(AppError::from)?;
    let assets = state
        .service
        .get_assets(book_id)
        .await
        .map_err(AppError::from)?;
    Ok(Some(book_to_detail(&book, &chapters, &assets)))
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

#[derive(Deserialize)]
pub struct SearchParams {
    pub q: Option<String>,
    pub page: Option<i64>,
    pub size: Option<i64>,
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

// ---------- 辅助 ----------

/// 批量查询多本书的章节数 / 资源数 / 封面 id
async fn batch_counts(
    state: &AppState,
    ids: &[String],
) -> Result<
    (
        HashMap<String, i64>,
        HashMap<String, i64>,
        HashMap<String, String>,
    ),
    AppError,
> {
    if ids.is_empty() {
        return Ok((HashMap::new(), HashMap::new(), HashMap::new()));
    }
    let placeholders = ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");

    // chapter counts
    let sql = format!(
        "SELECT book_id, COUNT(*) FROM chapters WHERE book_id IN ({placeholders}) GROUP BY book_id"
    );
    let mut q = sqlx::query_as::<_, (String, i64)>(&sql);
    for id in ids {
        q = q.bind(id);
    }
    let rows = q
        .fetch_all(&state.service.pool)
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?;
    let ch: HashMap<String, i64> = rows.into_iter().collect();

    // asset counts
    let sql = format!(
        "SELECT book_id, COUNT(*) FROM assets WHERE book_id IN ({placeholders}) GROUP BY book_id"
    );
    let mut q = sqlx::query_as::<_, (String, i64)>(&sql);
    for id in ids {
        q = q.bind(id);
    }
    let rows = q
        .fetch_all(&state.service.pool)
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?;
    let as_: HashMap<String, i64> = rows.into_iter().collect();

    // cover ids
    let sql = format!(
        "SELECT book_id, id FROM assets WHERE is_cover = 1 AND book_id IN ({placeholders})"
    );
    let mut q = sqlx::query_as::<_, (String, String)>(&sql);
    for id in ids {
        q = q.bind(id);
    }
    let rows = q
        .fetch_all(&state.service.pool)
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?;
    let cov: HashMap<String, String> = rows.into_iter().collect();

    Ok((ch, as_, cov))
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
