"""异步 SQLAlchemy engine + session factory。"""

from __future__ import annotations  # 让类型标注中的 "X | None" 语法在 Python 3.9/3.10 也能用

# 这是"延迟求值"——类型标注不会在运行时真正求值
from collections.abc import AsyncIterator  # 异步迭代器类型，用于 yield 生成器的类型标注

from sqlalchemy.ext.asyncio import (  # SQLAlchemy 的异步扩展模块
    AsyncEngine,  # 异步数据库引擎，负责管理连接池
    AsyncSession,  # 异步数据库会话，每次请求用一个
    async_sessionmaker,  # 会话工厂，每次调用它就创建一个新的 AsyncSession
    create_async_engine,  # 创建异步引擎的工厂函数
)

from epub_backend.config import get_settings  # 读取项目配置（含数据库 URL）

# 模块级变量，用 None 初始化——这就是"单例"模式的标记
_engine: AsyncEngine | None = None        # "类型 | None" 表示"要么是 AsyncEngine 要么是 None"
# 方括号是泛型，限定工厂创建的会话类型
_session_factory: async_sessionmaker[AsyncSession] | None = None


def get_engine() -> AsyncEngine:
    """单例 engine（per process）。

    单例模式：整个进程中只创建一个引擎实例。
    全局变量 _engine 用作缓存，第一次调用时创建，后续直接返回。
    """
    global _engine  # global 关键字：告诉 Python 我们要修改模块级变量，不是创建局部变量
    if _engine is None:
        settings = get_settings()  # 从配置获取数据库连接 URL（如 sqlite+aiosqlite:///./db.sqlite3）
        _engine = create_async_engine(
            settings.db_url,
            echo=False,    # 不把每条 SQL 打印到控制台（调试时可改为 True）
            future=True,   # 启用 SQLAlchemy 2.x 风格 API
        )
    return _engine


def get_session_factory() -> async_sessionmaker[AsyncSession]:
    """单例 session factory。

    sessionmaker 是一个"工厂"——调用它就产生一个新的 Session 对象。
    expire_on_commit=False：提交事务后，ORM 对象的属性不会被"过期"，
    否则提交后再访问属性会重新查数据库（这里不需要，因为数据刚写入不久）。
    """
    global _session_factory
    if _session_factory is None:
        _session_factory = async_sessionmaker(
            bind=get_engine(),           # 绑定到上面创建的引擎
            expire_on_commit=False,      # 提交后不"过期"对象属性
            class_=AsyncSession,         # 指定创建的会话类型是异步的
        )
    return _session_factory


async def get_session() -> AsyncIterator[AsyncSession]:
    """FastAPI Depends 用的 session 生成器。

    async def + yield 组合：这是一个"异步生成器函数"。
    FastAPI 的 Depends() 依赖注入机制会：
    1. 调用此函数获取异步生成器
    2. 拿到 yield 的 session 传给路由函数
    3. 路由函数执行完后，执行 yield 之后的代码（即 async with 的 __aexit__，自动关闭 session）
    """
    factory = get_session_factory()
    async with factory() as session:  # async with：异步上下文管理器，退出时自动关闭 session
        yield session                 # 把 session "交出去"给路由函数使用


async def init_db() -> None:
    """创建所有表（MVP 用，Alembic 接管后仅用于测试）。

    这个函数会根据 ORM 模型定义自动建表。
    生产环境应该用 Alembic 迁移来管理数据库结构变更。
    """
    from epub_backend.db.models import Base  # 延迟导入，避免循环依赖

    engine = get_engine()
    async with engine.begin() as conn:  # begin() 自动管理事务，结束时自动提交或回滚
        await conn.run_sync(Base.metadata.create_all)
        # run_sync：在异步引擎上运行同步函数
        # create_all：遍历 Base 的所有子类，为每张表执行 CREATE TABLE IF NOT EXISTS


async def reset_engine_for_tests() -> None:
    """测试钩子：清掉 engine 缓存，便于切换到不同 DB URL。

    测试时每个测试用例可能用不同的数据库（如内存数据库），
    需要先把旧引擎清掉，重新创建。
    """
    global _engine, _session_factory
    if _engine is not None:
        await _engine.dispose()  # 关闭所有数据库连接
    _engine = None
    _session_factory = None
