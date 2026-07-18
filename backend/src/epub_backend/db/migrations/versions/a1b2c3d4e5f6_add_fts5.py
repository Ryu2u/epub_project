"""add FTS5 full-text search for chapter content

Revision ID: a1b2c3d4e5f6
Revises: 2c25148d0fb7
Create Date: 2026-07-18 22:50:00.000000

为 chapters 表的 text 列添加 SQLite FTS5 全文索引。
FTS5 是 SQLite 内置的全文搜索引擎，trigram 分词器按 3 字符切分，
适合中日韩等无空格分隔的语言。

迁移内容：
1. 创建 FTS5 虚拟表 chapters_fts
2. 创建 INSERT/DELETE/UPDATE 触发器，自动同步 chapters → chapters_fts
3. 回填已有章节数据到 FTS 索引
"""
from collections.abc import Sequence

from alembic import op

revision: str = 'a1b2c3d4e5f6'
down_revision: str | Sequence[str] | None = '2c25148d0fb7'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # 1. 创建 FTS5 虚拟表（trigram 分词器）
    # FTS5 虚拟表不是普通表，不能用 op.create_table()，必须用 raw SQL
    op.execute("""
        CREATE VIRTUAL TABLE chapters_fts USING fts5(
            chapter_id,
            book_id,
            text,
            tokenize='trigram'
        )
    """)

    # 2. 创建触发器：chapters 表的增删改自动同步到 FTS 索引
    # INSERT 触发器：新章节入库时自动索引
    op.execute("""
        CREATE TRIGGER chapters_fts_ai AFTER INSERT ON chapters BEGIN
            INSERT INTO chapters_fts(chapter_id, book_id, text)
            VALUES (new.id, new.book_id, new.text);
        END
    """)

    # DELETE 触发器：章节删除时清除索引
    op.execute("""
        CREATE TRIGGER chapters_fts_ad AFTER DELETE ON chapters BEGIN
            DELETE FROM chapters_fts
            WHERE chapter_id = old.id AND book_id = old.book_id;
        END
    """)

    # UPDATE 触发器：章节内容更新时重建索引（先删后增）
    op.execute("""
        CREATE TRIGGER chapters_fts_au AFTER UPDATE ON chapters BEGIN
            DELETE FROM chapters_fts
            WHERE chapter_id = old.id AND book_id = old.book_id;
            INSERT INTO chapters_fts(chapter_id, book_id, text)
            VALUES (new.id, new.book_id, new.text);
        END
    """)

    # 3. 回填已有数据：把现有所有章节的纯文本灌入 FTS 索引
    op.execute("""
        INSERT INTO chapters_fts(chapter_id, book_id, text)
        SELECT id, book_id, text FROM chapters
    """)


def downgrade() -> None:
    # 删除触发器和 FTS 虚拟表（触发器随表一起删，但显式删除更干净）
    op.execute("DROP TRIGGER IF EXISTS chapters_fts_au")
    op.execute("DROP TRIGGER IF EXISTS chapters_fts_ad")
    op.execute("DROP TRIGGER IF EXISTS chapters_fts_ai")
    op.execute("DROP TABLE IF EXISTS chapters_fts")
