"""EPUB 写入器：从 ORM 数据构建标准 EPUB 3 文件（导入的逆操作）。

纯函数构建，不碰 DB / 文件系统。调用方（BookService.export_epub）
负责加载数据和读取资源字节。

输出结构（所有资源扁平到 OEBPS/assets/，章节扁平到 OEBPS/chapter_*.xhtml）：
    mimetype                       ← 不压缩（EPUB 规范）
    META-INF/container.xml
    OEBPS/content.opf              ← metadata + manifest + spine
    OEBPS/nav.xhtml                ← 目录
    OEBPS/chapter_0001.xhtml ...   ← 章节（重写资源引用）
    OEBPS/assets/{asset_id} ...    ← 资源（图片/CSS/封面）
"""

from __future__ import annotations

import zipfile
from datetime import datetime
from io import BytesIO
from typing import TYPE_CHECKING

from lxml import etree

if TYPE_CHECKING:
    from epub_backend.db.models import Asset, Book, Chapter

XHTML_NS = "http://www.w3.org/1999/xhtml"
XLINK_NS = "http://www.w3.org/1999/xlink"
SVG_NS = "http://www.w3.org/2000/svg"
OPF_NS = "http://www.idpf.org/2007/opf"
OPS_NS = "http://www.idpf.org/2007/ops"
DC_NS = "http://purl.org/dc/elements/1.1/"


def build_epub_bytes(
    book: Book,
    chapters: list[Chapter],
    assets: list[Asset],
    asset_bytes: dict[str, bytes],
) -> bytes:
    """构建 EPUB 文件字节。

    chapters 必须已按 spine_order 排序。
    asset_bytes: {asset_id: 字节}，应包含所有要写入的资源。
    """
    # 资源原始 href → asset_id（用于解析章节内的引用）
    asset_map: dict[str, str] = {a.href: a.id for a in assets}
    cover_asset_id = next((a.id for a in assets if a.is_cover), None)

    buf = BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        # 1. mimetype（不压缩）
        zf.writestr(
            zipfile.ZipInfo("mimetype", date_time=(2026, 1, 1, 0, 0, 0)),
            "application/epub+zip",
            compress_type=zipfile.ZIP_STORED,
        )

        # 2. container.xml
        zf.writestr(
            "META-INF/container.xml",
            (
                '<?xml version="1.0" encoding="UTF-8"?>\n'
                '<container version="1.0"'
                ' xmlns="urn:oasis:names:tc:opendocument:xmlns:container">'
                "  <rootfiles>"
                '    <rootfile full-path="OEBPS/content.opf"'
                ' media-type="application/oebps-package+xml"/>'
                "  </rootfiles>"
                "</container>"
            ),
        )

        # 3. 章节 XHTML（重写资源引用 → assets/{id}）
        chapter_files: list[tuple[str, str]] = []  # (manifest_id, href)
        chapter_nav: list[tuple[str, str]] = []  # (href, title)
        for i, ch in enumerate(chapters):
            ch_href = f"chapter_{i:04d}.xhtml"
            rewritten = _rewrite_chapter_refs(ch.html, ch.href, asset_map)
            zf.writestr(f"OEBPS/{ch_href}", _ensure_xml_decl(rewritten))
            chapter_files.append((ch.id or f"ch{i}", ch_href))
            chapter_nav.append((ch_href, ch.title))

        # 4. nav.xhtml
        zf.writestr("OEBPS/nav.xhtml", _build_nav(chapter_nav))

        # 5. 资源文件（扁平到 OEBPS/assets/{asset_id}）
        asset_items: list[tuple[str, str, str, bool]] = []  # (id, href, media_type, is_cover)
        for a in assets:
            data = asset_bytes.get(a.id)
            if data is None:
                continue  # 字节缺失则跳过（不阻断导出）
            zf.writestr(f"OEBPS/assets/{a.id}", data)
            asset_items.append((a.id, f"assets/{a.id}", a.media_type, a.id == cover_asset_id))

        # 6. content.opf
        zf.writestr(
            "OEBPS/content.opf",
            _build_opf(book, chapter_files, asset_items, cover_asset_id),
        )

    return buf.getvalue()


# ──────────────────────────────────────────────────────────────────────────
# 章节引用重写
# ──────────────────────────────────────────────────────────────────────────


def _rewrite_chapter_refs(html: str, chapter_href: str, asset_map: dict[str, str]) -> str:
    """把章节 XHTML 内的 <img src> / <svg image href> / <link href> 引用
    重写为扁平 assets/{asset_id} 路径；匹配不到的资源移除元素（避免破链）。

    chapter_href 是章节在原 EPUB 中的路径，用于解析相对引用的基目录。
    """
    try:
        root = etree.fromstring(html.encode("utf-8"))
    except etree.XMLSyntaxError:
        return html  # 解析失败原样返回（已是合法 XHTML 概率高，兜底）

    chapter_dir = chapter_href.rsplit("/", 1)[0] if "/" in chapter_href else ""

    # <img src="...">
    for img in list(root.iter(f"{{{XHTML_NS}}}img")):
        asset_id = _resolve_to_asset(img.get("src", ""), chapter_dir, asset_map)
        if asset_id is None:
            img.getparent().remove(img)
        else:
            img.set("src", f"assets/{asset_id}")

    # <svg><image href|xlink:href>
    for image in list(root.iter(f"{{{SVG_NS}}}image")):
        raw = image.get("href") or image.get(f"{{{XLINK_NS}}}href") or ""
        asset_id = _resolve_to_asset(raw, chapter_dir, asset_map)
        if asset_id is None:
            image.getparent().remove(image)
        else:
            image.set("href", f"assets/{asset_id}")
            image.set(f"{{{XLINK_NS}}}href", f"assets/{asset_id}")

    # <link href="...css">
    for link in list(root.iter(f"{{{XHTML_NS}}}link")):
        asset_id = _resolve_to_asset(link.get("href", ""), chapter_dir, asset_map)
        if asset_id is None:
            link.getparent().remove(link)
        else:
            link.set("href", f"assets/{asset_id}")

    return etree.tostring(root, encoding="unicode")


