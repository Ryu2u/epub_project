"""Pydantic schema：API 入参/出参。

镜像 reader/models.py 和 db/models.py 的子集。
"""

from __future__ import annotations

from datetime import date, datetime

from pydantic import BaseModel, ConfigDict


class ChapterOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    title: str
    spine_order: int
    word_count: int


class AssetOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    href: str
    media_type: str
    size: int
    is_cover: bool


class BookSummary(BaseModel):
    """列表里用：不含 chapters/assets 详细。"""

    model_config = ConfigDict(from_attributes=True)

    id: str
    title: str
    authors: list[str]
    language: str
    chapter_count: int
    asset_count: int
    file_size: int
    has_cover: bool
    cover_id: str | None = None
    created_at: datetime


class BookDetail(BaseModel):
    """详情用：包含所有字段 + chapters + assets。"""

    model_config = ConfigDict(from_attributes=True)

    id: str
    title: str
    authors: list[str]
    language: str
    publisher: str | None
    description: str | None
    pub_date: date | None
    identifier: str
    file_size: int
    created_at: datetime
    chapters: list[ChapterOut]
    assets: list[AssetOut]


class BookListResponse(BaseModel):
    items: list[BookSummary]
    total: int
    page: int
    size: int


class UploadResult(BaseModel):
    book: BookDetail
    warnings: list[str]


class ChapterContent(BaseModel):
    title: str
    content: str
    format: str  # "text" | "html"


class ErrorBody(BaseModel):
    code: str
    message: str
    phase: str | None = None
    existing_book_id: str | None = None


class ErrorResponse(BaseModel):
    error: ErrorBody
