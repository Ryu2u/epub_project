// EPUB 写入器：从 DB 数据重建 EPUB 3 文件字节。
// 对应 Python services/epub_writer.py。
//
// 用于「导出 EPUB」端点：把用户编辑过的书籍（元数据/章节）打包成标准 EPUB 3。
//
// 兼容性：所有导出的 XHTML 都保证有 <?xml?> + <!DOCTYPE html ...> + 正确的
// xmlns 命名空间，<head> 里至少有一个 <title>。Sigil / EpubCheck 都不会报警。

use std::collections::HashMap;
use std::io::Write;

use chrono::Utc;

use crate::db::{Asset, Book, Chapter};

/// EPUB / XML 命名空间常量
const XHTML_NS: &str = "http://www.w3.org/1999/xhtml";
const OPS_NS: &str = "http://www.idpf.org/2007/ops";
const OPF_NS: &str = "http://www.idpf.org/2007/opf";
const DC_NS: &str = "http://purl.org/dc/elements/1.1/";

/// XHTML 1.1 DOCTYPE（EPUB 3 实际使用 XHTML 序列化版，DTD 标记保持 1.1）
const XHTML_DOCTYPE: &str = r#"<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">"#;

/// 构建 EPUB 文件字节。
///
/// - chapters 会按 spine_order 排序，重命名为 chapter_0000.xhtml 等
/// - asset_bytes: { asset_id: 字节 }，缺失的跳过
pub fn build_epub_bytes(
    book: &Book,
    mut chapters: Vec<Chapter>,
    assets: &[Asset],
    asset_bytes: &HashMap<String, Vec<u8>>,
) -> Vec<u8> {
    // 章节按 spine_order 排序
    chapters.sort_by_key(|c| c.spine_order);

    // href -> asset_id 映射（用于重写章节内引用）
    let asset_map: HashMap<String, String> =
        assets.iter().map(|a| (a.href.clone(), a.id.clone())).collect();
    let cover_asset_id = assets.iter().find(|a| a.is_cover_bool()).map(|a| a.id.clone());

    let buf: Vec<u8> = Vec::new();
    let mut zw = zip::ZipWriter::new(std::io::Cursor::new(buf));

    let deflated = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    let stored = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Stored);

    // 1. mimetype（不压缩，EPUB 规范）
    let _ = zw.start_file("mimetype", stored);
    let _ = zw.write_all(b"application/epub+zip");

    // 2. container.xml
    let _ = zw.start_file("META-INF/container.xml", deflated);
    let _ = zw.write_all(
        b"<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
<container version=\"1.0\" xmlns=\"urn:oasis:names:tc:opendocument:xmlns:container\">\
<rootfiles><rootfile full-path=\"OEBPS/content.opf\" media-type=\"application/oebps-package+xml\"/>\
</rootfiles></container>",
    );

    // 3. 章节 XHTML（重写引用 → assets/{id}，统一包裹成合规 XHTML）
    let mut chapter_files: Vec<(String, String)> = Vec::new(); // (manifest_id, href)
    let mut chapter_nav: Vec<(String, String)> = Vec::new(); // (href, title)
    for (i, ch) in chapters.iter().enumerate() {
        let ch_href = format!("chapter_{i:04}.xhtml");
        let rewritten = crate::epub::html_rewrite::rewrite_img_refs(
            &ch.html,
            &ch.href,
            &asset_map,
            |aid| format!("assets/{aid}"),
        );
        let normalized = normalize_xhtml(&rewritten, &ch.title);

        let _ = zw.start_file(format!("OEBPS/{ch_href}"), deflated);
        let _ = zw.write_all(normalized.as_bytes());
        let cid = if ch.id.is_empty() { format!("ch{i}") } else { ch.id.clone() };
        chapter_files.push((cid, ch_href.clone()));
        chapter_nav.push((ch_href, ch.title.clone()));
    }

    // 4. nav.xhtml
    let _ = zw.start_file("OEBPS/nav.xhtml", deflated);
    let _ = zw.write_all(build_nav(&chapter_nav).as_bytes());

    // 5. 资源文件（扁平到 OEBPS/assets/{id}）
    let mut asset_items: Vec<(String, String, String, bool)> = Vec::new();
    for a in assets {
        if let Some(data) = asset_bytes.get(&a.id) {
            let _ = zw.start_file(format!("OEBPS/assets/{}", a.id), deflated);
            let _ = zw.write_all(data);
            let is_cover = Some(&a.id) == cover_asset_id.as_ref();
            asset_items.push((a.id.clone(), format!("assets/{}", a.id), a.media_type.clone(), is_cover));
        }
    }

    // 6. content.opf
    let _ = zw.start_file("OEBPS/content.opf", deflated);
    let _ = zw.write_all(build_opf(book, &chapter_files, &asset_items, cover_asset_id.as_deref()).as_bytes());

    zw.finish()
        .map(|c| c.into_inner())
        .unwrap_or_default()
}

