"""EpubReader 顶层编排：open(path) -> Book。

调用顺序：
1. 打开 ZIP
2. 校验 mimetype
3. DRM 检测
4. 读 container.xml → 找 rootfile (OPF)
5. 解析 OPF（metadata / manifest / spine）
6. （可选）解析 nav.xhtml 用于章节 title 兜底
7. 按 spine 顺序遍历章节 XHTML → text/html
8. 构造 Asset 列表
9. 返回 Book（id 留空，由 service 层生成 UUID）
"""

from __future__ import annotations

from pathlib import Path
from typing import BinaryIO

from epub_backend.reader import container, nav
from epub_backend.reader.chapter import parse_chapter
from epub_backend.reader.errors import (
    DRMError,
    FileSystemError,
    InvalidContainerError,
)
from epub_backend.reader.models import Asset, Book, Chapter
from epub_backend.reader.opf import (
    ManifestItem,
    OpfPackage,
    parse_opf,
    parse_pub_date,
)


def open_epub(source: str | Path | BinaryIO) -> Book:
    """解析一个 EPUB 文件，返回 Book 对象。

    source 可以是文件路径（str / Path）或二进制流（UploadFile 等）。
    """
    zip_file = container.open_zip(source)

    try:
        # 1. mimetype 校验
        container.validate_mimetype(zip_file)

        # 2. DRM 检测
        if container.has_drm(zip_file):
            raise DRMError("EPUB 含 META-INF/encryption.xml，不支持")

        # 3. 找 rootfile
        opf_path = container.find_rootfile(zip_file)

        # 4. 解析 OPF
        try:
            opf_bytes = container.read_member(zip_file, opf_path)
        except Exception as e:
            raise FileSystemError(f"无法读取 OPF：{e}") from e

        pkg = parse_opf(opf_bytes, opf_path)

        # 5. 目录：EPUB 3 nav 优先；缺失或为空时回退解析 EPUB 2 NCX navMap
        warnings: list[str] = []

        toc_by_href: dict[str, str] = {}
        if pkg.nav_href:
            try:
                nav_bytes = container.read_member(zip_file, pkg.nav_href)
                toc_by_href = nav.parse_nav_toc(nav_bytes, nav_href=pkg.nav_href)
            except Exception:
                toc_by_href = {}

        if not toc_by_href:
            ncx_name = nav.find_ncx(zip_file.namelist())
            if ncx_name:
                try:
                    ncx_bytes = container.read_member(zip_file, ncx_name)
                    toc_by_href = nav.parse_ncx_toc(ncx_bytes, ncx_href=ncx_name)
                except Exception:
                    toc_by_href = {}
                if toc_by_href:
                    warnings.append("EPUB 2 NCX used for chapter titles (no EPUB 3 nav)")

        # 6. 章节
        chapters = _build_chapters(zip_file, pkg, toc_by_href, warnings)

        # 7. 资源
        assets = _build_assets(zip_file, pkg)

        # 8. 组装 Book（pkg.metadata["title"][0] 必填必存在）
        book = Book(
            id="",  # service 层填 UUID
            title=pkg.metadata["title"][0],
            authors=pkg.metadata.get("creator", []),
            language=pkg.metadata["language"][0],
            publisher=(pkg.metadata.get("publisher") or [None])[0],
            description=(pkg.metadata.get("description") or [None])[0],
            pub_date=parse_pub_date(pkg.metadata.get("date")),
            identifier=pkg.metadata["identifier"][0],
            chapters=chapters,
            assets=assets,
            warnings=warnings,
        )

        return book
    finally:
        zip_file.close()


def _build_chapters(
    zip_file, pkg: OpfPackage, toc_by_href: dict[str, str], warnings: list[str]
) -> list[Chapter]:
    """按 spine 顺序遍历章节 XHTML。"""
    manifest_by_id: dict[str, ManifestItem] = {m.id: m for m in pkg.manifest}

    chapters: list[Chapter] = []
    order = 0
    for spine_item in pkg.spine:
        if not spine_item.linear:
            continue
        manifest_item = manifest_by_id.get(spine_item.idref)
        if manifest_item is None:
            continue
        if manifest_item.media_type not in (
            "application/xhtml+xml",
            "application/xhtml",
            "text/html",
        ):
            continue

        try:
            xhtml_bytes = container.read_member(zip_file, manifest_item.href)
        except InvalidContainerError:
            continue

        plain_text, html, word_count, recovered = parse_chapter(xhtml_bytes)
        if recovered:
            warnings.append(f"chapter recovered (lenient parse): {manifest_item.href}")

        # 章节 title：manifest 无，nav 有用 nav，nav 没有用 href 或序号
        title = _derive_chapter_title(manifest_item, toc_by_href, order)

        chapters.append(
            Chapter(
                id=manifest_item.id,
                title=title,
                order=order,
                href=manifest_item.href,
                text=plain_text,
                html=html,
                word_count=word_count,
            )
        )
        order += 1

    return chapters


def _derive_chapter_title(
    manifest_item: ManifestItem, toc_by_href: dict[str, str], order: int
) -> str:
    """从 nav TOC 兜底章节 title。"""
    # nav 里 href 可能不带 fragment、不带 OPF 所在目录前缀
    # 我们尝试匹配 href 末尾片段
    if manifest_item.href in toc_by_href:
        return toc_by_href[manifest_item.href]

    # 回退：用 href 的 basename（去掉 .xhtml）
    base = manifest_item.href.rsplit("/", 1)[-1]
    base = base.rsplit(".", 1)[0]
    if base and base != manifest_item.href:
        return base

    return f"Chapter {order + 1}"


def _build_assets(zip_file, pkg: OpfPackage) -> list[Asset]:
    """遍历 manifest，构造资源列表。封面判定：
    1. properties="cover-image"（EPUB 3 标准）
    2. <meta name="cover" content="..."/> 标记（EPUB 2 / calibre 风格 fallback）
    """
    cover_ids: set[str] = {
        m.id for m in pkg.manifest if "cover-image" in (m.properties or "").split()
    }
    if pkg.cover_meta_id:
        cover_ids.add(pkg.cover_meta_id)

    assets: list[Asset] = []
    for info in zip_file.infolist():
        if info.is_dir():
            continue
        # 找匹配的 manifest 项
        match = next((m for m in pkg.manifest if m.href == info.filename), None)
        if match is None:
            continue
        # 跳过章节（已经在 chapters 里）
        if match.media_type in (
            "application/xhtml+xml",
            "application/xhtml",
            "text/html",
        ):
            continue

        assets.append(
            Asset(
                id=match.id,
                href=match.href,
                media_type=match.media_type,
                size=info.file_size,
                is_cover=match.id in cover_ids,
            )
        )

    return assets
