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
use crate::epub::{EpubError, SourceFormat};
use crate::error::AppError;
use crate::progress::{
    create_delete_task, create_export_task, create_import_task, Progress,
};
use crate::AppState;

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

            // 扩展名 → SourceFormat 校验（None 表示不支持的扩展名）
            let format = SourceFormat::from_filename(&filename).ok_or_else(|| {
                AppError::UnsupportedMedia(format!(
                    "仅支持扩展名 {ALLOWED_EXT:?}，收到 {:?}",
                    filename
                ))
            })?;

            let bytes = field
                .bytes()
                .await
                .map_err(|e| AppError::BadRequest(format!("read body: {e}")))?;

            let book = state
                .service
                .add_book(bytes.to_vec(), &filename, format, |_, _, _| {})
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

        // 扩展名 → SourceFormat 校验
        let format = match SourceFormat::from_filename(&filename) {
            Some(f) => f,
            None => {
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
        };

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

        match state
            .service
            .add_book(bytes.to_vec(), &filename, format, |_, _, _| {})
            .await
        {
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

/// DELETE /api/books/:id — 删除书（同步，无进度反馈）。成功 204，书不存在 404。
/// 前端大书删除请走 POST /api/books/:id/delete/async（SSE 进度）。
pub async fn delete_book(
    State(state): State<AppState>,
    Path(book_id): Path<String>,
) -> Result<StatusCode, AppError> {
    let ok = state
        .service
        .delete_book(&book_id, |_, _, _| {})
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
    /// 搜索关键词（至少 2 个字符）
    pub q: Option<String>,
    /// 页码（从 1 开始，默认 1）
    pub page: Option<i64>,
    /// 每页数量（默认 20，上限 100）
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

    // html 真值在 storage 文件里，从 service 层单独读
    let html = state.service.read_chapter_html(&book_id, &chapter_id);
    // 跟 get_chapter 一样重写图片 + 字体 URL，保持 PATCH 回显与 Reader 看到的一致
    let assets = state
        .service
        .get_assets(&book_id)
        .await
        .map_err(AppError::from)?;
    let asset_map: std::collections::HashMap<String, String> = assets
        .iter()
        .map(|a| (a.href.clone(), a.id.clone()))
        .collect();
    let to_url = |aid: &str| format!("/api/books/{book_id}/assets/{aid}");
    let rewritten = crate::epub::html_rewrite::rewrite_img_refs(
        &html,
        &ch.href,
        &asset_map,
        to_url,
    );
    let content = crate::epub::html_rewrite::rewrite_url_refs(
        &rewritten,
        &ch.href,
        &asset_map,
        to_url,
    );

    Ok(Json(ChapterContent {
        title: ch.title,
        content,
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

/// 导出格式查询参数：`?format=epub|txt`，缺省 epub。
#[derive(Debug, Deserialize)]
pub struct ExportQuery {
    pub format: Option<String>,
}

impl ExportQuery {
    /// 解析为 "epub" / "txt"；空或缺失回退 epub，非法值 400。
    fn parse_format(&self) -> Result<&'static str, AppError> {
        match self
            .format
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            None => Ok("epub"),
            Some("epub") => Ok("epub"),
            Some("txt") => Ok("txt"),
            Some(other) => Err(AppError::BadRequest(format!(
                "不支持的导出格式 {other:?}（可选 epub / txt）"
            ))),
        }
    }
}

/// GET /api/books/:id/export?format=epub|txt —— 导出（重建 EPUB 3 / 转 TXT）
pub async fn export_book(
    State(state): State<AppState>,
    Path(book_id): Path<String>,
    Query(q): Query<ExportQuery>,
) -> Result<Response, AppError> {
    let format = q.parse_format()?;

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

    // 先取出 title 用于 Content-Disposition（book 会被 move 进闭包）
    let title = book.title.clone();
    let svc_clone = state.service.clone();

    // CPU 密集，放 spawn_blocking；按格式分支产 (bytes, ext, content_type)
    let (bytes, ext, content_type): (Vec<u8>, &str, &str) = if format == "txt" {
        let txt_bytes = tokio::task::spawn_blocking(move || {
            svc_clone.export_txt(chapters, |_, _, _| {})
        })
        .await
        .map_err(|e| AppError::Internal(format!("join: {e}")))?
        .map_err(AppError::from)?;
        (txt_bytes, "txt", "text/plain; charset=utf-8")
    } else {
        let assets = state
            .service
            .get_assets(&book_id)
            .await
            .map_err(AppError::from)?;
        let epub_bytes = tokio::task::spawn_blocking(move || {
            svc_clone.export_epub(&book, chapters, &assets, |_, _, _| {})
        })
        .await
        .map_err(|e| AppError::Internal(format!("join: {e}")))?
        .map_err(AppError::from)?;
        (epub_bytes, "epub", "application/epub+zip")
    };

    // Content-Disposition：ASCII fallback + UTF-8 filename*
    let safe = title
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect::<String>();
    let safe = if safe.is_empty() { "book".to_string() } else { safe };
    // filename* 编码原始（含中文）标题字节
    let quoted = percent_encoding(title.as_bytes());
    let disposition = format!(
        "attachment; filename=\"{safe}.{ext}\"; filename*=UTF-8''{quoted}.{ext}"
    );

    let mut headers = HeaderMap::new();
    headers.insert(header::CONTENT_TYPE, content_type.parse().unwrap());
    headers.insert(
        header::CONTENT_DISPOSITION,
        disposition.parse().unwrap(),
    );

    Ok((StatusCode::OK, headers, Body::from(bytes)).into_response())
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

// ==================== 异步导入/导出/删除（SSE 进度） ====================

/// POST /api/books/async — 异步导入一本书，立即返回 `{task_id}`。
/// 后台任务跑 add_book，进度通过 GET /api/progress/{task_id}（SSE）订阅。
pub async fn upload_book_async(
    State(state): State<AppState>,
    mut multipart: Multipart,
) -> Result<Json<serde_json::Value>, AppError> {
    let mut bytes: Option<Vec<u8>> = None;
    let mut filename = String::new();

    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| AppError::BadRequest(format!("multipart: {e}")))?
    {
        if field.name() == Some("file") {
            filename = field.file_name().unwrap_or("unknown.epub").to_string();
            bytes = Some(
                field
                    .bytes()
                    .await
                    .map_err(|e| AppError::BadRequest(format!("read body: {e}")))?
                    .to_vec(),
            );
            break;
        }
    }
    let bytes = bytes.ok_or_else(|| AppError::BadRequest("no 'file' field".into()))?;
    let format = SourceFormat::from_filename(&filename).ok_or_else(|| {
        AppError::UnsupportedMedia(format!(
            "仅支持扩展名 {ALLOWED_EXT:?}，收到 {:?}",
            filename
        ))
    })?;

    let (task_id, progress) = create_import_task(&state.tasks).await;
    let svc = state.service.clone();
    let progress_for_task = progress.clone();

    tokio::spawn(async move {
        let cb = make_import_callback(progress_for_task);
        match svc.add_book(bytes, &filename, format, cb).await {
            Ok(_book) => {
                *progress.lock().unwrap() = Progress::done(None);
            }
            Err(crate::epub::EpubError::DuplicateFile { existing_book_id }) => {
                *progress.lock().unwrap() = Progress::duplicate(existing_book_id);
            }
            Err(e) => {
                let code = e.code().to_string();
                let msg = e.to_string();
                *progress.lock().unwrap() = Progress::error(code, msg);
            }
        }
    });

    Ok(Json(serde_json::json!({ "task_id": task_id })))
}

/// 把 (current, total, phase) 三元回调翻译成 Progress 写入共享状态。
/// 阶段分配：parsing 0-50%，writing_chapters 50-95%，writing_assets 95-99%。
fn make_import_callback(
    progress: std::sync::Arc<std::sync::Mutex<Progress>>,
) -> impl Fn(usize, usize, &str) + Clone + Send + 'static {
    move |current, total, phase| {
        let pct = match phase {
            "parsing" => scale(current, total, 0, 50),
            "writing_chapters" => scale(current, total, 50, 95),
            "writing_assets" => scale(current, total, 95, 99),
            _ => 0,
        };
        // EPUB 的 current/total 是章节数，TXT 的解析阶段是行数——统一写"解析"。
        let msg = match phase {
            "parsing" => format!("解析 {current}/{total}"),
            "writing_chapters" => format!("写入章节 {current}/{total}"),
            "writing_assets" => format!("写入资源 {current}/{total}"),
            _ => format!("{phase} {current}/{total}"),
        };
        let snapshot = Progress::update(phase, msg, pct);
        *progress.lock().unwrap() = snapshot;
    }
}

/// POST /api/books/:id/export/async?format=epub|txt — 异步导出，立即返回 `{task_id}`。
/// 完成后通过 GET /api/tasks/{task_id}/download 拿文件。
pub async fn export_book_async(
    State(state): State<AppState>,
    Path(book_id): Path<String>,
    Query(q): Query<ExportQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    let format = q.parse_format()?;

    // 提前校验书存在性（找不到立刻 404）
    let book = state
        .service
        .get_book_orm(&book_id)
        .await
        .map_err(AppError::from)?
        .ok_or(AppError::NotFound("book not found".into()))?;

    let (task_id, progress, result_slot) = create_export_task(&state.tasks, &book_id).await;
    let svc = state.service.clone();
    let progress_for_task = progress.clone();
    let title = book.title.clone();
    let task_id_for_spawn = task_id.clone();

    tokio::spawn(async move {
        let cb = make_export_callback(progress_for_task);
        let svc_clone = svc.clone();
        let book_id_for_task = book_id.clone();
        let chapters = match svc.get_chapters(&book_id_for_task).await {
            Ok(c) => c,
            Err(e) => {
                *progress.lock().unwrap() =
                    Progress::error("INTERNAL", format!("读取章节失败:{e}"));
                return;
            }
        };
        let assets = match svc.get_assets(&book_id_for_task).await {
            Ok(a) => a,
            Err(e) => {
                *progress.lock().unwrap() =
                    Progress::error("INTERNAL", format!("读取资源失败:{e}"));
                return;
            }
        };
        let book_for_blocking = match svc.get_book_orm(&book_id_for_task).await {
            Ok(Some(b)) => b,
            _ => {
                *progress.lock().unwrap() =
                    Progress::error("INTERNAL", "读不到 book 元数据".to_string());
                return;
            }
        };
        let cb_for_blocking = cb.clone();
        let svc_for_blocking = svc_clone.clone();
        let bytes_res = tokio::task::spawn_blocking(move || {
            if format == "txt" {
                // TXT 导出用不到 assets，但仍读一次保持分支结构一致
                svc_for_blocking.export_txt(chapters, cb_for_blocking)
            } else {
                svc_for_blocking.export_epub(
                    &book_for_blocking,
                    chapters,
                    &assets,
                    cb_for_blocking,
                )
            }
        })
        .await;

        match bytes_res {
            Ok(Ok(bytes)) => {
                let filename = format!("{title}.{format}");
                *result_slot.lock().unwrap() = Some((bytes, filename));
                let download_url = format!("/api/tasks/{task_id_for_spawn}/download");
                *progress.lock().unwrap() = Progress::done(Some(download_url));
            }
            Ok(Err(e)) => {
                let code = e.code().to_string();
                let msg = e.to_string();
                *progress.lock().unwrap() = Progress::error(code, msg);
            }
            Err(e) => {
                *progress.lock().unwrap() =
                    Progress::error("INTERNAL", format!("join 失败:{e}"));
            }
        }
    });

    Ok(Json(serde_json::json!({ "task_id": task_id })))
}

/// 把 (current, total, phase) 翻译成导出阶段的 Progress。
/// 阶段分配：reading_assets 0-15%，building 15-95%。
fn make_export_callback(
    progress: std::sync::Arc<std::sync::Mutex<Progress>>,
) -> impl Fn(usize, usize, &str) + Clone + Send + 'static {
    move |current, total, phase| {
        let pct = match phase {
            "reading_assets" => scale(current, total, 0, 15),
            "building" => scale(current, total, 15, 95),
            _ => 0,
        };
        let msg = match phase {
            "reading_assets" => format!("读取资源 {current}/{total}"),
            "building" => format!("打包章节 {current}/{total}"),
            _ => format!("{phase} {current}/{total}"),
        };
        *progress.lock().unwrap() = Progress::update(phase, msg, pct);
    }
}

/// 把 current/total 比例映射到 [from, to] 区间。total 为 0 时返回 from。
fn scale(current: usize, total: usize, from: u8, to: u8) -> u8 {
    if total == 0 {
        return from;
    }
    let frac = current as f64 / total as f64;
    let span = to as f64 - from as f64;
    (from as f64 + frac * span).min(to as f64).max(0.0) as u8
}

/// POST /api/books/:id/delete/async — 异步删除书，立即返回 `{task_id}`。
/// 进度通过 GET /api/progress/{task_id}（SSE）订阅；
/// 阶段：deleting_chapters → deleting_records → deleting_files → deleting_cos。
pub async fn delete_book_async(
    State(state): State<AppState>,
    Path(book_id): Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    // 提前校验书存在性（找不到立刻 404）
    let book = state
        .service
        .get_book_orm(&book_id)
        .await
        .map_err(AppError::from)?
        .ok_or(AppError::NotFound("book not found".into()))?;

    let title = book.title;
    let (task_id, progress) = create_delete_task(&state.tasks).await;
    let svc = state.service.clone();
    let progress_for_task = progress.clone();

    tokio::spawn(async move {
        let cb = make_delete_callback(progress_for_task.clone());
        match svc.delete_book(&book_id, cb).await {
            Ok(true) => {
                *progress_for_task.lock().unwrap() =
                    Progress::done_message(format!("《{title}》已删除"));
            }
            Ok(false) => {
                *progress_for_task.lock().unwrap() =
                    Progress::error("NOT_FOUND", "书不存在".to_string());
            }
            Err(e) => {
                let code = e.code().to_string();
                let msg = e.to_string();
                *progress_for_task.lock().unwrap() = Progress::error(code, msg);
            }
        }
    });

    Ok(Json(serde_json::json!({ "task_id": task_id })))
}

/// 把删除阶段回调翻译成 Progress。
/// 阶段分配：deleting_chapters 5-80%，deleting_records 80-88%，
/// deleting_files 88-95%，deleting_cos 95-99%。
fn make_delete_callback(
    progress: std::sync::Arc<std::sync::Mutex<Progress>>,
) -> impl Fn(usize, usize, &str) + Clone + Send + 'static {
    move |current, total, phase| {
        let pct = match phase {
            "deleting_chapters" => scale(current, total, 5, 80),
            "deleting_records" => scale(current, total, 80, 88),
            "deleting_files" => scale(current, total, 88, 95),
            "deleting_cos" => scale(current, total, 95, 99),
            _ => 0,
        };
        let msg = match phase {
            "deleting_chapters" => format!("删除章节 {current}/{total}"),
            "deleting_records" => "清理书目记录".to_string(),
            "deleting_files" => "删除本地文件".to_string(),
            "deleting_cos" => "清理云端资源".to_string(),
            _ => format!("{phase} {current}/{total}"),
        };
        *progress.lock().unwrap() = Progress::update(phase, msg, pct);
    }
}
