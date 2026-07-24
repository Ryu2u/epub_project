// 读取路径：书籍 / 章节 / 资源 / 列表查询。

use sqlx::query_as;

use crate::db::{Asset, Book, Chapter};
use crate::epub::EpubError;

use super::BookService;

impl BookService {
    /// 读单本书 ORM
    pub async fn get_book_orm(&self, book_id: &str) -> Result<Option<Book>, EpubError> {
        let book = query_as::<_, Book>(
            "SELECT id, title, authors, language, publisher, description, pub_date, \
             identifier, file_path, file_size, file_sha256, created_at \
             FROM books WHERE id = ?",
        )
        .bind(book_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| EpubError::FileSystem(format!("查询书失败：{e}")))?;
        Ok(book)
    }

    /// 读单本书的章节
    pub async fn get_chapters(&self, book_id: &str) -> Result<Vec<Chapter>, EpubError> {
        let chapters = query_as::<_, Chapter>(
            "SELECT id, book_id, title, spine_order, href, text, html, word_count \
             FROM chapters WHERE book_id = ? ORDER BY spine_order",
        )
        .bind(book_id)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| EpubError::FileSystem(format!("查询章节失败：{e}")))?;
        Ok(chapters)
    }

    /// 读单本书的资源
    pub async fn get_assets(&self, book_id: &str) -> Result<Vec<Asset>, EpubError> {
        let assets = query_as::<_, Asset>(
            "SELECT id, book_id, href, media_type, size, is_cover \
             FROM assets WHERE book_id = ?",
        )
        .bind(book_id)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| EpubError::FileSystem(format!("查询资源失败：{e}")))?;
        Ok(assets)
    }

    /// 读单章节（text + html）
    pub async fn get_chapter(&self, book_id: &str, chapter_id: &str) -> Result<Option<Chapter>, EpubError> {
        let ch = query_as::<_, Chapter>(
            "SELECT id, book_id, title, spine_order, href, text, html, word_count \
             FROM chapters WHERE book_id = ? AND id = ?",
        )
        .bind(book_id)
        .bind(chapter_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| EpubError::FileSystem(format!("查询章节失败：{e}")))?;
        Ok(ch)
    }

    // ---------- 列表 ----------

    /// 书名搜索 + 分页列表
    pub async fn list_books(
        &self,
        q: &str,
        page: i64,
        size: i64,
    ) -> Result<(Vec<Book>, i64), EpubError> {
        let offset = (page - 1).max(0) * size;

        let (books, total) = if q.trim().is_empty() {
            let total: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM books")
                .fetch_one(&self.pool)
                .await
                .map_err(|e| EpubError::FileSystem(format!("COUNT 失败：{e}")))?;
            let books = query_as::<_, Book>(
                "SELECT id, title, authors, language, publisher, description, pub_date, \
                 identifier, file_path, file_size, file_sha256, created_at \
                 FROM books ORDER BY created_at DESC LIMIT ? OFFSET ?",
            )
            .bind(size)
            .bind(offset)
            .fetch_all(&self.pool)
            .await
            .map_err(|e| EpubError::FileSystem(format!("查询失败：{e}")))?;
            (books, total)
        } else {
            let pattern = format!("%{}%", q.trim());
            let total: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM books WHERE title LIKE ?")
                .bind(&pattern)
                .fetch_one(&self.pool)
                .await
                .map_err(|e| EpubError::FileSystem(format!("COUNT 失败：{e}")))?;
            let books = query_as::<_, Book>(
                "SELECT id, title, authors, language, publisher, description, pub_date, \
                 identifier, file_path, file_size, file_sha256, created_at \
                 FROM books WHERE title LIKE ? ORDER BY created_at DESC LIMIT ? OFFSET ?",
            )
            .bind(&pattern)
            .bind(size)
            .bind(offset)
            .fetch_all(&self.pool)
            .await
            .map_err(|e| EpubError::FileSystem(format!("查询失败：{e}")))?;
            (books, total)
        };

        Ok((books, total))
    }
}
