"""DB 模型测试。"""

from datetime import date, datetime

import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from epub_backend.db.models import Asset, Book, Chapter


@pytest.mark.asyncio
async def test_create_book_minimal(session) -> None:
    book = Book(
        id="b1",
        title="Hello",
        authors=["Alice"],
        language="zh-CN",
        identifier="urn:uuid:1",
        file_path="b1.epb",
        file_size=1024,
        file_sha256="a" * 64,
        created_at=datetime.now(),
    )
    session.add(book)
    await session.commit()

    result = await session.execute(select(Book).where(Book.id == "b1"))
    fetched = result.scalar_one()
    assert fetched.title == "Hello"
    assert fetched.authors == ["Alice"]


@pytest.mark.asyncio
async def test_duplicate_sha256_rejected(session) -> None:
    sha = "b" * 64
    for i in range(2):
        session.add(
            Book(
                id=f"b{i}",
                title=f"Book {i}",
                authors=[],
                language="en",
                identifier=f"id{i}",
                file_path=f"b{i}.epb",
                file_size=1,
                file_sha256=sha,
                created_at=datetime.now(),
            )
        )
    # commit 时 SQLite 会拒绝（UNIQUE 约束）
    with pytest.raises(IntegrityError):
        await session.commit()


@pytest.mark.asyncio
async def test_cascade_delete_chapters_and_assets(session) -> None:
    book = Book(
        id="b1",
        title="T",
        authors=[],
        language="en",
        identifier="i",
        file_path="x",
        file_size=1,
        file_sha256="c" * 64,
        created_at=datetime.now(),
    )
    book.chapters.append(
        Chapter(
            id="ch1",
            title="Ch",
            spine_order=0,
            href="c.xhtml",
            text="t",
            html="<p>t</p>",
            word_count=1,
        )
    )
    book.assets.append(
        Asset(
            id="a1",
            href="a.jpg",
            media_type="image/jpeg",
            size=10,
            is_cover=1,
        )
    )
    session.add(book)
    await session.commit()

    # 删除 book，级联应该清掉 chapters + assets
    await session.delete(book)
    await session.commit()

    chapters = (await session.execute(select(Chapter))).scalars().all()
    assets = (await session.execute(select(Asset))).scalars().all()
    assert chapters == []
    assert assets == []


@pytest.mark.asyncio
async def test_book_optional_fields(session) -> None:
    """publisher/description/pub_date 都是可选。"""
    book = Book(
        id="b1",
        title="T",
        authors=[],
        language="en",
        identifier="i",
        file_path="x",
        file_size=1,
        file_sha256="d" * 64,
        created_at=datetime.now(),
    )
    session.add(book)
    await session.commit()
    assert book.publisher is None
    assert book.description is None
    assert book.pub_date is None


@pytest.mark.asyncio
async def test_book_with_pub_date(session) -> None:
    book = Book(
        id="b1",
        title="T",
        authors=[],
        language="en",
        identifier="i",
        file_path="x",
        file_size=1,
        file_sha256="e" * 64,
        created_at=datetime.now(),
        pub_date=date(2024, 5, 1),
    )
    session.add(book)
    await session.commit()
    assert book.pub_date == date(2024, 5, 1)
