// BookService：业务层，粘合 EPUB 解析 / DB / 文件系统。
// 对应 Python services/book_service.py 的核心方法。
//
// 搜索 / 编辑 / 导出 / 封面管理 在后续 Phase 补充。

use std::path::{Path, PathBuf};

use chrono::{NaiveDate, Utc};
use regex::Regex;
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::api::schema::{BookUpdate, ChapterUpdate};
use crate::db::{Asset, Book, Chapter};
use crate::epub::{self, EpubError};
use crate::storage;

pub struct BookService {
    pub pool: SqlitePool,
    pub storage_dir: PathBuf,
}

impl BookService {
    pub fn new(pool: SqlitePool, storage_dir: PathBuf) -> Self {
        Self { pool, storage_dir }
    }

    /// 书文件路径
    fn book_file_path(&self, book_id: &str) -> PathBuf {
        self.storage_dir.join(format!("{book_id}.epb"))
    }

    // ---------- 上传 ----------

    /// 上传 EPUB：解析 + 去重 + 写文件 + 入库
    pub async fn add_book(&self, bytes: Vec<u8>, _filename: &str) -> Result<Book, EpubError> {
        // 1. SHA-256 去重（用引用，不 move bytes）
        let sha = storage::compute_sha256(&bytes);
        if let Some(existing_id) = self.find_by_sha(&sha).await? {
            return Err(EpubError::DuplicateFile {
                existing_book_id: existing_id,
            });
        }

        // 2. 生成 ID + 先写文件（用引用，不 move bytes）
        let book_id = Uuid::new_v4().simple().to_string();
        let file_path = format!("{book_id}.epb");
        let file_size = bytes.len() as i64;
        let created_at = Utc::now().naive_utc();

        let target = self.book_file_path(&book_id);
        storage::atomic_write(&target, &bytes)
            .map_err(|e| EpubError::FileSystem(format!("写文件失败：{e}")))?;

        // 3. 解析 EPUB（CPU 密集，放 spawn_blocking，move bytes）
        let parsed = match tokio::task::spawn_blocking(move || epub::parse_epub(bytes))
            .await
        {
            Ok(Ok(p)) => p,
            Ok(Err(e)) => {
                let _ = std::fs::remove_file(&target);
                return Err(e);
            }
            Err(e) => {
                let _ = std::fs::remove_file(&target);
                return Err(EpubError::FileSystem(format!("解析任务失败：{e}")));
            }
        };

        // 5. DB 写入（事务）
        let mut tx = self
            .pool
            .begin()
            .await
            .map_err(|e| EpubError::FileSystem(format!("开启事务失败：{e}")))?;

        let authors_json =
            serde_json::to_string(&parsed.authors).unwrap_or_else(|_| "[]".to_string());

        let result = sqlx::query(
            "INSERT INTO books (id, title, authors, language, publisher, description, \
             pub_date, identifier, file_path, file_size, file_sha256, created_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&book_id)
        .bind(&parsed.title)
        .bind(&authors_json)
        .bind(&parsed.language)
        .bind(&parsed.publisher)
        .bind(&parsed.description)
        .bind(&parsed.pub_date)
        .bind(&parsed.identifier)
        .bind(&file_path)
        .bind(file_size)
        .bind(&sha)
        .bind(created_at)
        .execute(&mut *tx)
        .await;

        if let Err(e) = result {
            let _ = tx.rollback().await;
            // 清理已写的文件
            let _ = std::fs::remove_file(&target);
            return Err(EpubError::FileSystem(format!("INSERT book 失败：{e}")));
        }

        // 批量插入章节
        for ch in &parsed.chapters {
            let r = sqlx::query(
                "INSERT INTO chapters (id, book_id, title, spine_order, href, text, html, word_count) \
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(&ch.id)
            .bind(&book_id)
            .bind(&ch.title)
            .bind(ch.order)
            .bind(&ch.href)
            .bind(&ch.text)
            .bind(&ch.html)
            .bind(ch.word_count)
            .execute(&mut *tx)
            .await;
            if let Err(e) = r {
                let _ = tx.rollback().await;
                let _ = std::fs::remove_file(&target);
                return Err(EpubError::FileSystem(format!("INSERT chapter 失败：{e}")));
            }
        }

        // 批量插入资源
        for a in &parsed.assets {
            let is_cover: i64 = if a.is_cover { 1 } else { 0 };
            let r = sqlx::query(
                "INSERT INTO assets (id, book_id, href, media_type, size, is_cover) \
                 VALUES (?, ?, ?, ?, ?, ?)",
            )
            .bind(&a.id)
            .bind(&book_id)
            .bind(&a.href)
            .bind(&a.media_type)
            .bind(a.size as i64)
            .bind(is_cover)
            .execute(&mut *tx)
            .await;
            if let Err(e) = r {
                let _ = tx.rollback().await;
                let _ = std::fs::remove_file(&target);
                return Err(EpubError::FileSystem(format!("INSERT asset 失败：{e}")));
            }
        }

        tx.commit()
            .await
            .map_err(|e| EpubError::FileSystem(format!("提交事务失败：{e}")))?;

        // 读回完整 Book 返回
        self.get_book_orm(&book_id)
            .await?
            .ok_or_else(|| EpubError::FileSystem("刚写入的书读不回来".to_string()))
    }

    /// 按 SHA-256 查重
    async fn find_by_sha(&self, sha: &str) -> Result<Option<String>, EpubError> {
        let row: Option<(String,)> = sqlx::query_as("SELECT id FROM books WHERE file_sha256 = ?")
            .bind(sha)
            .fetch_optional(&self.pool)
            .await
            .map_err(|e| EpubError::FileSystem(format!("查重失败：{e}")))?;
        Ok(row.map(|r| r.0))
    }

    // ---------- 读取 ----------

    /// 读单本书 ORM
    pub async fn get_book_orm(&self, book_id: &str) -> Result<Option<Book>, EpubError> {
        let book = sqlx::query_as::<_, Book>(
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
        let chapters = sqlx::query_as::<_, Chapter>(
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
        let assets = sqlx::query_as::<_, Asset>(
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
        let ch = sqlx::query_as::<_, Chapter>(
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
            let books = sqlx::query_as::<_, Book>(
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
            let books = sqlx::query_as::<_, Book>(
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

    /// 删除书（DB 级联 + 文件）
    pub async fn delete_book(&self, book_id: &str) -> Result<bool, EpubError> {
        let book = self.get_book_orm(book_id).await?;
        let Some(book) = book else {
            return Ok(false);
        };

        // DB 删除（FK CASCADE 自动删 chapters/assets）
        let result = sqlx::query("DELETE FROM books WHERE id = ?")
            .bind(book_id)
            .execute(&self.pool)
            .await
            .map_err(|e| EpubError::FileSystem(format!("删除失败：{e}")))?;

        if result.rows_affected() == 0 {
            return Ok(false);
        }

        // 删除文件
        let _ = storage::delete_file(&self.book_file_path(book_id));

        // 删除上传的封面（covers/ 目录）
        let _ = self.delete_uploaded_covers(book_id).await;

        Ok(true)
    }

    /// 删除这本书所有上传的封面文件
    async fn delete_uploaded_covers(&self, book_id: &str) -> Result<(), EpubError> {
        let assets = self.get_assets(book_id).await?;
        for a in assets {
            if a.href.starts_with("cover:") {
                let cover_path = self.storage_dir.join("covers").join(&a.id);
                let _ = std::fs::remove_file(&cover_path);
            }
        }
        Ok(())
    }

    /// 读取资源字节（封面从磁盘读，其他从 .epb zip 读）
    pub fn read_asset_bytes(&self, asset: &Asset, book: &Book) -> Result<Vec<u8>, EpubError> {
        if asset.href.starts_with("cover:") {
            // 上传的封面：从 covers/{id} 读
            let path = self.storage_dir.join("covers").join(&asset.id);
            std::fs::read(&path).map_err(|e| EpubError::FileSystem(format!("读封面失败：{e}")))
        } else {
            // EPUB 自带资源：从 .epb zip 读
            let epb_path = self
                .storage_dir
                .join(Path::new(&book.file_path).file_name().unwrap_or_default());
            let file = std::fs::File::open(&epb_path)
                .map_err(|e| EpubError::FileSystem(format!("打开 EPUB 失败：{e}")))?;
            let mut archive = zip::ZipArchive::new(file)
                .map_err(|e| EpubError::Corrupt(format!("打开 ZIP 失败：{e}")))?;
            let mut zf = archive
                .by_name(&asset.href)
                .map_err(|e| EpubError::FileSystem(format!("ZIP 内找不到 {e}")))?;
            let mut buf = Vec::new();
            std::io::Read::read_to_end(&mut zf, &mut buf)
                .map_err(|e| EpubError::FileSystem(format!("读取失败：{e}")))?;
            Ok(buf)
        }
    }

    // ---------- 编辑 ----------

    /// 部分更新书籍元数据。书不存在返回 None。
    /// pub_date 字符串会转成 NaiveDate。
    pub async fn update_book(
        &self,
        book_id: &str,
        data: &BookUpdate,
    ) -> Result<Option<Book>, EpubError> {
        let book = match self.get_book_orm(book_id).await? {
            Some(b) => b,
            None => return Ok(None),
        };

        // pub_date 字符串转 NaiveDate（失败则忽略该字段）
        let pub_date_parsed: Option<NaiveDate> = match &data.pub_date {
            Some(s) => NaiveDate::parse_from_str(s, "%Y-%m-%d").ok(),
            None => None,
        };

        let mut updates: Vec<(&str, String)> = Vec::new();

        if let Some(v) = &data.title {
            updates.push(("title", v.clone()));
        }
        if let Some(v) = &data.authors {
            updates.push(("authors", serde_json::to_string(v).unwrap_or_else(|_| "[]".to_string())));
        }
        if let Some(v) = &data.language {
            updates.push(("language", v.clone()));
        }
        if let Some(v) = &data.publisher {
            updates.push(("publisher", v.clone()));
        }
        if let Some(v) = &data.description {
            updates.push(("description", v.clone()));
        }
        if let Some(v) = pub_date_parsed {
            updates.push(("pub_date", v.to_string()));
        }
        if let Some(v) = &data.identifier {
            updates.push(("identifier", v.clone()));
        }

        if updates.is_empty() {
            return Ok(Some(book));
        }

        let set_clause = updates
            .iter()
            .map(|(col, _)| format!("{col} = ?"))
            .collect::<Vec<_>>()
            .join(", ");
        let sql = format!("UPDATE books SET {set_clause} WHERE id = ?");

        let mut q = sqlx::query(&sql);
        for (_, val) in &updates {
            q = q.bind(val);
        }
        q = q.bind(book_id);

        q.execute(&self.pool)
            .await
            .map_err(|e| EpubError::FileSystem(format!("UPDATE book 失败：{e}")))?;

        self.get_book_orm(book_id).await
    }

    /// 更新章节标题和/或正文。html 变了用 parse_chapter 重算 text + word_count。
    /// 章节不存在返回 None。
    pub async fn update_chapter(
        &self,
        book_id: &str,
        chapter_id: &str,
        data: &ChapterUpdate,
    ) -> Result<Option<Chapter>, EpubError> {
        let chapter = match self.get_chapter(book_id, chapter_id).await? {
            Some(c) => c,
            None => return Ok(None),
        };

        // 先算 html 变化时的派生字段
        let (new_text, new_word_count) = if let Some(html) = &data.html {
            let (text, _html, word_count) = epub::chapter::parse_chapter(html.as_bytes());
            (Some(text), Some(word_count))
        } else {
            (None, None)
        };

        let mut updates: Vec<(&str, String)> = Vec::new();
        if let Some(v) = &data.title {
            updates.push(("title", v.clone()));
        }
        if let Some(v) = &data.html {
            updates.push(("html", v.clone()));
        }
        if let Some(v) = &new_text {
            updates.push(("text", v.clone()));
        }
        if let Some(v) = new_word_count {
            updates.push(("word_count", v.to_string()));
        }

        if !updates.is_empty() {
            let set_clause = updates
                .iter()
                .map(|(col, _)| format!("{col} = ?"))
                .collect::<Vec<_>>()
                .join(", ");
            let sql = format!(
                "UPDATE chapters SET {set_clause} WHERE book_id = ? AND id = ?"
            );

            let mut q = sqlx::query(&sql);
            for (_, val) in &updates {
                q = q.bind(val);
            }
            q = q.bind(book_id).bind(chapter_id);

            q.execute(&self.pool)
                .await
                .map_err(|e| EpubError::FileSystem(format!("UPDATE chapter 失败：{e}")))?;
        }

        let _ = chapter; // chapter 已用做存在性校验
        self.get_chapter(book_id, chapter_id).await
    }

    /// 按给定 chapter id 列表重排。列表索引即新的 spine_order。
    /// 未列出的章节追加到末尾（保持原相对顺序）。书不存在返回 false。
    pub async fn reorder_chapters(
        &self,
        book_id: &str,
        chapter_ids: &[String],
    ) -> Result<bool, EpubError> {
        // 书不存在直接返回 false（与 Python 行为一致）
        if self.get_book_orm(book_id).await?.is_none() {
            return Ok(false);
        }

        let chapters = self.get_chapters(book_id).await?;

        // 按新顺序分配 spine_order；去重防止同一 id 出现多次
        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
        let mut ordered_ids: Vec<String> = Vec::new();
        for id in chapter_ids {
            if chapters.iter().any(|c| &c.id == id) && seen.insert(id.clone()) {
                ordered_ids.push(id.clone());
            }
        }

        // 不在列表中的章节追加到末尾，按原 spine_order 保持相对顺序
        let mut remaining: Vec<&Chapter> = chapters
            .iter()
            .filter(|c| !ordered_ids.contains(&c.id))
            .collect();
        remaining.sort_by_key(|c| c.spine_order);

        let mut tx = self
            .pool
            .begin()
            .await
            .map_err(|e| EpubError::FileSystem(format!("开启事务失败：{e}")))?;

        let mut order = 0i64;
        for id in &ordered_ids {
            let r = sqlx::query(
                "UPDATE chapters SET spine_order = ? WHERE book_id = ? AND id = ?",
            )
            .bind(order)
            .bind(book_id)
            .bind(id)
            .execute(&mut *tx)
            .await;
            if let Err(e) = r {
                let _ = tx.rollback().await;
                return Err(EpubError::FileSystem(format!("reorder 失败：{e}")));
            }
            order += 1;
        }
        for ch in remaining {
            let r = sqlx::query(
                "UPDATE chapters SET spine_order = ? WHERE book_id = ? AND id = ?",
            )
            .bind(order)
            .bind(book_id)
            .bind(&ch.id)
            .execute(&mut *tx)
            .await;
            if let Err(e) = r {
                let _ = tx.rollback().await;
                return Err(EpubError::FileSystem(format!("reorder 失败：{e}")));
            }
            order += 1;
        }

        tx.commit()
            .await
            .map_err(|e| EpubError::FileSystem(format!("提交事务失败：{e}")))?;

        Ok(true)
    }

    // ---------- 封面管理 ----------

    /// 为书籍设置上传封面：清旧封面标记 → 写 covers/{uuid} → 插入 Asset(is_cover=1)。
    /// 书不存在返回 None。
    pub async fn set_cover(
        &self,
        book_id: &str,
        image_bytes: &[u8],
        media_type: &str,
    ) -> Result<Option<Asset>, EpubError> {
        if self.get_book_orm(book_id).await?.is_none() {
            return Ok(None);
        }

        // 清理旧封面标记
        self.clear_existing_cover(book_id).await?;

        // 写新封面到磁盘 covers/{asset_id}
        let asset_id = Uuid::new_v4().simple().to_string();
        let covers_dir = self.storage_dir.join("covers");
        std::fs::create_dir_all(&covers_dir)
            .map_err(|e| EpubError::FileSystem(format!("创建 covers 目录失败：{e}")))?;
        let cover_path = covers_dir.join(&asset_id);
        storage::atomic_write(&cover_path, image_bytes)
            .map_err(|e| EpubError::FileSystem(format!("写封面失败：{e}")))?;

        // 插入 Asset 行
        let href = format!("cover:{asset_id}");
        let size = image_bytes.len() as i64;
        let r = sqlx::query(
            "INSERT INTO assets (id, book_id, href, media_type, size, is_cover) \
             VALUES (?, ?, ?, ?, ?, 1)",
        )
        .bind(&asset_id)
        .bind(book_id)
        .bind(&href)
        .bind(media_type)
        .bind(size)
        .execute(&self.pool)
        .await;

        if let Err(e) = r {
            // 回滚磁盘文件
            let _ = std::fs::remove_file(&cover_path);
            return Err(EpubError::FileSystem(format!("INSERT asset 失败：{e}")));
        }

        // 读回刚插入的 Asset
        let asset = sqlx::query_as::<_, Asset>(
            "SELECT id, book_id, href, media_type, size, is_cover \
             FROM assets WHERE book_id = ? AND id = ?",
        )
        .bind(book_id)
        .bind(&asset_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| EpubError::FileSystem(format!("读回封面失败：{e}")))?;

        Ok(asset)
    }

    /// 删除上传的封面（href 以 "cover:" 开头）。
    /// EPUB 自带封面只取消标记（is_cover=0）。无书或无上传封面返回 false。
    pub async fn delete_cover(&self, book_id: &str) -> Result<bool, EpubError> {
        if self.get_book_orm(book_id).await?.is_none() {
            return Ok(false);
        }

        // 查当前封面
        let cover: Option<Asset> = sqlx::query_as::<_, Asset>(
            "SELECT id, book_id, href, media_type, size, is_cover \
             FROM assets WHERE book_id = ? AND is_cover = 1",
        )
        .bind(book_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| EpubError::FileSystem(format!("查询封面失败：{e}")))?;

        let Some(cover) = cover else {
            return Ok(false);
        };

        if cover.href.starts_with("cover:") {
            // 上传的封面：删磁盘文件 + DB 行
            let cover_path = self.storage_dir.join("covers").join(&cover.id);
            let _ = std::fs::remove_file(&cover_path);
            sqlx::query("DELETE FROM assets WHERE book_id = ? AND id = ?")
                .bind(book_id)
                .bind(&cover.id)
                .execute(&self.pool)
                .await
                .map_err(|e| EpubError::FileSystem(format!("DELETE 封面失败：{e}")))?;
        } else {
            // EPUB 自带封面：只取消标记
            sqlx::query("UPDATE assets SET is_cover = 0 WHERE book_id = ? AND id = ?")
                .bind(book_id)
                .bind(&cover.id)
                .execute(&self.pool)
                .await
                .map_err(|e| EpubError::FileSystem(format!("取消封面标记失败：{e}")))?;
        }

        Ok(true)
    }

    /// 清除当前封面标记：上传封面删文件+行，EPUB 自带封面只置 0。
    async fn clear_existing_cover(&self, book_id: &str) -> Result<(), EpubError> {
        let cover: Option<Asset> = sqlx::query_as::<_, Asset>(
            "SELECT id, book_id, href, media_type, size, is_cover \
             FROM assets WHERE book_id = ? AND is_cover = 1",
        )
        .bind(book_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| EpubError::FileSystem(format!("查询旧封面失败：{e}")))?;

        let Some(cover) = cover else {
            return Ok(());
        };

        if cover.href.starts_with("cover:") {
            let cover_path = self.storage_dir.join("covers").join(&cover.id);
            let _ = std::fs::remove_file(&cover_path);
            sqlx::query("DELETE FROM assets WHERE book_id = ? AND id = ?")
                .bind(book_id)
                .bind(&cover.id)
                .execute(&self.pool)
                .await
                .map_err(|e| EpubError::FileSystem(format!("DELETE 旧封面失败：{e}")))?;
        } else {
            sqlx::query("UPDATE assets SET is_cover = 0 WHERE book_id = ? AND id = ?")
                .bind(book_id)
                .bind(&cover.id)
                .execute(&self.pool)
                .await
                .map_err(|e| EpubError::FileSystem(format!("取消旧封面标记失败：{e}")))?;
        }

        Ok(())
    }

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
        // rank 是 FTS5 内置排序值（越小越相关），-rank 取反使大小关系翻转
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
             ORDER BY rank \
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
            "SELECT id, book_id, title, spine_order, href, text, html, word_count \
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
            // 收集所有匹配的字节区间
            let matches: Vec<(usize, usize)> = re
                .find_iter(&ch.text)
                .map(|m| (m.start(), m.end()))
                .collect();
            let count = matches.len() as i64;
            if count == 0 {
                continue;
            }

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

    // ---------- 导出 ----------

    /// 导出 EPUB：读所有 asset 字节，调 epub_writer 重建 EPUB 3 字节
    pub fn export_epub(
        &self,
        book: &Book,
        chapters: Vec<Chapter>,
        assets: &[Asset],
    ) -> Result<Vec<u8>, EpubError> {
        let mut asset_bytes: std::collections::HashMap<String, Vec<u8>> =
            std::collections::HashMap::new();
        for a in assets {
            if let Ok(bytes) = self.read_asset_bytes(a, book) {
                asset_bytes.insert(a.id.clone(), bytes);
            }
        }
        Ok(crate::epub_writer::build_epub_bytes(
            book, chapters, assets, &asset_bytes,
        ))
    }
}
