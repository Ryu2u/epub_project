"""SQLAlchemy 2.x 异步 ORM 模型。

3 张表：books / chapters / assets，对应 spec 中的 schema。
"""

from __future__ import annotations

from datetime import date, datetime
from typing import TYPE_CHECKING

from sqlalchemy import (
    JSON,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship

if TYPE_CHECKING:
    pass


class Base(DeclarativeBase):
    """SQLAlchemy 2.x 声明基类。"""

    pass


class Book(Base):
    __tablename__ = "books"
    __table_args__ = (
        UniqueConstraint("file_sha256", name="uq_books_sha256"),
        Index("idx_books_created", "created_at"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    title: Mapped[str] = mapped_column(Text, nullable=False)
    authors: Mapped[list[str]] = mapped_column(JSON, nullable=False)
    language: Mapped[str] = mapped_column(String(16), nullable=False)
    publisher: Mapped[str | None] = mapped_column(Text)
    description: Mapped[str | None] = mapped_column(Text)
    pub_date: Mapped[date | None] = mapped_column(Date)
    identifier: Mapped[str] = mapped_column(Text, nullable=False)
    file_path: Mapped[str] = mapped_column(Text, nullable=False)
    file_size: Mapped[int] = mapped_column(Integer, nullable=False)
    file_sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)

    chapters: Mapped[list[Chapter]] = relationship(
        back_populates="book",
        cascade="all, delete-orphan",
        passive_deletes=True,
        order_by="Chapter.spine_order",
    )
    assets: Mapped[list[Asset]] = relationship(
        back_populates="book",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )


class Chapter(Base):
    __tablename__ = "chapters"
    __table_args__ = (
        Index("idx_chapters_book", "book_id", "spine_order"),
    )

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    book_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("books.id", ondelete="CASCADE"),
        primary_key=True,
    )
    title: Mapped[str] = mapped_column(Text, nullable=False)
    spine_order: Mapped[int] = mapped_column(Integer, nullable=False)
    href: Mapped[str] = mapped_column(Text, nullable=False)
    text: Mapped[str] = mapped_column(Text, nullable=False)
    html: Mapped[str] = mapped_column(Text, nullable=False)
    word_count: Mapped[int] = mapped_column(Integer, nullable=False)

    book: Mapped[Book] = relationship(back_populates="chapters")


class Asset(Base):
    __tablename__ = "assets"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    book_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("books.id", ondelete="CASCADE"),
        primary_key=True,
    )
    href: Mapped[str] = mapped_column(Text, nullable=False)
    media_type: Mapped[str] = mapped_column(String(64), nullable=False)
    size: Mapped[int] = mapped_column(Integer, nullable=False)
    is_cover: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    book: Mapped[Book] = relationship(back_populates="assets")
