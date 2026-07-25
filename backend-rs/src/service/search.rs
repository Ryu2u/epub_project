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
                let ctx = &ch.text[ctx_start..ctx_end];
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
