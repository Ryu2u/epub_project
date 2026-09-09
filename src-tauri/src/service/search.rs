// 搜索：按章节分组的逐次命中。
//
// 结果结构 = 章节分组（章为一行,展开看每次出现）：
//   SearchChapter { 章信息, match_count, hits: [每次出现的 snippet/偏移/定位锚] }
// 分页单位是「章节」；total 仍是全书命中次数,chapter_total 是命中章节数。
//
// 章节候选：q >= 3 字符走 FTS5 trigram 选出「含关键词的章节」，
// < 3 字符走 LIKE 兜底；两种路径都在 Rust 侧用同一套大小写不敏感
// 正则定位每一次出现，保证 snippet / 次数 / 偏移三者一致。

use regex::Regex;

use crate::epub::EpubError;
use crate::schema::{SearchChapter, SearchHit};

use super::BookService;

/// 命中前后各取的上下文字符数。
const CONTEXT_CHARS: usize = 24;

/// 候选章节的正文（够构造命中条目）。
struct ChapterText {
    id: String,
    title: String,
    spine_order: i64,
    text: String,
}

impl BookService {
    // ---------- 搜索 ----------

    /// 在指定书的章节正文中搜索。
    /// 返回 `(当前页章节分组, 全书总命中次数, 命中章节数)`。
    pub async fn search_in_book(
        &self,
        book_id: &str,
        q: &str,
        page: i64,
        size: i64,
    ) -> Result<(Vec<SearchChapter>, i64, i64), EpubError> {
        let q = q.trim();
        if q.is_empty() {
            return Ok((Vec::new(), 0, 0));
        }

        let chapters = if q.chars().count() >= 3 {
            self.search_chapters_fts(book_id, q).await?
        } else {
            self.search_chapters_like(book_id, q).await?
        };

        // 大小写不敏感定位（(?i) 不改变字节偏移，故 offset 与原文对齐）
        let re = Regex::new(&format!("(?i){}", regex::escape(q)))
            .map_err(|e| EpubError::FileSystem(format!("正则编译失败：{e}")))?;

        let offset = (page - 1).max(0) * size;
        let mut items: Vec<SearchChapter> = Vec::new();
        let mut total: i64 = 0;
        let mut chapter_total: i64 = 0;
        let mut chapter_index: i64 = 0; // 命中章节的序号（分页单位）

        for ch in &chapters {
            let in_window = chapter_index >= offset && chapter_index < offset + size;
            let mut hits: Vec<SearchHit> = Vec::new();
            let mut chapter_hits: i64 = 0;
            for m in re.find_iter(&ch.text) {
                total += 1;
                chapter_hits += 1;
                // 只物化当前页章节的条目（总次数仍需扫完，否则 total 不准）
                if in_window {
                    hits.push(make_hit(&ch.text, m.start(), m.end(), chapter_hits));
                }
            }
            if chapter_hits > 0 {
                chapter_total += 1;
                if in_window {
                    items.push(SearchChapter {
                        chapter_id: ch.id.clone(),
                        chapter_title: ch.title.clone(),
                        spine_order: ch.spine_order,
                        match_count: chapter_hits,
                        hits,
                    });
                }
                chapter_index += 1;
            }
        }

        Ok((items, total, chapter_total))
    }

    /// FTS5 trigram 选出候选章节（q >= 3 字符）。
    async fn search_chapters_fts(
        &self,
        book_id: &str,
        q: &str,
    ) -> Result<Vec<ChapterText>, EpubError> {
        // FTS5 短语查询：引号内的双引号需转义为两个双引号
        let match_query = format!("\"{}\"", q.replace('"', "\"\""));
        let rows: Vec<(String, String, i64, String)> = sqlx::query_as(
            "SELECT ch.id, ch.title, ch.spine_order, ch.text \
             FROM chapters ch \
             WHERE ch.book_id = ? AND ch.id IN ( \
                 SELECT chapter_id FROM chapters_fts \
                 WHERE chapters_fts MATCH ? AND book_id = ? \
             ) \
             ORDER BY ch.spine_order ASC",
        )
        .bind(book_id)
        .bind(&match_query)
        .bind(book_id)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| EpubError::FileSystem(format!("FTS 搜索失败：{e}")))?;

        Ok(rows
            .into_iter()
            .map(|(id, title, spine_order, text)| ChapterText { id, title, spine_order, text })
            .collect())
    }

    /// LIKE 兜底选出候选章节（q < 3 字符）。
    async fn search_chapters_like(
        &self,
        book_id: &str,
        q: &str,
    ) -> Result<Vec<ChapterText>, EpubError> {
        // LIKE 通配符转义（% _），否则用户输入 % 会匹配全部
        let escaped = q.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_");
        let pattern = format!("%{escaped}%");
        let rows: Vec<(String, String, i64, String)> = sqlx::query_as(
            "SELECT id, title, spine_order, text FROM chapters \
             WHERE book_id = ? AND text LIKE ? ESCAPE '\\' \
             ORDER BY spine_order ASC",
        )
        .bind(book_id)
        .bind(&pattern)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| EpubError::FileSystem(format!("LIKE 搜索失败：{e}")))?;

        Ok(rows
            .into_iter()
            .map(|(id, title, spine_order, text)| ChapterText { id, title, spine_order, text })
            .collect())
    }
}

