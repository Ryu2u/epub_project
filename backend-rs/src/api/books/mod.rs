// Books API 模块：读端点（read.rs）+ 写端点（write.rs）+ 公共辅助。
//
// 路由通过 `router()` 暴露给 main.rs，handler 顺序与原内联注册保持一致
// （字面量段 batch/search/reorder 在通配 :id/:cid 之前）。

mod read;
mod write;

use std::collections::HashMap;

use axum::routing::{get, patch};
use axum::Router;

use crate::api::schema::{AssetOut, BookDetail, ChapterOut};
use crate::error::AppError;
use crate::AppState;

/// 所有 /api/books... 路由（不含 /api/health，health 留在 main.rs）。
///
/// 路由顺序：字面量段必须在通配 :id/:cid 之前。
pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/books", get(read::list_books).post(write::upload_book))
        .route("/api/books/batch", axum::routing::post(write::upload_books_batch))
        .route(
            "/api/books/:id",
            get(read::get_book)
                .patch(write::update_book)
                .delete(write::delete_book),
        )
        .route("/api/books/:id/search", get(write::search_in_book))
        .route(
            "/api/books/:id/chapters/reorder",
            patch(write::reorder_chapters),
        )
        .route(
            "/api/books/:id/chapters/:cid",
            get(read::get_chapter).patch(write::update_chapter),
        )
        .route("/api/books/:id/assets/:aid", get(read::get_asset))
        .route("/api/books/:id/export", get(write::export_book))
        .route(
            "/api/books/:id/cover",
            axum::routing::post(write::upload_cover).delete(write::delete_cover),
        )
}

/// 允许上传的扩展名
pub(super) const ALLOWED_EXT: [&str; 3] = [".epub", ".epb", ".txt"];

/// 允许的封面 MIME
pub(super) const ALLOWED_COVER_TYPES: [&str; 4] =
    ["image/jpeg", "image/png", "image/webp", "image/gif"];

/// 把 ORM Book（含 chapters/assets）转 BookDetail
pub(super) fn book_to_detail(
    book: &crate::db::Book,
    chapters: &[crate::db::Chapter],
    assets: &[crate::db::Asset],
) -> BookDetail {
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
pub(super) async fn fetch_book_detail(
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

/// 批量查询多本书的章节数 / 资源数 / 封面 id
pub(super) async fn batch_counts(
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
    let sql =
        format!("SELECT book_id, id FROM assets WHERE is_cover = 1 AND book_id IN ({placeholders})");
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
