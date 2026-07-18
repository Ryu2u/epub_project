// TypeScript 类型，镜像后端 Pydantic schemas。
// 这些 interface 定义了前后端交互的 JSON 数据结构，
// 确保前端请求和响应的字段名、类型与后端完全一致。

// 章节信息：从 EPUB spine 中解析出的单个章节
export interface ChapterOut {
  id: string;           // 章节唯一标识
  title: string;        // 章节标题（来自 EPUB 的 navPoint 或 heading）
  spine_order: number;  // 在 EPUB spine 中的顺序索引（从 0 开始）
  word_count: number;   // 章节字数
}

// 书籍资源：EPUB 中的图片、样式表、字体等附件
export interface AssetOut {
  id: string;         // 资源唯一标识
  href: string;       // 资源在 EPUB 内的相对路径
  media_type: string; // MIME 类型，如 'image/jpeg'、'text/css'
  size: number;       // 资源大小（字节）
  is_cover: boolean;  // 是否为封面图片
}

// 书籍摘要：列表页使用的精简信息，比详情页少了 chapters/assets 等大字段
export interface BookSummary {
  id: string;
  title: string;
  authors: string[];       // 作者列表（数组），因为一本书可能有多个作者
  language: string;        // 语言代码，如 'zh'、'en'
  chapter_count: number;   // 章节总数
  asset_count: number;     // 资源总数
  file_size: number;       // 原始 EPUB 文件大小（字节）
  has_cover: boolean;      // 是否有封面
  cover_id: string | null; // 封面资源 ID，null 表示无封面（联合类型 X | null）
  created_at: string;      // 导入时间（ISO 8601 格式字符串）
}

// 书籍详情：继承 BookSummary，但用 Omit 排除不需要的字段，再添加详情页特有的字段。
// Omit<T, K> 是 TypeScript 内置工具类型，从 T 中移除 K 指定的键。
export interface BookDetail extends Omit<BookSummary, 'chapter_count' | 'asset_count'> {
  publisher: string | null;     // 出版社，可为空
  description: string | null;   // 书籍简介，可为空
  pub_date: string | null;      // 出版日期，可为空
  identifier: string;           // EPUB 唯一标识符（ISBN 或 UUID）
  chapters: ChapterOut[];       // 完整章节列表
  assets: AssetOut[];           // 完整资源列表
}

// 分页列表响应：后端返回的通用分页结构
export interface BookListResponse {
  items: BookSummary[]; // 当前页的书籍列表
  total: number;        // 符合条件的书籍总数
  page: number;         // 当前页码（从 1 开始）
  size: number;         // 每页条数
}

// 上传结果：上传 EPUB 后的返回值
export interface UploadResult {
  book: BookDetail;     // 解析后的书籍详情
  warnings: string[];   // 解析过程中的警告信息（如缺失元数据）
}

// 章节内容：阅读器获取章节正文时的响应
export interface ChapterContent {
  title: string;                    // 章节标题
  content: string;                  // 章节正文内容
  format: 'text' | 'html';         // 内容格式：纯文本或 HTML（联合类型的字面量类型）
}

// 后端错误响应的内部结构（对应 { error: { ... } } 的内层）
export interface ApiError {
  code: string;                     // 业务错误码
  message: string;                  // 人类可读的错误消息
  phase?: string | null;            // 错误阶段（可选）
  existing_book_id?: string | null; // 重复上传时返回已有书籍 ID（可选）
}

// 后端错误响应的完整结构：外层用 error 字段包裹
export interface ApiErrorResponse {
  error: ApiError;
}

// ========== 编辑功能的请求类型（镜像后端 Pydantic request schemas） ==========

// PATCH /api/books/{book_id} 请求体：部分更新书籍元数据
// 所有字段可选——只更新传入的非 null 字段
export interface BookUpdate {
  title?: string;
  authors?: string[];
  language?: string;
  publisher?: string | null;
  description?: string | null;
  pub_date?: string | null;
  identifier?: string;
}

// PATCH /api/books/{book_id}/chapters/{chapter_id} 请求体
export interface ChapterUpdate {
  title?: string;
  html?: string;
}

// PATCH /api/books/{book_id}/chapters/reorder 请求体
export interface ChapterReorder {
  chapter_ids: string[];
}

// ========== 内容搜索 ==========

// 搜索结果：单个章节的匹配信息
export interface SearchResult {
  chapter_id: string;
  chapter_title: string;
  spine_order: number;
  snippet: string;       // 包含 <mark> 高亮标签的文本片段
  match_count: number;   // 该章节内的匹配次数
}

// 搜索响应
export interface SearchResponse {
  items: SearchResult[];
  total: number;         // 匹配的章节数
  query: string;
}