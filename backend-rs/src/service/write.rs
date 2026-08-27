// 写路径：上传 / 更新 / 重排 / 删除。

use chrono::{NaiveDate, Utc};
use uuid::Uuid;

use crate::api::schema::{BookUpdate, ChapterUpdate};
use crate::db::{Book, Chapter};
use crate::epub::{self, EpubError, SourceFormat};
use crate::storage;

use super::BookService;

impl BookService {
    // ---------- 上传 ----------

    /// 上传书籍：解析 + 去重 + 写文件 + 入库。
    /// `format` 决定解析器（EPUB / TXT）与落盘文件后缀。
    /// 上传书籍：解析 + 去重 + 写文件 + 入库。
    /// `format` 决定解析器（EPUB / TXT）与落盘文件后缀。
    ///
    /// `on_progress` 在解析章节、写章节、写资源三个阶段被回调：
    ///   - "parsing": (current, total, "parsing") — parse_epub / parse_txt 内部触发
    ///   - "writing_chapters": (current, total, "writing_chapters") — 每章写完回调一次
    ///   - "writing_assets": (current, total, "writing_assets") — 每资源写完回调一次
    pub async fn add_book<F>(
        &self,
        bytes: Vec<u8>,
        filename: &str,
        format: SourceFormat,
        on_progress: F,
    ) -> Result<Book, EpubError>
    where
        F: Fn(usize, usize, &str) + Clone + Send + 'static,
    {
        // 1. SHA-256 去重（用引用，不 move bytes）
        let sha = storage::compute_sha256(&bytes);
        if let Some(existing_id) = self.find_by_sha(&sha).await? {
            return Err(EpubError::DuplicateFile {
                existing_book_id: existing_id,
            });
        }

        // 2. 生成 ID + 先写文件（用引用，不 move bytes）
        //    落盘后缀按 format 决定（EPUB → .epb，TXT → .txt）
        let book_id = Uuid::new_v4().simple().to_string();
        let file_path = format!("{book_id}.{}", format.storage_extension());
        let file_size = bytes.len() as i64;
        let created_at = Utc::now().naive_utc();

        let target = self.storage_dir.join(&file_path);
        storage::atomic_write(&target, &bytes)
            .map_err(|e| EpubError::FileSystem(format!("写文件失败：{e}")))?;

        // 3. 按 format 分发到对应解析器（CPU 密集，放 spawn_blocking，move bytes）
        let parse_filename = filename.to_string();
        let on_progress_for_parse = on_progress.clone();
        let parsed = match tokio::task::spawn_blocking(move || match format {
            SourceFormat::Epub => epub::parse_epub(bytes, on_progress_for_parse),
            SourceFormat::Txt => epub::parse_txt(bytes, &parse_filename, on_progress_for_parse),
        })
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

        // 批量插入章节：先写 html 到 storage 文件，DB 不存 html 列
        let chapter_total = parsed.chapters.len();
        for (i, ch) in parsed.chapters.iter().enumerate() {
            // 1. 写文件失败 → 立即中止，清理书文件 + 章节目录
            if let Err(e) = self.write_chapter_html(&book_id, &ch.id, &ch.html) {
                let _ = tx.rollback().await;
                let _ = std::fs::remove_file(&target);
                self.delete_chapter_html_dir(&book_id);
                return Err(e);
            }

            // 2. INSERT：html 真值在文件里，DB 不再存该列
            let r = sqlx::query(
                "INSERT INTO chapters (id, book_id, title, spine_order, href, text, word_count) \
                 VALUES (?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(&ch.id)
            .bind(&book_id)
            .bind(&ch.title)
            .bind(ch.order)
            .bind(&ch.href)
            .bind(&ch.text)
            .bind(ch.word_count)
            .execute(&mut *tx)
            .await;
            if let Err(e) = r {
                let _ = tx.rollback().await;
                let _ = std::fs::remove_file(&target);
                // 已写的章节文件全部清掉（DB 没有任何 chapter 行，孤儿文件无意义）
                self.delete_chapter_html_dir(&book_id);
                return Err(EpubError::FileSystem(format!("INSERT chapter 失败：{e}")));
            }
            // 进度回调
            on_progress(i + 1, chapter_total, "writing_chapters");
        }

        // 批量插入资源
        let asset_total = parsed.assets.len();

        // COS 启用时：每条 asset 先从 zip 读字节并上传到云，再 INSERT DB。
        // 单本上传过程中 COS 失败 → 整书回滚（DB tx rollback + 删 .epb + 删章节目录）。
        // 已上传的 COS 对象暂不主动清理（add_book 失败通常因 SHA 命中/重复，下次重试
        // 会走 DuplicateFile 分支，不会再传；不同内容同 id 的极端边界情况会留下几个对象，
        // 代价很小；后续可加 prefix 清理 task）。
        let zip_for_assets: Option<std::sync::Arc<std::sync::Mutex<Option<zip::ZipArchive<std::fs::File>>>>> =
            if self.cos.is_some() {
                Some(std::sync::Arc::new(std::sync::Mutex::new(None)))
            } else {
                None
            };
        if let Some(slot) = &zip_for_assets {
            let epb_path = target.clone();
            match std::fs::File::open(&epb_path) {
                Ok(file) => match zip::ZipArchive::new(file) {
                    Ok(archive) => {
                        *slot.lock().unwrap() = Some(archive);
                    }
                    Err(e) => {
                        let _ = tx.rollback().await;
                        let _ = std::fs::remove_file(&target);
                        return Err(EpubError::Corrupt(format!("打开 .epb zip 失败:{e}")));
                    }
                },
                Err(e) => {
                    let _ = tx.rollback().await;
                    return Err(EpubError::FileSystem(format!("打开 .epb 失败:{e}")));
                }
            }
        }

        for (i, a) in parsed.assets.iter().enumerate() {
            // COS 上传
            if let (Some(cos), Some(slot)) = (&self.cos, &zip_for_assets) {
                let key = cos.make_key(&book_id, &a.id);
                let bytes_result: Result<Vec<u8>, EpubError> = (|| {
                    let mut guard = slot.lock().unwrap();
                    let archive = guard.as_mut().ok_or_else(|| {
                        EpubError::FileSystem("COS 启用但 zip 未打开".to_string())
                    })?;
                    let mut zf = archive.by_name(&a.href).map_err(|e| {
                        EpubError::FileSystem(format!("zip 内找不到 {href}:{e}", href = a.href))
                    })?;
                    let mut buf = Vec::new();
                    std::io::Read::read_to_end(&mut zf, &mut buf)
                        .map_err(|e| EpubError::FileSystem(format!("读 zip 失败:{e}")))?;
                    Ok(buf)
                })();
                let bytes = bytes_result?;
                cos.put_object(&key, bytes, &a.media_type)
                    .await
                    .map_err(|e| {
                        EpubError::FileSystem(format!("COS 上传 {key} 失败:{e}"))
                    })?;
            }

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
            on_progress(i + 1, asset_total, "writing_assets");
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

    /// 删除书（DB 级联 + 文件 + COS prefix）
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
        let _ = storage::delete_file(&self.book_file_path(&book));

        // 删除上传的封面（covers/ 目录）
        let _ = self.delete_uploaded_covers(book_id).await;

        // 删除章节 html 文件（chapters/{book_id}/ 目录）
        self.delete_chapter_html_dir(book_id);

        // COS：清掉 books/{book_id}/ 整个 prefix
        if let Some(cos) = &self.cos {
            if let Err(e) = cos.delete_book_assets(book_id).await {
                tracing::warn!(
                    "delete COS prefix for book {book_id} failed: {e} \
                     (DB/file 已清理，云端残留待手动处理)"
                );
            }
        }

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

        // html 变了 → 先写文件（失败立即返回，不碰 DB）
        if let Some(html) = &data.html {
            self.write_chapter_html(book_id, chapter_id, html)?;
        }

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
        // html 列已 DROP，真值在 storage 文件里。
        // 用户已确认：极少数情况下文件写成功但 DB UPDATE 失败，会出现"文件比 DB 新一点"的窗口。
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
}
