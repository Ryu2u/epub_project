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
"""

from __future__ import annotations

from lxml import etree

XHTML_NS = "http://www.w3.org/1999/xhtml"
EPUB_NS = "http://www.idpf.org/2007/ops"


def parse_nav_toc(nav_bytes: bytes, nav_href: str = "") -> dict[str, str]:
    """解析 nav.xhtml，返回 {href: title}。

    只看 epub:type="toc" 的 nav（或第一个 nav）。
    href 可能是相对的（相对于 nav 所在目录）。nav_href 是 nav 在 zip 内的完整路径，
    用于把 nav 里的 href 归一化到 zip 内绝对路径（与 OPF manifest href 对齐）。
    """
    try:
        root = etree.fromstring(nav_bytes)
    except etree.XMLSyntaxError:
        return {}

    # 找 toc nav（按 epub:type）
    navs = root.findall(f".//{{{XHTML_NS}}}nav")
    toc_nav = None
    for n in navs:
        if n.get(f"{{{EPUB_NS}}}type") == "toc":
            toc_nav = n
            break
    if toc_nav is None and navs:
        toc_nav = navs[0]
    if toc_nav is None:
        return {}

    # nav 所在目录
    base_dir = nav_href.rsplit("/", 1)[0] if "/" in nav_href else ""

    result: dict[str, str] = {}
    for a in toc_nav.findall(f".//{{{XHTML_NS}}}a"):
        href = a.get("href", "").strip()
        # 去掉 fragment (#anchor)
        if "#" in href:
            href = href.split("#", 1)[0]
        title = "".join(a.itertext()).strip()
        if not href or not title:
            continue
        # 归一化：相对 base_dir
        if base_dir and not href.startswith("/"):
            full = f"{base_dir}/{href}"
            full = _normalize(full)
            result[full] = title
        result[href] = title  # 同时保留原 href 便于 basename 兜底匹配

    return result


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


def has_ncx(zip_namelist: list[str]) -> bool:
    """是否含 EPUB 2 的 toc.ncx（用于发 warning，不强求解析）。"""
    for name in zip_namelist:
        if name.endswith("toc.ncx"):
            return True
    return False
