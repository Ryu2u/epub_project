"""EpubReader 领域错误定义。

所有错误都带 `phase`（解析阶段）和 `code`（HTTP 错误码映射用），
便于 BookService 统一映射到 HTTP 响应。

错误类继承关系：
    Exception                  ← Python 所有异常的基类
      └─ EpubReaderError       ← EPUB 解析错误的基类
           ├─ InvalidContainerError   ← mimetype / container.xml 错误
           ├─ IncompleteMetadataError ← 缺必填元数据
           ├─ DRMError                ← 含 DRM 加密
           ├─ CorruptEpubError        ← ZIP 损坏
           ├─ FileSystemError         ← 文件读取失败
           └─ DuplicateFileError      ← 文件已存在（去重）
"""

from typing import Literal

# Literal：类型标注工具，限定变量只能是几个固定值之一
# 例如 Literal["a", "b"] 表示值只能是 "a" 或 "b"

# 解析阶段枚举：标记错误发生在 EPUB 解析的哪个步骤
ParsePhase = Literal[
    "container_parse",  # 解析容器（mimetype + container.xml）
    "opf_parse",        # 解析 OPF 包描述文件
    "chapter_parse",    # 解析 XHTML 章节
    "nav_parse",        # 解析导航目录
]


class EpubReaderError(Exception):
    """EPUB 解析错误的基类。

    所有 EPUB 相关错误都继承此类，便于上层统一捕获。
    Exception 是 Python 内置的异常基类。
    """

    phase: ParsePhase = "container_parse"  # 类属性：默认发生在容器解析阶段
    code: str = "INVALID_CONTAINER"        # 类属性：默认错误码

    def __init__(self, message: str, *, phase: ParsePhase | None = None) -> None:
        # __init__：Python 类的构造函数，创建实例时自动调用
        # *：后面的参数必须用关键字方式传递（如 phase="opf_parse"），不能用位置传参
        super().__init__(message)  # 调用父类 Exception 的构造函数，传入错误消息
        if phase is not None:
            self.phase = phase  # 实例属性覆盖类属性


class InvalidContainerError(EpubReaderError):
    """mimetype 错 / container.xml 缺或坏。"""

    code = "INVALID_CONTAINER"


class IncompleteMetadataError(EpubReaderError):
    """缺必填 metadata（title / language / identifier）。"""

    code = "INCOMPLETE_METADATA"
    phase: ParsePhase = "opf_parse"  # 覆盖父类默认值：这个错误发生在 OPF 解析阶段

    def __init__(self, message: str, missing: list[str]) -> None:
        super().__init__(message)
        self.missing = missing  # 记录缺少哪些字段，如 ["title", "language"]


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
    """sha256 已存在于库中（service 层抛出，不是 reader 内部）。

    这个错误在 BookService 中抛出——当用户上传的文件哈希与已有书籍相同时。
    existing_book_id 记录已存在的书籍 ID，前端可以跳转到那本书。
    """

    code = "DUPLICATE_FILE"

    def __init__(self, message: str, existing_book_id: str = "") -> None:
        super().__init__(message)
        self.existing_book_id = existing_book_id
