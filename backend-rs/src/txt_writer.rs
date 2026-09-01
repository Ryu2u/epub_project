// TXT 导出：把书（章节 HTML）转成纯文本字节。
//
// 排版约定与 TXT 导入（epub/txt.rs）的识别规则互为镜像——
// "章节标题顶格、正文段落带前导空格"：
//   - 章节标题独立成行，顶格（无前导空白）
//   - 正文每个段落独立成行，段首缩进两个全角空格（U+3000 ×2）
//   - 章与章之间空一行
//
// 导出的 TXT 重新上传可还原章节结构（标题为「第X卷/部/篇/章」样式的书
// 完整往返；其他标题样式的书导入端不识别，属导入正则的已知范围）。
//
// 不输出书名行：导入器会把顶格的非章节模式行当正文/丢弃，书名由导出
// 文件名（{书名}.txt）承载。
//
// 章节真值是 XHTML（storage 里的 .html 文件），段落结构只在 HTML 里
// （DB 的 chapters.text 已压缩空白、无换行，不可用），因此这里用
// scraper（html5ever）重解析 HTML：block 元素边界与 <br> 转换行，
// 其余标签剥掉取文本。

use scraper::node::Node;
use scraper::{Html, Selector};

use crate::db::Chapter;

/// 段首缩进：两个全角空格（中文排版"空两格"惯例）。
const INDENT: &str = "\u{3000}\u{3000}";

/// 构建整本书的 TXT 字节（UTF-8，\n 换行）。
///
/// `on_progress(current, total, "building")` 每处理完一章回调一次。
pub fn build_txt(
    chapters: &[Chapter],
    chapter_htmls: &[String],
    on_progress: &dyn Fn(usize, usize, &str),
) -> Vec<u8> {
    let mut out = String::new();

    for (i, ch) in chapters.iter().enumerate() {
        let html = chapter_htmls.get(i).map(String::as_str).unwrap_or("");
        let paragraphs = html_to_paragraphs(html);

        if i > 0 {
            out.push('\n'); // 章间空行
        }

        // 章节标题：顶格，独立成行
        let ch_title = ch.title.trim();
        if !ch_title.is_empty() {
            out.push_str(ch_title);
            out.push('\n');
        }

        // 正文段落：段首两个全角空格
        for p in &paragraphs {
            out.push_str(INDENT);
            out.push_str(p);
            out.push('\n');
        }

        on_progress(i + 1, chapters.len(), "building");
    }

    out.into_bytes()
}

/// 章节 HTML → 段落列表（已去标签 / 压缩空白 / 去空行）。
///
/// block 元素（p/div/h1-h6/li/blockquote/tr/…）的开始与结束都视为换行边界，
/// `<br>` 同样转换行；inline 元素（span/em/strong/a/…）文本直接拼接。
/// script/style/head/title 的文本丢弃。每段内连续空白压缩为单个半角空格。
pub fn html_to_paragraphs(html: &str) -> Vec<String> {
    if html.trim().is_empty() {
        return Vec::new();
    }

    let document = Html::parse_document(html);

    let mut raw = String::with_capacity(html.len());
    let root = if let Ok(sel) = Selector::parse("body") {
        document
            .select(&sel)
            .next()
            .unwrap_or_else(|| document.root_element())
    } else {
        document.root_element()
    };
    collect_text(root, &mut raw);

    raw.lines()
        .map(collapse_whitespace)
        .filter(|l| !l.is_empty())
        .collect()
}

/// 深度优先收集文本节点：block 边界与 <br> 插换行，跳过 script/style。
fn collect_text(node: scraper::ElementRef, out: &mut String) {
    for child in node.children() {
        match child.value() {
            Node::Text(t) => out.push_str(&t.text),
            Node::Element(e) => {
                let tag = e.name();
                match tag {
                    "br" => out.push('\n'),
                    "script" | "style" | "head" | "title" | "template" => {}
                    _ => {
                        if is_block(tag) {
                            out.push('\n');
                        }
                        if let Some(el) = scraper::ElementRef::wrap(child) {
                            collect_text(el, out);
                        }
                        if is_block(tag) {
                            out.push('\n');
                        }
                    }
                }
            }
            _ => {}
        }
    }
}

