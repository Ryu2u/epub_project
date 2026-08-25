// BookService：业务层，粘合 EPUB 解析 / DB / 文件系统。
// 对应 Python services/book_service.py 的核心方法。
//
// 模块划分：
// - mod.rs：struct 定义 + 构造 + 公共辅助（book_file_path / read_asset_bytes）
// - read.rs：读取路径（书 / 章节 / 资源 / 列表）
// - write.rs：写路径（上传 / 更新 / 重排 / 删除）
// - cover.rs：封面管理（设置 / 删除 / 清理）
// - search.rs：搜索（FTS5 + LIKE 兜底）
// - export.rs：导出 EPUB

use std::path::{Path, PathBuf};
use std::sync::Arc;

use sqlx::SqlitePool;

use crate::cos::CosClient;
use crate::db::{Asset, Book};
use crate::epub::EpubError;
use crate::storage;

mod cover;
mod export;
mod read;
mod search;
mod write;

pub struct BookService {
    /// SQLite 连接池
    pub pool: SqlitePool,
    /// 本地数据存储根目录（books / chapters / covers）
    pub storage_dir: PathBuf,
    /// COS 客户端（可选）。Some 时资源读写走云端；None 走本地存储。
    pub cos: Option<Arc<CosClient>>,
}

impl BookService {
    pub fn new(pool: SqlitePool, storage_dir: PathBuf) -> Self {
        Self {
            pool,
            storage_dir,
            cos: None,
        }
    }

    pub fn with_cos(mut self, cos: Arc<CosClient>) -> Self {
        self.cos = Some(cos);
        self
    }

    /// 书文件路径：从 Book.file_path 提取 basename（不含目录），
    /// 不再硬编码 .epb，以兼容 EPUB(.epb) 与 TXT(.txt) 两种来源。
    fn book_file_path(&self, book: &Book) -> PathBuf {
        self.storage_dir.join(
            Path::new(&book.file_path)
                .file_name()
                .unwrap_or_default(),
        )
    }

    // ---------- 章节 html 文件 IO（真值外置到 storage_dir/chapters/） ----------

    /// 章节 html 文件路径：storage_dir/chapters/{book_id}/{chapter_id}.html
    pub fn chapter_html_path(&self, book_id: &str, chapter_id: &str) -> PathBuf {
        storage::chapter_html_path(&self.storage_dir, book_id, chapter_id)
    }

    /// 原子写章节 html（自动创建父目录）。
    pub fn write_chapter_html(
        &self,
        book_id: &str,
        chapter_id: &str,
        html: &str,
    ) -> Result<(), EpubError> {
        storage::write_chapter_html(&self.storage_dir, book_id, chapter_id, html)
            .map_err(|e| EpubError::FileSystem(format!("写章节 html 失败：{e}")))
    }

    /// 读章节 html。文件不存在返回空串（优雅降级）。
    pub fn read_chapter_html(&self, book_id: &str, chapter_id: &str) -> String {
        storage::read_chapter_html(&self.storage_dir, book_id, chapter_id)
    }

    /// 删除整本书的章节目录（storage_dir/chapters/{book_id}/）。
    pub fn delete_chapter_html_dir(&self, book_id: &str) {
        storage::delete_chapter_html_dir(&self.storage_dir, book_id)
    }

    /// 读取资源字节（同步上下文用）。
    /// - COS 启用时：用 `Handle::block_on` 驱动异步 get_object（仅在 spawn_blocking 内合法）
    /// - COS 未启用时：本地路径（封面从 covers/{id}，其他从 .epb zip）
    ///
    /// 注意：handler 调用前应先调 `asset_storage_url()` 拿 URL 推给前端；
    /// 本函数仅在服务端需要字节本身时调用（如导出 EPUB / 用户单独下载）。
    pub fn read_asset_bytes(&self, asset: &Asset, book: &Book) -> Result<Vec<u8>, EpubError> {
        if let Some(cos) = &self.cos {
            let key = cos.make_key(&book.id, &asset.id);
            let cos_clone = cos.clone();
            let key_clone = key.clone();
            // 在 spawn_blocking 线程（非 tokio worker）内驱动 future 是合法的
            let cos_result = tokio::runtime::Handle::current()
                .block_on(async move { cos_clone.get_object(&key_clone).await });
            // Fallback：若 COS 上没有（旧书在 COS 启用前入库，或迁移未完成），
            // 从本地 .epb zip 读字节，避免导出 EPUB 时图片丢失。
            // 只在导出等"服务端要字节"的场景有意义；前端直接访问 302 后由 COS 自身 404。
            match cos_result {
                Ok(bytes) => return Ok(bytes),
                Err(e) => {
                    tracing::warn!(
                        "COS get_object({key}) failed ({e}); fallback to local zip"
                    );
                    // fall through 到本地 zip 读
                }
            }
        }
        if asset.href.starts_with("cover:") {
            let path = self.storage_dir.join("covers").join(&asset.id);
            std::fs::read(&path).map_err(|e| EpubError::FileSystem(format!("读封面失败：{e}")))
        } else {
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

    /// 生成资源访问 URL（供前端 img.src / 导出 EPUB 时打包）。
    /// - COS 启用时：返回 5 分钟有效的预签名 URL
    /// - COS 未启用时：返回本地相对路径 `/api/books/{book_id}/assets/{asset_id}`
    pub fn asset_storage_url(&self, book_id: &str, asset_id: &str) -> String {
        if let Some(cos) = &self.cos {
            let key = cos.make_key(book_id, asset_id);
            return cos
                .presigned_get_url(&key, 300)
                .unwrap_or_else(|e| {
                    tracing::error!("presigned url for {key} failed: {e}");
                    format!("/api/books/{book_id}/assets/{asset_id}")
                });
        }
        format!("/api/books/{book_id}/assets/{asset_id}")
    }
}

// ========== 章节 html 外置 IO 集成测试 ==========
//
// 不放进 tests/ 目录（项目是 binary crate，没有 lib 入口让外部 use）。
// 用 #[cfg(test)] 共享 BookService 实例，in-memory SQLite + 临时 storage_dir。

#[cfg(test)]
mod chapter_html_io_tests {
    use super::*;
    use crate::api::schema::ChapterUpdate;
    use chrono::Utc;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use std::str::FromStr;
    use tempfile::TempDir;

    /// 标准测试 fixture：临时 storage 目录 + 跑过 migration 的 in-memory SQLite
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

    /// 直接 SQL 插入一本带 N 章的书。html 真值在 storage 文件里，DB 无 html 列。
    async fn insert_book_with_chapters(
        svc: &BookService,
        book_id: &str,
        chapters: &[(&str, &str)], // (chapter_id, text)
    ) {
        sqlx::query(
            "INSERT INTO books (id, title, authors, language, identifier, file_path, file_size, file_sha256, created_at) \
             VALUES (?, ?, '[]', 'zh', ?, ?, 0, 'deadbeef', ?)",
        )
        .bind(book_id)
        .bind("测试书")
        .bind(book_id)
        .bind(format!("{book_id}.epb"))
        .bind(Utc::now().naive_utc())
        .execute(&svc.pool)
        .await
        .expect("insert book");

        for (i, (cid, text)) in chapters.iter().enumerate() {
            sqlx::query(
                "INSERT INTO chapters (id, book_id, title, spine_order, href, text, word_count) \
                 VALUES (?, ?, ?, ?, ?, ?, 0)",
            )
            .bind(cid)
            .bind(book_id)
            .bind(format!("Chapter {}", i + 1))
            .bind(i as i64)
            .bind(format!("OEBPS/chapter_{}.xhtml", i + 1))
            .bind(text)
            .execute(&svc.pool)
            .await
            .expect("insert chapter");
        }
    }

    #[tokio::test]
    async fn write_and_read_chapter_html_roundtrip() {
        let (svc, _tmp) = setup().await;
        let book_id = "book-1";
        let chapter_id = "ch-1";
        let html = "<html><body><p>正文</p></body></html>";

        svc.write_chapter_html(book_id, chapter_id, html)
            .expect("write html");

        // 文件确实落在 chapters/{book_id}/{chapter_id}.html
        let path = svc.chapter_html_path(book_id, chapter_id);
        assert!(path.exists(), "chapter html file must exist");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), html);

        // 通过 service 读回，值一致
        assert_eq!(svc.read_chapter_html(book_id, chapter_id), html);
    }

    #[tokio::test]
    async fn get_chapter_returns_file_content_via_service() {
        let (svc, _tmp) = setup().await;
        let book_id = "book-1";
        let chapter_id = "ch-1";
        let html = "<html><body><p>第一段</p><p>第二段</p></body></html>";

        svc.write_chapter_html(book_id, chapter_id, html)
            .expect("write html");
        insert_book_with_chapters(&svc, book_id, &[(chapter_id, "第一段 第二段")]).await;

        // DB 行已插入，Chapter 结构体不再有 html 字段。
        // 调用方拿 html 应该走 service.read_chapter_html(book_id, chapter_id)。
        let _ch = svc.get_chapter(book_id, chapter_id).await.expect("get").expect("found");
        assert_eq!(svc.read_chapter_html(book_id, chapter_id), html);
    }

    #[tokio::test]
    async fn get_chapters_returns_metadata_html_via_service() {
        let (svc, _tmp) = setup().await;
        let book_id = "book-1";
        let pairs = [("ch-1", "<p>第一章</p>"), ("ch-2", "<p>第二章</p>"), ("ch-3", "<p>第三章</p>")];
        for (cid, html) in &pairs {
            svc.write_chapter_html(book_id, cid, html).expect("write");
        }
        insert_book_with_chapters(
            &svc,
            book_id,
            &pairs.iter().map(|(c, t)| (*c, *t)).collect::<Vec<_>>(),
        )
        .await;

        // get_chapters 只返回 metadata（id/title/text/word_count），
        // 不再带 html。html 通过 read_chapter_html 按需取。
        let chapters = svc.get_chapters(book_id).await.expect("get_chapters");
        assert_eq!(chapters.len(), 3);
        for (i, (cid, _text)) in pairs.iter().enumerate() {
            assert_eq!(chapters[i].id, *cid);
        }
        for (cid, html) in &pairs {
            assert_eq!(svc.read_chapter_html(book_id, cid), *html);
        }
    }

    #[tokio::test]
    async fn update_chapter_overwrites_file_and_recomputes_text() {
        let (svc, _tmp) = setup().await;
        let book_id = "book-1";
        let chapter_id = "ch-1";
        let original_html = "<p>原文</p>";
        let new_html = "<p>新内容</p>";

        svc.write_chapter_html(book_id, chapter_id, original_html).expect("write");
        insert_book_with_chapters(&svc, book_id, &[(chapter_id, "原文")]).await;

        let update = ChapterUpdate {
            title: None,
            html: Some(new_html.to_string()),
        };
        let updated = svc.update_chapter(book_id, chapter_id, &update).await.expect("update").expect("found");

        // 返回的 chapter 不带 html，但 text 已被重算
        assert_eq!(updated.text, "新内容");

        // 文件被覆盖
        assert_eq!(svc.read_chapter_html(book_id, chapter_id), new_html);

        // DB 里 text / word_count 已被重算
        let raw: (String, i64) = sqlx::query_as("SELECT text, word_count FROM chapters WHERE id = ? AND book_id = ?")
            .bind(chapter_id)
            .bind(book_id)
            .fetch_one(&svc.pool)
            .await
            .expect("raw select");
        assert_eq!(raw.0, "新内容", "text should be recomputed from new html");
        assert!(raw.1 > 0, "word_count should be > 0");
    }

    #[tokio::test]
    async fn delete_book_removes_chapter_dir() {
        let (svc, tmp) = setup().await;
        let book_id = "book-1";
        for cid in ["ch-1", "ch-2"] {
            svc.write_chapter_html(book_id, cid, "<p>x</p>").expect("write");
        }
        insert_book_with_chapters(&svc, book_id, &[("ch-1", "x"), ("ch-2", "y")]).await;

        // 章节目录存在
        let chapters_dir = tmp.path().join("chapters").join(book_id);
        assert!(chapters_dir.exists(), "chapter dir should exist before delete");

        svc.delete_book(book_id).await.expect("delete");

        // 章节目录应被清理
        assert!(!chapters_dir.exists(), "chapter dir must be cleaned up after delete_book");
    }

    #[tokio::test]
    async fn missing_html_file_returns_empty_string() {
        let (svc, _tmp) = setup().await;
        let book_id = "book-1";
        let chapter_id = "ch-1";

        // 没写文件，只插章节行
        insert_book_with_chapters(&svc, book_id, &[(chapter_id, "文本")]).await;

        // read_chapter_html 应返回空字符串而不是 error
        assert_eq!(svc.read_chapter_html(book_id, chapter_id), "");
    }
}
