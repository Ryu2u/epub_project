"""EPUB 领域模型：reader 的输出，service 层把它拆开存到 DB。

这些是"纯数据对象"（dataclass），不是 ORM 模型——它们只在解析阶段临时使用，
解析完成后由 BookService 转换成 ORM 对象写入数据库。
"""

from __future__ import annotations  # 延迟求值类型标注

from dataclasses import (  # dataclass：Python 的数据类装饰器，自动生成 __init__、__repr__ 等方法
    dataclass,
    field,
)
from datetime import date  # 日期类型（只有年月日，没有时分秒）


@dataclass(slots=True)
# @dataclass：装饰器，把这个类标记为"数据类"——自动为其生成 __init__（构造函数）、
# __repr__（打印）等方法
# slots=True：使用 __slots__ 优化内存，实例只能有声明的属性，不能动态添加新属性
class Asset:
    """EPUB 中的一个资源文件（图片、CSS、字体等）。"""
    id: str            # 资源 ID（来自 OPF manifest）
    href: str          # 资源在 ZIP 内的路径
    media_type: str    # MIME 类型（如 "image/jpeg"）
    size: int          # 字节大小
    is_cover: bool = False  # 是否是封面（默认不是）


@dataclass(slots=True)
class Chapter:
    """EPUB 中的一个章节。"""
    id: str           # 章节 ID（来自 OPF manifest item 的 id 属性）
    title: str        # 章节标题
    order: int        # 在 spine（阅读顺序）中的位置（0, 1, 2...）
    href: str         # 章节在 ZIP 内的路径
    text: str         # 提取的纯文本（用于搜索、字数统计）
    html: str         # 原始 HTML（用于前端渲染阅读器）
    word_count: int   # 字数


@dataclass(slots=True)
class Book:
    """解析出的书籍完整信息。

    这是 reader 模块的"输出"——一个完整的 Book 对象包含了
    从 EPUB 文件中解析出的所有信息。
    """
    id: str  # UUID（reader 不生成 UUID，留空由 service 填）
    title: str
    # field(default_factory=list)：默认值不能直接用 list（可变对象），
    # 必须用 default_factory 指定一个"工厂函数"，每次创建实例时调用它生成新的空列表
    authors: list[str] = field(default_factory=list)
    language: str = "en"
    # "str | None" 表示"可以是字符串，也可以是 None"——即可选字段
    publisher: str | None = None
    description: str | None = None
    pub_date: date | None = None
    identifier: str = ""
    chapters: list[Chapter] = field(default_factory=list)
    assets: list[Asset] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)  # 解析警告，如 "EPUB 2 NCX detected, ignored"
