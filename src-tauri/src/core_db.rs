// 数据库层：sqlx SqlitePool + ORM 模型结构体。
//
// 设计要点：
// - 复用现有 ./data/library.db（Python alembic 已建表），sqlx 用 IF NOT EXISTS 幂等迁移
// - authors 列是 JSON 数组，用 sqlx::types::Json<Vec<String>> 自动序列化
// - chapters/assets 是复合主键 (id, book_id)，FromRow 结构体保留两个字段

use chrono::NaiveDateTime;
use serde::{Deserialize, Serialize};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::{FromRow, SqlitePool};
use std::str::FromStr;

/// 创建并验证连接池，自动跑迁移。
pub async fn init_pool(database_url: &str) -> anyhow::Result<SqlitePool> {
    let opts = SqliteConnectOptions::from_str(database_url)?
        .create_if_missing(true)
        // 启用外键约束（SQLite 默认关闭，FK CASCADE 需要它）
        .foreign_keys(true)
        // 启用 WAL 模式提升并发读性能
        .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal);

    let pool = SqlitePoolOptions::new()
        .max_connections(5)
        .connect_with(opts)
        .await?;

    // 跑迁移（IF NOT EXISTS 保证对已有库幂等）
    sqlx::migrate!("./migrations").run(&pool).await?;

    Ok(pool)
}

// ---------- ORM 模型（对应数据库行） ----------

#[derive(Debug, FromRow, Serialize, Deserialize)]
pub struct Book {
    /// 书 ID（UUID，全局唯一）
    pub id: String,
    /// 书名
    pub title: String,
    /// 作者列表（JSON 列），sqlx::types::Json 自动处理序列化
    #[sqlx(json)]
    pub authors: Vec<String>,
    /// 语言代码（如 zh / en）
    pub language: String,
    /// 出版社（可选）
    pub publisher: Option<String>,
    /// 简介（可选）
    pub description: Option<String>,
    /// 出版日期（可选）
    pub pub_date: Option<chrono::NaiveDate>,
    /// 唯一标识符（如 ISBN / urn）
    pub identifier: String,
    /// 源文件在 storage_dir 下的相对路径（如 `{id}.epb`）
    pub file_path: String,
    /// 源文件字节大小
    pub file_size: i64,
    /// 源文件 SHA-256（去重用）
    pub file_sha256: String,
    /// 入库时间
    pub created_at: NaiveDateTime,
}

#[derive(Debug, FromRow, Serialize, Deserialize)]
pub struct Chapter {
    /// 章节 ID（EPUB manifest 中的 item id）
    pub id: String,
    /// 所属书 ID
    pub book_id: String,
    /// 章节标题
    pub title: String,
    /// 阅读顺序（从 0 递增）
    pub spine_order: i64,
    /// 章节源文件在 EPUB 内的相对路径
    pub href: String,
    /// 纯文本正文
    pub text: String,
    /// 章节字数
    pub word_count: i64,
    // html 真值在 storage_dir/chapters/{book_id}/{chapter_id}.html。
    // 调用方通过 service.read_chapter_html(book_id, chapter_id) 拿字符串。
}

#[derive(Debug, FromRow, Serialize, Deserialize)]
pub struct Asset {
    /// 资源 ID（EPUB manifest 中的 item id）
    pub id: String,
    /// 所属书 ID
    pub book_id: String,
    /// 资源在 EPUB 内的相对路径
    pub href: String,
    /// MIME 类型（如 image/jpeg）
    pub media_type: String,
    /// 资源字节大小
    pub size: i64,
    /// SQLite 无原生 bool，存 0/1
    pub is_cover: i64,
}

impl Asset {
    pub fn is_cover_bool(&self) -> bool {
        self.is_cover != 0
    }
}
