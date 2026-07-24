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

/// 全局连接池（main 启动时初始化，存入 AppState）
pub type Db = SqlitePool;

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
    pub id: String,
    pub title: String,
    /// 作者列表（JSON 列），sqlx::types::Json 自动处理序列化
    #[sqlx(json)]
    pub authors: Vec<String>,
    pub language: String,
    pub publisher: Option<String>,
    pub description: Option<String>,
    pub pub_date: Option<chrono::NaiveDate>,
    pub identifier: String,
    pub file_path: String,
    pub file_size: i64,
    pub file_sha256: String,
    pub created_at: NaiveDateTime,
}

#[derive(Debug, FromRow, Serialize, Deserialize)]
pub struct Chapter {
    pub id: String,
    pub book_id: String,
    pub title: String,
    pub spine_order: i64,
    pub href: String,
    pub text: String,
    pub html: String,
    pub word_count: i64,
}

#[derive(Debug, FromRow, Serialize, Deserialize)]
pub struct Asset {
    pub id: String,
    pub book_id: String,
    pub href: String,
    pub media_type: String,
    pub size: i64,
    /// SQLite 无原生 bool，存 0/1
    pub is_cover: i64,
}

impl Asset {
    pub fn is_cover_bool(&self) -> bool {
        self.is_cover != 0
    }
}
