"""文件系统工具：路径生成、sha256、流式写、删除。

所有函数都是纯函数或对单一路径操作，不依赖全局状态。
纯函数：给定相同输入，总是产生相同输出，没有副作用。
"""

from __future__ import annotations

import hashlib  # Python 标准库哈希算法（SHA-256 等）
import shutil  # 高级文件操作（move、copy 等）
import tempfile  # 创建临时文件
import uuid  # 生成 UUID
from collections.abc import Iterator  # 同步迭代器类型标注
from pathlib import Path  # 面向对象的文件路径操作

# SHA-256 分块读大小（64 KiB，性能和内存平衡）
# 不要一次读整个大文件（可能几百 MB），分块读取节省内存
CHUNK_SIZE = 64 * 1024  # 64 * 1024 = 65536 字节 = 64 KiB

# 单文件上传临时块大小（1 MiB）
UPLOAD_CHUNK_SIZE = 1024 * 1024  # 1024 * 1024 = 1,048,576 字节 = 1 MiB


def generate_book_path(storage_dir: Path, book_id: str | None = None) -> Path:
    """生成书籍文件的目标路径：{storage_dir}/{book_id}.epb

    .epb 是我们自定义的扩展名，本质就是 ZIP 文件。
    book_id 不传则用 uuid4 生成。
    uuid.uuid4().hex：生成随机 UUID 并取其十六进制表示（32 个字符）。
    """
    storage_dir.mkdir(parents=True, exist_ok=True)
    # mkdir(parents=True)：递归创建目录（类似 mkdir -p）
    # exist_ok=True：目录已存在也不报错
    bid = book_id or uuid.uuid4().hex
    return storage_dir / f"{bid}.epb"  # Path 的 / 运算符：拼接路径


def save_upload(upload_iter: Iterator[bytes], dest: Path) -> int:
    """流式把上传块写到目标路径，返回写入字节数。

    写入是原子的：先写临时文件，fsync 后 rename 到 dest。
    "原子写入"意味着要么文件完整存在，要么完全不存在——
    不会出现"写了一半"的损坏文件。
    失败时临时文件会被清理。
    """
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = None
    total = 0
    try:
        # NamedTemporaryFile 与 dest 同目录，确保 rename 是原子的（同文件系统）
        # 在 Linux/macOS 上，同文件系统的 rename 是原子操作
        with tempfile.NamedTemporaryFile(
            dir=dest.parent,     # 临时文件放在目标同目录
            prefix=".tmp_",      # 文件名前缀
            suffix=".epb",       # 文件名后缀
            delete=False,        # 不自动删除（我们要手动 rename）
        ) as tmp:
            tmp_path = Path(tmp.name)
            for chunk in upload_iter:
                if chunk:
                    tmp.write(chunk)
                    total += len(chunk)
            tmp.flush()          # 把 Python 缓冲区刷到操作系统缓冲区
            # 强制刷盘，避免机器断电后损坏
            import os

            os.fsync(tmp.fileno())
            # fsync：强制操作系统把数据从内存写入磁盘
            # fileno()：获取文件描述符（操作系统级别的文件标识）
        # 原子 rename：把临时文件重命名为目标文件
        shutil.move(str(tmp_path), str(dest))
        tmp_path = None  # 已移动，不需要清理
    finally:
        # finally 块：无论是否发生异常都执行
        # 如果临时文件还存在（说明发生了异常），清理它
        if tmp_path is not None and tmp_path.exists():
            tmp_path.unlink()  # 删除文件
    return total


def compute_sha256(path: Path) -> str:
    """流式算文件的 sha256 哈希（hex 字符串）。

    SHA-256 是一种加密哈希函数，可以把任意大小的数据映射为 64 位十六进制字符串。
    相同内容 → 相同哈希，不同内容 → 几乎不可能碰撞。
    用于文件去重：如果两个文件的 SHA-256 相同，说明它们内容相同。
    """
    h = hashlib.sha256()  # 创建 SHA-256 哈希对象
    with path.open("rb") as f:  # "rb"：以二进制读取模式打开
        while True:
            chunk = f.read(CHUNK_SIZE)  # 每次读 64 KiB
            if not chunk:
                break  # 读到末尾，退出循环
            h.update(chunk)  # 把数据块喂给哈希对象
    return h.hexdigest()  # 返回十六进制哈希字符串（64 个字符）


def delete_file(path: Path) -> bool:
    """删除文件，缺失不抛错。返回是否实际删了。

    注意：这里故意忽略 FileNotFoundError——
    因为删除操作在"文件可能不存在"的场景下是安全的。
    """
    try:
        path.unlink()  # unlink()：删除文件
        return True
    except FileNotFoundError:
        return False


def file_size(path: Path) -> int:
    """文件大小，缺失抛 FileNotFoundError。

    path.stat()：获取文件的元信息（大小、修改时间等）。
    st_size：文件大小（字节）。
    """
    return path.stat().st_size
