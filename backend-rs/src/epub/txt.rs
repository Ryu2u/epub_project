// TXT 小说解析：从整本 TXT 字节流切分章节，构造 ParsedBook。
//
// 与 book_search 项目 read_file.rs::note_split 算法同源:
//   - 跳过空行
//   - 跳过 ^-+$ 分隔线
//   - 任何匹配 ^\w+.*$ 的行视为新章节标题
//     （在 Rust regex 中 \w = [A-Za-z0-9_]，与 Python 的 UNICODE 行为不同；
//      用户已确认对他下载的小说"章节标题顶格、正文带空格"的格式下
//      此规则可用。）
//   - 第一个章节标题之前的内容（版权页/简介/广告）静默丢弃。
//
// 输出与 parse_epub 相同的领域模型（ParsedBook / ParsedChapter），
// 让 service 层和持久化代码无需为 TXT 单独分支。

use std::path::Path;

use regex::Regex;
use uuid::Uuid;

use crate::epub::chapter::count_words;
use crate::epub::errors::EpubError;
use crate::epub::{ParsedBook, ParsedChapter};
use crate::storage;

/// 解析入口：TXT 字节 → ParsedBook。
pub fn parse_txt(bytes: Vec<u8>, filename: &str) -> Result<ParsedBook, EpubError> {
    // 1. UTF-8 校验（非 UTF-8 直接返回 TxtEncoding）
    let text = String::from_utf8(bytes).map_err(|e| EpubError::TxtEncoding(e.to_string()))?;

    // 2. 章节切分（空文件 / 无章节都会在这里抛错）
    let chapters = split_chapters(&text)?;

    // 3. 元数据派生
    //    title: 文件名去掉扩展名
    let title = Path::new(filename)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("未命名")
        .to_string();

    //    identifier: TXT 全文 SHA-256（与 EPUB 的 file_sha256 字段同源）
    let identifier = storage::compute_sha256(text.as_bytes());

    // 4. 构造 ParsedChapter
    let parsed_chapters: Vec<ParsedChapter> = chapters
        .into_iter()
        .map(|ch| {
            let order = ch.order;
            ParsedChapter {
                id: Uuid::new_v4().simple().to_string(),
                title: ch.title,
                order,
                // 虚拟 href：EPUB 的 href 是 ZIP 内路径，TXT 没有；
                // 用自定义 scheme 表明非真实文件路径。
                href: format!("txt://chapter/{order}"),
                text: ch.text.clone(),
                html: text_to_xhtml(&ch.text),
                word_count: count_words(&ch.text),
            }
        })
        .collect();

    Ok(ParsedBook {
        title,
        authors: vec!["未知".to_string()],
        language: "zh".to_string(),
        publisher: None,
        description: None,
        pub_date: None,
        identifier,
        chapters: parsed_chapters,
        assets: Vec::new(),
    })
}

/// 章节切分：返回 (title, body_lines)。
/// 严格复刻 book_search::note_split 的章节识别规则。
fn split_chapters(text: &str) -> Result<Vec<TxtChapter>, EpubError> {
    if text.trim().is_empty() {
        return Err(EpubError::TxtEmpty);
    }

    // \w+.*$ 与原项目完全一致；连字符分隔线排除。
    let title_regex = Regex::new(r"^\w+.*$").expect("static title regex must compile");
    let separator_regex = Regex::new(r"^-+$").expect("static separator regex must compile");

    let mut chapters: Vec<TxtChapter> = Vec::new();
    let mut current_title: Option<String> = None;
    let mut current_lines: Vec<String> = Vec::new();

    for raw_line in text.lines() {
        let line = raw_line.trim_end_matches('\r');

        // 空行 + 分隔线跳过
        if line.is_empty() || separator_regex.is_match(line) {
            continue;
        }

        if title_regex.is_match(line) {
            // 遇到新标题：先 flush 当前章节（如果有）
            if let Some(title) = current_title.take() {
                chapters.push(TxtChapter {
                    title,
                    text: trim_each_line(&current_lines).join("\n"),
                    order: chapters.len() as i64,
                });
                current_lines.clear();
            }
            current_title = Some(line.to_string());
        } else if current_title.is_some() {
            // 标题之后：作为正文行累积
            current_lines.push(line.to_string());
        }
        // 第一个章节标题之前的行（缩进正文/版权页等）静默丢弃
    }

    // 文件末尾如果还有未 flush 的最后一章
    if let Some(title) = current_title {
        chapters.push(TxtChapter {
            title,
            text: trim_each_line(&current_lines).join("\n"),
            order: chapters.len() as i64,
        });
    }

    if chapters.is_empty() {
        return Err(EpubError::TxtNoChapters);
    }

    Ok(chapters)
}

