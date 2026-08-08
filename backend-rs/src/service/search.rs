// 搜索：FTS5 trigram（>=3 字符）+ LIKE 兜底（<3 字符）。

use regex::Regex;

use crate::db::Chapter;
use crate::epub::EpubError;

use super::BookService;

impl BookService {
    // ---------- 搜索 ----------

    /// 在指定书的章节正文中搜索。
    /// q.len() >= 3 用 FTS5 trigram；< 3 用 LIKE + 手动片段提取。
    pub async fn search_in_book(
        &self,
        book_id: &str,
        q: &str,
        page: i64,
        size: i64,
    ) -> Result<(Vec<crate::api::schema::SearchResult>, i64), EpubError> {
        let q = q.trim();
        if q.chars().count() >= 3 {
            self.search_fts(book_id, q, page, size).await
        } else {
            self.search_like(book_id, q, page, size).await
        }
    }

    /// FTS5 trigram 全文搜索（q >= 3 字符）。
    async fn search_fts(
        &self,
        book_id: &str,
        q: &str,
        page: i64,
        size: i64,
    ) -> Result<(Vec<crate::api::schema::SearchResult>, i64), EpubError> {
        let match_query = format!("\"{q}\"");

        // COUNT DISTINCT chapter
        let total: i64 = sqlx::query_scalar(
            "SELECT COUNT(DISTINCT fts.chapter_id) \
             FROM chapters_fts fts \
             WHERE fts.chapters_fts MATCH ? AND fts.book_id = ?",
        )
        .bind(&match_query)
        .bind(book_id)
        .fetch_one(&self.pool)
        .await
        .map_err(|e| EpubError::FileSystem(format!("FTS COUNT 失败：{e}")))?;

        if total == 0 {
            return Ok((Vec::new(), 0));
        }

        let offset = (page - 1).max(0) * size;

        // snippet(chapters_fts, 2, ...) — 第 2 列是 text
        // 排序按章节号 (spine_order ASC)，不按 FTS5 的 BM25 相关度。
        // 这样用户从前往后翻阅时，搜索结果也按章节顺序呈现，符合阅读直觉。
        let rows: Vec<(String, String, i64, String, f64)> = sqlx::query_as(
            "SELECT \
                fts.chapter_id, \
                ch.title AS chapter_title, \
                ch.spine_order, \
                snippet(chapters_fts, 2, '<mark>', '</mark>', '…', 48) AS snip, \
                rank \
             FROM chapters_fts fts \
             JOIN chapters ch ON ch.id = fts.chapter_id AND ch.book_id = fts.book_id \
             WHERE fts.chapters_fts MATCH ? AND fts.book_id = ? \
             ORDER BY ch.spine_order ASC \
             LIMIT ? OFFSET ?",
        )
        .bind(&match_query)
        .bind(book_id)
        .bind(size)
        .bind(offset)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| EpubError::FileSystem(format!("FTS 搜索失败：{e}")))?;

        let items = rows
            .into_iter()
            .map(|(chapter_id, chapter_title, spine_order, snippet, rank)| {
                crate::api::schema::SearchResult {
                    chapter_id,
                    chapter_title,
                    spine_order,
                    snippet,
                    // rank 是 BM25 负值（FTS5 默认），取绝对值近似匹配相关度
                    match_count: rank.abs() as i64,
                }
            })
            .collect();

        Ok((items, total))
    }

    /// LIKE 模糊搜索 + 手动片段提取（q < 3 字符）。
    async fn search_like(
        &self,
        book_id: &str,
        q: &str,
        page: i64,
        size: i64,
    ) -> Result<(Vec<crate::api::schema::SearchResult>, i64), EpubError> {
        let pattern = format!("%{q}%");

        let total: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM chapters WHERE book_id = ? AND text LIKE ?",
        )
        .bind(book_id)
        .bind(&pattern)
        .fetch_one(&self.pool)
        .await
        .map_err(|e| EpubError::FileSystem(format!("LIKE COUNT 失败：{e}")))?;

        if total == 0 {
            return Ok((Vec::new(), 0));
        }

        let offset = (page - 1).max(0) * size;

        let chapters = sqlx::query_as::<_, Chapter>(
            "SELECT id, book_id, title, spine_order, href, text, word_count \
             FROM chapters WHERE book_id = ? AND text LIKE ? \
             ORDER BY spine_order LIMIT ? OFFSET ?",
        )
        .bind(book_id)
        .bind(&pattern)
        .bind(size)
        .bind(offset)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| EpubError::FileSystem(format!("LIKE 搜索失败：{e}")))?;

        // 构建匹配正则（按 char_indices 得到字节区间，与 Python re 等价）
        let escaped = regex::escape(q);
        let re = Regex::new(&format!("(?i){escaped}"))
            .map_err(|e| EpubError::FileSystem(format!("正则编译失败：{e}")))?;

        let mut items = Vec::new();
        for ch in chapters {
            // SQL 已用 text LIKE 过滤，这里 text 必然至少匹配一次（否则这行不会进来）
            let matches: Vec<(usize, usize)> = re
                .find_iter(&ch.text)
                .map(|m| (m.start(), m.end()))
                .collect();
            let count = matches.len() as i64;

            let text_len = ch.text.len();
            // 最多取前 3 个匹配，每个前后各 40 字（字节近似，Python 也是按字符下标）
            let mut snippets: Vec<String> = Vec::new();
            for &(start, end) in matches.iter().take(3) {
                let ctx_start = start.saturating_sub(40);
                let ctx_end = (end + 40).min(text_len);
                // 圆整到最近的 UTF-8 字符边界，避免 saturating_sub 后落在多字节字符中间。
                let safe_start = ch.text.ceil_char_boundary(ctx_start);
                let safe_end = ch.text.floor_char_boundary(ctx_end);
                let ctx = &ch.text[safe_start..safe_end];
                let highlighted = re.replace_all(ctx, "<mark>$0</mark>").to_string();
                let prefix = if ctx_start > 0 { "…" } else { "" };
                let suffix = if ctx_end < text_len { "…" } else { "" };
                snippets.push(format!("{prefix}{highlighted}{suffix}"));
            }

            items.push(crate::api::schema::SearchResult {
                chapter_id: ch.id,
                chapter_title: ch.title,
                spine_order: ch.spine_order,
                snippet: snippets.join(" … "),
                match_count: count,
            });
        }

        Ok((items, total))
    }
}

