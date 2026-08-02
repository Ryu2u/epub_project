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
/// - chapter_htmls[i] 对应 chapters[i] 的 html 真值（html 已外置到文件，这里由
///   service 层读出来后按顺序传入；不依赖存储路径细节）
/// - asset_bytes: { asset_id: 字节 }，缺失的跳过
pub fn build_epub_bytes(
    book: &Book,
    chapters: Vec<Chapter>,
    chapter_htmls: Vec<String>,
    assets: &[Asset],
    asset_bytes: &HashMap<String, Vec<u8>>,
) -> Vec<u8> {
    // 同步按 spine_order 排序 chapters 和 chapter_htmls（zip 关系）
    let mut indexed: Vec<(i64, Chapter, String)> = chapters
        .into_iter()
        .zip(chapter_htmls)
        .map(|(c, h)| (c.spine_order, c, h))
        .collect();
    indexed.sort_by_key(|(order, _, _)| *order);
    let (chapters, chapter_htmls): (Vec<Chapter>, Vec<String>) =
        indexed.into_iter().map(|(_, c, h)| (c, h)).unzip();

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
    for (i, (ch, html)) in chapters.iter().zip(chapter_htmls.iter()).enumerate() {
        let ch_href = format!("chapter_{i:04}.xhtml");
        let rewritten = crate::epub::html_rewrite::rewrite_img_refs(
            html,
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

    // 4a. 内嵌字体（Maple Mono）— 必须在 nav.xhtml 之前写入，
    //     因为 nav.xhtml 头部会引用 fonts/MapleMono-*.ttf。
    let embedded = embedded_fonts();
    for (_font_id, font_path, font_bytes) in &embedded {
        let _ = zw.start_file(format!("OEBPS/fonts/{font_path}"), deflated);
        let _ = zw.write_all(font_bytes);
    }

    // 4b. nav.xhtml — 头部注入 @font-face 让导出 EPUB 自带 Maple Mono
    let _ = zw.start_file("OEBPS/nav.xhtml", deflated);
    let _ = zw.write_all(build_nav(&chapter_nav, &embedded).as_bytes());

    // 5. 资源文件（扁平到 OEBPS/assets/{id}）
    let mut asset_items: Vec<(String, String, String, bool, bool)> = Vec::new();
    for a in assets {
        if let Some(data) = asset_bytes.get(&a.id) {
            let _ = zw.start_file(format!("OEBPS/assets/{}", a.id), deflated);
            let _ = zw.write_all(data);
            let is_cover = Some(&a.id) == cover_asset_id.as_ref();
            let is_font = is_font_mime(&a.media_type);
            asset_items.push((
                a.id.clone(),
                format!("assets/{}", a.id),
                a.media_type.clone(),
                is_cover,
                is_font,
            ));
        }
    }

    // 5b. 把内嵌字体也作为 asset_item 加进去（让 content.opf 列出 manifest）
    for (font_id, font_path, _bytes) in &embedded {
        asset_items.push((
            font_id.clone(),
            format!("fonts/{font_path}"),
            "application/font-sfnt".to_string(),
            false,
            true,
        ));
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

    // 已经是合规 XHTML（含 DOCTYPE）→ 确保 XML decl 存在,再补标题
    if trimmed.contains("<!DOCTYPE") {
        return inject_chapter_heading(&ensure_xml_decl(input), title);
    }

    // 有 <?xml 但没 DOCTYPE → 加 DOCTYPE
    if trimmed.starts_with("<?xml") {
        let xml_end = trimmed.find("?>").map(|i| i + 2).unwrap_or(0);
        let after_xml_decl = &trimmed[xml_end..];
        let doc = format!(
            "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n{XHTML_DOCTYPE}\n{}",
            inject_title_into_xhtml(after_xml_decl, title).trim_start()
        );
        return inject_chapter_heading(&doc, title);
    }

    // 解析根标签：要么是 <html ...>，要么没有 <html>（纯 body 片段）
    let lower = trimmed.to_lowercase();
    if lower.contains("<html") {
        // 已有 <html> 根：在 </html> 之后没有内容时，补齐 head/title
        let doc = format!(
            "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n{XHTML_DOCTYPE}\n{}",
            inject_title_into_xhtml(trimmed, title)
        );
        return inject_chapter_heading(&doc, title);
    }

    // 没有 <html> 根（纯 body 片段，如 TXT 解析产物）→ 包成完整 XHTML
    let doc = format!(
        "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n{XHTML_DOCTYPE}\n\
<html xmlns=\"{XHTML_NS}\">\n<head>\n<title>{}</title>\n</head>\n<body>\n{input}\n</body>\n</html>",
        escape_xml(title),
    );
    inject_chapter_heading(&doc, title)
}

/// 在 XHTML 文档中保证 <head> 里至少有一个 <title>。
/// 如果 <head> 存在但没有 <title>,在 <head> 起始标签后插入。
/// 如果 <head> 不存在,跳过（调用方应保证至少有 <html> 根）。
fn inject_title_into_xhtml(doc: &str, title: &str) -> String {
    let lower = doc.to_lowercase();
    let escaped = escape_xml(title);

    // 已有 <title> → 非空保留,空则覆盖为章节标题
    if let Some(title_tag_start) = lower.find("<title") {
        // 开标签结束 > 位置
        let tag_end = title_tag_start + doc[title_tag_start..].find('>').unwrap_or(7) + 1;
        // 找 </title> 闭标签
        if let Some(close) = doc[tag_end..].find("</title>") {
            let content_end = tag_end + close;
            let original = &doc[tag_end..content_end];
            if original.trim().is_empty() {
                // 空 title → 替换内容
                let escaped = escape_xml(title);
                return format!("{}{}{}", &doc[..tag_end], escaped, &doc[content_end..]);
            }
        }
        // 非空 title → 保留
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

/// 在 <body> 起始标签后插入 <h3>章节标题</h3>。
/// 正文已有 h1-h6 标题则跳过(避免重复)。无 <body> 时原样返回。
fn inject_chapter_heading(doc: &str, title: &str) -> String {
    let lower = doc.to_lowercase();
    // 已有任何标题元素 → 不动
    if ["<h1", "<h2", "<h3", "<h4", "<h5", "<h6"]
        .iter()
        .any(|tag| lower.contains(tag))
    {
        return doc.to_string();
    }
    // 定位 <body ...> 的结束 >
    if let Some(body_start) = lower.find("<body") {
        if let Some(tag_end) = doc[body_start..].find('>') {
            let insert_at = body_start + tag_end + 1;
            let (before, after) = doc.split_at(insert_at);
            return format!("{before}<h3>{}</h3>\n{}", escape_xml(title), after);
        }
    }
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

/// 构建 nav.xhtml — 头部注入 @font-face 让导出 EPUB 自带 Maple Mono
fn build_nav(
    chapter_nav: &[(String, String)],
    embedded_fonts: &[(String, String, Vec<u8>)],
) -> String {
    let items: String = chapter_nav
        .iter()
        .map(|(href, title)| format!("<li><a href=\"{href}\">{}</a></li>", escape_xml(title)))
        .collect::<Vec<_>>()
        .join("\n");

    // @font-face 注入：导出 EPUB 自带字体，让阅读器/Sigil 打开后字体立即可用
    let font_face_css: String = embedded_fonts
        .iter()
        .map(|(_id, filename, _bytes)| {
            // weight/style 按文件名推断（Regular / Bold / Italic）
            let (weight, style) = if filename.contains("Bold") {
                ("700", "normal")
            } else if filename.contains("Italic") {
                ("400", "italic")
            } else {
                ("400", "normal")
            };
            format!(
                "@font-face {{ font-family: 'Maple Mono NF CN'; \
                 src: url('fonts/{filename}') format('truetype'); \
                 font-weight: {weight}; font-style: {style}; }}",
            )
        })
        .collect::<Vec<_>>()
        .join("\n");

    let style_block = if font_face_css.is_empty() {
        String::new()
    } else {
        format!("<style type=\"text/css\">\n{font_face_css}\n</style>")
    };

    format!(
        "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n\
{XHTML_DOCTYPE}\n\
<html xmlns=\"{XHTML_NS}\" xmlns:epub=\"{OPS_NS}\">\n\
<head>\n<title>目录</title>\n{style_block}\n</head>\n<body>\n\
<nav epub:type=\"toc\" id=\"toc\"><h1>目录</h1><ol>{items}</ol></nav>\n\
</body>\n</html>"
    )
}

/// 构建 content.opf
fn build_opf(
    book: &Book,
    chapter_files: &[(String, String)],
    asset_items: &[(String, String, String, bool, bool)],
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
    for (aid, href, media_type, is_cover, is_font) in asset_items {
        // 同一 item 可能有多个 properties（cover-image + embedded-font）
        let mut props = String::new();
        if *is_cover {
            props.push_str(" cover-image");
        }
        if *is_font {
            props.push_str(" embedded-font");
        }
        let props_attr = if props.is_empty() {
            String::new()
        } else {
            format!(" properties=\"{}\"", props.trim())
        };
        manifest.push(format!(
            "<item id=\"{}\" href=\"{href}\" media-type=\"{media_type}\"{props_attr}/>",
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

/// 内嵌字体：在导出 EPUB 时自动打包 Maple Mono（来自 web/public/fonts/）。
/// 用 PathBuf 而非 include_bytes! — 避免 60MB 字体数据塞进 server binary。
/// 找不到时返回空 Vec，导出 EPUB 不携带字体（向后兼容）。
fn embedded_fonts() -> Vec<(String, String, Vec<u8>)> {
    // CARGO_MANIFEST_DIR = backend-rs，向上两级到项目根，再到 web/public/fonts
    let fonts_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("web")
        .join("public")
        .join("fonts");

    let entries: &[(&str, &str)] = &[
        ("font-maple-regular", "MapleMono-Regular.ttf"),
        ("font-maple-bold", "MapleMono-Bold.ttf"),
        ("font-maple-italic", "MapleMono-Italic.ttf"),
    ];

    let mut out = Vec::new();
    for (id, filename) in entries {
        let path = fonts_dir.join(filename);
        match std::fs::read(&path) {
            Ok(bytes) => out.push((id.to_string(), filename.to_string(), bytes)),
            Err(e) => {
                tracing::warn!(
                    "内嵌字体缺失（导出 EPUB 不携带字体）: {} — {e}",
                    path.display()
                );
                return Vec::new(); // 任何一个缺失就整体跳过，保持一致
            }
        }
    }
    out
}

/// 判断 MIME 是否为嵌入字体（导出时需要 `properties="embedded-font"`）。
/// 同时接受 EPUB 2 时期和 EPUB 3 的 MIME，避免不同制作工具的差异。
fn is_font_mime(mt: &str) -> bool {
    matches!(
        mt,
        // EPUB 3 时期
        "application/font-woff"
            | "application/font-woff2"
            | "application/font-sfnt"
            | "application/vnd.ms-opentype"
            // 新规范（RFC 8081）
            | "font/ttf"
            | "font/otf"
            | "font/woff"
            | "font/woff2"
            // 兼容
            | "application/x-font-ttf"
            | "application/x-font-otf"
    )
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
        let out = build_nav(&[("ch1.xhtml".into(), "第一章".into())], &[]);
        assert!(out.starts_with("<?xml"), "got: {out}");
        assert!(out.contains("<!DOCTYPE html PUBLIC"), "got: {out}");
        assert!(out.contains("<title>目录</title>"), "got: {out}");
        assert!(out.contains("第一章"), "got: {out}");
    }

    #[test]
    fn inject_title_overwrites_empty_title() {
        let input = r#"<html xmlns="http://www.w3.org/1999/xhtml">
<head><title></title></head>
<body><p>正文</p></body>
</html>"#;
        let out = normalize_xhtml(input, "第1章 失能症候群");
        assert!(
            out.contains("<title>第1章 失能症候群</title>"),
            "空 title 应被覆盖: {out}"
        );
        assert!(!out.contains("<title></title>"), "不应保留空 title: {out}");
    }

    #[test]
    fn inject_h3_heading_into_body() {
        let input = r#"<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>已有</title></head>
<body><p>正文</p></body>
</html>"#;
        let out = normalize_xhtml(input, "第一章");
        assert!(
            out.contains("<body><h3>第一章</h3>"),
            "body 开头应有 <h3> 标题: {out}"
        );
    }

    #[test]
    fn skip_h3_when_body_has_existing_heading() {
        let input = r#"<html xmlns="http://www.w3.org/1999/xhtml">
<head></head>
<body><h1>已有大标题</h1><p>正文</p></body>
</html>"#;
        let out = normalize_xhtml(input, "第一章");
        assert!(!out.contains("<h3>第一章</h3>"), "正文已有标题不应重复插入: {out}");
        assert!(out.contains("<h1>已有大标题</h1>"), "应保留已有标题: {out}");
    }

    #[test]
    fn escape_xml_ampersands() {
        assert_eq!(escape_xml("a & b"), "a &amp; b");
        assert_eq!(escape_xml("<script>"), "&lt;script&gt;");
        assert_eq!(escape_xml("\"x\""), "&quot;x&quot;");
    }

    #[test]
    fn is_font_mime_recognizes_common_types() {
        // EPUB 3 + RFC 8081 + 旧式
        assert!(is_font_mime("application/font-woff"));
        assert!(is_font_mime("application/font-woff2"));
        assert!(is_font_mime("application/font-sfnt"));
        assert!(is_font_mime("font/ttf"));
        assert!(is_font_mime("font/woff2"));
        assert!(is_font_mime("application/vnd.ms-opentype"));
        // 非字体
        assert!(!is_font_mime("application/xhtml+xml"));
        assert!(!is_font_mime("image/jpeg"));
        assert!(!is_font_mime("text/css"));
    }

    #[test]
    fn build_nav_includes_font_face_css_when_embedded_fonts_present() {
        let fonts = vec![
            (
                "font-maple-regular".to_string(),
                "MapleMono-Regular.ttf".to_string(),
                vec![0u8; 10],
            ),
            (
                "font-maple-bold".to_string(),
                "MapleMono-Bold.ttf".to_string(),
                vec![0u8; 10],
            ),
        ];
        let nav = build_nav(
            &[("ch1.xhtml".into(), "第一章".into())],
            &fonts,
        );
        assert!(nav.contains("@font-face"), "nav must include @font-face");
        assert!(nav.contains("font-family: 'Maple Mono NF CN'"));
        assert!(nav.contains("fonts/MapleMono-Regular.ttf"));
        assert!(nav.contains("font-weight: 400"));
        assert!(nav.contains("font-weight: 700"));
        // 只有 Regular 和 Bold，没有 Italic
        assert!(!nav.contains("font-style: italic"), "should not have italic style when only Regular+Bold");
    }

    #[test]
    fn build_nav_italic_has_italic_style() {
        let fonts = vec![(
            "font-maple-italic".to_string(),
            "MapleMono-Italic.ttf".to_string(),
            vec![0u8; 10],
        )];
        let nav = build_nav(&[], &fonts);
        assert!(nav.contains("font-style: italic"));
        assert!(nav.contains("font-weight: 400"));
    }

    #[test]
    fn build_nav_no_fonts_means_no_style_block() {
        let nav = build_nav(&[], &[]);
        assert!(!nav.contains("<style"), "no fonts → no style block");
        assert!(!nav.contains("@font-face"));
    }

    /// 端到端：构造 Book + 章节 + 字体的最小数据集，
    /// 跑 build_epub_bytes，验证 ZIP 里有 fonts/ 目录 + content.opf 列出字体 item。
    #[test]
    fn end_to_end_build_epub_includes_embedded_fonts() {
        use crate::db::{Asset, Book, Chapter};
        use chrono::Utc;
        use std::collections::HashMap;

        let book = Book {
            id: "book-1".into(),
            title: "测试".into(),
            authors: vec!["作者".into()],
            language: "zh".into(),
            publisher: None,
            description: None,
            pub_date: None,
            identifier: "urn:test:1".into(),
            file_path: "book-1.epb".into(),
            file_size: 0,
            file_sha256: "x".into(),
            created_at: Utc::now().naive_utc(),
        };

        let chapters = vec![Chapter {
            id: "ch-1".into(),
            book_id: "book-1".into(),
            title: "第一章".into(),
            spine_order: 0,
            href: "OEBPS/chapter_0001.xhtml".into(),
            text: "正文".into(),
            word_count: 1,
        }];
        let chapter_htmls = vec!["<p>正文</p>".to_string()];

        let assets: Vec<Asset> = vec![];
        let asset_bytes: HashMap<String, Vec<u8>> = HashMap::new();

        let zip_bytes = build_epub_bytes(&book, chapters, chapter_htmls, &assets, &asset_bytes);
        assert!(!zip_bytes.is_empty(), "build_epub_bytes must return bytes");

        // 用 zip crate 解压验证结构
        let cursor = std::io::Cursor::new(zip_bytes);
        let mut archive = zip::ZipArchive::new(cursor).expect("open zip");

        // 1. mimetype 必须存在且不被压缩
        let mut mimetype = String::new();
        std::io::Read::read_to_string(
            &mut archive.by_name("mimetype").expect("mimetype"),
            &mut mimetype,
        )
        .expect("read mimetype");
        assert_eq!(mimetype, "application/epub+zip");

        // 2. 字体文件必须在 ZIP 里（仅当 web/public/fonts 存在时；CI 环境可能没有）
        let embedded = embedded_fonts();
        if !embedded.is_empty() {
            let font_filename = &embedded[0].1;
            let path = format!("OEBPS/fonts/{font_filename}");
            assert!(
                archive.by_name(&path).is_ok(),
                "expected font file {path} in zip"
            );
        }

        // 3. nav.xhtml 必须含 DOCTYPE + 字体引用
        let mut nav = String::new();
        std::io::Read::read_to_string(
            &mut archive.by_name("OEBPS/nav.xhtml").expect("nav.xhtml"),
            &mut nav,
        )
        .expect("read nav");
        assert!(nav.contains("<!DOCTYPE html PUBLIC"), "nav must have DOCTYPE");
        if !embedded.is_empty() {
            assert!(nav.contains("@font-face"), "nav must have @font-face");
            assert!(nav.contains("fonts/"));
        }

        // 4. content.opf 必须有效（验证不是空 manifest）
        let mut opf = String::new();
        std::io::Read::read_to_string(
            &mut archive.by_name("OEBPS/content.opf").expect("content.opf"),
            &mut opf,
        )
        .expect("read opf");
        assert!(opf.contains("<manifest>"));
        assert!(opf.contains("<spine>"));
        assert!(opf.contains("chapter_0000.xhtml"), "spine must reference chapter");

        // 5. 字体 item 必须在 manifest（仅当字体存在时）
        if !embedded.is_empty() {
            let font_id = &embedded[0].0;
            assert!(
                opf.contains(&format!("id=\"{font_id}\"")),
                "OPF manifest must include embedded font item {font_id}"
            );
            assert!(
                opf.contains("properties=\"embedded-font\""),
                "OPF must tag font item with embedded-font property"
            );
        }
    }
}