"""EpubReader 领域错误定义。

所有错误都带 `phase`（解析阶段）和 `code`（HTTP 错误码映射用），
便于 BookService 统一映射到 HTTP 响应。
"""

from typing import Literal

ParsePhase = Literal[
    "container_parse",
    "opf_parse",
    "chapter_parse",
    "nav_parse",
]


class EpubReaderError(Exception):
    """EPUB 解析错误的基类。"""

    phase: ParsePhase = "container_parse"
    code: str = "INVALID_CONTAINER"

    def __init__(self, message: str, *, phase: ParsePhase | None = None) -> None:
        super().__init__(message)
        if phase is not None:
            self.phase = phase


class InvalidContainerError(EpubReaderError):
    """mimetype 错 / container.xml 缺或坏。"""

    code = "INVALID_CONTAINER"


class IncompleteMetadataError(EpubReaderError):
    """缺必填 metadata（title / language / identifier）。"""

    code = "INCOMPLETE_METADATA"
    phase: ParsePhase = "opf_parse"

    def __init__(self, message: str, missing: list[str]) -> None:
        super().__init__(message)
        self.missing = missing


class DRMError(EpubReaderError):
    """含 META-INF/encryption.xml。"""

    code = "DRM_DETECTED"


class CorruptEpubError(EpubReaderError):
    """ZIP 损坏或非 ZIP 格式。"""

    code = "CORRUPT_EPUB"


class FileSystemError(EpubReaderError):
    """文件系统错误（文件读不了、解压失败）。"""

    code = "CORRUPT_EPUB"


class DuplicateFileError(EpubReaderError):
    """sha256 已存在于库中（service 层抛出，不是 reader 内部）。"""

    code = "DUPLICATE_FILE"

    def __init__(self, message: str, existing_book_id: str = "") -> None:
        super().__init__(message)
        self.existing_book_id = existing_book_id
