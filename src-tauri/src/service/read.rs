// 读取路径：书籍 / 章节 / 资源 / 列表查询。

use sqlx::query_as;

use crate::core_db::{Asset, Book, Chapter};
use crate::epub::EpubError;

use super::BookService;

impl BookService {
    /// 读单本书 ORM
    pub async fn get_book_orm(&self, book_id: &str) -> Result<Option<Book>, EpubError> {
        let book = query_as::<_, Book>(
            "SELECT id, title, authors, language, publisher, description, pub_date, \
             identifier, file_path, file_size, file_sha256, created_at, category, tags, aliases \
             FROM books WHERE id = ?",
        )
        .bind(book_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| EpubError::FileSystem(format!("查询书失败：{e}")))?;
        Ok(book)
    }

    /// 读单本书的章节。html 真值在 storage 文件里，调用方按需单独调
    /// service.read_chapter_html(book_id, chapter_id) 拿。
    pub async fn get_chapters(&self, book_id: &str) -> Result<Vec<Chapter>, EpubError> {
        let chapters = query_as::<_, Chapter>(
            "SELECT id, book_id, title, spine_order, href, text, word_count \
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

    /// 读单章节（不含 html）。html 真值在 storage 文件里，调用方单独读。
    pub async fn get_chapter(&self, book_id: &str, chapter_id: &str) -> Result<Option<Chapter>, EpubError> {
        let ch = query_as::<_, Chapter>(
            "SELECT id, book_id, title, spine_order, href, text, word_count \
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
                 identifier, file_path, file_size, file_sha256, created_at, category, tags, aliases \
                 FROM books ORDER BY created_at DESC LIMIT ? OFFSET ?",
            )
            .bind(size)
            .bind(offset)
            .fetch_all(&self.pool)
            .await
            .map_err(|e| EpubError::FileSystem(format!("查询失败：{e}")))?;
            (books, total)
        } else {
            // LIKE 通配符转义(% _ \),与 service/search.rs 的兜底路径同一套规则
            let escaped = q
                .trim()
                .replace('\\', "\\\\")
                .replace('%', "\\%")
                .replace('_', "\\_");
            let pattern = format!("%{escaped}%");
            // 一体化搜索:书名/作者/分类/标签/别名五列任一命中。
            // tags/aliases 是 JSON 文本,中文按原文存储,LIKE 直接子串命中。
            // 注意这是行为变更——此前只搜书名(设计文档已确认)。
            let where_clause = "title LIKE ? ESCAPE '\\' OR authors LIKE ? ESCAPE '\\' \
                 OR category LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\' \
                 OR aliases LIKE ? ESCAPE '\\'";
            let total: i64 = sqlx::query_scalar(&format!(
                "SELECT COUNT(*) FROM books WHERE {where_clause}"
            ))
            .bind(&pattern)
            .bind(&pattern)
            .bind(&pattern)
            .bind(&pattern)
            .bind(&pattern)
            .fetch_one(&self.pool)
            .await
            .map_err(|e| EpubError::FileSystem(format!("COUNT 失败：{e}")))?;
            let books = query_as::<_, Book>(&format!(
                "SELECT id, title, authors, language, publisher, description, pub_date, \
                 identifier, file_path, file_size, file_sha256, created_at, category, tags, aliases \
                 FROM books WHERE {where_clause} ORDER BY created_at DESC LIMIT ? OFFSET ?"
            ))
            .bind(&pattern)
            .bind(&pattern)
            .bind(&pattern)
            .bind(&pattern)
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

    /// 批量查询多本书的章节数 / 资源数 / 封面 id / 总字数(避免 N+1)。
    /// 返回:(章节数, 资源数, 封面 asset_id, 总字数),key 均为 book_id。
    pub async fn batch_counts(
        &self,
        ids: &[String],
    ) -> Result<
        (
            std::collections::HashMap<String, i64>,
            std::collections::HashMap<String, i64>,
            std::collections::HashMap<String, String>,
            std::collections::HashMap<String, i64>,
        ),
        EpubError,
    > {
        use std::collections::HashMap;

        if ids.is_empty() {
            return Ok((
                HashMap::new(),
                HashMap::new(),
                HashMap::new(),
                HashMap::new(),
            ));
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
            .fetch_all(&self.pool)
            .await
            .map_err(|e| EpubError::FileSystem(format!("查询失败:{e}")))?;
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
            .fetch_all(&self.pool)
            .await
            .map_err(|e| EpubError::FileSystem(format!("查询失败:{e}")))?;
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
            .fetch_all(&self.pool)
            .await
            .map_err(|e| EpubError::FileSystem(format!("查询失败:{e}")))?;
        let cov: HashMap<String, String> = rows.into_iter().collect();

        // word counts（chapters.word_count 求和）
        let sql = format!(
            "SELECT book_id, SUM(word_count) FROM chapters WHERE book_id IN ({placeholders}) GROUP BY book_id"
        );
        let mut q = sqlx::query_as::<_, (String, i64)>(&sql);
        for id in ids {
            q = q.bind(id);
        }
        let rows = q
            .fetch_all(&self.pool)
            .await
            .map_err(|e| EpubError::FileSystem(format!("查询失败:{e}")))?;
        let wc: HashMap<String, i64> = rows.into_iter().collect();

        Ok((ch, as_, cov, wc))
    }

    /// ORM Book(+ chapters + assets)→ 前端 BookDetail
    pub fn book_to_detail(
        &self,
        book: &Book,
        chapters: &[Chapter],
        assets: &[Asset],
    ) -> crate::schema::BookDetail {
        use crate::schema::{AssetOut, BookDetail, ChapterOut};

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
            category: book.category.clone(),
            tags: book.tags.clone(),
            aliases: book.aliases.clone(),
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

    /// 读取某本书的完整 detail(含 chapters/assets)。书不存在返回 None。
    pub async fn fetch_book_detail(
        &self,
        book_id: &str,
    ) -> Result<Option<crate::schema::BookDetail>, EpubError> {
        let book = self.get_book_orm(book_id).await?;
        let Some(book) = book else {
            return Ok(None);
        };
        let chapters = self.get_chapters(book_id).await?;
        let assets = self.get_assets(book_id).await?;
        Ok(Some(self.book_to_detail(&book, &chapters, &assets)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use std::str::FromStr;
    use tempfile::TempDir;

    async fn setup() -> (BookService, TempDir) {
        let tmp = tempfile::tempdir().expect("tempdir");
        let opts = SqliteConnectOptions::from_str(":memory:")
            .expect("sqlite opts")
            .foreign_keys(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(opts)
            .await
            .expect("connect");
        sqlx::migrate!("./migrations").run(&pool).await.expect("migrate");
        (BookService::new(pool, tmp.path().to_path_buf()), tmp)
    }

    /// 直插一行书(带元数据),绕开解析链路。meta 形如 "小说|[\"推理\"]|[\"旧称\"]"
    /// → category|tags|aliases;分类传空串表示 NULL。
    async fn seed_book(svc: &BookService, id: &str, title: &str, authors: &str, meta: &str) {
        let (cat, tags, aliases) = {
            let mut it = meta.splitn(3, '|');
            (it.next().unwrap_or(""), it.next().unwrap_or("[]"), it.next().unwrap_or("[]"))
        };
        let cat = if cat.is_empty() { "NULL".to_string() } else { format!("'{cat}'") };
        sqlx::query(&format!(
            "INSERT INTO books (id, title, authors, language, identifier, file_path, \
             file_size, file_sha256, created_at, category, tags, aliases) \
             VALUES ('{id}', '{title}', '{authors}', 'zh', '{id}', '{id}.epb', 10, 'sha-{id}', \
             '2024-01-01 00:00:00', {cat}, '{tags}', '{aliases}')"
        ))
        .execute(&svc.pool)
        .await
        .expect("seed");
    }

    /// 一体化搜索:五列(书名/作者/分类/标签/别名)任一命中即返回。
    /// 注意「作者」也是行为变更——此前连作者都不搜,只搜书名。
    #[tokio::test]
    async fn search_matches_all_five_columns() {
        let (svc, _t) = setup().await;
        seed_book(&svc, "b1", "白夜行", "[\"东野圭吾\"]", "小说|[\"推理\"]|[\"Byakoya\"]").await;
        seed_book(&svc, "b2", "无关书", "[\"某人\"]", "|[]|[]").await;

        for q in ["白夜行", "东野圭吾", "小说", "推理", "Byakoya"] {
            let (books, total) = svc.list_books(q, 1, 20).await.expect("search");
            assert_eq!(total, 1, "查询 {q} 应恰好命中 b1");
            assert_eq!(books[0].id, "b1", "查询 {q}");
        }
        // 五列都不含 → 不命中
        let (_, total) = svc.list_books("不存在的词", 1, 20).await.expect("miss");
        assert_eq!(total, 0);
    }

    /// LIKE 通配符必须转义:输入 % 或 _ 不会变成「匹配任意」。
    #[tokio::test]
    async fn search_escapes_like_wildcards() {
        let (svc, _t) = setup().await;
        seed_book(&svc, "b1", "100%满意", "[\"甲\"]", "|[]|[]").await;
        seed_book(&svc, "b2", "普通书", "[\"乙\"]", "|[]|[]").await;

        // 输入 % 只命中字面含 % 的书,不会匹配全部
        let (books, total) = svc.list_books("%", 1, 20).await.expect("wildcard");
        assert_eq!(total, 1);
        assert_eq!(books[0].id, "b1");
        // 输入 _ 同理(不会当成单字符通配)
        let (_, total) = svc.list_books("____", 1, 20).await.expect("underscore");
        assert_eq!(total, 0, "没有书名含字面下划线");
    }
}
