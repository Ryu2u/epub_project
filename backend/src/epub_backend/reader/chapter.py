"""XHTML 章节解析：用 lxml 提取纯文本，保留原始 HTML。"""

from __future__ import annotations

import re
from typing import TYPE_CHECKING

from lxml import etree

from epub_backend.reader.errors import CorruptEpubError

if TYPE_CHECKING:
    pass

# EPUB 3 XHTML 命名空间
XHTML_NS = "http://www.w3.org/1999/xhtml"

# 仅取 body 内容（忽略 head / metadata）
_BODY_TAGS = ("body", "section", "div", "article")


def parse_chapter(xhtml_bytes: bytes) -> tuple[str, str, int, bool]:
    """解析 XHTML 章节，返回 (纯文本, 原始 HTML, word_count, recovered)。

    - 纯文本：来自 body 的 .itertext() 拼接，段落用 \\n\\n 分隔
    - word_count：按 Unicode 词数估算（中文按字符）
    - 原始 HTML：UTF-8 解码后的字符串（保留原始内容，即使非良构）
    - recovered：严格 XML 解析失败、改用 recover 模式容错重试时为 True
    """
    try:
        text = xhtml_bytes.decode("utf-8")
    except UnicodeDecodeError as e:
        raise CorruptEpubError(
            f"章节不是 UTF-8 编码：{e}",
            phase="chapter_parse",
        ) from e

    recovered = False
    try:
        root = etree.fromstring(xhtml_bytes)
    except etree.XMLSyntaxError:
        # 真实 EPUB 常含非严格 XHTML（如 href= 无值、属性未引号、未闭合标签），
        # 用 recover 模式容错重试，避免单章问题导致整本书导入失败。
        try:
            root = etree.fromstring(xhtml_bytes, parser=etree.XMLParser(recover=True))
        except etree.XMLSyntaxError as e:
            raise CorruptEpubError(
                f"章节不是合法 XML/XHTML：{e}",
                phase="chapter_parse",
            ) from e
        recovered = True

    # 找 body（或第一个 XHTML 块级元素）
    body = root.find(f".//{{{XHTML_NS}}}body")
    if body is None:
        # 回退：用整个 root
        body = root

    plain_text = _extract_text(body)
    word_count = _count_words(plain_text)

    return plain_text, text, word_count, recovered


def _extract_text(el: etree._Element) -> str:
    """递归提取元素文本，块级元素之间用换行分隔。

    简化策略：把所有直接子 text 拼起来，按块级标签（p / div / h1-h6 / li）分段。
    """
    block_tags = {
        f"{{{XHTML_NS}}}p",
        f"{{{XHTML_NS}}}div",
        f"{{{XHTML_NS}}}h1",
        f"{{{XHTML_NS}}}h2",
        f"{{{XHTML_NS}}}h3",
        f"{{{XHTML_NS}}}h4",
        f"{{{XHTML_NS}}}h5",
        f"{{{XHTML_NS}}}h6",
        f"{{{XHTML_NS}}}li",
        f"{{{XHTML_NS}}}br",
        f"{{{XHTML_NS}}}blockquote",
    }

    parts: list[str] = []
    _walk(el, block_tags, parts)
    # 合并相邻空白，块级之间用 \n\n
    text = "".join(parts)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n[ \t]*", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def _walk(el: etree._Element, block_tags: set[str], parts: list[str]) -> None:
    """深度优先遍历，块级元素之间插入换行。

    关键修复：进入 block 元素时，先 append 其 .text，再递归子元素；最后 append .tail。
    """
    if el.tag in block_tags:
        # 块级元素：先拿自己的 text（开标签到第一个子标签之间的内容）
        if el.text:
            parts.append(el.text)
        # 再递归子元素
        for child in el:
            _walk(child, block_tags, parts)
        # 块级元素自身的尾部（闭合标签前的空白）一般忽略
    else:
        # 行内元素：text 直接拼
        if el.text:
            parts.append(el.text)
        for child in el:
            _walk(child, block_tags, parts)
        if el.tail:
            parts.append(el.tail)


def _count_words(text: str) -> int:
    """词数估算：CJK 字符每个算 1 词，ASCII 按空白分词。"""
    if not text:
        return 0
    cjk = sum(1 for c in text if "一" <= c <= "鿿" or "぀" <= c <= "ヿ")
    non_cjk = re.sub(r"[一-鿿぀-ヿ]", " ", text)
    ascii_words = len(re.findall(r"\S+", non_cjk))
    return cjk + ascii_words