/// HTML 块级元素：边界处换行，保证段落切分。
fn is_block(tag: &str) -> bool {
    matches!(
        tag,
        "address"
            | "article"
            | "aside"
            | "blockquote"
            | "center"
            | "dd"
            | "details"
            | "dialog"
            | "div"
            | "dl"
            | "dt"
            | "fieldset"
            | "figcaption"
            | "figure"
            | "footer"
            | "form"
            | "h1"
            | "h2"
            | "h3"
            | "h4"
            | "h5"
            | "h6"
            | "header"
            | "hr"
            | "li"
            | "main"
            | "nav"
            | "ol"
            | "p"
            | "pre"
            | "section"
            | "summary"
            | "table"
            | "tbody"
            | "td"
            | "tfoot"
            | "th"
            | "thead"
            | "tr"
            | "ul"
    )
}

/// 行内空白压缩：连续空白（含全角空格/制表符）→ 单个半角空格，首尾去净。
fn collapse_whitespace(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut prev_ws = false;
    for ch in line.chars() {
        if ch.is_whitespace() {
            if !prev_ws {
                out.push(' ');
            }
            prev_ws = true;
        } else {
            out.push(ch);
            prev_ws = false;
        }
    }
    out.trim().to_string()
}

// ========== 单元测试 ==========

#[cfg(test)]
mod tests {
    use super::*;

    fn chapter(title: &str) -> Chapter {
        Chapter {
            id: format!("ch-{}", title),
            book_id: "b1".into(),
            title: title.into(),
            spine_order: 0,
            href: format!("ch/{title}.xhtml"),
            text: String::new(),
            word_count: 0,
        }
    }

    #[test]
    fn paragraphs_indented_title_flush() {
        let chapters = vec![chapter("第一章 起点")];
        let htmls = vec![r#"<?xml version="1.0"?>
<html><head><title>ignored</title></head><body>
<p>第一段。</p>
<p>第二段。</p>
</body></html>"#
            .to_string()];

        let bytes = build_txt(&chapters, &htmls, &|_, _, _| {});
        let text = String::from_utf8(bytes).unwrap();

        assert_eq!(
            text,
            "第一章 起点\n\
             \u{3000}\u{3000}第一段。\n\
             \u{3000}\u{3000}第二段。\n"
        );
    }

    #[test]
    fn chapters_separated_by_blank_line() {
        let chapters = vec![chapter("第一章"), chapter("第二章")];
        let htmls = vec![
            "<p>甲</p>".to_string(),
            "<p>乙</p>".to_string(),
        ];
        let text = String::from_utf8(build_txt(&chapters, &htmls, &|_, _, _| {})).unwrap();

        assert_eq!(
            text,
            "第一章\n\
             \u{3000}\u{3000}甲\n\
             \n\
             第二章\n\
             \u{3000}\u{3000}乙\n"
        );
    }

    #[test]
    fn inline_tags_joined_block_split_br_newline() {
        let paragraphs = html_to_paragraphs(
            "<div><p>你好<span>世界</span>，<em>读者</em>。</p><p>第二行<br/>第三行</p></div>",
        );
        assert_eq!(
            paragraphs,
            vec!["你好世界，读者。".to_string(), "第二行".to_string(), "第三行".to_string()]
        );
    }

    #[test]
    fn leading_fullwidth_spaces_renormalized() {
        // 源 HTML 段首自带全角空格（导入遗留），导出时先去净再统一加缩进
        let paragraphs = html_to_paragraphs("<p>\u{3000}\u{3000}已有缩进的段落</p>");
        assert_eq!(paragraphs, vec!["已有缩进的段落".to_string()]);
    }

    #[test]
    fn script_style_skipped() {
        let paragraphs = html_to_paragraphs(
            "<html><head><style>p{color:red}</style></head><body><p>正文</p><script>alert(1)</script></body></html>",
        );
        assert_eq!(paragraphs, vec!["正文".to_string()]);
    }

    #[test]
    fn empty_chapter_renders_title_only() {
        let chapters = vec![chapter("空章")];
        let htmls = vec!["<body></body>".to_string()];
        let text = String::from_utf8(build_txt(&chapters, &htmls, &|_, _, _| {})).unwrap();
        assert_eq!(text, "空章\n");
    }

    #[test]
    fn progress_callback_fires_per_chapter() {
        let chapters = vec![chapter("一"), chapter("二"), chapter("三")];
        let htmls = vec!["<p>a</p>".to_string(), "<p>b</p>".to_string(), "<p>c</p>".to_string()];
        let seen = std::cell::RefCell::new(Vec::new());
        build_txt(&chapters, &htmls, &|c, t, p| {
            seen.borrow_mut().push((c, t, p.to_string()))
        });
        let seen = seen.into_inner();
        assert_eq!(seen.len(), 3);
        assert_eq!(seen[0], (1, 3, "building".to_string()));
        assert_eq!(seen[2], (3, 3, "building".to_string()));
    }
}
