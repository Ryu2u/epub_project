// 进度流 + 下载端点。
//
// GET /api/progress/:task_id — Server-Sent Events 流，前端订阅拿实时阶段/百分比。
// GET /api/tasks/:task_id/download — 导出任务完成后下载文件（导入任务无下载产物）。

use std::convert::Infallible;
use std::time::Duration;

use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::sse::{Event, Sse};
use axum::response::{IntoResponse, Response};
use futures::stream::Stream;

use crate::progress::TaskKind;
use crate::error::AppError;
use crate::AppState;

/// GET /api/progress/:task_id — SSE 流，每 200ms 推送一份 Progress 快照，
/// 直到 progress.done = true 后发最后一帧再关闭。
pub async fn progress_stream(
    State(state): State<AppState>,
    Path(task_id): Path<String>,
) -> Result<
    Sse<impl Stream<Item = Result<Event, Infallible>>>,
    AppError,
> {
    let entry = state
        .tasks
        .get(&task_id)
        .await
        .ok_or_else(|| AppError::NotFound(format!("task {task_id} not found")))?;
    let progress = entry.progress;

    let stream = async_stream::stream! {
        loop {
            let snapshot = {
                let guard = progress.lock().unwrap();
                guard.clone()
            };
            let data = serde_json::to_string(&snapshot)
                .unwrap_or_else(|_| "{}".to_string());
            yield Ok(Event::default().data(data));
            if snapshot.done {
                break;
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    };

    Ok(Sse::new(stream))
}

/// GET /api/tasks/:task_id/download — 导出任务完成后取文件字节。
/// 任务未完成 / 非导出任务 / 不存在 → 404。
pub async fn download_task(
    State(state): State<AppState>,
    Path(task_id): Path<String>,
) -> Result<Response, AppError> {
    let entry = state
        .tasks
        .get(&task_id)
        .await
        .ok_or_else(|| AppError::NotFound(format!("task {task_id} not found")))?;

    let TaskKind::Export { result, .. } = entry.kind else {
        return Err(AppError::BadRequest("任务不是导出任务".into()));
    };

    let Some((bytes, filename)) = ({
        let guard = result.lock().unwrap();
        guard.clone()
    }) else {
        return Err(AppError::NotFound("导出文件未就绪".into()));
    };

    // 与同步导出一致的 Content-Disposition 编码（ASCII fallback + UTF-8 filename*）
    let safe: String = filename
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect();
    let safe = if safe.is_empty() { "book".to_string() } else { safe };
    let quoted = percent_encoding(filename.as_bytes());
    let disposition = format!(
        "attachment; filename=\"{safe}.epub\"; filename*=UTF-8''{quoted}.epub"
    );

    let mut headers = HeaderMap::new();
    headers.insert(header::CONTENT_TYPE, "application/epub+zip".parse().unwrap());
    headers.insert(
        header::CONTENT_DISPOSITION,
        disposition.parse().unwrap(),
    );

    Ok((StatusCode::OK, headers, Body::from(bytes)).into_response())
}

/// 简单 percent-encoding（与 write.rs::export_book 一致）
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