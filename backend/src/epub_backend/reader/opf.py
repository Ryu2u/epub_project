"""OPF (Open Packaging Format) 解析：metadata / manifest / spine。"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from typing import TYPE_CHECKING

from lxml import etree

from epub_backend.reader.errors import CorruptEpubError, IncompleteMetadataError

if TYPE_CHECKING:
    pass

# EPUB 3 OPF 命名空间
OPF_NS = "http://www.idpf.org/2007/opf"
DC_NS = "http://purl.org/dc/elements/1.1/"

REQUIRED_DC_FIELDS = ("title", "language", "identifier")


@dataclass(slots=True)
class ManifestItem:
    id: str
    href: str
    media_type: str
    properties: str = ""  # 空格分隔，如 "nav cover-image"


@dataclass(slots=True)
class SpineItem:
    idref: str
    linear: bool = True


@dataclass(slots=True)
class OpfPackage:
    metadata: dict[str, list[str]] = field(default_factory=dict)
    manifest: list[ManifestItem] = field(default_factory=list)
    spine: list[SpineItem] = field(default_factory=list)
    # nav 文档（properties="nav" 的 manifest 项），可能为 None
    nav_href: str | None = None
    # EPUB 2 / calibre 风格 <meta name="cover" content="..."/> 标记的封面 manifest id
    cover_meta_id: str | None = None


def parse_opf(opf_bytes: bytes, opf_path: str) -> OpfPackage:
    """解析 content.opf 字节，返回结构化包对象。

    opf_path 是 zip 内路径（如 "OEBPS/content.opf"），用于解析 manifest href 的相对基址。
    """
    try:
        root = etree.fromstring(opf_bytes)
    except etree.XMLSyntaxError as e:
        raise CorruptEpubError(f"OPF 不是合法 XML：{e}", phase="opf_parse") from e

    # base href：OPF 自身所在目录
    base_dir = opf_path.rsplit("/", 1)[0] if "/" in opf_path else ""

    pkg = OpfPackage()

    # ---------- metadata ----------
    metadata_el = root.find(f"{{{OPF_NS}}}metadata")
    if metadata_el is None:
        raise CorruptEpubError("OPF 缺少 <metadata> 元素", phase="opf_parse")

    # dc:* 字段可能有多个（如多个 creator）
    for tag in ("title", "creator", "language", "identifier", "publisher", "description", "date"):
        values = []
        for el in metadata_el.findall(f"{{{DC_NS}}}{tag}"):
            text = (el.text or "").strip()
            if text:
                values.append(text)
        if values:
            pkg.metadata[tag] = values

    # 兼容性封面：EPUB 2 / calibre 风格 <meta name="cover" content="..."/>
    for el in metadata_el.findall(f"{{{OPF_NS}}}meta"):
        if el.get("name") == "cover":
            content = (el.get("content") or "").strip()
            if content:
                pkg.cover_meta_id = content
                break

    # ---------- manifest ----------
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
        full_href = _normalize_path(full_href)

        mi = ManifestItem(
            id=item_id,
            href=full_href,
            media_type=media_type,
            properties=properties,
        )
        pkg.manifest.append(mi)

        if "nav" in properties.split():
            pkg.nav_href = full_href

    # ---------- spine ----------
    spine_el = root.find(f"{{{OPF_NS}}}spine")
    if spine_el is None:
        raise CorruptEpubError("OPF 缺少 <spine> 元素", phase="opf_parse")

    for itemref in spine_el.findall(f"{{{OPF_NS}}}itemref"):
        idref = itemref.get("idref", "")
        if not idref:
            continue
        linear = itemref.get("linear", "yes").lower() != "no"
        pkg.spine.append(SpineItem(idref=idref, linear=linear))

    # ---------- 必填字段校验 ----------
    missing = [f for f in REQUIRED_DC_FIELDS if f not in pkg.metadata or not pkg.metadata[f]]
    if missing:
        raise IncompleteMetadataError(
            f"OPF 缺少必填 dc 字段：{', '.join(missing)}",
            missing=missing,
        )

    return pkg


def parse_pub_date(values: list[str] | None) -> date | None:
    """OPF dc:date 可能为 'YYYY' / 'YYYY-MM-DD' / 'YYYY-MM-DDThh:mm:ssZ'，尝试解析。"""
    if not values:
        return None
    text = values[0].strip()
    for fmt in ("%Y-%m-%dT%H:%M:%SZ", "%Y-%m-%d", "%Y-%m", "%Y"):
        try:
            from datetime import datetime

            d = datetime.strptime(text, fmt).date()
            return d
        except ValueError:
            continue
    return None


def _normalize_path(path: str) -> str:
    """把 'a/b/../c' 这样的相对路径规范化（不跨越顶级目录）。"""
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
