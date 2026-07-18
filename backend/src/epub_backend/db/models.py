"""SQLAlchemy 2.x 异步 ORM 模型。

3 张表：books / chapters / assets，对应 spec 中的 schema。
ORM（Object-Relational Mapping）：用 Python 类来表示数据库表，
类的属性 = 表的列，类的实例 = 表的一行数据。
"""

from __future__ import annotations  # 延迟求值类型标注

from datetime import date, datetime  # Python 标准库的日期/时间类型
from typing import (
    TYPE_CHECKING,  # TYPE_CHECKING 在运行时为 False，只在类型检查工具（如 mypy）运行时为 True
)

from sqlalchemy import (
    JSON,  # JSON 列类型，存取 JSON 数据（SQLite 用 TEXT 存 JSON 字符串）
    Date,  # 日期列类型（只存日期，不含时间）
    DateTime,  # 日期时间列类型
    ForeignKey,  # 外键约束声明
    Index,  # 索引声明
    Integer,  # 整数列类型
    String,  # 字符串列类型（需指定最大长度）
    Text,  # 长文本列类型（不限长度）
    UniqueConstraint,  # 唯一约束
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship

# DeclarativeBase：SQLAlchemy 2.x 的声明式基类，所有 ORM 模型类都继承它
# Mapped：类型标注包装器，声明"这个属性映射到数据库列"
# mapped_column：描述列的详细信息（类型、约束等）
# relationship：定义表之间的关联关系（一对多、多对一等）

if TYPE_CHECKING:
    pass  # 这里可以放仅类型检查时需要的导入（目前没有）


class Base(DeclarativeBase):
    """SQLAlchemy 2.x 声明基类。

    所有 ORM 模型类都必须继承这个类。
    SQLAlchemy 通过遍历 Base 的所有子类来收集表定义。
    """

    pass


class Book(Base):
    """书籍表：对应一本导入的 EPUB 书。"""

    __tablename__ = "books"  # 指定这张表在数据库中叫 "books"
    __table_args__ = (       # 表级别的额外约束和索引
        # 同一个文件（sha256 相同）不能重复导入
        UniqueConstraint("file_sha256", name="uq_books_sha256"),
        # 给创建时间建索引，加速按时间排序查询
        Index("idx_books_created", "created_at"),
    )

    # Mapped[str] 表示"这个列的 Python 类型是 str"
    # mapped_column(String(36), primary_key=True) 表示"列类型是 VARCHAR(36)，且是主键"
    # 主键：唯一标识表中每一行的列
    id: Mapped[str] = mapped_column(String(36), primary_key=True)  # UUID 格式的书籍 ID
    title: Mapped[str] = mapped_column(Text, nullable=False)       # 书名（必填）
    authors: Mapped[list[str]] = mapped_column(JSON, nullable=False)  # 作者列表，用 JSON 数组存储
    # list[str] 是 Python 3.9+ 的泛型语法，表示"字符串列表"
    # 语言代码（如 "en", "zh-CN"）
    language: Mapped[str] = mapped_column(String(16), nullable=False)
    # "str | None" 表示"可以是字符串，也可以是 None（空）"——即可选字段
    publisher: Mapped[str | None] = mapped_column(Text)    # 出版社（可选）
    description: Mapped[str | None] = mapped_column(Text)  # 简介（可选）
    pub_date: Mapped[date | None] = mapped_column(Date)    # 出版日期（可选）
    identifier: Mapped[str] = mapped_column(Text, nullable=False)  # ISBN 或其他唯一标识
    file_path: Mapped[str] = mapped_column(Text, nullable=False)   # 书文件在磁盘上的路径
    file_size: Mapped[int] = mapped_column(Integer, nullable=False)  # 文件大小（字节）
    # 文件的 SHA-256 哈希，用于查重
    file_sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)  # 入库时间

    # relationship：定义 ORM 关联关系
    # Book 1:N Chapter（一本书有多个章节）
    # back_populates="book"：双向关联，Chapter 里也有 .book 属性指回 Book
    # cascade="all, delete-orphan"：删除书时，自动删除所有关联章节
    # passive_deletes=True：让数据库的 ON DELETE CASCADE 处理，而不是 ORM 层逐行删除
    # order_by="Chapter.spine_order"：按章节在 EPUB spine 中的顺序排列
    chapters: Mapped[list[Chapter]] = relationship(
        back_populates="book",
        cascade="all, delete-orphan",
        passive_deletes=True,
        order_by="Chapter.spine_order",
    )
    # Book 1:N Asset（一本书有多个资源文件：图片、CSS 等）
    assets: Mapped[list[Asset]] = relationship(
        back_populates="book",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )


class Chapter(Base):
    """章节表：EPUB 中的一个 XHTML 章节。"""

    __tablename__ = "chapters"
    __table_args__ = (
        # 复合索引：按 book_id + spine_order 查询章节列表时很快
        Index("idx_chapters_book", "book_id", "spine_order"),
    )

    # 章节 ID（来自 OPF manifest 的 item id）
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    # ForeignKey：外键，引用 books 表的 id 列
    # ondelete="CASCADE"：当 books 表中对应行被删除时，自动删除这里的章节记录
    # 这里 book_id 也是主键的一部分——(id, book_id) 组成复合主键
    book_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("books.id", ondelete="CASCADE"),
        primary_key=True,
    )
    title: Mapped[str] = mapped_column(Text, nullable=False)         # 章节标题
    # 在 EPUB spine 中的顺序（0, 1, 2...）
    spine_order: Mapped[int] = mapped_column(Integer, nullable=False)
    href: Mapped[str] = mapped_column(Text, nullable=False)          # 章节在 EPUB ZIP 内的路径
    # 提取的纯文本内容（用于搜索/字数统计）
    text: Mapped[str] = mapped_column(Text, nullable=False)
    # 原始 HTML 内容（用于阅读器渲染）
    html: Mapped[str] = mapped_column(Text, nullable=False)
    # 字数（中文按字符计，英文按词计）
    word_count: Mapped[int] = mapped_column(Integer, nullable=False)

    # 多对一关系：每章属于一本书
    book: Mapped[Book] = relationship(back_populates="chapters")


class Asset(Base):
    """资源表：EPUB 中的图片、CSS、字体等非章节文件。"""

    __tablename__ = "assets"

    # 资源 ID（来自 OPF manifest 的 item id）
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    book_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("books.id", ondelete="CASCADE"),
        primary_key=True,
    )
    # 资源在 ZIP 内的路径（如 "OEBPS/images/cover.jpg"）
    href: Mapped[str] = mapped_column(Text, nullable=False)
    # MIME 类型（如 "image/jpeg", "text/css"）
    media_type: Mapped[str] = mapped_column(String(64), nullable=False)
    size: Mapped[int] = mapped_column(Integer, nullable=False)        # 资源大小（字节）
    # is_cover：封面标记。0 = 不是封面，1 = 是封面。
    # 用 int 而不是 bool，因为 SQLite 没有原生布尔类型
    is_cover: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    book: Mapped[Book] = relationship(back_populates="assets")
