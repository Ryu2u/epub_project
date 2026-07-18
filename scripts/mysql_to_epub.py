"""从 MySQL book 库提取书籍，生成 EPUB 3 文件并导入到 epub_project SQLite。

用法：
    cd backend && python ../scripts/mysql_to_epub.py

依赖：
    pip install mysql-connector-python
"""

from __future__ import annotations

import hashlib
import re
import shutil
import sys
import uuid
import zipfile
from datetime import datetime
from io import BytesIO
from pathlib import Path

import mysql.connector
from lxml import etree

# ── 项目路径 ──────────────────────────────────────────────────────────────────
# 把 backend/src 加入 sys.path，使 epub_backend 可导入
PROJECT_ROOT = Path(__file__).resolve().parent.parent
BACKEND_SRC = PROJECT_ROOT / "backend" / "src"
sys.path.insert(0, str(BACKEND_SRC))

from epub_backend.reader.epub_reader import open_epub  # noqa: E402
from epub_backend.storage import filesystem as fs  # noqa: E402

# ── MySQL 配置 ────────────────────────────────────────────────────────────────
MYSQL_CONFIG = {
    "host": "127.0.0.1",
    "port": 3306,
    "user": "root",
    "password": "123456",
    "database": "book",
    "charset": "utf8mb4",
}

# ── 项目存储目录 ──────────────────────────────────────────────────────────────
STORAGE_DIR = PROJECT_ROOT / "backend" / "data" / "storage"
DB_PATH = PROJECT_ROOT / "backend" / "data" / "library.db"

# ── EPUB 常量 ─────────────────────────────────────────────────────────────────
XHTML_NS = "http://www.w3.org/1999/xhtml"
OPF_NS = "http://www.idpf.org/2007/opf"
DC_NS = "http://purl.org/dc/elements/1.1/"


# ═══════════════════════════════════════════════════════════════════════════════
# MySQL 数据读取
# ═══════════════════════════════════════════════════════════════════════════════


def fetch_books(conn) -> list[dict]:
    """读取所有书籍基本信息。"""
    cur = conn.cursor(dictionary=True)
    cur.execute("SELECT id, name, path FROM book ORDER BY id")
    books = cur.fetchall()
    cur.close()
    return books


def fetch_chapters(conn, book_id: int) -> list[dict]:
    """读取某本书的所有章节，按 ch_index 排序。"""
    cur = conn.cursor(dictionary=True)
    cur.execute(
        "SELECT id, ch_name, ch_index FROM book_chapter "
        "WHERE book_id = %s ORDER BY ch_index",
        (book_id,),
    )
    chapters = cur.fetchall()
    cur.close()
    return chapters


def fetch_chapter_content(conn, book_id: int, ch_id: int) -> list[str]:
    """读取某章节的所有内容行，按 line_index 排序。"""
    cur = conn.cursor(dictionary=True)
    cur.execute(
        "SELECT content FROM book_chapter_content "
        "WHERE book_id = %s AND ch_id = %s ORDER BY line_index",
        (book_id, ch_id),
    )
    rows = cur.fetchall()
    cur.close()
    return [r["content"] for r in rows]


# ═══════════════════════════════════════════════════════════════════════════════
# EPUB 3 生成
# ═══════════════════════════════════════════════════════════════════════════════


def _count_words(text: str) -> int:
    """CJK 字符每个算 1 词，ASCII 按空白分词。"""
    if not text:
        return 0
    cjk = sum(1 for c in text if "一" <= c <= "鿿" or "぀" <= c <= "ヿ")
    non_cjk = re.sub(r"[一-鿿぀-ヿ]", " ", text)
    ascii_words = len(re.findall(r"\S+", non_cjk))
    return cjk + ascii_words


def _build_xhtml(chapter_title: str, paragraphs: list[str]) -> bytes:
    """生成一个章节的 XHTML 字节。"""
    html = f"""\
<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="{XHTML_NS}">
<head><title>{_escape(chapter_title)}</title></head>
<body>
<h1>{_escape(chapter_title)}</h1>
{chr(10).join(f'<p>{_escape(p)}</p>' for p in paragraphs if p.strip())}
</body>
</html>"""
    return html.encode("utf-8")


