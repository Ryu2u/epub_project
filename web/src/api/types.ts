// TypeScript 类型，镜像后端 Pydantic schemas。

export interface ChapterOut {
  id: string;
  title: string;
  spine_order: number;
  word_count: number;
}

export interface AssetOut {
  id: string;
  href: string;
  media_type: string;
  size: number;
  is_cover: boolean;
}

export interface BookSummary {
  id: string;
  title: string;
  authors: string[];
  language: string;
  chapter_count: number;
  asset_count: number;
  file_size: number;
  has_cover: boolean;
  cover_id: string | null;
  created_at: string;
}

export interface BookDetail extends Omit<BookSummary, 'chapter_count' | 'asset_count'> {
  publisher: string | null;
  description: string | null;
  pub_date: string | null;
  identifier: string;
  chapters: ChapterOut[];
  assets: AssetOut[];
}

export interface BookListResponse {
  items: BookSummary[];
  total: number;
  page: number;
  size: number;
}

export interface UploadResult {
  book: BookDetail;
  warnings: string[];
}

export interface ChapterContent {
  title: string;
  content: string;
  format: 'text' | 'html';
}

export interface ApiError {
  code: string;
  message: string;
  phase?: string | null;
  existing_book_id?: string | null;
}

export interface ApiErrorResponse {
  error: ApiError;
}