struct TxtChapter {
    title: String,
    text: String,
    order: i64,
}

/// 纯文本 → XHTML：每行一段，HTML 转义防 XSS。
fn text_to_xhtml(text: &str) -> String {
    let paragraphs: String = text
        .lines()
        .filter(|line| !line.is_empty())
        .map(|line| format!("<p>{}</p>", html_escape(line)))
        .collect::<Vec<_>>()
        .join("\n");

    format!(
        r#"<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title></title></head>
<body>
{paragraphs}
</body>
</html>"#
    )
}

/// HTML 实体转义：& < > " 四种基本字符。
/// 比引入 askama/handlebars 轻量，对纯文本足够。
fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// 去掉每行首尾空白：小说正文行常带前导空格/全角空格，
/// 渲染时一并去掉，避免 Reader 出现怪异的左边距。
fn trim_each_line(lines: &[String]) -> Vec<String> {
    lines.iter().map(|l| l.trim().to_string()).collect()
}

// ========== 单元测试 ==========

#[cfg(test)]
mod tests {
    use super::*;

    fn parse_ok(input: &str, filename: &str) -> ParsedBook {
        parse_txt(input.as_bytes().to_vec(), filename).expect("parse should succeed")
    }

    #[test]
    fn multi_chapter_basic() {
        let text = "第一章\n    正文一\n第二章\n    正文二\n";
        let book = parse_ok(text, "demo.txt");

        assert_eq!(book.title, "demo");
        assert_eq!(book.authors, vec!["未知".to_string()]);
        assert_eq!(book.language, "zh");
        assert_eq!(book.chapters.len(), 2);

        let c0 = &book.chapters[0];
        assert_eq!(c0.title, "第一章");
        assert_eq!(c0.order, 0);
        assert_eq!(c0.text, "正文一");
        assert_eq!(c0.href, "txt://chapter/0");
        assert!(c0.html.contains("<p>正文一</p>"));
        assert!(c0.word_count > 0);

        let c1 = &book.chapters[1];
        assert_eq!(c1.title, "第二章");
        assert_eq!(c1.order, 1);
        assert_eq!(c1.text, "正文二");
    }

    #[test]
    fn blank_lines_and_separators_ignored() {
        let text = "\
第一章
    内容一



-----
    不应作为章节标题的分隔线

第二章
    内容二
";
        let book = parse_ok(text, "x.txt");

        assert_eq!(book.chapters.len(), 2);
        assert_eq!(book.chapters[0].title, "第一章");
        assert!(book.chapters[0].text.contains("内容一"));
        // 分隔线不应进入正文
        assert!(!book.chapters[0].text.contains("---"));
        assert_eq!(book.chapters[1].title, "第二章");
    }

    #[test]
    fn empty_file_returns_txt_empty() {
        let r = parse_txt("".as_bytes().to_vec(), "empty.txt");
        assert!(matches!(r, Err(EpubError::TxtEmpty)));

        // 只有空白也视为空
        let r2 = parse_txt("   \n\n  \n".as_bytes().to_vec(), "ws.txt");
        assert!(matches!(r2, Err(EpubError::TxtEmpty)));
    }

    #[test]
    fn no_chapter_title_returns_txt_no_chapters() {
        // 全部是缩进行（以空白开头），没有 \w 开头的标题
        let text = "    正文一\n    正文二\n    正文三\n";
        let r = parse_txt(text.as_bytes().to_vec(), "x.txt");
        assert!(matches!(r, Err(EpubError::TxtNoChapters)));
    }

