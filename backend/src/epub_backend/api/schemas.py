"""Pydantic schema：API 入参/出参。

镜像 reader/models.py 和 db/models.py 的子集。

Pydantic 是一个数据校验库，它通过 Python 类型标注自动校验数据。
FastAPI 用 pydantic 模型来：
  1. 校验请求参数（入参）
  2. 序列化响应数据（出参）
  3. 自动生成 API 文档中的数据结构说明
"""

# __future__ 的 annotations 让类型标注（如 list[str]、str | None）
# 在 Python 3.9 等旧版本也能正常工作（把标注当字符串处理，延迟求值）
from __future__ import annotations

from datetime import date, datetime

# BaseModel 是 pydantic 的核心基类，所有数据模型都继承它
# ConfigDict 用来配置模型行为（如是否允许从 ORM 对象创建）
from pydantic import BaseModel, ConfigDict


class ChapterOut(BaseModel):
    """章节输出模型：用于 API 返回章节的基本信息。"""

    # from_attributes=True 表示可以从 ORM 对象（如 SQLAlchemy 模型）直接创建这个 pydantic 模型
    # 默认 pydantic 只接受字典，加上这个配置后可以传入 ORM 对象，通过属性访问字段
    model_config = ConfigDict(from_attributes=True)

    id: str
    title: str
    spine_order: int  # 章节在书中的阅读顺序（从 EPUB spine 提取）
    word_count: int   # 章节字数统计


class AssetOut(BaseModel):
    """资源输出模型：描述 EPUB 中的图片、样式表等附属资源。"""

    model_config = ConfigDict(from_attributes=True)

    id: str
    href: str         # 资源在 EPUB 包内的路径
    media_type: str   # MIME 类型，如 "image/png"、"text/css"
    size: int         # 资源文件大小（字节）
    is_cover: bool    # 是否为封面图片


class BookSummary(BaseModel):
    """列表里用：不含 chapters/assets 详细。

    用在书籍列表页，只包含摘要信息，不加载章节和资源列表（节省流量和性能）。
    """

    model_config = ConfigDict(from_attributes=True)

    id: str
    title: str
    # list[str] 表示字符串列表，因为一本书可能有多个作者
    authors: list[str]
    language: str
    chapter_count: int  # 章节总数（不加载章节列表，只返回数量）
    asset_count: int    # 资源总数
    file_size: int      # EPUB 文件大小（字节）
    has_cover: bool     # 是否有封面
    # str | None 表示这个字段可以是字符串，也可以是 None（没有封面时）
    cover_id: str | None = None
    # = None 是默认值，表示这个字段是可选的，不传时默认为 None
    created_at: datetime  # 导入时间


class BookDetail(BaseModel):
    """详情用：包含所有字段 + chapters + assets。"""

    model_config = ConfigDict(from_attributes=True)

    id: str
    title: str
    authors: list[str]
    language: str
    # str | None 且没有默认值 = 这个字段必填，但值可以是 None（如书籍没有出版商信息）
    publisher: str | None
    description: str | None
    pub_date: date | None     # 出版日期，date 类型只包含年月日
    identifier: str           # EPUB 的唯一标识符（通常是 ISBN 或 UUID）
    file_size: int
    created_at: datetime
    # 嵌套模型：BookDetail 包含一个 ChapterOut 列表和一个 AssetOut 列表
    chapters: list[ChapterOut]
    assets: list[AssetOut]


class BookListResponse(BaseModel):
    """书籍列表的分页响应。

    包含当前页的数据（items）和分页信息（total/page/size），
    前端用这些信息渲染分页组件。
    """
    items: list[BookSummary]
    total: int   # 符合条件的书籍总数
    page: int    # 当前页码
    size: int    # 每页数量


class UploadResult(BaseModel):
    """上传书籍的返回结果。"""
    book: BookDetail
    warnings: list[str]  # 解析 EPUB 时产生的非致命警告


class ChapterContent(BaseModel):
    """章节内容的返回模型。"""
    title: str
    content: str
    format: str  # "text" | "html"  — 纯文本格式或 HTML 格式


class ErrorBody(BaseModel):
    """统一错误响应体。"""
    code: str               # 错误代码，如 "DRM_DETECTED"
    message: str            # 人类可读的错误描述
    phase: str | None = None          # 错误发生的阶段（解析、校验等）
    existing_book_id: str | None = None  # 重复文件时，已存在书籍的 ID


class ErrorResponse(BaseModel):
    """完整的错误响应，外层包一个 error 字段。"""
    error: ErrorBody


# ---------- 编辑功能的请求 Schema ----------


class BookUpdate(BaseModel):
    """PATCH /api/books/{book_id} 请求体。

    所有字段可选——只更新传入的非 None 字段（部分更新 / partial update）。
    未传的字段保持数据库原值不变。
    """
    title: str | None = None
    authors: list[str] | None = None
    language: str | None = None
    publisher: str | None = None
    description: str | None = None
    pub_date: str | None = None        # ISO 格式日期字符串（如 "2024-01-15"）
    identifier: str | None = None


class ChapterUpdate(BaseModel):
    """PATCH /api/books/{book_id}/chapters/{chapter_id} 请求体。

    更新章节标题和/或正文内容。
    如果传了 html，后端会自动重算 text（纯文本）和 word_count，前端不需要传。
    """
    title: str | None = None
    html: str | None = None            # 完整的 XHTML 内容（用于阅读器渲染）


class ChapterReorder(BaseModel):
    """PATCH /api/books/{book_id}/chapters/reorder 请求体。

    按给定的 chapter id 列表重新排列章节顺序。
    列表的顺序就是新的阅读顺序（index 0 = spine_order 0）。
    """
    chapter_ids: list[str]
