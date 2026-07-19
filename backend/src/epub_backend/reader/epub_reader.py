"""EpubReader 顶层编排：open(path) -> Book。

这是 EPUB 解析的"指挥官"——协调各个子模块按正确顺序完成解析。

调用顺序：
1. 打开 ZIP
2. 校验 mimetype（确认是 EPUB 格式）
3. DRM 检测（不支持加密书籍）
4. 读 container.xml -> 找到 rootfile (OPF) 路径
5. 解析 OPF（元数据 / 文件清单 / 阅读顺序）
6. （可选）解析 nav.xhtml 用于章节标题兜底
7. 按 spine 顺序遍历章节 XHTML -> 提取纯文本和 HTML
8. 构造资源（图片、CSS）列表
9. 返回 Book 对象（id 留空，由 service 层生成 UUID）
"""

from __future__ import annotations

from pathlib import Path  # 文件路径操作
from typing import BinaryIO  # 二进制流类型（如 BytesIO）

from epub_backend.reader import container, nav  # 导入子模块
from epub_backend.reader.chapter import parse_chapter
from epub_backend.reader.errors import (
    DRMError,
    FileSystemError,
    InvalidContainerError,
)
from epub_backend.reader.models import Asset, Book, Chapter  # 领域模型
from epub_backend.reader.nav import XHTML_NS  # 用于 XHTML <title> 提取
from epub_backend.reader.opf import (
    ManifestItem,
    OpfPackage,
    parse_opf,
    parse_pub_date,
)


def open_epub(source: str | Path | BinaryIO) -> Book:
    """解析一个 EPUB 文件，返回 Book 对象。

    source 可以是文件路径（str / Path）或二进制流（UploadFile 等）。
    这是同步函数——因为 EPUB 解析是 CPU 密集操作，不涉及网络 IO。
    BookService 会通过 asyncio.to_thread() 把它放到线程池里执行。
    """
    zip_file = container.open_zip(source)  # 打开 ZIP 文件

    try:
        # 1. mimetype 校验：确认是合法的 EPUB 格式
        container.validate_mimetype(zip_file)

        # 2. DRM 检测：不支持加密的 EPUB
        if container.has_drm(zip_file):
            raise DRMError("EPUB 含 META-INF/encryption.xml，不支持")

        # 3. 找 rootfile：从 container.xml 中读取 OPF 文件路径
        opf_path = container.find_rootfile(zip_file)

        # 4. 解析 OPF：读取元数据、文件清单、阅读顺序
        try:
            opf_bytes = container.read_member(zip_file, opf_path)
        except Exception as e:
            raise FileSystemError(f"无法读取 OPF：{e}") from e

        pkg = parse_opf(opf_bytes, opf_path)  # 解析为结构化的 OpfPackage 对象

        # 5. 目录解析：EPUB 3 nav 优先；缺失或为空时回退解析 EPUB 2 NCX navMap
        warnings: list[str] = []  # 收集解析过程中的警告信息

        toc_by_href: dict[str, str] = {}  # {章节路径: 章节标题} 映射
        if pkg.nav_href:  # 有 EPUB 3 nav 文档
            try:
                nav_bytes = container.read_member(zip_file, pkg.nav_href)
                toc_by_href = nav.parse_nav_toc(nav_bytes, nav_href=pkg.nav_href)
            except Exception:  # nav 解析失败不影响整体，只是标题缺失
                toc_by_href = {}

        if not toc_by_href:  # nav 解析不出标题，尝试 EPUB 2 NCX
            ncx_name = nav.find_ncx(zip_file.namelist())
            if ncx_name:
                try:
                    ncx_bytes = container.read_member(zip_file, ncx_name)
                    toc_by_href = nav.parse_ncx_toc(ncx_bytes, ncx_href=ncx_name)
                except Exception:
                    toc_by_href = {}
                if toc_by_href:
                    warnings.append("EPUB 2 NCX used for chapter titles (no EPUB 3 nav)")

        # 6. 章节：按 spine 顺序遍历，提取纯文本和 HTML
        chapters = _build_chapters(zip_file, pkg, toc_by_href, warnings)

        # 7. 资源：收集图片、CSS、字体等非章节文件
        assets = _build_assets(zip_file, pkg)

        # 8. 组装 Book：把所有解析结果组装成一个 Book 对象
        # pkg.metadata["title"][0] 因为 title 是必填必存在的字段
        book = Book(
            id="",  # service 层填 UUID
            title=pkg.metadata["title"][0],
            authors=pkg.metadata.get("creator", []),           # creator 是作者字段
            language=pkg.metadata["language"][0],
            # or [None] 确保列表不为空，取第一个
            publisher=(pkg.metadata.get("publisher") or [None])[0],
            description=(pkg.metadata.get("description") or [None])[0],
            pub_date=parse_pub_date(pkg.metadata.get("date")),        # 解析多种日期格式
            identifier=pkg.metadata["identifier"][0],
            chapters=chapters,
            assets=assets,
            warnings=warnings,
        )

        return book
    finally:
        zip_file.close()  # 无论成功还是失败，都关闭 ZIP 文件


