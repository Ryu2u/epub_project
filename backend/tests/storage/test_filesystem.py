"""filesystem 工具测试。"""

import hashlib
from pathlib import Path

from epub_backend.storage.filesystem import (
    CHUNK_SIZE,
    compute_sha256,
    delete_file,
    file_size,
    generate_book_path,
    save_upload,
)


def test_generate_book_path_creates_dir(tmp_path: Path) -> None:
    p = generate_book_path(tmp_path)
    assert p.parent.exists()
    assert p.suffix == ".epb"
    # 默认 uuid4 路径名长度 32 hex chars
    assert len(p.stem) == 32


def test_generate_book_path_with_id(tmp_path: Path) -> None:
    p = generate_book_path(tmp_path, book_id="abc123")
    assert p.name == "abc123.epb"


def test_save_upload_writes_correctly(tmp_path: Path) -> None:
    dest = generate_book_path(tmp_path)
    data = b"hello world" * 1000

    def chunks() -> iter:
        # 分 5 块喂
        step = len(data) // 5
        return iter(data[i : i + step] for i in range(0, len(data), step))

    n = save_upload(chunks(), dest)
    assert n == len(data)
    assert dest.read_bytes() == data


def test_save_upload_atomic_on_failure(tmp_path: Path) -> None:
    """写入中途异常时，不应留半成品文件。"""
    dest = generate_book_path(tmp_path)

    def bad_chunks() -> iter:
        yield b"some data"
        raise RuntimeError("boom")

    try:
        save_upload(bad_chunks(), dest)
    except RuntimeError:
        pass
    assert not dest.exists()
    # 不留临时文件
    leftovers = list(tmp_path.glob(".tmp_*"))
    assert leftovers == []


def test_compute_sha256_correct(tmp_path: Path) -> None:
    f = tmp_path / "x.bin"
    data = b"abc123" * 5000
    f.write_bytes(data)
    assert compute_sha256(f) == hashlib.sha256(data).hexdigest()


def test_compute_sha256_large_file(tmp_path: Path) -> None:
    """文件 > CHUNK_SIZE 时也能正确算哈希。"""
    f = tmp_path / "big.bin"
    # 写 3 * CHUNK_SIZE 的数据
    f.write_bytes(b"x" * (CHUNK_SIZE * 3 + 17))
    h = compute_sha256(f)
    assert len(h) == 64  # sha256 hex 长度


def test_delete_file(tmp_path: Path) -> None:
    f = tmp_path / "x.txt"
    f.write_bytes(b"x")
    assert delete_file(f) is True
    assert delete_file(f) is False  # 再删返回 False


def test_file_size(tmp_path: Path) -> None:
    f = tmp_path / "x.txt"
    f.write_bytes(b"12345")
    assert file_size(f) == 5