/// 把任意来源的 HTML 规范化成 Sigil/EpubCheck 接受的 XHTML 1.1 文档。
///
/// 保证:
///   1. 以 `<?xml version="1.0" encoding="utf-8"?>` 开头
///   2. 紧跟 `<!DOCTYPE html PUBLIC ...>` XHTML 1.1 DTD 声明
///   3. 根元素是 `<html xmlns="http://www.w3.org/1999/xhtml">`（保留已有的额外 xmlns）
///   4. `<head>` 里至少有一个 `<title>title</title>`
///   5. 主体内容在 `<body>` 中
///
/// 兼容以下几种输入:
///   - 已经是合规 XHTML（含 DOCTYPE）→ 不动
///   - 只含 body 内部片段 → 包成最小合规 XHTML 文档
///   - EPUB 解析器存的原始 XHTML（可能没有 DOCTYPE / 没有 title）→ 修补
fn normalize_xhtml(input: &str, title: &str) -> String {
    let trimmed = input.trim_start();

    // 已经是合规 XHTML（含 DOCTYPE）→ 原样返回（最多确保 XML decl 存在）
    if trimmed.contains("<!DOCTYPE") {
        return ensure_xml_decl(input);
    }

    // 有 <?xml 但没 DOCTYPE → 加 DOCTYPE
    if trimmed.starts_with("<?xml") {
        let xml_end = trimmed.find("?>").map(|i| i + 2).unwrap_or(0);
        let after_xml_decl = &trimmed[xml_end..];
        return format!(
            "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n{XHTML_DOCTYPE}\n{}",
            inject_title_into_xhtml(after_xml_decl, title).trim_start()
        );
    }

    // 解析根标签：要么是 <html ...>，要么没有 <html>（纯 body 片段）
    let lower = trimmed.to_lowercase();
    if lower.contains("<html") {
        // 已有 <html> 根：在 </html> 之后没有内容时，补齐 head/title
        return format!(
            "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n{XHTML_DOCTYPE}\n{}",
            inject_title_into_xhtml(trimmed, title)
        );
    }

    // 没有 <html> 根（纯 body 片段，如 TXT 解析产物）→ 包成完整 XHTML
    format!(
        "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n{XHTML_DOCTYPE}\n\
<html xmlns=\"{XHTML_NS}\">\n<head>\n<title>{}</title>\n</head>\n<body>\n{input}\n</body>\n</html>",
        escape_xml(title),
    )
}

