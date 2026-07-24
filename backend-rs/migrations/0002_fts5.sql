-- FTS5 全文索引 + 同步触发器
-- 与 Python alembic 0002 (a1b2c3d4e5f6) 等价。
-- trigram 分词器适合中日韩文本；触发器基于复合主键 (chapter_id, book_id)。

CREATE VIRTUAL TABLE IF NOT EXISTS chapters_fts USING fts5(
    chapter_id,
    book_id,
    text,
    tokenize='trigram'
);

CREATE TRIGGER IF NOT EXISTS chapters_fts_ai AFTER INSERT ON chapters BEGIN
    INSERT INTO chapters_fts(chapter_id, book_id, text)
    VALUES (new.id, new.book_id, new.text);
END;

CREATE TRIGGER IF NOT EXISTS chapters_fts_ad AFTER DELETE ON chapters BEGIN
    DELETE FROM chapters_fts
    WHERE chapter_id = old.id AND book_id = old.book_id;
END;

CREATE TRIGGER IF NOT EXISTS chapters_fts_au AFTER UPDATE ON chapters BEGIN
    DELETE FROM chapters_fts
    WHERE chapter_id = old.id AND book_id = old.book_id;
    INSERT INTO chapters_fts(chapter_id, book_id, text)
    VALUES (new.id, new.book_id, new.text);
END;
