// EPUB 写入器：从 DB 数据重建 EPUB 3 文件字节。
// 对应 Python services/epub_writer.py。
//
// 用于「导出 EPUB」端点：把用户编辑过的书籍（元数据/章节）打包成标准 EPUB 3。

use std::collections::HashMap;
use std::io::Write;

use chrono::Utc;

use crate::db::{Asset, Book, Chapter};

/// EPUB / XML 命名空间常量
const XHTML_NS: &str = "http://www.w3.org/1999/xhtml";
const OPS_NS: &str = "http://www.idpf.org/2007/ops";
const OPF_NS: &str = "http://www.idpf.org/2007/opf";
const DC_NS: &str = "http://purl.org/dc/elements/1.1/";

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

    // 3. 章节 XHTML（重写引用 → assets/{id}）
    let mut chapter_files: Vec<(String, String)> = Vec::new(); // (manifest_id, href)
    let mut chapter_nav: Vec<(String, String)> = Vec::new(); // (href, title)
    for (i, ch) in chapters.iter().enumerate() {
        let ch_href = format!("chapter_{i:04}.xhtml");
        let rewritten = rewrite_refs_for_export(&ch.html, &ch.href, &asset_map);
        let _ = zw.start_file(format!("OEBPS/{ch_href}"), deflated);
        let _ = zw.write_all(ensure_xml_decl(&rewritten).as_bytes());
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

/// 把章节内 <img src> / <svg image href> 重写为扁平 assets/{id} 路径。
/// 匹配不到的资源保持原样（不删除，与 Python 略不同但更安全）。
fn rewrite_refs_for_export(
    html: &str,
    chapter_href: &str,
    asset_map: &HashMap<String, String>,
) -> String {
    use scraper::{Html, Selector};

    let chapter_dir = chapter_href.rsplit_once('/').map(|(d, _)| d).unwrap_or("");
    let document = Html::parse_document(html);
    let mut result = html.to_string();

    // <img src>
    if let Ok(sel) = Selector::parse("img") {
        for img in document.select(&sel) {
            if let Some(src) = img.value().attr("src") {
                let resolved = resolve_relative(src, chapter_dir);
                if let Some(aid) = asset_map.get(&resolved).or_else(|| asset_map.get(src)) {
                    let new_src = format!("assets/{aid}");
                    result = result.replace(src, &new_src);
                }
            }
        }
    }
    // SVG <image href>
    if let Ok(sel) = Selector::parse("image") {
        for image in document.select(&sel) {
            let href = image.value().attr("href").or_else(|| image.value().attr("xlink:href"));
            if let Some(href) = href {
                let resolved = resolve_relative(href, chapter_dir);
                if let Some(aid) = asset_map.get(&resolved).or_else(|| asset_map.get(href)) {
                    let new_href = format!("assets/{aid}");
                    result = result.replace(href, &new_href);
                }
            }
        }
    }
    result
}

fn resolve_relative(src: &str, base_dir: &str) -> String {
    let src = src.split('#').next().unwrap_or(src);
    if src.starts_with('/') {
        return src.trim_start_matches('/').to_string();
    }
    if base_dir.is_empty() {
        return normalize(src);
    }
    normalize(&format!("{base_dir}/{src}"))
}

fn normalize(path: &str) -> String {
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

/// 确保 HTML 以 <?xml 声明开头
fn ensure_xml_decl(html: &str) -> String {
    let trimmed = html.trim_start();
    if trimmed.starts_with("<?xml") {
        html.to_string()
    } else {
        format!("<?xml version=\"1.0\" encoding=\"utf-8\"?>\n{html}")
    }
}

/// 构建 nav.xhtml
fn build_nav(chapter_nav: &[(String, String)]) -> String {
    let items: String = chapter_nav
        .iter()
        .map(|(href, title)| format!("<li><a href=\"{href}\">{}</a></li>", escape_xml(title)))
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n\
<html xmlns=\"{XHTML_NS}\" xmlns:epub=\"{OPS_NS}\">\
<head><title>目录</title></head><body>\
<nav epub:type=\"toc\" id=\"toc\"><h1>目录</h1><ol>{items}</ol></nav></body></html>"
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
