// API 请求/响应 schema（serde 类型），对应 Python api/schemas.py。
// 字段顺序与 Python 一致，确保前端 byte-for-byte 兼容。

use chrono::{NaiveDate, NaiveDateTime};
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
pub struct ChapterOut {
    pub id: String,
    pub title: String,
    pub spine_order: i64,
    pub word_count: i64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct AssetOut {
    pub id: String,
    pub href: String,
    pub media_type: String,
    pub size: i64,
    pub is_cover: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct BookSummary {
    pub id: String,
    pub title: String,
    pub authors: Vec<String>,
    pub language: String,
    pub chapter_count: i64,
    pub asset_count: i64,
    /// 全书总字数（chapters.word_count 之和）
    pub word_count: i64,
    pub file_size: i64,
    pub has_cover: bool,
    pub cover_id: Option<String>,
    pub created_at: NaiveDateTime,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct BookDetail {
    pub id: String,
    pub title: String,
    pub authors: Vec<String>,
    pub language: String,
    pub publisher: Option<String>,
    pub description: Option<String>,
    pub pub_date: Option<NaiveDate>,
    pub identifier: String,
    pub file_size: i64,
    pub created_at: NaiveDateTime,
    pub chapters: Vec<ChapterOut>,
    pub assets: Vec<AssetOut>,
}

#[derive(Debug, Serialize)]
pub struct BookListResponse {
    pub items: Vec<BookSummary>,
    pub total: i64,
    pub page: i64,
    pub size: i64,
}

#[derive(Debug, Serialize)]
pub struct ChapterContent {
    pub title: String,
    pub content: String,
    pub format: String, // "text" | "html"
}

// ---------- 写端点：请求 Schema ----------

/// PATCH /api/books/:id 请求体（所有字段可选，部分更新）
#[derive(Debug, Deserialize)]
pub struct BookUpdate {
    pub title: Option<String>,
    pub authors: Option<Vec<String>>,
    pub language: Option<String>,
    pub publisher: Option<String>,
    pub description: Option<String>,
    /// ISO 日期字符串（如 "2024-01-15"）
    pub pub_date: Option<String>,
    pub identifier: Option<String>,
}

/// PATCH /api/books/:id/chapters/:cid 请求体
#[derive(Debug, Deserialize)]
pub struct ChapterUpdate {
    pub title: Option<String>,
    pub html: Option<String>,
}

/// PATCH /api/books/:id/chapters/reorder 请求体
#[derive(Debug, Deserialize)]
pub struct ChapterReorder {
    pub chapter_ids: Vec<String>,
}

// ---------- 写端点：响应 Schema ----------

/// POST /api/books 返回结果
#[derive(Debug, Serialize)]
pub struct UploadResult {
    pub book: BookDetail,
    pub warnings: Vec<String>,
}

/// 批量上传中单本书的处理结果
#[derive(Debug, Serialize)]
pub struct BatchUploadResultItem {
    pub filename: String,
    /// "success" | "duplicate" | "error"
    pub status: String,
    pub book_id: Option<String>,
    pub title: Option<String>,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
}

/// 批量上传汇总
#[derive(Debug, Serialize)]
pub struct BatchUploadResult {
    pub items: Vec<BatchUploadResultItem>,
    pub total: i64,
    pub succeeded: i64,
    pub skipped: i64,
    pub failed: i64,
}

/// 单个章节的搜索结果
#[derive(Debug, Serialize)]
pub struct SearchResult {
    pub chapter_id: String,
    pub chapter_title: String,
    pub spine_order: i64,
    /// 高亮片段，关键词用 <mark> 标记
    pub snippet: String,
    pub match_count: i64,
}

/// 搜索结果分页响应
#[derive(Debug, Serialize)]
pub struct SearchResponse {
    pub items: Vec<SearchResult>,
    pub total: i64,
    pub query: String,
}
