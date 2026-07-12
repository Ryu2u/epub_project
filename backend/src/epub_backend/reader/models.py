"""EPUB 领域模型：reader 的输出，service 层把它拆开存到 DB。"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date


@dataclass(slots=True)
class Asset:
    id: str
    href: str
    media_type: str
    size: int
    is_cover: bool = False


@dataclass(slots=True)
class Chapter:
    id: str
    title: str
    order: int
    href: str
    text: str
    html: str
    word_count: int


@dataclass(slots=True)
class Book:
    id: str  # UUID（reader 不生成 UUID，留空由 service 填）
    title: str
    authors: list[str] = field(default_factory=list)
    language: str = "en"
    publisher: str | None = None
    description: str | None = None
    pub_date: date | None = None
    identifier: str = ""
    chapters: list[Chapter] = field(default_factory=list)
    assets: list[Asset] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)  # 比如 "EPUB 2 NCX detected, ignored"
