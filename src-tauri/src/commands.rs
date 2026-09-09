// Tauri 命令层:把原 axum HTTP 端点一一映射为 #[tauri::command]。
//
// 与 HTTP 版的行为镜像:
// - 复用 epub-backend-rs 的 BookService / TaskRegistry / schema 类型
// - 异步任务(导入/删除/导出)与 HTTP 版一致:立即返回 task_id,
//   进度写入 TaskRegistry,前端通过 get_progress 轮询(替代 SSE)
// - 错误结构 { code, message, existing_book_id? } 与 HTTP 错误体内层一致,
//   前端 client.ts 包装成 ApiClientError,ErrorBanner 无感兼容

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::epub::{html_rewrite, EpubError, SourceFormat};
use crate::migration::{export_library, import_library};
use crate::progress::{
    create_delete_task, create_export_task, create_import_task, create_migration_task, Progress,
    TaskKind,
};
use crate::schema::{
    BatchUploadResult, BatchUploadResultItem, BookDetail, BookListResponse, BookSummary,
    ChapterContent, ChapterReorder, ChapterUpdate, SearchResponse, UploadResult,
    ALLOWED_COVER_TYPES, ALLOWED_EXT,
};
use crate::AppState;

// ==================== 错误类型 ====================

/// 与 HTTP 错误响应体内层({"error":{code,message,...}})同构,
/// invoke 失败时前端拿到的就是这个对象。
#[derive(Debug, Serialize)]
pub struct CmdError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub existing_book_id: Option<String>,
}

impl CmdError {
    pub fn not_found(msg: impl Into<String>) -> Self {
        Self { code: "NOT_FOUND".into(), message: msg.into(), existing_book_id: None }
    }
    pub fn bad_request(msg: impl Into<String>) -> Self {
        Self { code: "BAD_REQUEST".into(), message: msg.into(), existing_book_id: None }
    }
    pub fn unsupported(msg: impl Into<String>) -> Self {
        Self { code: "UNSUPPORTED_MEDIA".into(), message: msg.into(), existing_book_id: None }
    }
    pub fn internal(msg: impl Into<String>) -> Self {
        Self { code: "INTERNAL".into(), message: msg.into(), existing_book_id: None }
    }
}

impl From<EpubError> for CmdError {
    fn from(e: EpubError) -> Self {
        let code = e.code().to_string();
        let message = e.to_string();
        let existing_book_id = match &e {
            EpubError::DuplicateFile { existing_book_id } => Some(existing_book_id.clone()),
            _ => None,
        };
        Self { code, message, existing_book_id }
    }
}

type CmdResult<T> = Result<T, CmdError>;

// ==================== 进度回调(镜像 api/books/write.rs) ====================

/// 把 current/total 比例映射到 [from, to] 区间。total 为 0 时返回 from。
fn scale(current: usize, total: usize, from: u8, to: u8) -> u8 {
    if total == 0 {
        return from;
    }
    let frac = current as f64 / total as f64;
    let span = to as f64 - from as f64;
    (from as f64 + frac * span).min(to as f64).max(0.0) as u8
}

/// 导入阶段:parsing 0-50%,writing_chapters 50-95%,writing_assets 95-99%。
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
        let msg = match phase {
            "parsing" => format!("解析 {current}/{total}"),
            "writing_chapters" => format!("写入章节 {current}/{total}"),
            "writing_assets" => format!("写入资源 {current}/{total}"),
            _ => format!("{phase} {current}/{total}"),
        };
        *progress.lock().unwrap() = Progress::update(phase, msg, pct);
    }
}

/// 删除阶段:deleting_chapters 5-80%,deleting_records 80-88%,
/// deleting_files 88-95%,deleting_cos 95-99%。
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

/// 导出阶段:reading_assets 0-15%,building 15-95%。
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

/// epubasset 自定义协议 URL(与前端 convertFileSrc 同构):
/// Windows/Android → http://epubasset.localhost{path};其余 → epubasset://localhost{path}
pub fn asset_url(path: &str) -> String {
    if cfg!(any(target_os = "windows", target_os = "android")) {
        format!("http://epubasset.localhost{path}")
    } else {
        format!("epubasset://localhost{path}")
    }
}

