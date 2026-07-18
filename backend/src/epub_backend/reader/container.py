"""EPUB 容器解析：mimetype 文件 + META-INF/container.xml。

EPUB 3 容器规则：
- 压缩包第一个 entry 必须是 'mimetype' 文件，内容是 'application/epub+zip'（无 BOM、无换行）。
- META-INF/container.xml 指向包文档（OPF），通常是 OEBPS/content.opf。

一个 EPUB 文件本质上是一个 ZIP 压缩包，container.xml 就像"地址簿"，
告诉阅读器去哪里找书籍描述文件（OPF）。
"""

from __future__ import annotations

from pathlib import Path  # 文件路径操作
from typing import BinaryIO  # 二进制流类型标注（如 BytesIO 对象）
from zipfile import ZipFile  # Python 标准库的 ZIP 文件读取

from lxml import etree  # lxml 是高性能的 XML 解析库，etree 是其核心 API

from epub_backend.reader.errors import InvalidContainerError

# XML 命名空间常量
# XML 命名空间用来区分不同标准定义的同名元素，格式是 URI 字符串
CONTAINER_NS = "urn:oasis:names:tc:opendocument:xmlns:container"  # EPUB container.xml 的命名空间
EXPECTED_MIMETYPE = "application/epub+zip"  # EPUB 规范要求的 mimetype 内容
MIMETYPE_ENTRY = "mimetype"  # mimetype 文件在 ZIP 中的路径


def validate_mimetype(zip_file: ZipFile) -> None:
    """验证压缩包第一个 entry 是 mimetype 且内容正确。

    EPUB 规范要求 mimetype 是 ZIP 第一个 entry 且未压缩。
    这里只验证内容正确；解压顺序由 reader orchestrator 在打开时控制。
    """
    try:
        with zip_file.open(MIMETYPE_ENTRY) as f:  # 打开 ZIP 内的 mimetype 文件
            content = f.read().decode("ascii").strip()  # 读取内容并用 ASCII 解码
    except KeyError as e:  # KeyError：ZIP 内找不到 mimetype 文件
        raise InvalidContainerError(
            "压缩包缺少 mimetype 文件（不是合法的 EPUB 容器）",
            phase="container_parse",
        ) from e  # from e：保留原始异常链，便于调试追踪
    except UnicodeDecodeError as e:  # 文件内容不是 ASCII 编码
        raise InvalidContainerError(
            "mimetype 文件不是 ASCII",
            phase="container_parse",
        ) from e

    if content != EXPECTED_MIMETYPE:
        raise InvalidContainerError(
            f"mimetype 内容错误：期望 '{EXPECTED_MIMETYPE}'，实际 '{content}'",
            phase="container_parse",
        )


def find_rootfile(zip_file: ZipFile) -> str:
    """读 META-INF/container.xml，返回 rootfile 的 OPF 完整路径（zip 内）。

    container.xml 示例：
    <container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">
      <rootfiles>
        <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
      </rootfiles>
    </container>

    rootfile 元素的 full-path 属性就是 OPF 文件在 ZIP 内的路径。
    """
    try:
        with zip_file.open("META-INF/container.xml") as f:
            tree = etree.parse(f)  # 解析 XML 文档，返回 ElementTree 对象
    except KeyError as e:  # ZIP 内找不到 container.xml
        raise InvalidContainerError(
            "缺少 META-INF/container.xml",
            phase="container_parse",
        ) from e
    except etree.XMLSyntaxError as e:  # XML 语法错误
        raise InvalidContainerError(
            f"META-INF/container.xml 不是合法 XML：{e}",
            phase="container_parse",
        ) from e

    # XPath 查找带命名空间的 rootfile 元素
    # "c:" 是命名空间前缀的占位符，对应 namespaces 字典中的实际 URI
    ns = {"c": CONTAINER_NS}
    rootfile = tree.find(".//c:rootfile", namespaces=ns)
    if rootfile is None:
        raise InvalidContainerError(
            "META-INF/container.xml 中找不到 rootfile 元素",
            phase="container_parse",
        )

    full_path = rootfile.get("full-path")  # 获取 XML 元素的属性值
    if not full_path:
        raise InvalidContainerError(
            "rootfile 元素缺少 full-path 属性",
            phase="container_parse",
        )

    # EPUB 3 允许相对路径（相对于 container.xml 所在目录），但实际几乎都是绝对
    return full_path


def has_drm(zip_file: ZipFile) -> bool:
    """检测是否含 META-INF/encryption.xml（DRM 标记）。

    DRM（数字版权管理）：如果存在 encryption.xml，说明书籍被加密保护，
    我们不支持解析加密的 EPUB。
    """
    return "META-INF/encryption.xml" in zip_file.namelist()  # namelist() 返回 ZIP 内所有文件名列表


def read_member(zip_file: ZipFile, member: str) -> bytes:
    """读 zip 内某文件的字节；调用前应先确认存在。"""
    try:
        with zip_file.open(member) as f:
            return f.read()  # 返回原始字节（bytes），不是字符串
    except KeyError as e:
        raise InvalidContainerError(
            f"ZIP 内找不到预期文件：{member}",
            phase="container_parse",
        ) from e


def open_zip(path: str | Path | BinaryIO) -> ZipFile:
    """打开一个 EPUB 文件；非 ZIP 或损坏抛 CorruptEpubError。

    path 可以是文件路径字符串、Path 对象、或二进制流（如用户上传的文件）。
    注意：这里延迟 import 以避免在 errors 之外的循环依赖。
    """
    from epub_backend.reader.errors import CorruptEpubError  # 函数内 import 避免循环引用

    try:
        return ZipFile(path)  # Python 标准库：打开 ZIP 文件
    except Exception as e:  # zipfile.BadZipFile 或 FileNotFoundError 等
        raise CorruptEpubError(
            f"无法打开 ZIP 文件：{e}",
        ) from e