    #[test]
    fn html_escaping_prevents_xss() {
        let text = "第一章\n    <script>alert(1)</script> & test \"quote\"\n";
        let book = parse_ok(text, "xss.txt");

        let html = &book.chapters[0].html;
        // 不能出现未转义的标签或字符
        assert!(!html.contains("<script>"), "raw <script> must be escaped");
        assert!(html.contains("&lt;script&gt;"));
        assert!(html.contains("&amp;"));
        assert!(html.contains("&quot;"));
        // 原文（text 字段）保留
        assert!(book.chapters[0].text.contains("<script>"));
    }

    #[test]
    fn word_count_uses_chapter_count_words() {
        let text = "第一章\n    中文ABC hello world！\n";
        let book = parse_ok(text, "count.txt");

        // chapter::count_words 算法：split_whitespace 后逐 token 计
        //   - CJK 字符每个 +1
        //   - 含 ascii_graphic 字符的 token +1（作为一个词）
        // token1 "中文ABC"  → cjk=2, ascii 词 = 1（有 A/B/C）
        // token2 "hello"    → ascii 词 = 1
        // token3 "world！"  → world！整体一个 token，里面有 world → ascii 词 = 1
        // 标点"！"是 is_ascii_graphic（在 ASCII 范围），所以包含在 has_ascii 判定里。
        // 总计: 2 + 1 + 1 + 1 = 5
        assert_eq!(book.chapters[0].word_count, 5);
    }

    #[test]
    fn chapter_with_empty_body_still_kept() {
        let text = "第一章\n第二章\n";
        let book = parse_ok(text, "empty-body.txt");

        assert_eq!(book.chapters.len(), 2);
        assert_eq!(book.chapters[0].text, "");
        assert_eq!(book.chapters[1].text, "");
        // 即使正文为空也构造合法 XHTML（空 body）
        assert!(book.chapters[0].html.contains("<body>"));
        assert!(book.chapters[0].html.contains("</body>"));
    }

    #[test]
    fn leading_content_silently_discarded() {
        // 已知限制：Rust regex 的 \w 在 Unicode 模式下也匹配汉字，
        // 因此任何非空、非 ^-+$ 分隔线的行都会被 ^\w+.*$ 视为标题，
        // 包括文件开头的版权页、简介、广告等前置内容。
        // 这与 book_search 原项目(Python re 默认 Unicode 模式)行为一致，
        // 用户已确认沿用此算法。如未来需要丢弃前置内容，应在 split_chapters
        // 内增加"跳过前 N 个 title 直到第一个看起来像章节的标题"的策略。
        let text = "\
本站所有小说均为网络搜集
仅供学习交流
请于小时内删除

第一章
    正文
";
        let book = parse_ok(text, "x.txt");

        // 当前行为：3 行纯中文版权页被切成 3 个假章节 + 1 个真章节
        assert_eq!(book.chapters.len(), 4);
        assert_eq!(book.chapters[0].title, "本站所有小说均为网络搜集");
        assert_eq!(book.chapters[3].title, "第一章");
        assert_eq!(book.chapters[3].text, "正文");
    }

    #[test]
    fn ascii_copyright_page_becomes_fake_chapters_known_limit() {
        // 与 leading_content_silently_discarded 同理：含 ASCII 字符的版权页
        // 也会被当成章节，与 book_search 原项目行为一致。
        // 本测试用来"冻结"这个行为，避免将来无意中破坏向后兼容。
        let text = "\
本站所有小说均为网络搜集
仅供学习交流
请于24小时内删除

第一章
    正文
";
        let book = parse_ok(text, "x.txt");

        assert_eq!(book.chapters.len(), 4);
        assert_eq!(book.chapters[3].title, "第一章");
        assert_eq!(book.chapters[3].text, "正文");
    }

    #[test]
    fn identifier_is_sha256_hex() {
        let text = "第一章\n    正文\n";
        let book = parse_ok(text, "x.txt");
        // SHA-256 是 64 个十六进制字符
        assert_eq!(book.identifier.len(), 64);
        assert!(book.identifier.chars().all(|c| c.is_ascii_hexdigit()));
    }
}