// ==================== 读命令 ====================

/// 书籍列表(镜像 GET /api/books)
#[tauri::command]
pub async fn list_books(
    q: Option<String>,
    page: Option<i64>,
    size: Option<i64>,
    state: State<'_, AppState>,
) -> CmdResult<BookListResponse> {
    let q = q.unwrap_or_default();
    let page = page.unwrap_or(1).max(1);
    let size = size.unwrap_or(20).clamp(1, 100);

    let (books, total) = state
        .service
        .list_books(&q, page, size)
        .await
        .map_err(CmdError::from)?;

    let ids: Vec<String> = books.iter().map(|b| b.id.clone()).collect();
    let (ch_counts, as_counts, cover_ids, word_counts) =
        state.service.batch_counts(&ids).await.map_err(|e| CmdError::internal(e.to_string()))?;

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

    Ok(BookListResponse { items, total, page, size })
}

/// 书籍详情(镜像 GET /api/books/:id)
#[tauri::command]
pub async fn get_book(
    book_id: String,
    state: State<'_, AppState>,
) -> CmdResult<BookDetail> {
    state.service.fetch_book_detail(&book_id)
        .await
        .map_err(|e| CmdError::internal(e.to_string()))?
        .ok_or_else(|| CmdError::not_found("book not found"))
}

/// 章节内容(镜像 GET /api/books/:id/chapters/:cid?format=)。
/// html 模式下图片/字体引用重写为 epubasset 协议 URL(替代 /api/... 路径)。
#[tauri::command]
pub async fn get_chapter(
    book_id: String,
    chapter_id: String,
    format: Option<String>,
    state: State<'_, AppState>,
) -> CmdResult<ChapterContent> {
    let format = format.unwrap_or_else(|| "text".to_string());

    let ch = state
        .service
        .get_chapter(&book_id, &chapter_id)
        .await
        .map_err(CmdError::from)?
        .ok_or_else(|| CmdError::not_found("chapter not found"))?;

    let content = if format == "html" {
        let html = state.service.read_chapter_html(&book_id, &chapter_id);
        let assets = state.service.get_assets(&book_id).await.map_err(CmdError::from)?;
        let asset_map: HashMap<String, String> = assets
            .iter()
            .map(|a| (a.href.clone(), a.id.clone()))
            .collect();
        let to_url = |aid: &str| asset_url(&format!("/books/{book_id}/assets/{aid}"));
        let rewritten =
            html_rewrite::rewrite_img_refs(&html, &ch.href, &asset_map, to_url);
        html_rewrite::rewrite_url_refs(&rewritten, &ch.href, &asset_map, to_url)
    } else {
        ch.text
    };

    Ok(ChapterContent { title: ch.title, content, format })
}

/// 书内全文搜索(逐次命中:一条结果 = 一次出现,按阅读顺序分页)
#[tauri::command]
pub async fn search_in_book(
    book_id: String,
    q: Option<String>,
    page: Option<i64>,
    size: Option<i64>,
    state: State<'_, AppState>,
) -> CmdResult<SearchResponse> {
    let q = q.unwrap_or_default();
    let page = page.unwrap_or(1).max(1);
    // 分页单位是章节(每章带本章全部命中),每页默认 20 章
    let size = size.unwrap_or(20).clamp(1, 100);

    if q.trim().chars().count() < 2 {
        return Ok(SearchResponse { items: Vec::new(), total: 0, chapter_total: 0, query: q });
    }

    if state
        .service
        .get_book_orm(&book_id)
        .await
        .map_err(CmdError::from)?
        .is_none()
    {
        return Err(CmdError::not_found("book not found"));
    }

    let (items, total, chapter_total) = state
        .service
        .search_in_book(&book_id, &q, page, size)
        .await
        .map_err(CmdError::from)?;

    Ok(SearchResponse { items, total, chapter_total, query: q })
}

