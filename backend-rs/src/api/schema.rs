// API 请求/响应 schema（serde 类型），对应 Python api/schemas.py。
// 字段顺序与 Python 一致，确保前端 byte-for-byte 兼容。

use chrono::{NaiveDate, NaiveDateTime};
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
pub struct ChapterOut {
    /// 章节 ID
    pub id: String,
    /// 章节标题
    pub title: String,
    /// 阅读顺序（从 0 递增）
    pub spine_order: i64,
    /// 章节字数
    pub word_count: i64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct AssetOut {
    /// 资源 ID
    pub id: String,
    /// 资源在 EPUB 内的相对路径
    pub href: String,
    /// MIME 类型
    pub media_type: String,
    /// 资源字节大小
    pub size: i64,
    /// 是否为封面
    pub is_cover: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct BookSummary {
    /// 书 ID
    pub id: String,
    /// 书名
    pub title: String,
    /// 作者列表
    pub authors: Vec<String>,
    /// 语言代码
    pub language: String,
    /// 章节数
    pub chapter_count: i64,
    /// 资源数
    pub asset_count: i64,
    /// 全书总字数（chapters.word_count 之和）
    pub word_count: i64,
    /// 源文件字节大小
    pub file_size: i64,
    /// 是否有封面
    pub has_cover: bool,
    /// 封面资源 ID（无封面时为 None）
    pub cover_id: Option<String>,
    /// 入库时间
    pub created_at: NaiveDateTime,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct BookDetail {
    /// 书 ID
    pub id: String,
    /// 书名
    pub title: String,
    /// 作者列表
    pub authors: Vec<String>,
    /// 语言代码
    pub language: String,
    /// 出版社（可选）
    pub publisher: Option<String>,
    /// 简介（可选）
    pub description: Option<String>,
    /// 出版日期（可选）
    pub pub_date: Option<NaiveDate>,
    /// 唯一标识符（如 ISBN / urn）
    pub identifier: String,
    /// 源文件字节大小
    pub file_size: i64,
    /// 入库时间
    pub created_at: NaiveDateTime,
    /// 章节列表（按阅读顺序）
    pub chapters: Vec<ChapterOut>,
    /// 资源列表
    pub assets: Vec<AssetOut>,
}

#[derive(Debug, Serialize)]
pub struct BookListResponse {
    /// 当前页的书列表
    pub items: Vec<BookSummary>,
    /// 符合条件的书总数
    pub total: i64,
    /// 当前页码（从 1 开始）
    pub page: i64,
    /// 每页数量
    pub size: i64,
}

#[derive(Debug, Serialize)]
pub struct ChapterContent {
    /// 章节标题
    pub title: String,
    /// 正文内容（text 为纯文本，html 为 XHTML）
    pub content: String,
    /// 内容格式："text" | "html"
    pub format: String, // "text" | "html"
}

// ---------- 写端点：请求 Schema ----------

/// PATCH /api/books/:id 请求体（所有字段可选，部分更新）
#[derive(Debug, Deserialize)]
pub struct BookUpdate {
    /// 书名（更新时可选）
    pub title: Option<String>,
    /// 作者列表（更新时可选）
    pub authors: Option<Vec<String>>,
    /// 语言代码（更新时可选）
    pub language: Option<String>,
    /// 出版社（更新时可选）
    pub publisher: Option<String>,
    /// 简介（更新时可选）
    pub description: Option<String>,
    /// ISO 日期字符串（如 "2024-01-15"）
    pub pub_date: Option<String>,
    /// 唯一标识符（更新时可选）
    pub identifier: Option<String>,
}

/// PATCH /api/books/:id/chapters/:cid 请求体
#[derive(Debug, Deserialize)]
pub struct ChapterUpdate {
    /// 章节标题（更新时可选）
    pub title: Option<String>,
    /// 章节 XHTML 正文（更新后自动重算 text/word_count）
    pub html: Option<String>,
}

/// PATCH /api/books/:id/chapters/reorder 请求体
#[derive(Debug, Deserialize)]
pub struct ChapterReorder {
    /// 按目标顺序排列的章节 ID 列表
    pub chapter_ids: Vec<String>,
}

// ---------- 写端点：响应 Schema ----------

/// POST /api/books 返回结果
#[derive(Debug, Serialize)]
pub struct UploadResult {
    /// 入库后的书详情
    pub book: BookDetail,
    /// 处理过程中的警告列表（如解析回退）
    pub warnings: Vec<String>,
}

/// 批量上传中单本书的处理结果
#[derive(Debug, Serialize)]
pub struct BatchUploadResultItem {
    /// 上传文件名
    pub filename: String,
    /// "success" | "duplicate" | "error"
    pub status: String,
    /// 成功/重复时返回的书 ID
    pub book_id: Option<String>,
    /// 成功时返回的书名
    pub title: Option<String>,
    /// 失败时的错误码
    pub error_code: Option<String>,
    /// 失败时的错误描述
    pub error_message: Option<String>,
}

/// 批量上传汇总
#[derive(Debug, Serialize)]
pub struct BatchUploadResult {
    /// 单本书的处理结果列表
    pub items: Vec<BatchUploadResultItem>,
    /// 上传的总文件数
    pub total: i64,
    /// 成功数量
    pub succeeded: i64,
    /// 重复跳过数量
    pub skipped: i64,
    /// 失败数量
    pub failed: i64,
}

/// 单个章节的搜索结果
#[derive(Debug, Serialize)]
pub struct SearchResult {
    /// 章节 ID
    pub chapter_id: String,
    /// 章节标题
    pub chapter_title: String,
    /// 阅读顺序
    pub spine_order: i64,
    /// 高亮片段，关键词用 <mark> 标记
    pub snippet: String,
    /// 命中次数
    pub match_count: i64,
}

/// 搜索结果分页响应
#[derive(Debug, Serialize)]
pub struct SearchResponse {
    /// 命中章节列表
    pub items: Vec<SearchResult>,
    /// 总命中数
    pub total: i64,
    /// 搜索关键词
    pub query: String,
}
