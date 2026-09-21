-- 书籍元数据：分类(单选,可空) / 标签(多值) / 别名(多值)。
-- tags/aliases 与 authors 同型：JSON 数组存 TEXT。
-- SQLite 的 ADD COLUMN NOT NULL 必须带 DEFAULT，故存量行起步为 '[]'。
ALTER TABLE books ADD COLUMN category TEXT;
ALTER TABLE books ADD COLUMN tags TEXT NOT NULL DEFAULT '[]';
ALTER TABLE books ADD COLUMN aliases TEXT NOT NULL DEFAULT '[]';
