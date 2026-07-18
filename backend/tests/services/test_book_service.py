"""BookService 测试。"""

from pathlib import Path
from typing import AsyncIterator

import pytest

from epub_backend.reader.errors import (
    CorruptEpubError,
    DRMError,
    DuplicateFileError,
    IncompleteMetadataError,
)
from epub_backend.services.book_service import BookService


async def _upload_chunks(data: bytes) -> AsyncIterator[bytes]:
    """把字节切成 5 块异步喂给 service。"""
    step = max(1, len(data) // 5)
    for i in range(0, len(data), step):
        yield data[i : i + step]


@pytest.mark.asyncio
async def test_add_book_happy_path(session, tmp_path: Path, valid_epub: Path) -> None:
    svc = BookService(session, tmp_path / "storage")
    data = valid_epub.read_bytes()

    book, warnings = await svc.add_book(_upload_chunks(data), filename="valid.epub")
    # 显式刷新关系，避免断言时触发 lazy load（异步 session 下 lazy load 不能工作）
    await session.refresh(book, ["chapters", "assets"])

    assert book.title == "Test Book"
    assert book.authors == ["Test Author"]
    assert len(book.chapters) == 2
    assert len(book.assets) == 1
    assert warnings == []
    # 文件实际存到了 storage
    files = list((tmp_path / "storage").iterdir())
    assert len(files) == 1
    assert files[0].suffix == ".epb"


@pytest.mark.asyncio
async def test_add_book_duplicate_rejected(
    session, tmp_path: Path, valid_epub: Path
) -> None:
    svc = BookService(session, tmp_path / "storage")
    data = valid_epub.read_bytes()

    await svc.add_book(_upload_chunks(data), filename="a.epub")

    # 第二次传同样的内容 → DuplicateFileError
    with pytest.raises(DuplicateFileError) as exc:
        await svc.add_book(_upload_chunks(data), filename="b.epub")
    assert exc.value.existing_book_id  # 至少有值
    # storage 仍然只有一份文件
    files = list((tmp_path / "storage").iterdir())
    assert len([f for f in files if not f.name.startswith(".tmp_")]) == 1


@pytest.mark.asyncio
async def test_add_book_corrupt_no_file_left(
    session, tmp_path: Path, corrupt_epub: Path
) -> None:
    svc = BookService(session, tmp_path / "storage")
    data = corrupt_epub.read_bytes()

    with pytest.raises(CorruptEpubError):
        await svc.add_book(_upload_chunks(data), filename="bad.epub")

    # storage 应为空（不含 .epb）
    epb_files = [f for f in (tmp_path / "storage").iterdir() if f.suffix == ".epb"]
    assert epb_files == []
    # 也没有临时文件
    leftovers = [f for f in (tmp_path / "storage").iterdir() if f.name.startswith(".tmp_")]
    assert leftovers == []


@pytest.mark.asyncio
async def test_add_book_drm_rejected(session, tmp_path: Path, with_drm_epub: Path) -> None:
    svc = BookService(session, tmp_path / "storage")
    data = with_drm_epub.read_bytes()

    with pytest.raises(DRMError):
        await svc.add_book(_upload_chunks(data), filename="drm.epub")

    epb_files = [f for f in (tmp_path / "storage").iterdir() if f.suffix == ".epb"]
    assert epb_files == []


@pytest.mark.asyncio
async def test_add_book_incomplete_metadata(
    session, tmp_path: Path, missing_identifier_epub: Path
) -> None:
    svc = BookService(session, tmp_path / "storage")
    data = missing_identifier_epub.read_bytes()

    with pytest.raises(IncompleteMetadataError):
        await svc.add_book(_upload_chunks(data), filename="x.epub")


@pytest.mark.asyncio
async def test_list_books_search(session, tmp_path: Path, valid_epub: Path) -> None:
    svc = BookService(session, tmp_path / "storage")
    data = valid_epub.read_bytes()

    await svc.add_book(_upload_chunks(data), filename="a.epub")

    items, total, *_ = await svc.list_books(q="Test")
    assert total == 1
    assert items[0].title == "Test Book"

    items2, total2, *_ = await svc.list_books(q="NonExist")
    assert total2 == 0
    assert items2 == []


@pytest.mark.asyncio
async def test_delete_book_cascades(session, tmp_path: Path, valid_epub: Path) -> None:
    svc = BookService(session, tmp_path / "storage")
    data = valid_epub.read_bytes()

    book, _ = await svc.add_book(_upload_chunks(data), filename="a.epub")
    await session.refresh(book, ["chapters", "assets"])

    assert await svc.delete_book(book.id) is True

    # 二次删 → False
    assert await svc.delete_book(book.id) is False

    # storage 应该是空的（不算临时）
    leftover = [f for f in (tmp_path / "storage").iterdir() if f.suffix == ".epb"]
    assert leftover == []


@pytest.mark.asyncio
async def test_get_chapter_returns_text(session, tmp_path: Path, valid_epub: Path) -> None:
    svc = BookService(session, tmp_path / "storage")
    data = valid_epub.read_bytes()
    book, _ = await svc.add_book(_upload_chunks(data), filename="a.epub")
    await session.refresh(book, ["chapters", "assets"])

    ch = await svc.get_chapter(book.id, "ch1")
    assert ch is not None
    assert "第一段" in ch.text
    assert "English text" in ch.text


@pytest.mark.asyncio
async def test_get_asset_returns_bytes(session, tmp_path: Path, valid_epub: Path) -> None:
    svc = BookService(session, tmp_path / "storage")
    data = valid_epub.read_bytes()
    book, _ = await svc.add_book(_upload_chunks(data), filename="a.epub")
    await session.refresh(book, ["chapters", "assets"])

    result = await svc.get_asset(book.id, "cover-img")
    assert result is not None
    asset, blob = result
    assert asset.is_cover == 1
    assert blob[:3] == b"\xff\xd8\xff"  # JPEG 头


@pytest.mark.asyncio
async def test_get_chapter_unknown_returns_none(session, tmp_path: Path) -> None:
    svc = BookService(session, tmp_path / "storage")
    assert await svc.get_chapter("nope", "nope") is None