def _build_chapters(
    zip_file, pkg: OpfPackage, toc_by_href: dict[str, str], warnings: list[str]
) -> list[Chapter]:
    """按 spine 顺序遍历章节 XHTML。

    spine 是 EPUB 的"播放列表"，定义了章节的阅读顺序。
    只处理 linear=True 的主线章节（跳过辅助内容如脚注页）。
    """
    # 把 manifest 列表转成字典，方便按 id 查找
    manifest_by_id: dict[str, ManifestItem] = {m.id: m for m in pkg.manifest}

    chapters: list[Chapter] = []
    order = 0  # 章节序号（0, 1, 2...）
    for spine_item in pkg.spine:
        if not spine_item.linear:  # 跳过非主线内容
            continue
        manifest_item = manifest_by_id.get(spine_item.idref)  # 通过 idref 找到 manifest 条目
        if manifest_item is None:
            continue
        # 只处理 XHTML 类型的条目（跳过图片、CSS 等资源）
        if manifest_item.media_type not in (
            "application/xhtml+xml",      # EPUB 3 标准 XHTML
            "application/xhtml",           # 通用 XHTML（少用）
            "text/html",                   # HTML 兜底
            "text/x-oebps-document",       # EPUB 2 标准 OPS（Calibre/Sigil 旧版常用）
            "text/x-oebps-1",             # EPUB 2 早期变体
        ):
            continue

        try:
            xhtml_bytes = container.read_member(zip_file, manifest_item.href)
        except InvalidContainerError:
            continue  # 文件缺失则跳过（容错）

        plain_text, html, word_count, recovered = parse_chapter(xhtml_bytes)
        if recovered:
            warnings.append(f"chapter recovered (lenient parse): {manifest_item.href}")

        # 提取 XHTML <head><title> 作为最后的标题来源（比裸文件名更友好）
        xhtml_title = _extract_xhtml_title(xhtml_bytes)

        # 章节 title：多级兜底（nav/NCX → basename → xhtml title → 文件名）
        title = _derive_chapter_title(manifest_item, toc_by_href, order, xhtml_title)

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
    manifest_item: ManifestItem,
    toc_by_href: dict[str, str],
    order: int,
    xhtml_title: str = "",
) -> str:
    """从 nav/NCX TOC 兜底章节 title。

    章节标题的获取优先级：
    1. nav.xhtml / toc.ncx 中按完整 href 匹配（最可靠）
    2. nav.xhtml / toc.ncx 中按 basename 匹配（处理路径前缀不一致的 EPUB）
    3. XHTML <head><title> 内容（真实文件自带的标题，比裸文件名更友好）
    4. 文件名去掉后缀作为标题（如 "chapter01.xhtml" -> "chapter01"）
    5. "Chapter N" 作为最终兜底
    """
    # 1. 直接 href 匹配
    if manifest_item.href in toc_by_href:
        return toc_by_href[manifest_item.href]

    # 2. basename 匹配（处理 OEBPS/ch.xhtml vs ch.xhtml 路径不一致的情况）
    basename = manifest_item.href.rsplit("/", 1)[-1]
    if basename in toc_by_href:
        return toc_by_href[basename]

    # 3. XHTML <head><title>（如 "插图"、"版权页"、"内容简介" 等）
    if xhtml_title:
        return xhtml_title

    # 4. 文件名去掉扩展名
    base = basename.rsplit(".", 1)[0]
    if base and base != manifest_item.href:
        return base

    return f"Chapter {order + 1}"  # 5. 最终兜底


def _extract_xhtml_title(xhtml_bytes: bytes) -> str:
    """从 XHTML 字节中快速提取 <head><title> 内容，用于章节标题兜底。

    只解析 <title> 元素（不解析 body），比完整 parse_chapter 轻量。
    返回空字符串表示没有 <title> 或解析失败。
    """
    from lxml import etree

    parser = etree.XMLParser(recover=True)  # 容错模式（真实 EPUB 经常非严格 XHTML）
    try:
        root = etree.fromstring(xhtml_bytes, parser=parser)
    except Exception:
        return ""

    # 遍历所有 <title> 元素（兼容带/不带命名空间），取第一个有文本的
    for title_el in root.iter(f"{{{XHTML_NS}}}title", "title"):
        text = "".join(title_el.itertext()).strip()
        if text:
            return text
    return ""


def _build_assets(zip_file, pkg: OpfPackage) -> list[Asset]:
    """遍历 manifest，构造资源列表。

    资源是 EPUB 中的非章节文件（图片、CSS、字体等）。
    封面判定：
    1. properties="cover-image"（EPUB 3 标准方式）
    2. <meta name="cover" content="..."/> 标记（EPUB 2 / calibre 风格 fallback）
    """
    # 收集所有被标记为封面的 manifest ID
    cover_ids: set[str] = {
        m.id for m in pkg.manifest if "cover-image" in (m.properties or "").split()
    }
    if pkg.cover_meta_id:
        cover_ids.add(pkg.cover_meta_id)  # 加入 EPUB 2 风格的封面 ID

    assets: list[Asset] = []
    for info in zip_file.infolist():  # infolist()：列出 ZIP 内所有条目的详细信息
        if info.is_dir():
            continue  # 跳过目录
        # 找匹配的 manifest 项：通过 ZIP 内路径与 manifest href 匹配
        match = next((m for m in pkg.manifest if m.href == info.filename), None)
        if match is None:
            continue  # manifest 中没有的文件不处理
        # 跳过章节文件（已经在 chapters 列表里了）
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
                is_cover=match.id in cover_ids,  # 是否是封面
            )
        )

    return assets