def _resolve_to_asset(ref: str, chapter_dir: str, asset_map: dict[str, str]) -> str | None:
    """把章节内的资源引用解析为 asset_id，找不到返回 None。"""
    if not ref:
        return None
    ref = ref.strip()
    if "#" in ref:
        ref = ref.split("#", 1)[0]
    if not ref or ref.startswith(("http://", "https://", "data:")):
        return None
    # 解析为 zip 内绝对路径
    if ref.startswith("/"):
        abs_href = ref.lstrip("/")
    else:
        abs_href = _normalize(f"{chapter_dir}/{ref}") if chapter_dir else ref
    # 精确匹配
    if abs_href in asset_map:
        return asset_map[abs_href]
    # basename 兜底
    base = abs_href.rsplit("/", 1)[-1]
    for href, aid in asset_map.items():
        if href.rsplit("/", 1)[-1] == base:
            return aid
    return None


def _normalize(path: str) -> str:
    parts: list[str] = []
    for p in path.split("/"):
        if p in ("", "."):
            continue
        if p == "..":
            if parts:
                parts.pop()
            continue
        parts.append(p)
    return "/".join(parts)


def _ensure_xml_decl(html: str) -> bytes:
    """确保有 XML 声明，返回 UTF-8 字节。"""
    if html.lstrip().startswith("<?xml"):
        return html.encode("utf-8")
    return ('<?xml version="1.0" encoding="utf-8"?>\n' + html).encode("utf-8")


# ──────────────────────────────────────────────────────────────────────────
# OPF / Nav 构建
# ──────────────────────────────────────────────────────────────────────────


def _build_nav(chapter_nav: list[tuple[str, str]]) -> bytes:
    items = "\n".join(
        f'<li><a href="{href}">{_escape(title)}</a></li>' for href, title in chapter_nav
    )
    return (
        '<?xml version="1.0" encoding="utf-8"?>\n'
        f'<html xmlns="{XHTML_NS}" xmlns:epub="{OPS_NS}">'
        "<head><title>目录</title></head><body>"
        '<nav epub:type="toc" id="toc"><h1>目录</h1><ol>'
        f"{items}</ol></nav></body></html>"
    ).encode("utf-8")


def _build_opf(
    book: Book,
    chapter_files: list[tuple[str, str]],
    asset_items: list[tuple[str, str, str, bool]],
    cover_asset_id: str | None,
) -> bytes:
    # metadata
    creators = "".join(
        f"<dc:creator>{_escape(a)}</dc:creator>" for a in (book.authors or [])
    ) or "<dc:creator>未知作者</dc:creator>"
    extra_meta = ""
    if book.publisher:
        extra_meta += f"<dc:publisher>{_escape(book.publisher)}</dc:publisher>"
    if book.description:
        extra_meta += f"<dc:description>{_escape(book.description)}</dc:description>"
    if book.pub_date:
        extra_meta += f"<dc:date>{book.pub_date.isoformat()}</dc:date>"

    # manifest
    manifest = ['<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>']
    for cid, href in chapter_files:
        manifest.append(
            f'<item id="{_escape(cid)}" href="{href}" media-type="application/xhtml+xml"/>'
        )
    for aid, href, media_type, is_cover in asset_items:
        props = ' properties="cover-image"' if is_cover else ""
        manifest.append(
            f'<item id="{_escape(aid)}" href="{href}" media-type="{media_type}"{props}/>'
        )

    # spine
    spine = "".join(f'<itemref idref="{_escape(cid)}"/>' for cid, _ in chapter_files)

    modified = datetime.now().strftime("%Y-%m-%dT%H:%M:%SZ")
    opf = (
        '<?xml version="1.0" encoding="utf-8"?>\n'
        f'<package xmlns="{OPF_NS}" version="3.0" unique-identifier="uid">'
        f'<metadata xmlns:dc="{DC_NS}">'
        f'<dc:identifier id="uid">{_escape(book.identifier)}</dc:identifier>'
        f'<dc:title>{_escape(book.title)}</dc:title>'
        f"{creators}"
        f'<dc:language>{_escape(book.language or "en")}</dc:language>'
        f"{extra_meta}"
        f'<meta property="dcterms:modified">{modified}</meta>'
        "</metadata>"
        f"<manifest>{''.join(manifest)}</manifest>"
        f"<spine>{spine}</spine>"
        "</package>"
    )
    return opf.encode("utf-8")


def _escape(text: str) -> str:
    return (
        (text or "")
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )
