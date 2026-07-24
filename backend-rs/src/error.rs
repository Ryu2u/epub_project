// 统一错误类型：所有 handler 返回 Result<T, AppError>。
//
// IntoResponse 把错误转成 {"error":{"code":..,"message":..[,existing_book_id]}} JSON，
// 与前端 ErrorBanner 兼容（client.ts 的 parseError 期望这个结构）。
// 状态码按错误类型映射（与 Python 端一致）。

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;

use crate::epub::{EpubError, EpubError::DuplicateFile};

pub enum AppError {
    /// EPUB 解析/领域错误（按 code 映射 422/409）
    Epub(EpubError),
    /// 资源不存在（书/章节/资源）→ 404
    NotFound(String),
    /// 请求参数错误（空 body 等）→ 400
    BadRequest(String),
    /// 不支持的媒体类型（扩展名/MIME）→ 415
    UnsupportedMedia(String),
    /// 其他内部错误 → 500
    Internal(String),
}

// 让 service 的 EpubError 用 ? 自动转 AppError::Epub
impl From<EpubError> for AppError {
    fn from(e: EpubError) -> Self {
        AppError::Epub(e)
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, body): (StatusCode, serde_json::Value) = match self {
            AppError::Epub(e) => {
                let code = e.code();
                let status = match code {
                    "DUPLICATE_FILE" => StatusCode::CONFLICT,
                    "INVALID_CONTAINER" | "INCOMPLETE_METADATA" | "DRM_DETECTED"
                    | "CORRUPT_EPUB" => StatusCode::UNPROCESSABLE_ENTITY,
                    _ => StatusCode::INTERNAL_SERVER_ERROR,
                };
                let mut body = serde_json::json!({
                    "code": code,
                    "message": e.to_string(),
                });
                // DuplicateFile 暴露 existing_book_id（前端用于提示"已存在"）
                if let DuplicateFile { existing_book_id } = &e {
                    body["existing_book_id"] = serde_json::json!(existing_book_id);
                }
                (status, body)
            }
            AppError::NotFound(msg) => {
                (StatusCode::NOT_FOUND, serde_json::json!({ "code": "NOT_FOUND", "message": msg }))
            }
            AppError::BadRequest(msg) => {
                (StatusCode::BAD_REQUEST, serde_json::json!({ "code": "BAD_REQUEST", "message": msg }))
            }
            AppError::UnsupportedMedia(msg) => (
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                serde_json::json!({ "code": "UNSUPPORTED_MEDIA", "message": msg }),
            ),
            AppError::Internal(msg) => {
                (StatusCode::INTERNAL_SERVER_ERROR, serde_json::json!({ "code": "INTERNAL", "message": msg }))
            }
        };
        (status, Json(serde_json::json!({ "error": body }))).into_response()
    }
}
