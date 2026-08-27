-- 初始 schema：三张表（books / chapters / assets）
-- 与 Python alembic 0001 等价，用 IF NOT EXISTS 保证对已存在的库幂等。
-- 注意：现有 ./data/library.db 已有这些表（由 alembic 创建），sqlx 首次运行时
-- 会被记录到 _sqlx_migrations 表，CREATE TABLE IF NOT EXISTS 不会报错。

CREATE TABLE IF NOT EXISTS books (
    id           VARCHAR(36) PRIMARY KEY,
    title        TEXT NOT NULL,
    authors      JSON NOT NULL,
    language     VARCHAR(16) NOT NULL,
    publisher    TEXT,
    description  TEXT,
    pub_date     DATE,
    identifier   TEXT NOT NULL,
    file_path    TEXT NOT NULL,
    file_size    INTEGER NOT NULL,
    file_sha256  VARCHAR(64) NOT NULL,
    created_at   DATETIME NOT NULL,
    UNIQUE (file_sha256)
);

CREATE INDEX IF NOT EXISTS idx_books_created ON books (created_at);

CREATE TABLE IF NOT EXISTS assets (
    id          VARCHAR(64) NOT NULL,
    book_id     VARCHAR(36) NOT NULL,
    href        TEXT NOT NULL,
    media_type  VARCHAR(64) NOT NULL,
    size        INTEGER NOT NULL,
    is_cover    INTEGER NOT NULL,
    PRIMARY KEY (id, book_id),
    FOREIGN KEY (book_id) REFERENCES books (id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS chapters (
    id           VARCHAR(64) NOT NULL,
    book_id      VARCHAR(36) NOT NULL,
    title        TEXT NOT NULL,
    spine_order  INTEGER NOT NULL,
    href         TEXT NOT NULL,
    text         TEXT NOT NULL,
    html         TEXT NOT NULL,
    word_count   INTEGER NOT NULL,
    PRIMARY KEY (id, book_id),
    FOREIGN KEY (book_id) REFERENCES books (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_chapters_book ON chapters (book_id, spine_order);
