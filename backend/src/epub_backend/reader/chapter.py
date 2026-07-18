"""XHTML 章节解析：用 lxml 提取纯文本，保留原始 HTML。

每个 EPUB 章节是一个 XHTML 文件，包含结构化的 HTML 内容。
这个模块负责：
1. 把 XHTML 解析成纯文本（用于搜索和字数统计）
2. 保留原始 HTML（用于前端阅读器渲染）
3. 处理非严格 XHTML 的容错（真实 EPUB 文件经常不规范）
"""

from __future__ import annotations

import re  # 正则表达式模块，用于文本清洗
from typing import TYPE_CHECKING

from lxml import etree

from epub_backend.reader.errors import CorruptEpubError

if TYPE_CHECKING:
    pass

# EPUB 3 XHTML 命名空间——所有 EPUB 3 的章节都是 XHTML 格式
XHTML_NS = "http://www.w3.org/1999/xhtml"

# 仅取 body 内容（忽略 head / metadata）
_BODY_TAGS = ("body", "section", "div", "article")


def parse_chapter(xhtml_bytes: bytes) -> tuple[str, str, int, bool]:
    """解析 XHTML 章节，返回 (纯文本, 原始 HTML, word_count, recovered)。

    tuple[str, str, int, bool]：返回值类型，包含 4 个元素的元组。
    - 纯文本：来自 body 的 .itertext() 拼接，段落用 \\n\\n 分隔
    - word_count：按 Unicode 词数估算（中文按字符）
    - 原始 HTML：UTF-8 解码后的字符串（保留原始内容，即使非良构）
    - recovered：严格 XML 解析失败、改用 recover 模式容错重试时为 True
    """
    try:
        text = xhtml_bytes.decode("utf-8")  # 把原始字节解码为字符串
    except UnicodeDecodeError as e:
        raise CorruptEpubError(
            f"章节不是 UTF-8 编码：{e}",
            phase="chapter_parse",
        ) from e

    recovered = False
    try:
        root = etree.fromstring(xhtml_bytes)  # 严格 XML 解析
    except etree.XMLSyntaxError:
        # 真实 EPUB 常含非严格 XHTML（如 href= 无值、属性未引号、未闭合标签），
        # 用 recover 模式容错重试，避免单章问题导致整本书导入失败。
        try:
            root = etree.fromstring(xhtml_bytes, parser=etree.XMLParser(recover=True))
            # recover=True：解析器会尝试修复错误而不是抛异常
        except etree.XMLSyntaxError as e:
            raise CorruptEpubError(
                f"章节不是合法 XML/XHTML：{e}",
                phase="chapter_parse",
            ) from e
        recovered = True  # 标记使用了容错模式

    # 找 body（或第一个 XHTML 块级元素）
    body = root.find(f".//{{{XHTML_NS}}}body")
    if body is None:
        # 回退：用整个 root（某些 EPUB 章节没有 body 标签）
        body = root

    plain_text = _extract_text(body)
    word_count = _count_words(plain_text)

    return plain_text, text, word_count, recovered


def _extract_text(el: etree._Element) -> str:
    """递归提取元素文本，块级元素之间用换行分隔。

    简化策略：把所有直接子 text 拼起来，按块级标签（p / div / h1-h6 / li）分段。
    etree._Element：lxml 的 XML 元素类型。
    """
    # 块级元素集合——这些元素在排版中会产生换行
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
    _walk(el, block_tags, parts)  # 深度优先遍历所有元素
    # 合并相邻空白，块级之间用 \n\n
    text = "".join(parts)
    text = re.sub(r"[ \t]+", " ", text)      # 多个空格/制表符合并为一个空格
    text = re.sub(r"\n[ \t]*", "\n", text)   # 去掉行首空白
    text = re.sub(r"\n{3,}", "\n\n", text)   # 连续 3 个以上换行合并为 2 个
    return text.strip()


def _walk(el: etree._Element, block_tags: set[str], parts: list[str]) -> None:
    """深度优先遍历，块级元素之间插入换行。

    lxml 元素有三个文本区域：
    - el.text：开标签后、第一个子元素前的文本
    - child.tail：子元素闭合标签后、下一个兄弟元素前的文本
    - el 本身的递归子元素

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
        if el.tail:  # tail：子元素闭合标签后的文本（属于父元素的"尾巴"）
            parts.append(el.tail)


def _count_words(text: str) -> int:
    """词数估算：CJK 字符每个算 1 词，ASCII 按空白分词。

    CJK（中日韩）字符：每个字符算一个词（因为中文没有空格分词）。
    ASCII 文字：按空白分词（英文等拉丁文字用空格分隔单词）。
    Unicode 范围判断：
    - "一" ~ "鿿"：CJK 统一汉字基本区
    - "぀" ~ "ヿ"：日文假名
    """
    if not text:
        return 0
    cjk = sum(1 for c in text if "一" <= c <= "鿿" or "぀" <= c <= "ヿ")
    # 把 CJK 字符替换为空格，剩下纯 ASCII/拉丁文本
    non_cjk = re.sub(r"[一-鿿぀-ヿ]", " ", text)
    ascii_words = len(re.findall(r"\S+", non_cjk))  # \S+：匹配一个或多个非空白字符
    return cjk + ascii_words
