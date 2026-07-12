"""异步 SQLAlchemy engine + session factory。"""

from __future__ import annotations

from collections.abc import AsyncIterator

from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from epub_backend.config import get_settings

_engine: AsyncEngine | None = None
_session_factory: async_sessionmaker[AsyncSession] | None = None


def get_engine() -> AsyncEngine:
    """单例 engine（per process）。"""
    global _engine
    if _engine is None:
        settings = get_settings()
        _engine = create_async_engine(
            settings.db_url,
            echo=False,
            future=True,
        )
    return _engine


def get_session_factory() -> async_sessionmaker[AsyncSession]:
    """单例 session factory。"""
    global _session_factory
    if _session_factory is None:
        _session_factory = async_sessionmaker(
            bind=get_engine(),
            expire_on_commit=False,
            class_=AsyncSession,
        )
    return _session_factory


async def get_session() -> AsyncIterator[AsyncSession]:
    """FastAPI Depends 用的 session 生成器。"""
    factory = get_session_factory()
    async with factory() as session:
        yield session


async def init_db() -> None:
    """创建所有表（MVP 用，Alembic 接管后仅用于测试）。"""
    from epub_backend.db.models import Base

    engine = get_engine()
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)


async def reset_engine_for_tests() -> None:
    """测试钩子：清掉 engine 缓存，便于切换到不同 DB URL。"""
    global _engine, _session_factory
    if _engine is not None:
        await _engine.dispose()
    _engine = None
    _session_factory = None
