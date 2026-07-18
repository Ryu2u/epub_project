"""Alembic 迁移环境配置。

Alembic 是 SQLAlchemy 的数据库迁移工具——管理数据库结构（表、列、索引）的版本变更。
这个 env.py 是 Alembic 的核心配置文件，每次执行迁移命令时都会被加载。
它告诉 Alembic：用哪个数据库、怎么连接、迁移哪些表。
"""

import asyncio  # Python 标准库异步支持，这里用于运行异步迁移
import sys
from logging.config import fileConfig  # 从 ini 文件配置日志
from pathlib import Path

from alembic import context  # Alembic 全局上下文，提供迁移操作的 API
from sqlalchemy import pool  # 连接池配置
from sqlalchemy.engine import Connection
from sqlalchemy.ext.asyncio import async_engine_from_config  # 从配置创建异步引擎

# 把 src/ 加入 sys.path（Alembic 不会自动加）
# sys.path 是 Python 模块搜索路径列表
# 这样才能 import epub_backend.xxx 模块
SRC = Path(__file__).resolve().parents[3] / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

# Alembic Config 对象，读取 alembic.ini 中的配置值
config = context.config

# 配置 Python 日志（根据 alembic.ini 中的 [loggers] 部分）
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

# 从 application settings 拿 DB URL，注入 alembic config
# 这样 Alembic 就知道要连接哪个数据库（与应用使用同一个数据库）
from epub_backend.config import (
    get_settings,  # noqa: E402  # noqa: E402 是 lint 规则忽略，因为 import 在文件顶部代码之后
)

app_settings = get_settings()
config.set_main_option("sqlalchemy.url", app_settings.db_url)

# 导入 ORM 模型的 Base 类
# Alembic 的 autogenerate 功能会对比 Base.metadata（ORM 定义）和实际数据库结构，
# 自动生成迁移脚本
from epub_backend.db.models import Base  # noqa: E402

target_metadata = Base.metadata  # 所有 ORM 表定义的元数据集合


def run_migrations_offline() -> None:
    """Run migrations in 'offline' mode.

    This configures the context with just a URL
    and not an Engine, though an Engine is acceptable
    here as well.  By skipping the Engine creation
    we don't even need a DBAPI to be available.

    Calls to context.execute() here emit the given string to the
    script output.

    离线模式：不真正连接数据库，只把 SQL 语句输出到文件。
    适用于没有数据库访问权限时生成迁移 SQL。
    """
    url = config.get_main_option("sqlalchemy.url")
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,               # 把参数直接嵌入 SQL 字符串
        dialect_opts={"paramstyle": "named"},  # 使用命名参数风格
    )

    with context.begin_transaction():  # 开启迁移事务
        context.run_migrations()       # 执行所有待执行的迁移


def do_run_migrations(connection: Connection) -> None:
    """在给定的数据库连接上执行迁移。"""
    context.configure(connection=connection, target_metadata=target_metadata)

    with context.begin_transaction():
        context.run_migrations()


async def run_async_migrations() -> None:
    """In this scenario we need to create an Engine
    and associate a connection with the context.

    异步迁移：因为项目使用 aiosqlite 异步驱动，所以迁移也要异步执行。
    创建一个临时异步引擎，执行迁移，然后关闭。
    """

    connectable = async_engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,  # NullPool：不使用连接池，迁移时临时连接用完即关
    )

    async with connectable.connect() as connection:
        # run_sync：在异步连接上运行同步函数（do_run_migrations 是同步的）
        await connection.run_sync(do_run_migrations)

    await connectable.dispose()  # 关闭引擎，释放所有连接


def run_migrations_online() -> None:
    """Run migrations in 'online' mode.

    在线模式：真正连接数据库执行迁移。
    asyncio.run()：运行异步函数的入口点（把异步代码当同步运行）。
    """

    asyncio.run(run_async_migrations())


# 根据运行模式选择执行路径
if context.is_offline_mode():
    run_migrations_offline()   # 离线：只输出 SQL
else:
    run_migrations_online()    # 在线：直接执行
