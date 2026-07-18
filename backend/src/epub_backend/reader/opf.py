"""OPF (Open Packaging Format) 解析：metadata / manifest / spine。

OPF 是 EPUB 的"目录文件"，通常叫 content.opf。它包含三大部分：
1. metadata：书籍元数据（标题、作者、语言、ISBN 等）
2. manifest：所有文件的清单（章节、图片、CSS 等），每个条目有 id、路径、MIME 类型
3. spine：阅读顺序——按什么顺序显示章节
"""

from __future__ import annotations

from dataclasses import dataclass, field  # dataclass：数据类装饰器；field：字段详细配置
from datetime import date
from typing import TYPE_CHECKING

from lxml import etree  # lxml XML 解析库

from epub_backend.reader.errors import CorruptEpubError, IncompleteMetadataError

if TYPE_CHECKING:
    pass

# EPUB 3 OPF 命名空间——XML 元素前缀对应的 URI
OPF_NS = "http://www.idpf.org/2007/opf"          # OPF 包描述的命名空间
# Dublin Core 元数据标准的命名空间（描述"谁、什么、何时"）
DC_NS = "http://purl.org/dc/elements/1.1/"

# EPUB 规范要求的必填元数据字段
REQUIRED_DC_FIELDS = ("title", "language", "identifier")


@dataclass(slots=True)
# slots=True：用 __slots__ 优化，实例不能有声明之外的属性，节省内存
class ManifestItem:
    """OPF manifest 中的一个条目——描述 EPUB 内的一个文件。

    对应 OPF 中的 <item id="..." href="..." media-type="..." properties="..."/>
    """
    id: str            # 条目 ID（如 "chapter1"、"cover-image"）
    href: str          # 文件在 ZIP 内的完整路径（已相对于 OPF 所在目录解析）
    media_type: str    # MIME 类型（如 "application/xhtml+xml"、"image/jpeg"）
    properties: str = ""  # 特性标记，空格分隔（如 "nav" 表示导航文档，"cover-image" 表示封面）


@dataclass(slots=True)
class SpineItem:
    """OPF spine 中的一个条目——定义阅读顺序。

    spine 是一个"播放列表"，告诉阅读器按什么顺序显示章节。
    对应 OPF 中的 <itemref idref="..." linear="yes/no"/>
    """
    idref: str                # 引用 manifest 中某个条目的 id
    linear: bool = True       # True = 主线阅读顺序；False = 辅助内容（如脚注页）


@dataclass(slots=True)
class OpfPackage:
    """解析后的 OPF 包对象——包含 metadata、manifest、spine 三部分。"""
    metadata: dict[str, list[str]] = field(default_factory=dict)
    # metadata 格式：{"title": ["书名"], "creator": ["作者1", "作者2"], ...}
    # 用 list 因为某些字段可能有多个值（如多个作者）

    manifest: list[ManifestItem] = field(default_factory=list)
    spine: list[SpineItem] = field(default_factory=list)

    # nav 文档（properties="nav" 的 manifest 项），可能为 None
    # EPUB 3 的导航文档是 nav.xhtml，包含目录结构
    nav_href: str | None = None

    # EPUB 2 / calibre 风格 <meta name="cover" content="..."/> 标记的封面 manifest id
    # 一些旧 EPUB 文件通过这种方式指定封面图片
    cover_meta_id: str | None = None


