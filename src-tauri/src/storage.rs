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

/// 清洗「文件名主干」:把不可信文本(书名来自用户上传的 EPUB)安全地拼进路径。
///
/// 处理四类 Windows 坑:
///   1. 非法字符 `\ / : * ? " < > |` 与控制字符 → `_`;
///   2. 结尾的点/空格(资源管理器不允许,创建也可能失败)→ 去掉;
///   3. 保留设备名(CON/PRN/AUX/NUL/COM1-9/LPT1-9,含带扩展名的形式 ——
///      `NUL.epub` 会命中设备且 `std::fs::write` 返回成功但文件并不存在)
///      → 加 `_` 前缀;
///   4. 空名 → 兜底 `book`;超过 120 字节 → 按 UTF-8 边界截断。
pub fn sanitize_file_stem(stem: &str) -> String {
    const RESERVED: &[&str] = &[
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7",
        "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    const MAX_BYTES: usize = 120;

    let mut out: String = stem
        .chars()
        .map(|c| {
            if c.is_control() || matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
                '_'
            } else {
                c
            }
        })
        .collect();

    trim_trailing_dots_spaces(&mut out);
    if out.is_empty() {
        out.push_str("book");
    }
    // 保留名判定看第一个点之前的部分(设备名带扩展名同样命中)
    let head = out.split('.').next().unwrap_or("").to_ascii_uppercase();
    if RESERVED.contains(&head.as_str()) {
        out.insert(0, '_');
    }
    if out.len() > MAX_BYTES {
        let mut end = MAX_BYTES;
        while end > 0 && !out.is_char_boundary(end) {
            end -= 1;
        }
        out.truncate(end);
        trim_trailing_dots_spaces(&mut out);
        if out.is_empty() {
            out.push_str("book");
        }
    }
    out
}

fn trim_trailing_dots_spaces(s: &mut String) {
    while s.ends_with('.') || s.ends_with(' ') {
        s.pop();
    }
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

#[cfg(test)]
mod filename_tests {
    use super::sanitize_file_stem;

    #[test]
    fn replaces_illegal_chars() {
        assert_eq!(sanitize_file_stem("a/b\\c:d*e?f\"g<h>i|j"), "a_b_c_d_e_f_g_h_i_j");
        assert_eq!(sanitize_file_stem("换行\n书名"), "换行_书名");
    }

    #[test]
    fn trims_trailing_dots_and_spaces() {
        // Windows 上结尾的点/空格会被静默丢弃
        assert_eq!(sanitize_file_stem("书名..."), "书名");
        assert_eq!(sanitize_file_stem("书名   "), "书名");
        assert_eq!(sanitize_file_stem(" 书名 "), " 书名"); // 前导空格合法,保留
    }

    #[test]
    fn avoids_reserved_device_names() {
        // NUL.epub 会命中设备:write 返回成功但磁盘上没有文件
        assert_eq!(sanitize_file_stem("NUL"), "_NUL");
        assert_eq!(sanitize_file_stem("nul"), "_nul");
        assert_eq!(sanitize_file_stem("CON.txt"), "_CON.txt");
        assert_eq!(sanitize_file_stem("LPT9"), "_LPT9");
        assert_eq!(sanitize_file_stem("CONSOLE"), "CONSOLE"); // 仅前缀相同不算
    }

    #[test]
    fn falls_back_when_empty_and_truncates_long_names() {
        assert_eq!(sanitize_file_stem(""), "book");
        assert_eq!(sanitize_file_stem("..."), "book");
        let long = "书".repeat(200);
        let out = sanitize_file_stem(&long);
        assert!(out.len() <= 120, "按字节截断: {}", out.len());
        assert!(out.chars().all(|c| c == '书'), "UTF-8 边界必须对齐");
    }
}
