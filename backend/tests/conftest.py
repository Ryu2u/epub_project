"""全局 pytest fixture。

session fixture + EPUB fixture 都放这里，所有子目录可见。
"""

from collections.abc import AsyncIterator
from pathlib import Path

import pytest
import pytest_asyncio

from epub_backend import config as app_config
from epub_backend.db import session as db_session
from epub_backend.db.models import Base
from tests.fixtures import build_fixtures

FIXTURES_DIR = Path(__file__).parent / "fixtures" / "epubs"


@pytest.fixture(scope="session", autouse=True)
def _build_fixtures() -> None:
    """session 级自动跑一次：把所有 fixture EPUB 构造到 tests/fixtures/epubs/。"""
    build_fixtures.build_all(FIXTURES_DIR)


@pytest.fixture
def valid_epub() -> Path:
    return FIXTURES_DIR / "valid.epub"


@pytest.fixture
def missing_identifier_epub() -> Path:
    return FIXTURES_DIR / "missing_identifier.epub"


@pytest.fixture
def corrupt_epub() -> Path:
    return FIXTURES_DIR / "corrupt.epub"


@pytest.fixture
def with_ncx_epub() -> Path:
    return FIXTURES_DIR / "with_ncx.epub"


@pytest.fixture
def with_drm_epub() -> Path:
    return FIXTURES_DIR / "with_drm.epub"


@pytest.fixture
def cover_meta_epub() -> Path:
    return FIXTURES_DIR / "cover_meta.epub"


@pytest_asyncio.fixture
async def db_engine(tmp_path: Path) -> AsyncIterator[None]:
    """每个测试一个临时 SQLite 文件，测试结束后清掉。"""
    db_file = tmp_path / "test.db"
    db_path_str = db_file.as_posix()
    settings = app_config.Settings(
        storage_dir=tmp_path / "storage",
        db_url=f"sqlite+aiosqlite:///{db_path_str}",
    )

    app_config._settings = settings  # type: ignore[attr-defined]
    db_session._engine = None  # type: ignore[attr-defined]
    db_session._session_factory = None  # type: ignore[attr-defined]

    engine = db_session.get_engine()
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    yield

    await db_session.reset_engine_for_tests()
    if db_file.exists():
        db_file.unlink()


@pytest_asyncio.fixture
async def session(db_engine: None) -> AsyncIterator[db_session.AsyncSession]:
    factory = db_session.get_session_factory()
    async with factory() as s:
        yield s