/// 构造一条命中（上下文已转义，关键词 <mark> 包裹）。
fn make_hit(text: &str, start: usize, end: usize, index_in_chapter: i64) -> SearchHit {
    let (before, before_trunc) = take_last_chars(text, start, CONTEXT_CHARS);
    let (after, after_trunc) = take_first_chars(text, end, CONTEXT_CHARS);
    let matched = &text[start..end];
    let snippet = format!(
        "{}{}<mark>{}</mark>{}{}",
        if before_trunc { "…" } else { "" },
        escape_html(before),
        escape_html(matched),
        escape_html(after),
        if after_trunc { "…" } else { "" },
    );
    SearchHit {
        index_in_chapter,
        char_offset: text[..start].chars().count() as i64,
        snippet,
        before: before.to_string(),
        matched: matched.to_string(),
    }
}

/// 取 [0, end) 中最后 max 个字符（字符边界安全）；返回 (切片, 是否截断)。
fn take_last_chars(text: &str, end: usize, max: usize) -> (&str, bool) {
    let sub = &text[..end];
    let count = sub.chars().count();
    if count <= max {
        return (sub, false);
    }
    let skip = count - max;
    let start = sub.char_indices().nth(skip).map(|(i, _)| i).unwrap_or(0);
    (&sub[start..], true)
}

/// 取 [start, 末尾) 中前 max 个字符（字符边界安全）；返回 (切片, 是否截断)。
fn take_first_chars(text: &str, start: usize, max: usize) -> (&str, bool) {
    let sub = &text[start..];
    if sub.chars().count() <= max {
        return (sub, false);
    }
    let end = sub.char_indices().nth(max).map(|(i, _)| i).unwrap_or(sub.len());
    (&sub[..end], true)
}

/// 最小 HTML 转义：snippet 会被前端 dangerouslySetInnerHTML 渲染。
fn escape_html(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(c),
        }
    }
    out
}

// ========== 搜索测试 ==========
//
// 覆盖：逐次命中（非章节聚合）、真实总次数、分页切片、UTF-8 切片安全、
// snippet HTML 转义、定位锚字段。

#[cfg(test)]
mod search_tests {
    use super::*;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use std::str::FromStr;
    use tempfile::TempDir;

    /// 临时 storage 目录 + 跑过 migration 的 in-memory SQLite。
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

    async fn insert_book(svc: &BookService, book_id: &str) {
        sqlx::query(
            "INSERT INTO books (id, title, authors, language, identifier, file_path, file_size, file_sha256, created_at) \
             VALUES (?, '测试书', '[]', 'zh', ?, ?, 0, 'deadbeef', ?)",
        )
        .bind(book_id)
        .bind(book_id)
        .bind(format!("{book_id}.epb"))
        .bind(chrono::Utc::now().naive_utc())
        .execute(&svc.pool)
        .await
        .expect("insert book");
    }

    async fn insert_chapter(
        svc: &BookService,
        book_id: &str,
        chapter_id: &str,
        title: &str,
        order: i64,
        text: &str,
    ) {
        sqlx::query(
            "INSERT INTO chapters (id, book_id, title, spine_order, href, text, word_count) \
             VALUES (?, ?, ?, ?, 'OEBPS/ch.xhtml', ?, 0)",
        )
        .bind(chapter_id)
        .bind(book_id)
        .bind(title)
        .bind(order)
        .bind(text)
        .execute(&svc.pool)
        .await
        .expect("insert chapter");
    }

    /// 按章节分组:一章 3 次 → 1 个章节分组,组内 3 条命中。
    #[tokio::test]
    async fn groups_hits_by_chapter() {
        let (svc, _tmp) = setup().await;
        insert_book(&svc, "b1").await;
        insert_chapter(
            &svc,
            "b1",
            "c1",
            "第一章",
            0,
            "殷萱儿来了。殷萱儿走了。殷萱儿又来了。",
        )
        .await;

        let (items, total, chapters) = svc.search_in_book("b1", "殷萱儿", 1, 20).await.unwrap();
        assert_eq!(total, 3, "3 次出现应报 3");
        assert_eq!(chapters, 1);
        assert_eq!(items.len(), 1, "同一章只占一个分组");
        let group = &items[0];
        assert_eq!(group.chapter_title, "第一章");
        assert_eq!(group.match_count, 3);
        assert_eq!(group.hits.len(), 3);
        assert_eq!(
            group.hits.iter().map(|h| h.index_in_chapter).collect::<Vec<_>>(),
            vec![1, 2, 3]
        );
        assert_eq!(group.hits[0].char_offset, 0);
        assert_eq!(group.hits[1].char_offset, 6); // 殷萱儿来了。= 6 字
        assert!(group.hits[2].char_offset > group.hits[1].char_offset);
        assert!(group.hits.iter().all(|h| h.snippet.contains("<mark>殷萱儿</mark>")));
        assert_eq!(group.hits[0].matched, "殷萱儿");
        // before 是命中前上下文（供阅读器定位）
        assert_eq!(group.hits[1].before, "殷萱儿来了。");
    }

