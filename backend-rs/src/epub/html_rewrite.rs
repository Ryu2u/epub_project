// 章节图片引用重写：把 <img src> / <svg image href> 指向的 EPUB 内部资源，
// 重写为后端可服务的 URL（渲染时）或扁平 assets 路径（导出时）。
//
// 之前在 api/books.rs（rewrite_img_src）和 epub_writer.rs（rewrite_refs_for_export）
// 各有一份几乎相同的实现，差异只在目标 URL 格式。这里参数化合并。

use std::collections::HashMap;

use scraper::{Html, Selector};

/// 重写章节 HTML 中的图片引用。
///
/// - `chapter_href`：章节在 EPUB 内的路径，用于解析相对引用基目录
/// - `asset_map`：`{zip 内绝对 href: asset_id}`
/// - `asset_to_url`：把 asset_id 映射为目标字符串
///   - 渲染：`|aid| format!("/api/books/{book_id}/assets/{aid}")`
///   - 导出：`|aid| format!("assets/{aid}")`
///
/// 匹配不到 asset_map 的引用保持原样（不删除元素）。
pub fn rewrite_img_refs<F>(html: &str, chapter_href: &str, asset_map: &HashMap<String, String>, asset_to_url: F) -> String
where
    F: Fn(&str) -> String,
{
    let chapter_dir = chapter_href.rsplit_once('/').map(|(d, _)| d).unwrap_or("");
    let document = Html::parse_document(html);
    let mut result = html.to_string();

    // <img src="...">
    if let Ok(sel) = Selector::parse("img") {
        for img in document.select(&sel) {
            if let Some(src) = img.value().attr("src") {
                let resolved = crate::epub::path::resolve_relative(src, chapter_dir);
                if let Some(aid) = asset_map.get(&resolved).or_else(|| asset_map.get(src)) {
                    let new_src = asset_to_url(aid);
                    result = result.replace(src, &new_src);
                }
            }
        }
    }

    // SVG <image href> / <image xlink:href>
    if let Ok(sel) = Selector::parse("image") {
        for image in document.select(&sel) {
            let href = image.value().attr("href").or_else(|| image.value().attr("xlink:href"));
            if let Some(href) = href {
                let resolved = crate::epub::path::resolve_relative(href, chapter_dir);
                if let Some(aid) = asset_map.get(&resolved).or_else(|| asset_map.get(href)) {
                    let new_href = asset_to_url(aid);
                    result = result.replace(href, &new_href);
                }
            }
        }
    }

    result
}
