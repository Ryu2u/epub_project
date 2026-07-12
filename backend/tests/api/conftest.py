"""API 测试公用 fixture：临时 DB + httpx AsyncClient。"""

from collections.abc import AsyncIterator
from pathlib import Path

import pytest_asyncio
from httpx import ASGITransport, AsyncClient

from epub_backend import config as app_config
from epub_backend.db.models import Base
from epub_backend.db.session import get_engine, get_session_factory, reset_engine_for_tests
from epub_backend.main import create_app


@pytest_asyncio.fixture
async def client(tmp_path: Path) -> AsyncIterator[AsyncClient]:
    """临时 DB + AsyncClient，依赖覆盖 get_session。"""
    db_file = tmp_path / "test.db"
    db_path_str = db_file.as_posix()
    storage_dir = tmp_path / "storage"
    settings = app_config.Settings(
        storage_dir=storage_dir,
        db_url=f"sqlite+aiosqlite:///{db_path_str}",
    )
    app_config._settings = settings  # type: ignore[attr-defined]
    await reset_engine_for_tests()

    engine = get_engine()
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    app = create_app()

    # 覆盖 get_session，让它走我们当前的 session_factory
    from epub_backend.db import session as db_session

    async def _override_session():
        factory = get_session_factory()
        async with factory() as s:
            yield s

    app.dependency_overrides[db_session.get_session] = _override_session

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c

    await reset_engine_for_tests()
    if db_file.exists():
        db_file.unlink()