// ==================== 写命令 ====================

/// 单文件同步导入(镜像 POST /api/books)
#[tauri::command]
pub async fn upload_book(
    filename: String,
    bytes: Vec<u8>,
    state: State<'_, AppState>,
) -> CmdResult<UploadResult> {
    let format = SourceFormat::from_filename(&filename).ok_or_else(|| {
        CmdError::unsupported(format!("仅支持扩展名 {ALLOWED_EXT:?},收到 {filename:?}"))
    })?;

    let book = state
        .service
        .add_book(bytes, &filename, format, |_, _, _| {})
        .await
        .map_err(CmdError::from)?;

    let detail = state.service.fetch_book_detail(&book.id)
        .await
        .map_err(|e| CmdError::internal(e.to_string()))?
        .ok_or_else(|| CmdError::internal("刚写入的书读不回来"))?;

    Ok(UploadResult { book: detail, warnings: Vec::new() })
}

/// 批量导入入参(镜像 multipart 的多个 file 字段)
#[derive(Deserialize)]
pub struct BatchFileInput {
    pub filename: String,
    pub bytes: Vec<u8>,
}

/// 批量导入(镜像 POST /api/books/batch)——部分失败不影响其余
#[tauri::command]
pub async fn upload_books_batch(
    files: Vec<BatchFileInput>,
    state: State<'_, AppState>,
) -> CmdResult<BatchUploadResult> {
    let mut items: Vec<BatchUploadResultItem> = Vec::new();

    for f in files {
        let format = match SourceFormat::from_filename(&f.filename) {
            Some(fmt) => fmt,
            None => {
                items.push(BatchUploadResultItem {
                    filename: f.filename,
                    status: "error".to_string(),
                    book_id: None,
                    title: None,
                    error_code: Some("UNSUPPORTED_MEDIA".to_string()),
                    error_message: Some(format!("仅支持 {ALLOWED_EXT:?}")),
                });
                continue;
            }
        };

        match state
            .service
            .add_book(f.bytes, &f.filename, format, |_, _, _| {})
            .await
        {
            Ok(book) => items.push(BatchUploadResultItem {
                filename: f.filename,
                status: "success".to_string(),
                book_id: Some(book.id.clone()),
                title: Some(book.title.clone()),
                error_code: None,
                error_message: None,
            }),
            Err(EpubError::DuplicateFile { existing_book_id }) => {
                items.push(BatchUploadResultItem {
                    filename: f.filename,
                    status: "duplicate".to_string(),
                    book_id: Some(existing_book_id),
                    title: None,
                    error_code: None,
                    error_message: None,
                });
            }
            Err(e) => items.push(BatchUploadResultItem {
                filename: f.filename,
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

    Ok(BatchUploadResult { items, total, succeeded, skipped, failed })
}

/// 异步导入(镜像 POST /api/books/async):立即返回 task_id,
/// 进度用 get_progress 轮询
#[tauri::command]
pub async fn upload_book_async(
    filename: String,
    bytes: Vec<u8>,
    state: State<'_, AppState>,
) -> CmdResult<serde_json::Value> {
    let format = SourceFormat::from_filename(&filename).ok_or_else(|| {
        CmdError::unsupported(format!("仅支持扩展名 {ALLOWED_EXT:?},收到 {filename:?}"))
    })?;

    let (task_id, progress) = create_import_task(&state.tasks).await;
    let svc = state.service.clone();
    let progress_for_task = progress.clone();

    tauri::async_runtime::spawn(async move {
        let cb = make_import_callback(progress_for_task.clone());
        match svc.add_book(bytes, &filename, format, cb).await {
            Ok(_book) => {
                *progress_for_task.lock().unwrap() = Progress::done(None);
            }
            Err(EpubError::DuplicateFile { existing_book_id }) => {
                *progress_for_task.lock().unwrap() =
                    Progress::duplicate(existing_book_id);
            }
            Err(e) => {
                let code = e.code().to_string();
                let msg = e.to_string();
                *progress_for_task.lock().unwrap() = Progress::error(code, msg);
            }
        }
    });

    Ok(serde_json::json!({ "task_id": task_id }))
}

/// 同步删除(镜像 DELETE /api/books/:id)
#[tauri::command]
pub async fn delete_book(
    book_id: String,
    state: State<'_, AppState>,
) -> CmdResult<bool> {
    state
        .service
        .delete_book(&book_id, |_, _, _| {})
        .await
        .map_err(CmdError::from)
}

/// 异步删除(镜像 POST /api/books/:id/delete/async)
#[tauri::command]
pub async fn delete_book_async(
    book_id: String,
    state: State<'_, AppState>,
) -> CmdResult<serde_json::Value> {
    let book = state
        .service
        .get_book_orm(&book_id)
        .await
        .map_err(CmdError::from)?
        .ok_or_else(|| CmdError::not_found("book not found"))?;
    let title = book.title;

    let (task_id, progress) = create_delete_task(&state.tasks).await;
    let svc = state.service.clone();
    let progress_for_task = progress.clone();

    tauri::async_runtime::spawn(async move {
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

    Ok(serde_json::json!({ "task_id": task_id }))
}

/// 更新书籍元数据(镜像 PATCH /api/books/:id)
#[tauri::command]
pub async fn update_book(
    book_id: String,
    data: BookUpdateCmd,
    state: State<'_, AppState>,
) -> CmdResult<BookDetail> {
    // 空 body / 无字段 → 400(与 HTTP 行为一致)
    let has_update = data.title.is_some()
        || data.authors.is_some()
        || data.language.is_some()
        || data.publisher.is_some()
        || data.description.is_some()
        || data.pub_date.is_some()
        || data.identifier.is_some();
    if !has_update {
        return Err(CmdError::bad_request(
            "EMPTY_UPDATE: 至少需要传入一个要修改的字段",
        ));
    }

    let book = state
        .service
        .update_book(&book_id, &data.into())
        .await
        .map_err(CmdError::from)?
        .ok_or_else(|| CmdError::not_found("book not found"))?;

    state.service.fetch_book_detail(&book.id)
        .await
        .map_err(|e| CmdError::internal(e.to_string()))?
        .ok_or_else(|| CmdError::internal("更新后的书读不回来"))
}

/// 书籍元数据更新入参(镜像 schema::BookUpdate;单独定义以便 Deserialize)
#[derive(Deserialize)]
pub struct BookUpdateCmd {
    pub title: Option<String>,
    pub authors: Option<Vec<String>>,
    pub language: Option<String>,
    pub publisher: Option<String>,
    pub description: Option<String>,
    pub pub_date: Option<String>,
    pub identifier: Option<String>,
}

impl From<BookUpdateCmd> for crate::schema::BookUpdate {
    fn from(v: BookUpdateCmd) -> Self {
        Self {
            title: v.title,
            authors: v.authors,
            language: v.language,
            publisher: v.publisher,
            description: v.description,
            pub_date: v.pub_date,
            identifier: v.identifier,
        }
    }
}

/// 更新章节标题/正文(镜像 PATCH /api/books/:id/chapters/:cid)
#[tauri::command]
pub async fn update_chapter(
    book_id: String,
    chapter_id: String,
    data: ChapterUpdateCmd,
    state: State<'_, AppState>,
) -> CmdResult<ChapterContent> {
    if data.title.is_none() && data.html.is_none() {
        return Err(CmdError::bad_request(
            "EMPTY_UPDATE: 至少需要传入 title 或 html",
        ));
    }

    let update = ChapterUpdate { title: data.title, html: data.html };
    let ch = state
        .service
        .update_chapter(&book_id, &chapter_id, &update)
        .await
        .map_err(CmdError::from)?
        .ok_or_else(|| CmdError::not_found("chapter not found"))?;

    // 与 get_chapter 一致:html 重写为 epubasset URL
    let html = state.service.read_chapter_html(&book_id, &chapter_id);
    let assets = state.service.get_assets(&book_id).await.map_err(CmdError::from)?;
    let asset_map: HashMap<String, String> =
        assets.iter().map(|a| (a.href.clone(), a.id.clone())).collect();
    let to_url = |aid: &str| asset_url(&format!("/books/{book_id}/assets/{aid}"));
    let rewritten = html_rewrite::rewrite_img_refs(&html, &ch.href, &asset_map, to_url);
    let content = html_rewrite::rewrite_url_refs(&rewritten, &ch.href, &asset_map, to_url);

    Ok(ChapterContent { title: ch.title, content, format: "html".to_string() })
}

/// 章节更新入参(镜像 schema::ChapterUpdate)
#[derive(Deserialize)]
pub struct ChapterUpdateCmd {
    pub title: Option<String>,
    pub html: Option<String>,
}

/// 章节重排(镜像 PATCH /api/books/:id/chapters/reorder)
#[tauri::command]
pub async fn reorder_chapters(
    book_id: String,
    chapter_ids: Vec<String>,
    state: State<'_, AppState>,
) -> CmdResult<()> {
    if state
        .service
        .get_book_orm(&book_id)
        .await
        .map_err(CmdError::from)?
        .is_none()
    {
        return Err(CmdError::not_found("book not found"));
    }
    let data = ChapterReorder { chapter_ids };
    state
        .service
        .reorder_chapters(&book_id, &data.chapter_ids)
        .await
        .map_err(CmdError::from)?;
    Ok(())
}

/// 上传封面(镜像 POST /api/books/:id/cover)
#[tauri::command]
pub async fn upload_cover(
    book_id: String,
    bytes: Vec<u8>,
    media_type: String,
    state: State<'_, AppState>,
) -> CmdResult<BookDetail> {
    let media_type = media_type.to_lowercase();
    if !ALLOWED_COVER_TYPES.contains(&media_type.as_str()) {
        return Err(CmdError::unsupported(format!(
            "封面仅支持图片 {ALLOWED_COVER_TYPES:?},收到 {media_type:?}"
        )));
    }

    state
        .service
        .set_cover(&book_id, &bytes, &media_type)
        .await
        .map_err(CmdError::from)?
        .ok_or_else(|| CmdError::not_found("book not found"))?;

    state.service.fetch_book_detail(&book_id)
        .await
        .map_err(|e| CmdError::internal(e.to_string()))?
        .ok_or_else(|| CmdError::internal("更新后的书读不回来"))
}

/// 删除上传封面(镜像 DELETE /api/books/:id/cover)
#[tauri::command]
pub async fn delete_cover(
    book_id: String,
    state: State<'_, AppState>,
) -> CmdResult<bool> {
    state
        .service
        .delete_cover(&book_id)
        .await
        .map_err(CmdError::from)
}

// ==================== 导出 ====================

/// 导出格式解析("epub" | "txt",缺省 epub)
fn parse_export_format(format: &Option<String>) -> CmdResult<String> {
    match format.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        None => Ok("epub".to_string()),
        Some("epub") => Ok("epub".to_string()),
        Some("txt") => Ok("txt".to_string()),
        Some(other) => Err(CmdError::bad_request(format!(
            "不支持的导出格式 {other:?}(可选 epub / txt)"
        ))),
    }
}

/// 异步导出(镜像 POST /api/books/:id/export/async)。
/// 完成后通过 get_export_filename + take_export_bytes 取结果。
#[tauri::command]
pub async fn export_book_async(
    book_id: String,
    format: Option<String>,
    state: State<'_, AppState>,
) -> CmdResult<serde_json::Value> {
    let format = parse_export_format(&format)?;

    let book = state
        .service
        .get_book_orm(&book_id)
        .await
        .map_err(CmdError::from)?
        .ok_or_else(|| CmdError::not_found("book not found"))?;
    let title = book.title.clone();

    let (task_id, progress, result_slot) = create_export_task(&state.tasks, &book_id).await;
    let svc = state.service.clone();
    let progress_for_task = progress.clone();
    let task_id_for_spawn = task_id.clone();

    tauri::async_runtime::spawn(async move {
        let cb = make_export_callback(progress_for_task.clone());
        let chapters = match svc.get_chapters(&book_id).await {
            Ok(c) => c,
            Err(e) => {
                *progress_for_task.lock().unwrap() =
                    Progress::error("INTERNAL", format!("读取章节失败:{e}"));
                return;
            }
        };
        let assets = match svc.get_assets(&book_id).await {
            Ok(a) => a,
            Err(e) => {
                *progress_for_task.lock().unwrap() =
                    Progress::error("INTERNAL", format!("读取资源失败:{e}"));
                return;
            }
        };
        let book_for_blocking = match svc.get_book_orm(&book_id).await {
            Ok(Some(b)) => b,
            _ => {
                *progress_for_task.lock().unwrap() =
                    Progress::error("INTERNAL", "读不到 book 元数据".to_string());
                return;
            }
        };
        let cb_for_blocking = cb.clone();
        let svc_for_blocking = svc.clone();
        let format_for_blocking = format.clone();
        let bytes_res = tauri::async_runtime::spawn_blocking(move || {
            if format_for_blocking == "txt" {
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
                *progress_for_task.lock().unwrap() = Progress::done(Some(download_url));
            }
            Ok(Err(e)) => {
                let code = e.code().to_string();
                let msg = e.to_string();
                *progress_for_task.lock().unwrap() = Progress::error(code, msg);
            }
            Err(e) => {
                *progress_for_task.lock().unwrap() =
                    Progress::error("INTERNAL", format!("join 失败:{e}"));
            }
        }
    });

    Ok(serde_json::json!({ "task_id": task_id }))
}

/// 取导出文件名(镜像 GET /api/tasks/:id/download 的 Content-Disposition 部分)
#[tauri::command]
pub async fn get_export_filename(
    task_id: String,
    state: State<'_, AppState>,
) -> CmdResult<Option<String>> {
    let entry = state
        .tasks
        .get(&task_id)
        .await
        .ok_or_else(|| CmdError::not_found(format!("task {task_id} not found")))?;
    let TaskKind::Export { result, .. } = entry.kind else {
        return Err(CmdError::bad_request("任务不是导出任务"));
    };
    let guard = result.lock().unwrap();
    Ok(guard.as_ref().map(|(_, filename)| filename.clone()))
}

/// 取导出文件字节(二进制响应;镜像 GET /api/tasks/:id/download)
#[tauri::command]
pub async fn take_export_bytes(
    task_id: String,
    state: State<'_, AppState>,
) -> CmdResult<tauri::ipc::Response> {
    let entry = state
        .tasks
        .get(&task_id)
        .await
        .ok_or_else(|| CmdError::not_found(format!("task {task_id} not found")))?;
    let TaskKind::Export { result, .. } = entry.kind else {
        return Err(CmdError::bad_request("任务不是导出任务"));
    };
    let taken = result.lock().unwrap().take();
    match taken {
        Some((bytes, _)) => Ok(tauri::ipc::Response::new(bytes)),
        None => Err(CmdError::not_found("导出文件未就绪")),
    }
}

// ==================== 进度轮询(替代 SSE) ====================

/// 查询任务进度快照(镜像 GET /api/progress/:id 的单帧)。
/// 前端 200ms 轮询,与 SSE 的推送节奏一致。
#[tauri::command]
pub async fn get_progress(
    task_id: String,
    state: State<'_, AppState>,
) -> CmdResult<Option<Progress>> {
    match state.tasks.get(&task_id).await {
        Some(entry) => {
            let snapshot = entry.progress.lock().unwrap().clone();
            Ok(Some(snapshot))
        }
        None => Ok(None),
    }
}

// ==================== 书库迁移(两台设备互导) ====================

/// 迁移进度回调类型(与 backend migration::ProgressFn 同构)
type MigrationCallback = std::sync::Arc<dyn Fn(usize, usize, &str) + Send + Sync>;

/// 迁移进度回调:写 Progress 快照
fn make_migration_callback(
    progress: std::sync::Arc<std::sync::Mutex<Progress>>,
) -> MigrationCallback {
    // 阶段映射:packing 5-60%,extracting 5-30%,importing 30-99%
    std::sync::Arc::new(move |current: usize, total: usize, phase: &str| {
        let pct = match phase {
            "packing" => scale(current, total, 5, 60),
            "extracting" => scale(current, total, 5, 30),
            "importing" => scale(current, total, 30, 99),
            _ => 0,
        };
        let msg = match phase {
            "packing" => format!("打包 {current}/{total}"),
            "extracting" => format!("解包 {current}/{total}"),
            "importing" => format!("合并书籍 {current}/{total}"),
            _ => format!("{phase} {current}/{total}"),
        };
        *progress.lock().unwrap() = Progress::update(phase, msg, pct);
    })
}

/// 导出书库归档(后台任务)。dest_path 由前端文件保存对话框选定。
#[tauri::command]
pub async fn export_library_async(
    dest_path: String,
    state: State<'_, AppState>,
) -> CmdResult<serde_json::Value> {
    let (task_id, progress, result_slot) =
        create_migration_task(&state.tasks, "准备导出书库…").await;
    let svc = state.service.clone();
    let progress_for_task = progress.clone();

    tauri::async_runtime::spawn(async move {
        let cb = make_migration_callback(progress_for_task.clone());
        let dest = std::path::PathBuf::from(&dest_path);
        match export_library(&svc, &dest, cb).await {
            Ok(summary) => {
                let readable = format!(
                    "已导出 {} 本书({:.1} MB)",
                    summary.book_count,
                    summary.total_bytes as f64 / 1024.0 / 1024.0
                );
                *result_slot.lock().unwrap() =
                    Some((serde_json::to_string(&summary).unwrap(), readable.clone()));
                *progress_for_task.lock().unwrap() = Progress::done_message(readable);
            }
            Err(e) => {
                let code = e.code().to_string();
                let msg = e.to_string();
                *progress_for_task.lock().unwrap() = Progress::error(code, msg);
            }
        }
    });

    Ok(serde_json::json!({ "task_id": task_id }))
}

/// 导入书库归档(后台任务,合并语义:同 id/SHA 跳过)。
/// archive_path 由前端文件选择对话框选定。
#[tauri::command]
pub async fn import_library_async(
    archive_path: String,
    state: State<'_, AppState>,
) -> CmdResult<serde_json::Value> {
    let (task_id, progress, result_slot) =
        create_migration_task(&state.tasks, "准备导入书库…").await;
    let svc = state.service.clone();
    let progress_for_task = progress.clone();

    tauri::async_runtime::spawn(async move {
        let cb = make_migration_callback(progress_for_task.clone());
        let archive = std::path::PathBuf::from(&archive_path);
        match import_library(&svc, &archive, cb).await {
            Ok(summary) => {
                let readable = format!(
                    "导入完成:新增 {} 本,跳过 {} 本(已存在)",
                    summary.added, summary.skipped
                );
                *result_slot.lock().unwrap() =
                    Some((serde_json::to_string(&summary).unwrap(), readable.clone()));
                *progress_for_task.lock().unwrap() = Progress::done_message(readable);
            }
            Err(e) => {
                let code = e.code().to_string();
                let msg = e.to_string();
                *progress_for_task.lock().unwrap() = Progress::error(code, msg);
            }
        }
    });

    Ok(serde_json::json!({ "task_id": task_id }))
}

/// 取迁移任务结果:(JSON 摘要, 人类可读文本);未完成返回 None。
#[tauri::command]
pub async fn get_migration_result(
    task_id: String,
    state: State<'_, AppState>,
) -> CmdResult<Option<(String, String)>> {
    let entry = state
        .tasks
        .get(&task_id)
        .await
        .ok_or_else(|| CmdError::not_found(format!("task {task_id} not found")))?;
    let TaskKind::Migration { result } = entry.kind else {
        return Err(CmdError::bad_request("任务不是迁移任务"));
    };
    let guard = result.lock().unwrap();
    Ok(guard.clone())
}