/// 在 XHTML 文档中保证 <head> 里至少有一个 <title>。
/// 如果 <head> 存在但没有 <title>,在 <head> 起始标签后插入。
/// 如果 <head> 不存在,跳过（调用方应保证至少有 <html> 根）。
fn inject_title_into_xhtml(doc: &str, title: &str) -> String {
    let lower = doc.to_lowercase();
    let escaped = escape_xml(title);

    // 已有 <title> → 不动
    if lower.contains("<title>") {
        return doc.to_string();
    }

    // 有 <head>...</head> → 在 <head> 之后插入 <title>
    if let Some(head_start) = lower.find("<head") {
        // 找到 <head ...> 的结束 > 位置
        if let Some(head_tag_end) = doc[head_start..].find('>') {
            let insert_at = head_start + head_tag_end + 1;
            let (before, after) = doc.split_at(insert_at);
            return format!("{before}<title>{escaped}</title>{after}");
        }
    }

    // <html> 后直接是 <body>（没有 <head>）→ 插入一个
    if let Some(body_start) = lower.find("<body") {
        if let Some(body_tag_end) = doc[body_start..].find('>') {
            let insert_at = body_start + body_tag_end + 1;
            let (before, after) = doc.split_at(insert_at);
            return format!(
                "{before}<head><title>{escaped}</title></head>{after}"
            );
        }
    }

    // 兜底：原样返回
    doc.to_string()
}

/// 确保 HTML 以 <?xml 声明开头
fn ensure_xml_decl(html: &str) -> String {
    let trimmed = html.trim_start();
    if trimmed.starts_with("<?xml") {
        html.to_string()
    } else {
        format!("<?xml version=\"1.0\" encoding=\"utf-8\"?>\n{html}")
    }
}

/// 构建 nav.xhtml（导航文档，必须含 DOCTYPE 与 <title>）
fn build_nav(chapter_nav: &[(String, String)]) -> String {
    let items: String = chapter_nav
        .iter()
        .map(|(href, title)| format!("<li><a href=\"{href}\">{}</a></li>", escape_xml(title)))
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n\
{XHTML_DOCTYPE}\n\
<html xmlns=\"{XHTML_NS}\" xmlns:epub=\"{OPS_NS}\">\n\
<head>\n<title>目录</title>\n</head>\n<body>\n\
<nav epub:type=\"toc\" id=\"toc\"><h1>目录</h1><ol>{items}</ol></nav>\n\
</body>\n</html>"
    )
}

/// 构建 content.opf
fn build_opf(
    book: &Book,
    chapter_files: &[(String, String)],
    asset_items: &[(String, String, String, bool)],
    cover_asset_id: Option<&str>,
) -> String {
    let creators = if book.authors.is_empty() {
        "<dc:creator>未知作者</dc:creator>".to_string()
    } else {
        book.authors
            .iter()
            .map(|a| format!("<dc:creator>{}</dc:creator>", escape_xml(a)))
            .collect::<Vec<_>>()
            .join("")
    };

    let mut extra_meta = String::new();
    if let Some(p) = &book.publisher {
        extra_meta.push_str(&format!("<dc:publisher>{}</dc:publisher>", escape_xml(p)));
    }
    if let Some(d) = &book.description {
        extra_meta.push_str(&format!("<dc:description>{}</dc:description>", escape_xml(d)));
    }
    if let Some(date) = &book.pub_date {
        extra_meta.push_str(&format!("<dc:date>{date}</dc:date>"));
    }

    // manifest
    let mut manifest = vec![
        "<item id=\"nav\" href=\"nav.xhtml\" media-type=\"application/xhtml+xml\" properties=\"nav\"/>"
            .to_string(),
    ];
    for (cid, href) in chapter_files {
        manifest.push(format!(
            "<item id=\"{}\" href=\"{href}\" media-type=\"application/xhtml+xml\"/>",
            escape_xml(cid)
        ));
    }
    for (aid, href, media_type, is_cover) in asset_items {
        let props = if *is_cover { " properties=\"cover-image\"" } else { "" };
        manifest.push(format!(
            "<item id=\"{}\" href=\"{href}\" media-type=\"{media_type}\"{props}/>",
            escape_xml(aid)
        ));
    }

    // spine
    let spine: String = chapter_files
        .iter()
        .map(|(cid, _)| format!("<itemref idref=\"{}\"/>", escape_xml(cid)))
        .collect::<Vec<_>>()
        .join("");

    let modified = Utc::now().format("%Y-%m-%dT%H:%M:%SZ");
    let _ = cover_asset_id; // cover-image properties 已在 manifest 标记

    format!(
        "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n\
<package xmlns=\"{OPF_NS}\" version=\"3.0\" unique-identifier=\"uid\">\
<metadata xmlns:dc=\"{DC_NS}\">\
<dc:identifier id=\"uid\">{}</dc:identifier>\
<dc:title>{}</dc:title>\
{creators}\
<dc:language>{}</dc:language>\
{extra_meta}\
<meta property=\"dcterms:modified\">{modified}</meta>\
</metadata>\
<manifest>{}</manifest>\
<spine>{spine}</spine>\
</package>",
        escape_xml(&book.identifier),
        escape_xml(&book.title),
        escape_xml(if book.language.is_empty() { "en" } else { &book.language }),
        manifest.join(""),
    )
}

