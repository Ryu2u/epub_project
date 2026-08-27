// EPUB 路径工具：规范化 + 相对路径解析。
//
// 之前在 opf.rs / nav.rs / epub_writer.rs / api/books.rs 各有一份重复实现，统一到这里。

/// 规范化路径：处理 `.` 和 `..` 段（不跨越根目录）。
/// 例：`"OEBPS/images/../styles/main.css"` → `"OEBPS/styles/main.css"`
pub fn normalize_path(path: &str) -> String {
    let mut parts: Vec<&str> = Vec::new();
    for p in path.split('/') {
        match p {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            _ => parts.push(p),
        }
    }
    parts.join("/")
}

/// 把相对/绝对 src 解析为 zip 内绝对路径。
/// - `../images/cover.jpg` + base_dir `OEBPS/chapters` → `OEBPS/images/cover.jpg`
/// - `/OEBPS/x` → `OEBPS/x`（前导 / 视为 zip 根）
/// - 去掉 `#fragment`
pub fn resolve_relative(src: &str, base_dir: &str) -> String {
    let src = src.split('#').next().unwrap_or(src);
    if src.starts_with('/') {
        return normalize_path(src.trim_start_matches('/'));
    }
    if base_dir.is_empty() {
        normalize_path(src)
    } else {
        normalize_path(&format!("{base_dir}/{src}"))
    }
}