def parse_opf(opf_bytes: bytes, opf_path: str) -> OpfPackage:
    """解析 content.opf 字节，返回结构化包对象。

    opf_path 是 zip 内路径（如 "OEBPS/content.opf"），用于解析 manifest href 的相对基址。
    因为 manifest 中的 href 都是相对于 OPF 所在目录的路径。
    """
    try:
        root = etree.fromstring(opf_bytes)  # 从字节解析 XML，返回根元素
    except etree.XMLSyntaxError as e:
        raise CorruptEpubError(f"OPF 不是合法 XML：{e}", phase="opf_parse") from e

    # base href：OPF 自身所在目录，用于拼接 manifest 中的相对路径
    # rsplit("/", 1)[0] 按最后一个 "/" 分割取前半部分
    # 例如 "OEBPS/content.opf" → "OEBPS"
    base_dir = opf_path.rsplit("/", 1)[0] if "/" in opf_path else ""

    pkg = OpfPackage()

    # ---------- metadata ----------
    # 在 XML 中查找 <metadata> 元素，{} 内是命名空间 URI
    metadata_el = root.find(f"{{{OPF_NS}}}metadata")
    if metadata_el is None:
        raise CorruptEpubError("OPF 缺少 <metadata> 元素", phase="opf_parse")

    # 遍历 Dublin Core 元数据字段
    # dc:* 字段可能有多个（如多个 creator 代表多个作者）
    for tag in ("title", "creator", "language", "identifier", "publisher", "description", "date"):
        values = []
        for el in metadata_el.findall(f"{{{DC_NS}}}{tag}"):  # findall：查找所有匹配元素
            text = (el.text or "").strip()  # el.text：元素的文本内容；or ""：防止 None
            if text:
                values.append(text)
        if values:
            pkg.metadata[tag] = values

    # 兼容性封面：EPUB 2 / calibre 风格 <meta name="cover" content="..."/>
    # 旧版 EPUB 用这种方式在元数据里标记封面是哪个 manifest 条目
    for el in metadata_el.findall(f"{{{OPF_NS}}}meta"):
        if el.get("name") == "cover":
            content = (el.get("content") or "").strip()
            if content:
                pkg.cover_meta_id = content
                break

    # ---------- manifest ----------
    # manifest 列出 EPUB 内所有文件及其类型
    manifest_el = root.find(f"{{{OPF_NS}}}manifest")
    if manifest_el is None:
        raise CorruptEpubError("OPF 缺少 <manifest> 元素", phase="opf_parse")

    for item in manifest_el.findall(f"{{{OPF_NS}}}item"):
        item_id = item.get("id", "")
        href = item.get("href", "")
        media_type = item.get("media-type", "")
        properties = item.get("properties", "") or ""

        if not item_id or not href or not media_type:
            # 跳过不完整条目（罕见但应容错）
            continue

        # href 相对于 OPF 所在目录，拼成完整 zip 内路径
        full_href = f"{base_dir}/{href}" if base_dir else href
        full_href = _normalize_path(full_href)  # 规范化路径（处理 "../" 等）

        mi = ManifestItem(
            id=item_id,
            href=full_href,
            media_type=media_type,
            properties=properties,
        )
        pkg.manifest.append(mi)

        # 检查这个条目是否是导航文档（EPUB 3 用 properties="nav" 标记）
        if "nav" in properties.split():  # split() 按空格拆分，检查 "nav" 是否在属性列表中
            pkg.nav_href = full_href

    # ---------- spine ----------
    # spine 定义章节的阅读顺序
    spine_el = root.find(f"{{{OPF_NS}}}spine")
    if spine_el is None:
        raise CorruptEpubError("OPF 缺少 <spine> 元素", phase="opf_parse")

    for itemref in spine_el.findall(f"{{{OPF_NS}}}itemref"):
        idref = itemref.get("idref", "")
        if not idref:
            continue
        # linear="no" 表示辅助内容（如脚注），默认是 "yes"（主线内容）
        linear = itemref.get("linear", "yes").lower() != "no"
        pkg.spine.append(SpineItem(idref=idref, linear=linear))

    # ---------- 必填字段校验 ----------
    # EPUB 规范要求至少有 title、language、identifier
    missing = [f for f in REQUIRED_DC_FIELDS if f not in pkg.metadata or not pkg.metadata[f]]
    if missing:
        raise IncompleteMetadataError(
            f"OPF 缺少必填 dc 字段：{', '.join(missing)}",
            missing=missing,
        )

    return pkg


def parse_pub_date(values: list[str] | None) -> date | None:
    """OPF dc:date 可能为 'YYYY' / 'YYYY-MM-DD' / 'YYYY-MM-DDThh:mm:ssZ'，尝试解析。

    EPUB 文件的日期格式不统一，需要逐个尝试匹配。
    strptime 的 %Y/%m/%d/%H/%M/%S 是日期格式占位符：
    %Y=四位年, %m=月, %d=日, %H=时, %M=分, %S=秒
    """
    if not values:
        return None
    text = values[0].strip()
    # 尝试多种格式，从最完整到最简短
    for fmt in ("%Y-%m-%dT%H:%M:%SZ", "%Y-%m-%d", "%Y-%m", "%Y"):
        try:
            from datetime import datetime

            d = datetime.strptime(text, fmt).date()  # strptime：按格式解析字符串为 datetime
            return d
        except ValueError:  # 格式不匹配则尝试下一个
            continue
    return None  # 所有格式都不匹配


def _normalize_path(path: str) -> str:
    """把 'a/b/../c' 这样的相对路径规范化（不跨越顶级目录）。

    处理路径中的 "."（当前目录）和 ".."（上级目录）。
    例如 "OEBPS/images/../styles/main.css" → "OEBPS/styles/main.css"
    """
    parts: list[str] = []
    for p in path.split("/"):
        if p in ("", "."):  # 跳过空字符串和当前目录标记
            continue
        if p == "..":       # 上级目录：弹出最后一个路径段
            if parts:
                parts.pop()
            continue
        parts.append(p)
    return "/".join(parts)
