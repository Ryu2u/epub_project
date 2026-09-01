// 文件系统工具：SHA-256 哈希 + 原子写入。
// 对应 Python storage/filesystem.py。

use std::io::Write;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

/// 计算 SHA-256 哈希（十六进制字符串）
pub fn compute_sha256(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let result = hasher.finalize();
    // 每字节 2 个十六进制字符
    let mut hex = String::with_capacity(64);
    for b in result {
        hex.push_str(&format!("{b:02x}"));
    }
    hex
}

/// 原子写入：先写临时文件 + fsync，再 rename 到目标。
/// 同目录写临时文件确保 rename 是原子的（同一文件系统）。
pub fn atomic_write(target: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let dir = target.parent().unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(dir)?;

    // 临时文件：同目录，隐藏前缀
    let tmp_name = format!(".tmp_{}", uuid::Uuid::new_v4().simple());
    let tmp_path: PathBuf = dir.join(&tmp_name);

    // 写入 + fsync 确保数据落盘
    {
        let mut file = std::fs::File::create(&tmp_path)?;
        file.write_all(bytes)?;
        file.sync_all()?;
    }

    // rename（原子操作；失败时清理临时文件）
    std::fs::rename(&tmp_path, target).inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp_path);
    })?;

    Ok(())
}

/// 删除文件（忽略不存在的错误）
pub fn delete_file(path: &Path) -> bool {
    std::fs::remove_file(path).is_ok()
}

// ========== 章节 html 文件存储 ==========
// 章节 html 真值在 storage_dir/chapters/{book_id}/{chapter_id}.html。
// DB 里 chapters.html 列固定存 '' 哨兵,service 层在两个入口维护:
//   - 写:add_book / update_chapter 先写文件再碰 DB
//   - 读:get_chapter / get_chapters SELECT 后调 read_chapter_html 回填

/// 章节 html 文件路径:storage_dir/chapters/{book_id}/{chapter_id}.html
pub fn chapter_html_path(storage_dir: &Path, book_id: &str, chapter_id: &str) -> PathBuf {
    storage_dir
        .join("chapters")
        .join(book_id)
        .join(format!("{chapter_id}.html"))
}

/// 原子写章节 html（委托 atomic_write，自动创建父目录）。
pub fn write_chapter_html(
    storage_dir: &Path,
    book_id: &str,
    chapter_id: &str,
    html: &str,
) -> std::io::Result<()> {
    let target = chapter_html_path(storage_dir, book_id, chapter_id);
    atomic_write(&target, html.as_bytes())
}

/// 读章节 html。文件不存在返回空串（优雅降级，不打错误）。
pub fn read_chapter_html(storage_dir: &Path, book_id: &str, chapter_id: &str) -> String {
    let path = chapter_html_path(storage_dir, book_id, chapter_id);
    std::fs::read_to_string(&path).unwrap_or_default()
}

/// 删除整本书的章节目录（storage_dir/chapters/{book_id}/）。
/// 忽略不存在错误（可能根本没创建过）。
pub fn delete_chapter_html_dir(storage_dir: &Path, book_id: &str) {
    let dir = storage_dir.join("chapters").join(book_id);
    let _ = std::fs::remove_dir_all(&dir);
}
