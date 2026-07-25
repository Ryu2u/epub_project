-- Drop chapters.html 列：真值已搬到 storage_dir/chapters/{book_id}/{chapter_id}.html。
-- SQLite 不支持直接 ALTER TABLE ... DROP COLUMN（要 3.35+），用表重建方案。
-- FTS5 触发器只读 new.text，不读 new.html，所以索引不受影响。
-- 但表名 DROP + RENAME 后触发器引用关系由 SQLite 自动同步；稳妥起见显式重建。

CREATE TABLE IF NOT EXISTS chapters_new (
    id           VARCHAR(64) NOT NULL,
    book_id      VARCHAR(36) NOT NULL,
    title        TEXT NOT NULL,
    spine_order  INTEGER NOT NULL,
    href         TEXT NOT NULL,
    text         TEXT NOT NULL,
    word_count   INTEGER NOT NULL,
    PRIMARY KEY (id, book_id),
    FOREIGN KEY (book_id) REFERENCES books (id) ON DELETE CASCADE
);

INSERT INTO chapters_new (id, book_id, title, spine_order, href, text, word_count)
    SELECT id, book_id, title, spine_order, href, text, word_count FROM chapters;

DROP TABLE chapters;
ALTER TABLE chapters_new RENAME TO chapters;

CREATE INDEX IF NOT EXISTS idx_chapters_book ON chapters (book_id, spine_order);

-- 显式重建 FTS 触发器（避免 SQLite 不同版本在 RENAME 后行为差异）
DROP TRIGGER IF EXISTS chapters_fts_ai;
DROP TRIGGER IF EXISTS chapters_fts_ad;
DROP TRIGGER IF EXISTS chapters_fts_au;
CREATE TRIGGER IF NOT EXISTS chapters_fts_ai AFTER INSERT ON chapters BEGIN
    INSERT INTO chapters_fts(chapter_id, book_id, text)
    VALUES (new.id, new.book_id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS chapters_fts_ad AFTER DELETE ON chapters BEGIN
    DELETE FROM chapters_fts WHERE chapter_id = old.id AND book_id = old.book_id;
END;
CREATE TRIGGER IF NOT EXISTS chapters_fts_au AFTER UPDATE ON chapters BEGIN
    DELETE FROM chapters_fts WHERE chapter_id = old.id AND book_id = old.book_id;
    INSERT INTO chapters_fts(chapter_id, book_id, text)
    VALUES (new.id, new.book_id, new.text);
END;