// ========== LIKE 路径 UTF-8 切片安全测试 ==========
//
// 修复前 search_like 在生成 snippet 时按字节切片 UTF-8 文本,匹配位置距
// 章节开头不足 40 字节且落在字符中间时会 panic。本模块锁定该修复。

#[cfg(test)]
mod search_like_utf8_tests {
    use super::*;
    use crate::api::schema::SearchResult;
    use chrono::Utc;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use std::str::FromStr;
    use tempfile::TempDir;

    /// 临时 storage 目录 + 跑过 migration 的 in-memory SQLite。
    /// 与 service::chapter_html_io_tests::setup 等价,但独立以便本模块使用。
    async fn setup() -> (BookService, TempDir) {
        let tmp = tempfile::tempdir().expect("tempdir");
        let opts = SqliteConnectOptions::from_str(":memory:")
            .expect("sqlite opts")
            .foreign_keys(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(opts)
            .await
            .expect("connect sqlite");
        sqlx::migrate!("./migrations")
            .run(&pool)
            .await
            .expect("run migrations");
        let svc = BookService::new(pool, tmp.path().to_path_buf());
        (svc, tmp)
    }

    /// 插入一本带 N 章的书。html 列已不存在于 schema 中,不写文件。
    async fn insert_book_with_chapter(svc: &BookService, book_id: &str, chapter_id: &str, text: &str) {
        sqlx::query(
            "INSERT INTO books (id, title, authors, language, identifier, file_path, file_size, file_sha256, created_at) \
             VALUES (?, '测试书', '[]', 'zh', ?, ?, 0, 'deadbeef', ?)",
        )
        .bind(book_id)
        .bind(book_id)
        .bind(format!("{book_id}.epb"))
        .bind(Utc::now().naive_utc())
        .execute(&svc.pool)
        .await
        .expect("insert book");

        sqlx::query(
            "INSERT INTO chapters (id, book_id, title, spine_order, href, text, word_count) \
             VALUES (?, ?, '第一章', 0, 'OEBPS/ch1.xhtml', ?, 0)",
        )
        .bind(chapter_id)
        .bind(book_id)
        .bind(text)
        .execute(&svc.pool)
        .await
        .expect("insert chapter");
    }

    /// 修复前 panic:匹配位置在文本前 40 字节内,切片落在 UTF-8 字符中间。
    /// 修复后应返回 1 条带 <mark> 的 snippet。
    #[tokio::test]
    async fn search_like_does_not_panic_on_short_chinese_match() {
        let (svc, _tmp) = setup().await;
        // 文本开头先放 ~38 个 ASCII 字符 + 一个中文片段,保证 "开端" 命中位置
        // 距文本开头 < 40 字节且 ctx_start=447 落在中文汉字"业"中间。
        // 实际选一个更短的: 开头 30 个 ASCII 后接中文,确保 ctx_start 必然切到字符中间。
        let text = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa他突然觉得这一幕也许会成为某种改变的开端。\
                    他抬头看向远方,期待接下来会发生什么。";
        insert_book_with_chapter(&svc, "book-utf8-1", "ch-1", text).await;

        let (items, total) = svc
            .search_in_book("book-utf8-1", "开端", 1, 20)
            .await
            .expect("search_in_book should not panic");

        assert_eq!(total, 1, "expected 1 matching chapter, got {total}");
        assert_eq!(items.len(), 1);
        let item: &SearchResult = &items[0];
        assert!(
            item.snippet.contains("<mark>开端</mark>"),
            "snippet should highlight match, got: {}",
            item.snippet
        );
    }
}
