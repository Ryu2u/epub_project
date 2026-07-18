"""EpubReader 端到端测试。"""

from pathlib import Path

import pytest

from epub_backend.reader.epub_reader import open_epub
from epub_backend.reader.errors import (
    CorruptEpubError,
    DRMError,
    IncompleteMetadataError,
)


def test_valid_epub_parses_correctly(valid_epub: Path) -> None:
    book = open_epub(valid_epub)

    assert book.title == "Test Book"
    assert book.authors == ["Test Author"]
    assert book.language == "en"
    assert book.identifier == "urn:uuid:00000000-0000-0000-0000-000000000001"
    assert book.publisher == "Test Publisher"
    assert book.description == "A test book for reader validation."
    assert book.pub_date is not None
    assert book.pub_date.year == 2024

    # 章节：2 个，按 spine 顺序
    assert len(book.chapters) == 2
    assert book.chapters[0].title == "第一章 开始"  # 来自 nav
    assert book.chapters[1].title == "第二章 继续"
    assert book.chapters[0].order == 0
    assert book.chapters[1].order == 1

    # 文本提取：第一段含中文 + 英文
    assert "第一段" in book.chapters[0].text
    assert "English text" in book.chapters[0].text
    assert book.chapters[0].word_count > 0

    # 资源：1 张封面
    assert len(book.assets) == 1
    assert book.assets[0].is_cover is True
    assert book.assets[0].media_type == "image/jpeg"

    # 无 warning
    assert book.warnings == []


def test_missing_identifier_raises(valid_epub_path_missing: Path) -> None:
    with pytest.raises(IncompleteMetadataError) as exc:
        open_epub(valid_epub_path_missing)
    assert "identifier" in str(exc.value).lower()
    assert "identifier" in exc.value.missing


def test_corrupt_epub_raises(corrupt_epub_path: Path) -> None:
    with pytest.raises(CorruptEpubError):
        open_epub(corrupt_epub_path)


def test_ncx_epub_has_warning(valid_epub_with_ncx: Path) -> None:
    book = open_epub(valid_epub_with_ncx)
    # 无 EPUB 3 nav → 回退用 NCX，应带 NCX warning
    assert any("NCX" in w for w in book.warnings)
    assert len(book.chapters) == 2
    # 标题应来自 NCX navMap，而非文件名回退
    assert book.chapters[0].title == "NCX 第一章"
    assert book.chapters[1].title == "NCX 第二章"


def test_drm_epub_rejected(valid_epub_with_drm: Path) -> None:
    with pytest.raises(DRMError):
        open_epub(valid_epub_with_drm)


# 用 conftest 提供的 fixture 名字
@pytest.fixture
def valid_epub_path_missing(missing_identifier_epub: Path) -> Path:
    return missing_identifier_epub


@pytest.fixture
def corrupt_epub_path(corrupt_epub: Path) -> Path:
    return corrupt_epub


@pytest.fixture
def valid_epub_with_ncx(with_ncx_epub: Path) -> Path:
    return with_ncx_epub


@pytest.fixture
def valid_epub_with_drm(with_drm_epub: Path) -> Path:
    return with_drm_epub


def test_cover_meta_recognized(cover_meta_epub: Path) -> None:
    """calibre / EPUB 2 风格 <meta name="cover" content="..."> 应被识别为封面。"""
    book = open_epub(cover_meta_epub)
    assert len(book.assets) == 1
    assert book.assets[0].is_cover is True
    assert book.assets[0].id == "my-cover"