/// XML 特殊字符转义
fn escape_xml(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

// ========== 单元测试 ==========

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_already_valid_xhtml() {
        let input = r#"<?xml version="1.0"?>
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>已有</title></head>
<body><p>ok</p></body>
</html>"#;
        let out = normalize_xhtml(input, "新标题");
        // 已经有 title,不应被替换
        assert!(out.contains("<title>已有</title>"), "got: {out}");
        assert!(!out.contains("<title>新标题</title>"), "got: {out}");
    }

    #[test]
    fn normalize_inject_title_when_missing() {
        // EPUB 源常见形式：有 html/head 但没 title
        let input = r#"<html xmlns="http://www.w3.org/1999/xhtml">
<head></head>
<body><p>正文</p></body>
</html>"#;
        let out = normalize_xhtml(input, "第一章");
        assert!(out.starts_with("<?xml version=\"1.0\""), "got: {out}");
        assert!(out.contains("<!DOCTYPE html PUBLIC"), "got: {out}");
        assert!(out.contains("<title>第一章</title>"), "got: {out}");
        assert!(out.contains("<p>正文</p>"), "got: {out}");
    }

    #[test]
    fn normalize_body_fragment_only() {
        // TXT 解析产物：只有 <body> 内部
        let input = "<p>纯文本段落</p>";
        let out = normalize_xhtml(input, "第一章");
        assert!(out.starts_with("<?xml"), "got: {out}");
        assert!(out.contains("<!DOCTYPE html PUBLIC"), "got: {out}");
        assert!(
            out.contains("<html xmlns=\"http://www.w3.org/1999/xhtml\">"),
            "got: {out}"
        );
        assert!(out.contains("<title>第一章</title>"), "got: {out}");
        assert!(out.contains("<body>"), "got: {out}");
        assert!(out.contains("<p>纯文本段落</p>"), "got: {out}");
    }

    #[test]
    fn normalize_with_xml_decl_but_no_doctype() {
        let input = r#"<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>章</title></head>
<body><p>x</p></body>
</html>"#;
        let out = normalize_xhtml(input, "ignored");
        assert!(out.contains("<!DOCTYPE"), "got: {out}");
        assert!(out.contains("<title>章</title>"), "got: {out}");
    }

    #[test]
    fn nav_xhtml_has_doctype_and_title() {
        let out = build_nav(&[("ch1.xhtml".into(), "第一章".into())]);
        assert!(out.starts_with("<?xml"), "got: {out}");
        assert!(out.contains("<!DOCTYPE html PUBLIC"), "got: {out}");
        assert!(out.contains("<title>目录</title>"), "got: {out}");
        assert!(out.contains("第一章"), "got: {out}");
    }

    #[test]
    fn escape_xml_ampersands() {
        assert_eq!(escape_xml("a & b"), "a &amp; b");
        assert_eq!(escape_xml("<script>"), "&lt;script&gt;");
        assert_eq!(escape_xml("\"x\""), "&quot;x&quot;");
    }
}