def _escape(text: str) -> str:
    """XML 转义。"""
    return (
        text.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def _build_nav(chapters_info: list[tuple[str, str]]) -> bytes:
    """生成 nav.xhtml（目录）。chapters_info = [(href, title), ...]"""
    items = "\n".join(
        f'<li><a href="{href}">{_escape(title)}</a></li>'
        for href, title in chapters_info
    )
    html = f"""\
<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="{XHTML_NS}" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>目录</title></head>
<body>
<nav epub:type="toc" id="toc">
<h1>目录</h1>
<ol>
{items}
</ol>
</nav>
</body>
</html>"""
    return html.encode("utf-8")


def _build_opf(book_name: str, chapter_files: list[tuple[str, str, int]]) -> bytes:
    """生成 content.opf。chapter_files = [(id, href, word_count), ...]"""
    manifest_items = [
        '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>'
    ]
    spine_items = []
    for ch_id, href, _ in chapter_files:
        manifest_items.append(
            f'<item id="{ch_id}" href="{href}" media-type="application/xhtml+xml"/>'
        )
        spine_items.append(f'<itemref idref="{ch_id}"/>')

    opf = f"""\
<?xml version="1.0" encoding="utf-8"?>
<package xmlns="{OPF_NS}" version="3.0" unique-identifier="uid">
<metadata xmlns:dc="{DC_NS}">
  <dc:identifier id="uid">mysql-{uuid.uuid4().hex}</dc:identifier>
  <dc:title>{_escape(book_name)}</dc:title>
  <dc:creator>未知作者</dc:creator>
  <dc:language>zh</dc:language>
  <meta property="dcterms:modified">{datetime.now(tz=None).strftime("%Y-%m-%dT%H:%M:%SZ")}</meta>
</metadata>
<manifest>
  {chr(10) + "  ".join(manifest_items)}
</manifest>
<spine>
  {chr(10) + "  ".join(spine_items)}
</spine>
</package>"""
    return opf.encode("utf-8")


def build_epub(book_name: str, book_id: int, chapters: list[dict], conn) -> bytes:
    """从 MySQL 数据构建完整 EPUB 文件，返回 bytes。

    chapters: [{id, ch_name, ch_index}, ...]
    """
    buf = BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        # 1. mimetype（不压缩，EPUB 规范要求）
        zf.writestr(
            zipfile.ZipInfo("mimetype", date_time=(2026, 1, 1, 0, 0, 0)),
            "application/epub+zip",
            compress_type=zipfile.ZIP_STORED,
        )

        # 2. container.xml
        container_xml = f"""\
<?xml version="1.0" encoding="UTF-8"?>
<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>"""
        zf.writestr("META-INF/container.xml", container_xml)

        # 3. 章节 XHTML
        chapter_files: list[tuple[str, str, int]] = []  # (id, href, word_count)
        chapter_nav: list[tuple[str, str]] = []  # (href, title)

        for ch in chapters:
            lines = fetch_chapter_content(conn, book_id, ch["id"])
            if not lines:
                continue

            # 第一行通常是章节标题（和 ch_name 一致，但下划线/空格可能不同），用作 <h1>
            ch_title = ch["ch_name"]
            first_line = lines[0].strip() if lines else ""
            title_match = (
                first_line == ch_title
                or first_line == ch_title.replace("_", " ")
                or first_line.replace("_", " ") == ch_title.replace("_", " ")
            )
            body_lines = lines[1:] if title_match else lines

            plain_text = "\n".join(body_lines)
            word_count = _count_words(plain_text)

            ch_id = f"ch_{ch['ch_index']:04d}"
            href = f"{ch_id}.xhtml"

            xhtml = _build_xhtml(ch_title, body_lines)
            zf.writestr(f"OEBPS/{href}", xhtml)

            chapter_files.append((ch_id, href, word_count))
            chapter_nav.append((href, ch_title))

        # 4. nav.xhtml
        zf.writestr("OEBPS/nav.xhtml", _build_nav(chapter_nav))

        # 5. content.opf
        zf.writestr("OEBPS/content.opf", _build_opf(book_name, chapter_files))

    return buf.getvalue()


# ═══════════════════════════════════════════════════════════════════════════════
# 导入到 epub_project SQLite
# ═══════════════════════════════════════════════════════════════════════════════


def import_epub_to_library(epub_bytes: bytes, book_name: str) -> str:
    """将 EPUB bytes 解析并写入 SQLite，返回 book_id。"""
    import sqlite3

    # 1. 写临时文件
    tmp_dir = STORAGE_DIR / ".tmp_import"
    tmp_dir.mkdir(parents=True, exist_ok=True)
    tmp_path = tmp_dir / f"{uuid.uuid4().hex}.epub"
    tmp_path.write_bytes(epub_bytes)

    try:
        # 2. 解析 EPUB
        domain = open_epub(tmp_path)

        # 3. 生成元数据
        book_id = uuid.uuid4().hex
        sha256 = hashlib.sha256(epub_bytes).hexdigest()
        file_size = len(epub_bytes)

        # 4. 写入 SQLite
        conn = sqlite3.connect(str(DB_PATH))
        cur = conn.cursor()

        # 检查是否已存在
        cur.execute("SELECT id FROM books WHERE file_sha256 = ?", (sha256,))
        if cur.fetchone():
            print(f"  ⏭  已存在（sha256 匹配），跳过")
            conn.close()
            return ""

        cur.execute(
            """INSERT INTO books
               (id, title, authors, language, publisher, description, pub_date,
                identifier, file_path, file_size, file_sha256, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                book_id,
                domain.title,
                '["未知作者"]',
                domain.language,
                domain.publisher,
                domain.description,
                domain.pub_date.isoformat() if domain.pub_date else None,
                domain.identifier,
                f"{book_id}.epb",
                file_size,
                sha256,
                datetime.now().isoformat(),
            ),
        )

        for ch in domain.chapters:
            cur.execute(
                """INSERT INTO chapters
                   (id, book_id, title, spine_order, href, text, html, word_count)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                (ch.id, book_id, ch.title, ch.order, ch.href, ch.text, ch.html, ch.word_count),
            )

        for asset in domain.assets:
            cur.execute(
                """INSERT INTO assets
                   (id, book_id, href, media_type, size, is_cover)
                   VALUES (?, ?, ?, ?, ?, ?)""",
                (asset.id, book_id, asset.href, asset.media_type, asset.size, int(asset.is_cover)),
            )

        conn.commit()
        conn.close()

        # 5. 复制 .epb 文件到 storage
        final_path = STORAGE_DIR / f"{book_id}.epb"
        shutil.copy2(str(tmp_path), str(final_path))

        return book_id

    finally:
        tmp_path.unlink(missing_ok=True)


# ═══════════════════════════════════════════════════════════════════════════════
# 主流程
# ═══════════════════════════════════════════════════════════════════════════════


def main():
    print("🔗 连接 MySQL...")
    conn = mysql.connector.connect(**MYSQL_CONFIG)

    books = fetch_books(conn)
    print(f"📚 找到 {len(books)} 本书\n")

    success = 0
    skipped = 0
    failed = 0

    for i, book in enumerate(books, 1):
        book_id = book["id"]
        book_name = book["name"]
        print(f"[{i}/{len(books)}] {book_name} ...", end=" ", flush=True)

        try:
            chapters = fetch_chapters(conn, book_id)
            if not chapters:
                print("❌ 无章节数据")
                failed += 1
                continue

            # 生成 EPUB
            epub_bytes = build_epub(book_name, book_id, chapters, conn)

            # 导入到 SQLite
            new_id = import_epub_to_library(epub_bytes, book_name)
            if new_id:
                size_kb = len(epub_bytes) / 1024
                print(f"✅ {len(chapters)} 章, {size_kb:.0f} KB → {new_id[:8]}...")
                success += 1
            else:
                skipped += 1

        except Exception as e:
            print(f"❌ {e}")
            failed += 1

    conn.close()

    print(f"\n{'='*50}")
    print(f"✅ 成功: {success}  ⏭ 跳过: {skipped}  ❌ 失败: {failed}")
    print(f"总计: {len(books)} 本书")


if __name__ == "__main__":
    main()
