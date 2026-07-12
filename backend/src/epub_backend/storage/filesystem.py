"""文件系统工具：路径生成、sha256、流式写、删除。

所有函数都是纯函数或对单一路径操作，不依赖全局状态。
"""

from __future__ import annotations

import hashlib
import shutil
import tempfile
import uuid
from collections.abc import Iterator
from pathlib import Path

# SHA-256 分块读大小（64 KiB，性能和内存平衡）
CHUNK_SIZE = 64 * 1024

# 单文件上传临时块大小（1 MiB）
UPLOAD_CHUNK_SIZE = 1024 * 1024


def generate_book_path(storage_dir: Path, book_id: str | None = None) -> Path:
    """生成书籍文件的目标路径：{storage_dir}/{book_id}.epb

    book_id 不传则用 uuid4 生成。
    """
    storage_dir.mkdir(parents=True, exist_ok=True)
    bid = book_id or uuid.uuid4().hex
    return storage_dir / f"{bid}.epb"


def save_upload(upload_iter: Iterator[bytes], dest: Path) -> int:
    """流式把上传块写到目标路径，返回写入字节数。

    写入是原子的：先写临时文件，fsync 后 rename 到 dest。
    失败时临时文件会被清理。
    """
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = None
    total = 0
    try:
        # NamedTemporaryFile 与 dest 同目录，确保 rename 是原子的（同文件系统）
        with tempfile.NamedTemporaryFile(
            dir=dest.parent,
            prefix=".tmp_",
            suffix=".epb",
            delete=False,
        ) as tmp:
            tmp_path = Path(tmp.name)
            for chunk in upload_iter:
                if chunk:
                    tmp.write(chunk)
                    total += len(chunk)
            tmp.flush()
            # 强制刷盘，避免机器断电后损坏
            import os

            os.fsync(tmp.fileno())
        # 原子 rename
        shutil.move(str(tmp_path), str(dest))
        tmp_path = None  # 已移动，不需要清理
    finally:
        if tmp_path is not None and tmp_path.exists():
            tmp_path.unlink()
    return total


def compute_sha256(path: Path) -> str:
    """流式算文件的 sha256 哈希（hex 字符串）。"""
    h = hashlib.sha256()
    with path.open("rb") as f:
        while True:
            chunk = f.read(CHUNK_SIZE)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()


def delete_file(path: Path) -> bool:
    """删除文件，缺失不抛错。返回是否实际删了。"""
    try:
        path.unlink()
        return True
    except FileNotFoundError:
        return False


def file_size(path: Path) -> int:
    """文件大小，缺失抛 FileNotFoundError。"""
    return path.stat().st_size
