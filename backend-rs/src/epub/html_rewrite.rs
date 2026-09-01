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
    // 注意：SVG 里 xlink:href 带 XLink 命名空间，scraper 的 attr("href")/attr("xlink:href")
    // 都用"空命名空间 + 完整属性名"去精确匹配，因此拿不到。这里遍历元素属性，
    // 按 local 名（`href`）匹配即可同时覆盖普通 href 与带命名空间的 xlink:href。
    if let Ok(sel) = Selector::parse("image") {
        for image in document.select(&sel) {
            let href = image
                .value()
                .attrs()
                .find(|(local, _)| *local == "href")
                .map(|(_, v)| v);
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

/// 重写章节 HTML 中的字体 URL（@font-face src / background-image url / 行内 url）。
///
/// 主要解决:用户上传的 EPUB 章节 HTML 里通常带 `<style>@font-face { src: url('../Fonts/xxx.ttf') }</style>`，
/// 不重写的话 Reader 拿到的就是相对路径，浏览器会去找当前页面(Reader 路由)的相对位置 → 404。
/// 渲染时 asset_to_url 把 asset_id 映射为 `/api/books/{id}/assets/{aid}`,导出时映射为 `assets/{aid}`。
///
/// 跳过:
///   - data: URL (内联 base64,无需重写)
///   - 绝对 http(s) URL (跨域资源,服务端管不到)
///   - 在 asset_map 里找不到的引用 (保持原样,前端可能 fall back 到系统字体)
pub fn rewrite_url_refs<F>(
    html: &str,
    chapter_href: &str,
    asset_map: &HashMap<String, String>,
    asset_to_url: F,
) -> String
where
    F: Fn(&str) -> String,
{
    use regex::Regex;
    // 匹配 url(X) 其中 X 不含括号（CSS 不允许 url 嵌套括号）
    // 允许 X 两侧有可选引号
    let re = Regex::new(r#"url\(\s*(?:"([^"]+)"|'([^']+)'|([^)\s]+))\s*\)"#).expect("static regex");

    let chapter_dir = chapter_href.rsplit_once('/').map(|(d, _)| d).unwrap_or("");
    let mut result = html.to_string();

    for cap in re.captures_iter(html) {
        // 三个捕获组分别对应带双引号/单引号/无引号
        let raw = cap
            .get(1)
            .or_else(|| cap.get(2))
            .or_else(|| cap.get(3))
            .map(|m| m.as_str().to_string());
        let Some(raw) = raw else { continue };

        // 跳过 data URL 和绝对 URL
        if raw.starts_with("data:") || raw.starts_with("http://") || raw.starts_with("https://") {
            continue;
        }
        // 跳过 #fragment-only
        if raw.starts_with('#') {
            continue;
        }

        let resolved = crate::epub::path::resolve_relative(&raw, chapter_dir);
        let aid = asset_map
            .get(&resolved)
            .or_else(|| asset_map.get(&raw));
        let Some(aid) = aid else { continue };

        let new_url = asset_to_url(aid);
        // 只替换第一次出现（避免误伤重复字面量；实际场景几乎不会撞）
        if let Some(pos) = result.find(&raw) {
            result = format!(
                "{}{}{}",
                &result[..pos],
                new_url,
                &result[pos + raw.len()..]
            );
        }
    }

    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn asset_map() -> HashMap<String, String> {
        let mut m = HashMap::new();
        // 章节在 OEBPS/chapters/，字体在 OEBPS/fonts/
        m.insert("OEBPS/fonts/MapleMono-Regular.ttf".into(), "font-reg".into());
        m.insert("OEBPS/fonts/MapleMono-Bold.ttf".into(), "font-bold".into());
        m.insert("OEBPS/styles/cover.jpg".into(), "img-cover".into()); // 兼用资源
        m
    }

    #[test]
    fn rewrite_font_face_relative_path() {
        let html = r#"<style>@font-face { src: url('../fonts/MapleMono-Regular.ttf'); }</style><p>正文</p>"#;
        let out = rewrite_url_refs(html, "OEBPS/chapters/ch1.xhtml", &asset_map(), |aid| {
            format!("/api/books/b1/assets/{aid}")
        });
        assert!(
            out.contains("/api/books/b1/assets/font-reg"),
            "should rewrite relative font URL; got: {out}"
        );
    }

    #[test]
    fn rewrite_font_face_multiple_urls() {
        let html = r#"<style>
@font-face { src: url('../fonts/MapleMono-Regular.ttf'); font-weight: 400; }
@font-face { src: url('../fonts/MapleMono-Bold.ttf'); font-weight: 700; }
</style>"#;
        let out = rewrite_url_refs(html, "OEBPS/chapters/ch1.xhtml", &asset_map(), |aid| {
            format!("/api/books/b1/assets/{aid}")
        });
        assert!(out.contains("assets/font-reg"));
        assert!(out.contains("assets/font-bold"));
    }

    #[test]
    fn skip_data_and_absolute_urls() {
        let html = r#"<style>
@font-face { src: url('data:font/ttf;base64,AAAB...'); }
@font-face { src: url('https://cdn.example.com/font.ttf'); }
@font-face { src: url('../fonts/MapleMono-Regular.ttf'); }
</style>"#;
        let out = rewrite_url_refs(html, "OEBPS/chapters/ch1.xhtml", &asset_map(), |aid| {
            format!("/api/books/b1/assets/{aid}")
        });
        // data: 和 https:// 保留原样
        assert!(out.contains("data:font/ttf"));
        assert!(out.contains("https://cdn.example.com"));
        // 相对路径被重写
        assert!(out.contains("assets/font-reg"));
    }

    #[test]
    fn skip_when_not_in_asset_map() {
        // url 找不到 asset_map → 保持原样（fall back 到浏览器默认字体）
        let html = r#"<style>@font-face { src: url('../fonts/UnknownFont.ttf'); }</style>"#;
        let out = rewrite_url_refs(html, "OEBPS/chapters/ch1.xhtml", &asset_map(), |aid| {
            format!("/api/books/b1/assets/{aid}")
        });
        assert!(out.contains("UnknownFont.ttf"), "unknown URL must stay as-is");
        assert!(!out.contains("api/books"));
    }

    #[test]
    fn rewrite_quoted_and_unquoted_url() {
        // CSS url() 三种常见形式：url(x), url("x"), url('x')
        let html = r#"<style>
@font-face { src: url(foo.ttf); }
@font-face { src: url("bar.ttf"); }
@font-face { src: url('baz.ttf'); }
</style>"#;
        let mut m = HashMap::new();
        m.insert("foo.ttf".into(), "f1".into());
        m.insert("bar.ttf".into(), "f2".into());
        m.insert("baz.ttf".into(), "f3".into());
        let out = rewrite_url_refs(html, "", &m, |aid| format!("api/{aid}"));
        assert!(out.contains("api/f1"));
        assert!(out.contains("api/f2"));
        assert!(out.contains("api/f3"));
    }

    #[test]
    fn rewrite_svg_image_xlink_href() {
        // 插画章节常见结构：<svg><image xlink:href="../Images/xxx.jpg"/></svg>。
        // xlink:href 带 XLink 命名空间，scraper 的 attr("href")/attr("xlink:href")
        // 都匹配不到，必须遍历属性按 local 名取。这里用真实目录结构回归测试。
        let html = r#"<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><image xlink:href="../Images/165678.jpg"/></svg>"#;
        let mut m = HashMap::new();
        m.insert("OEBPS/Images/165678.jpg".into(), "img165678.jpg".into());
        let out = rewrite_img_refs(html, "OEBPS/Text/chapter0.xhtml", &m, |aid| {
            format!("/api/books/b1/assets/{aid}")
        });
        assert!(
            out.contains("/api/books/b1/assets/img165678.jpg"),
            "xlink:href must be rewritten; got: {out}"
        );
        assert!(!out.contains("../Images/165678.jpg"));
    }

    #[test]
    fn rewrite_svg_image_href_without_namespace() {
        // 普通（无命名空间）href 也应能被重写。
        let html = r#"<svg xmlns="http://www.w3.org/2000/svg"><image href="../Images/165678.jpg"/></svg>"#;
        let mut m = HashMap::new();
        m.insert("OEBPS/Images/165678.jpg".into(), "img165678.jpg".into());
        let out = rewrite_img_refs(html, "OEBPS/Text/chapter0.xhtml", &m, |aid| {
            format!("/api/books/b1/assets/{aid}")
        });
        assert!(out.contains("/api/books/b1/assets/img165678.jpg"));
    }
}
