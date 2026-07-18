"""nav.xhtml 解析：从 nav 文档提取章节 title 兜底。

EPUB 3 nav 文档结构示例：
<nav epub:type="toc">
  <h1>目录</h1>
  <ol>
    <li><a href="chapter1.xhtml">第一章</a></li>
    <li><a href="chapter2.xhtml">第二章</a></li>
  </ol>
</nav>

我们用 (href, title) 的列表返回，orchestrator 按 href 在 manifest 中匹配来兜底 title。
同时支持 EPUB 2 的 NCX 格式作为回退。

为什么需要兜底？因为有些 EPUB 的 manifest 里章节没有标题信息，
只有 nav.xhtml 或 toc.ncx 里才有人类可读的章节标题。
"""

from __future__ import annotations

from lxml import etree

# 命名空间常量
XHTML_NS = "http://www.w3.org/1999/xhtml"         # XHTML 命名空间
EPUB_NS = "http://www.idpf.org/2007/ops"          # EPUB 自身的命名空间（用于 epub:type 属性）
NCX_NS = "http://www.daisy.org/z3986/2005/ncx/"  # EPUB 2 NCX 导航文档的命名空间


def parse_nav_toc(nav_bytes: bytes, nav_href: str = "") -> dict[str, str]:
    """解析 nav.xhtml，返回 {href: title}。

    只看 epub:type="toc" 的 nav（或第一个 nav）。
    epub:type="toc" 标记这是目录（Table of Contents）导航。
    href 可能是相对的（相对于 nav 所在目录）。nav_href 是 nav 在 zip 内的完整路径，
    用于把 nav 里的 href 归一化到 zip 内绝对路径（与 OPF manifest href 对齐）。
    """
    try:
        root = etree.fromstring(nav_bytes)  # 从字节解析 XML
    except etree.XMLSyntaxError:
        return {}  # 解析失败返回空字典（容错，不影响其他解析）

    # 找 toc nav（按 epub:type 属性查找）
    # 双花括号 {{{XHTML_NS}}} 是 f-string 中的转义：外层 {} 是 f-string，内层 {} 是命名空间
    navs = root.findall(f".//{{{XHTML_NS}}}nav")  # 查找所有 <nav> 元素
    toc_nav = None
    for n in navs:
        if n.get(f"{{{EPUB_NS}}}type") == "toc":  # 找 epub:type="toc" 的那个
            toc_nav = n
            break
    if toc_nav is None and navs:
        toc_nav = navs[0]  # 找不到带 toc 标记的，就用第一个 <nav>
    if toc_nav is None:
        return {}

    # nav 所在目录（用于把相对 href 转成绝对路径）
    base_dir = nav_href.rsplit("/", 1)[0] if "/" in nav_href else ""

    result: dict[str, str] = {}
    for a in toc_nav.findall(f".//{{{XHTML_NS}}}a"):  # 查找目录中的所有 <a> 链接
        href = a.get("href", "").strip()
        # 去掉 fragment (#anchor)，例如 "chapter1.xhtml#section2" -> "chapter1.xhtml"
        if "#" in href:
            href = href.split("#", 1)[0]
        # itertext()：递归获取元素内所有文本节点的拼接
        title = "".join(a.itertext()).strip()
        if not href or not title:
            continue
        # 归一化：把相对路径拼成 zip 内绝对路径
        if base_dir and not href.startswith("/"):
            full = f"{base_dir}/{href}"
            full = _normalize(full)
            result[full] = title
        result[href] = title  # 同时保留原 href 便于 basename 兜底匹配

    return result


def _normalize(path: str) -> str:
    """规范化路径：处理 "./" 和 "../" 相对路径标记。"""
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


def has_ncx(zip_namelist: list[str]) -> bool:
    """是否含 EPUB 2 的 toc.ncx。

    NCX（Navigation Center eXtended）是 EPUB 2 的目录格式，
    EPUB 3 用 nav.xhtml 替代，但很多 EPUB 文件同时包含两者以兼容。
    """
    return find_ncx(zip_namelist) is not None


def find_ncx(zip_namelist: list[str]) -> str | None:
    """返回 zip 内 toc.ncx 的路径，没有返回 None。"""
    for name in zip_namelist:
        if name.endswith("toc.ncx"):  # 遍历 ZIP 内所有文件名，找以 toc.ncx 结尾的
            return name
    return None


def parse_ncx_toc(ncx_bytes: bytes, ncx_href: str = "") -> dict[str, str]:
    """解析 EPUB 2 toc.ncx 的 navMap，返回 {href: title}。

    作为 EPUB 3 nav 缺失时的标题兜底（纯 EPUB 2 书籍的目录来源）。
    结构：<navMap><navPoint><navLabel><text>标题</text></navLabel><content src="..."/></navPoint>
    navMap 是 NCX 的核心：一个嵌套的导航点树，每个 navPoint 代表一个目录条目。

    ncx_href 是 ncx 在 zip 内的完整路径，用于把 content src 归一化到 zip 内绝对路径
    （与 OPF manifest href 对齐）。
    """
    try:
        root = etree.fromstring(ncx_bytes)
    except etree.XMLSyntaxError:
        return {}

    base_dir = ncx_href.rsplit("/", 1)[0] if "/" in ncx_href else ""

    result: dict[str, str] = {}
    for pt in root.findall(f".//{{{NCX_NS}}}navPoint"):  # 查找所有导航点
        label_el = pt.find(f".//{{{NCX_NS}}}text")      # 导航点的标题文本
        content_el = pt.find(f"{{{NCX_NS}}}content")     # 导航点对应的内容链接
        if label_el is None or content_el is None:
            continue
        title = "".join(label_el.itertext()).strip()
        href = (content_el.get("src") or "").strip()
        if "#" in href:
            href = href.split("#", 1)[0]  # 去掉 fragment
        if not href or not title:
            continue
        if base_dir and not href.startswith("/"):
            full = _normalize(f"{base_dir}/{href}")
            result[full] = title
        result[href] = title  # 同时保留原 href 便于兜底匹配

    return result