    /// 分页单位是章节:每页 1 章时,第 1 页给 c1(2 条),第 2 页给 c2(1 条)。
    #[tokio::test]
    async fn paginates_by_chapter() {
        let (svc, _tmp) = setup().await;
        insert_book(&svc, "b2").await;
        insert_chapter(&svc, "b2", "c1", "第一章", 0, "甲甲殷萱儿乙乙殷萱儿").await;
        insert_chapter(&svc, "b2", "c2", "第二章", 1, "丙丙殷萱儿").await;

        let (items, total, chapters) = svc.search_in_book("b2", "殷萱儿", 1, 1).await.unwrap();
        assert_eq!(total, 3);
        assert_eq!(chapters, 2);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].chapter_id, "c1");
        assert_eq!(items[0].match_count, 2);
        assert_eq!(items[0].hits.len(), 2);

        let (items2, total2, _) = svc.search_in_book("b2", "殷萱儿", 2, 1).await.unwrap();
        assert_eq!(total2, 3);
        assert_eq!(items2.len(), 1);
        assert_eq!(items2[0].chapter_id, "c2");
        assert_eq!(items2[0].match_count, 1);
    }

    /// snippet 必须转义 HTML，否则前端 dangerouslySetInnerHTML 会解析成标签。
    #[tokio::test]
    async fn snippet_escapes_html() {
        let (svc, _tmp) = setup().await;
        insert_book(&svc, "b3").await;
        insert_chapter(&svc, "b3", "c1", "第一章", 0, "<b>殷萱儿</b> & \"引号\"").await;

        let (items, _, _) = svc.search_in_book("b3", "殷萱儿", 1, 10).await.unwrap();
        assert_eq!(items.len(), 1);
        let snippet = &items[0].hits[0].snippet;
        assert!(
            snippet.contains("&lt;b&gt;<mark>殷萱儿</mark>&lt;/b&gt;"),
            "HTML 应被转义：{snippet}"
        );
        assert!(snippet.contains("&amp;"));
    }

    /// 2 字中文（LIKE 路径）：不 panic，逐次命中，通配符被转义。
    #[tokio::test]
    async fn like_path_handles_2char_and_wildcards() {
        let (svc, _tmp) = setup().await;
        insert_book(&svc, "b4").await;
        insert_chapter(&svc, "b4", "c1", "第一章", 0, "开端之后又是开端。").await;
        insert_chapter(&svc, "b4", "c2", "第二章", 1, "100% 的把握").await;

        let (items, total, chapters) = svc.search_in_book("b4", "开端", 1, 10).await.unwrap();
        assert_eq!(total, 2);
        assert_eq!(chapters, 1);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].match_count, 2);
        assert_eq!(items[0].hits.len(), 2);

        // '%' 作为普通字符，不应匹配全书
        let (items_pct, total_pct, _) = svc.search_in_book("b4", "0%", 1, 10).await.unwrap();
        assert_eq!(total_pct, 1, "'0%' 应只命中第二章那一处");
        assert_eq!(items_pct.len(), 1);
        assert_eq!(items_pct[0].chapter_id, "c2");
    }

    /// 命中位置距章节开头不足上下文长度：UTF-8 切片安全（修复前 panic）。
    #[tokio::test]
    async fn snippet_slicing_is_utf8_safe() {
        let (svc, _tmp) = setup().await;
        insert_book(&svc, "b5").await;
        let text = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa他突然觉得这一幕也许会成为某种改变的开端。\
                    他抬头看向远方，期待接下来会发生什么。";
        insert_chapter(&svc, "b5", "c1", "第一章", 0, text).await;

        let (items, total, _) = svc.search_in_book("b5", "开端", 1, 10).await.unwrap();
        assert_eq!(total, 1);
        let snippet = &items[0].hits[0].snippet;
        assert!(snippet.contains("<mark>开端</mark>"));
        assert!(snippet.starts_with('…'), "截断时应带前省略号");
    }

    /// 空查询 / 无命中：返回空结果而不是报错。
    #[tokio::test]
    async fn empty_query_and_no_match() {
        let (svc, _tmp) = setup().await;
        insert_book(&svc, "b6").await;
        insert_chapter(&svc, "b6", "c1", "第一章", 0, "无关内容").await;

        let (items, total, chapters) = svc.search_in_book("b6", "  ", 1, 10).await.unwrap();
        assert!(items.is_empty());
        assert_eq!(total, 0);
        assert_eq!(chapters, 0);

        let (items, total, _) = svc.search_in_book("b6", "不存在", 1, 10).await.unwrap();
        assert!(items.is_empty());
        assert_eq!(total, 0);
    }
}
