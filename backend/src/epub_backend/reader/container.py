"""EPUB 容器解析：mimetype 文件 + META-INF/container.xml。

EPUB 3 容器规则：
- 压缩包第一个 entry 必须是 'mimetype' 文件，内容是 'application/epub+zip'（无 BOM、无换行）。
- META-INF/container.xml 指向包文档（OPF），通常是 OEBPS/content.opf。
"""

from __future__ import annotations

from pathlib import Path
from typing import BinaryIO
from zipfile import ZipFile

from lxml import etree

from epub_backend.reader.errors import InvalidContainerError

CONTAINER_NS = "urn:oasis:names:tc:opendocument:xmlns:container"
EXPECTED_MIMETYPE = "application/epub+zip"
MIMETYPE_ENTRY = "mimetype"


def validate_mimetype(zip_file: ZipFile) -> None:
    """验证压缩包第一个 entry 是 mimetype 且内容正确。

    EPUB 规范要求 mimetype 是 ZIP 第一个 entry 且未压缩。
    这里只验证内容正确；解压顺序由 reader orchestrator 在打开时控制。
    """
    try:
        with zip_file.open(MIMETYPE_ENTRY) as f:
            content = f.read().decode("ascii").strip()
    except KeyError as e:
        raise InvalidContainerError(
            "压缩包缺少 mimetype 文件（不是合法的 EPUB 容器）",
            phase="container_parse",
        ) from e
    except UnicodeDecodeError as e:
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
    """
    try:
        with zip_file.open("META-INF/container.xml") as f:
            tree = etree.parse(f)
    except KeyError as e:
        raise InvalidContainerError(
            "缺少 META-INF/container.xml",
            phase="container_parse",
        ) from e
    except etree.XMLSyntaxError as e:
        raise InvalidContainerError(
            f"META-INF/container.xml 不是合法 XML：{e}",
            phase="container_parse",
        ) from e

    ns = {"c": CONTAINER_NS}
    rootfile = tree.find(".//c:rootfile", namespaces=ns)
    if rootfile is None:
        raise InvalidContainerError(
            "META-INF/container.xml 中找不到 rootfile 元素",
            phase="container_parse",
        )

    full_path = rootfile.get("full-path")
    if not full_path:
        raise InvalidContainerError(
            "rootfile 元素缺少 full-path 属性",
            phase="container_parse",
        )

    # EPUB 3 允许相对路径（相对于 container.xml 所在目录），但实际几乎都是绝对
    return full_path


def has_drm(zip_file: ZipFile) -> bool:
    """检测是否含 META-INF/encryption.xml（DRM 标记）。"""
    return "META-INF/encryption.xml" in zip_file.namelist()


def read_member(zip_file: ZipFile, member: str) -> bytes:
    """读 zip 内某文件的字节；调用前应先确认存在。"""
    try:
        with zip_file.open(member) as f:
            return f.read()
    except KeyError as e:
        raise InvalidContainerError(
            f"ZIP 内找不到预期文件：{member}",
            phase="container_parse",
        ) from e


def open_zip(path: str | Path | BinaryIO) -> ZipFile:
    """打开一个 EPUB 文件；非 ZIP 或损坏抛 CorruptEpubError。

    注意：这里延迟 import 以避免在 errors 之外的循环依赖。
    """
    from epub_backend.reader.errors import CorruptEpubError

    try:
        return ZipFile(path)
    except Exception as e:  # zipfile.BadZipFile 或 FileNotFoundError 等
        raise CorruptEpubError(
            f"无法打开 ZIP 文件：{e}",
        ) from e
