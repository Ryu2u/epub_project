-- 阅读状态（进度 / 偏好 / 阅读时长）从 localStorage 迁入数据库。
--
-- 背景：.epublib 备份只打包数据库行与 storage 文件，而阅读进度、阅读偏好、
-- 主题、阅读时长此前全在 localStorage，导致换电脑后进度归零、偏好回到默认。
--
-- 形态：单表镜像 localStorage 的键值结构——键名沿用 epub_reader:* 不变，
-- 复杂值（如分页进度的锚点结构）仍以 JSON 字符串存储。
-- updated_at 逐键记录，供导入备份时「取较新」比较（进度本就是逐书一键，
-- 时间粒度天然对齐到「每本书」）。

CREATE TABLE IF NOT EXISTS reader_prefs (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at DATETIME NOT NULL
);

-- 说明：删除书籍时需清理该书的 4 个键（progress / progressPaged / lastRead / status），
-- 用精确键名 IN (...) 匹配而非 LIKE 前缀——LIKE 'epub_reader:%' || book_id 会误伤
-- （book_id 是后缀，'%c' 能匹配到 'progress:abc'）。表很小，主键扫描足够，不额外建索引。
