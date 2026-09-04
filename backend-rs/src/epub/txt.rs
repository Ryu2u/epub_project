// TXT 小说解析：从整本 TXT 字节流切分章节，构造 ParsedBook。
//
// 章节识别规则（标题必须顶格）：
//   - 跳过空行
//   - 跳过 ^-+$ 分隔线
//   - 行首（不允许前导空白）匹配「第 + 数字 + 卷/部/篇/章」或「数字 + 卷/部/篇/章」
//     的行视为新章节标题，数字支持阿拉伯数字与中文数词（一二三…百千万零〇两）
//   - 第一个章节标题之前的内容（版权页/简介/广告）静默丢弃
//
// 配套格式约定：章节标题顶格、正文段落带前导空格（全角/半角）。
// 正文行因有前导空白天然不会命中标题正则；即使正文忘了缩进（顶格），
// 只要不是「第X卷/部/篇/章」开头也不会被误切。
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
///
/// `on_progress` 在解析过程中被回调：(current, total, phase)，
/// 阶段固定为 "parsing"。TXT 切分是单遍流式扫描，章节总数无法提前
/// 已知，因此扫描期间以**行数**为粒度增量回调（约每 1024 行一次，
/// current/total 为行数），扫描结束后再以章节总数收尾一次。
pub fn parse_txt(
    bytes: Vec<u8>,
    filename: &str,
    on_progress: impl Fn(usize, usize, &str),
) -> Result<ParsedBook, EpubError> {
    // 1. UTF-8 校验（非 UTF-8 直接返回 TxtEncoding）
    let text = String::from_utf8(bytes).map_err(|e| EpubError::TxtEncoding(e.to_string()))?;

    // 2. 章节切分（空文件 / 无章节都会在这里抛错），扫描期间按行回报进度
    let chapters = split_chapters(&text, &on_progress)?;

    // 3. 元数据派生
    //    title: 文件名去掉扩展名
    let title = Path::new(filename)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("未命名")
        .to_string();

    //    identifier: TXT 全文 SHA-256（与 EPUB 的 file_sha256 字段同源）
    let identifier = storage::compute_sha256(text.as_bytes());

    // 切分完成，以章节总数收尾（total 已知）
    let total = chapters.len();
    on_progress(total, total, "parsing");

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
/// `on_progress` 在行扫描期间被增量回调（约每 1024 行一次，进度粒度为行数）。
fn split_chapters(
    text: &str,
    on_progress: &dyn Fn(usize, usize, &str),
) -> Result<Vec<TxtChapter>, EpubError> {
    if text.trim().is_empty() {
        return Err(EpubError::TxtEmpty);
    }

    // 章节标题正则（必须顶格，不允许前导空白）：
    //   第 + [阿拉伯/中文数字] + 卷|部|篇|章      → 第一章 / 第12卷 / 第三篇
    //   [阿拉伯/中文数字] + 卷|部|篇|章（无"第"） → 1章 / 一百章
    // "第"、数字、单位之间允许空白（如 "第 1 章"）；标题后可跟任意文字
    // （如 "第一章 起点"）。数字类：0-9 一二三四五六七八九十百千万零〇两。
    // 已知取舍：无"第"分支较宽，顶格正文若以 "一部…" "三章…" 开头会被
    // 误切——配套约定正文段首缩进即可规避。
    let title_regex = Regex::new(
        r"^(第\s*[0-9一二三四五六七八九十百千万零〇两]+\s*[卷部篇章]|[0-9一二三四五六七八九十百千万零〇两]+[卷部篇章]).*$",
    )
    .expect("static title regex must compile");
    let separator_regex = Regex::new(r"^-+$").expect("static separator regex must compile");

    let mut chapters: Vec<TxtChapter> = Vec::new();
    let mut current_title: Option<String> = None;
    let mut current_lines: Vec<String> = Vec::new();

    // 行级进度：先数总行数，扫描中每 PROGRESS_EVERY 行回调一次。
    // 回调只做一次 Mutex 赋值，1024 行的间隔足以避免高频锁竞争。
    const PROGRESS_EVERY: usize = 1024;
    let total_lines = text.lines().count();
    let mut processed_lines: usize = 0;

    for raw_line in text.lines() {
        processed_lines += 1;
        if processed_lines % PROGRESS_EVERY == 0 {
            on_progress(processed_lines, total_lines, "parsing");
        }

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
            // 标题行原样保留（仅去行尾空白），行内如 "第一章 起点" 保留空格
            current_title = Some(line.trim_end().to_string());
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
    /// 章节标题（来自章节分隔行的文本）
    title: String,
    /// 章节纯文本正文
    text: String,
    /// 阅读顺序（从 0 递增）
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
        parse_txt(input.as_bytes().to_vec(), filename, |_, _, _| {})
            .expect("parse should succeed")
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
        let r = parse_txt("".as_bytes().to_vec(), "empty.txt", |_, _, _| {});
        assert!(matches!(r, Err(EpubError::TxtEmpty)));

        // 只有空白也视为空
        let r2 = parse_txt("   \n\n  \n".as_bytes().to_vec(), "ws.txt", |_, _, _| {});
        assert!(matches!(r2, Err(EpubError::TxtEmpty)));
    }

    #[test]
    fn no_chapter_title_returns_txt_no_chapters() {
        // 全部是缩进行（以空白开头），没有顶格的「第X卷/部/篇/章」标题
        let text = "    正文一\n    正文二\n    正文三\n";
        let r = parse_txt(text.as_bytes().to_vec(), "x.txt", |_, _, _| {});
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
        // 旧规则（^\w+.*$）会把版权页每行都切成假章节；
        // 新规则只认「第X卷/部/篇/章」，前置版权页被静默丢弃。
        let text = "\
本站所有小说均为网络搜集
仅供学习交流
请于24小时内删除

第一章
    正文
";
        let book = parse_ok(text, "x.txt");

        // 版权页 3 行全部丢弃，只切出 1 个真章节
        assert_eq!(book.chapters.len(), 1);
        assert_eq!(book.chapters[0].title, "第一章");
        assert_eq!(book.chapters[0].text, "正文");
    }

    #[test]
    fn flush_left_body_lines_not_mistaken_as_titles() {
        // 顶格正文（忘缩进）只要不是「第X卷/部/篇/章」开头就不会被误切。
        // 旧规则 ^\w+.*$ 下这些行全部会被切成假章节。
        let text = "\
第一章 起点
他推开门走了进去。
窗外下着雨。
第二章 转折
故事继续。
";
        let book = parse_ok(text, "x.txt");

        assert_eq!(book.chapters.len(), 2);
        assert_eq!(book.chapters[0].title, "第一章 起点");
        assert_eq!(book.chapters[0].text, "他推开门走了进去。\n窗外下着雨。");
        assert_eq!(book.chapters[1].title, "第二章 转折");
        assert_eq!(book.chapters[1].text, "故事继续。");
    }

    #[test]
    fn chinese_and_arabic_numbers_with_all_units() {
        let text = "\
第1章 数字标题
    正文一
第十二章 中文数词
    正文二
第一卷 卷标题
    正文三
第2部 部标题
    正文四
第三篇 篇标题
    正文五
第 1 章 带空格
    正文六
";
        let book = parse_ok(text, "units.txt");

        let titles: Vec<&str> = book.chapters.iter().map(|c| c.title.as_str()).collect();
        assert_eq!(
            titles,
            vec![
                "第1章 数字标题",
                "第十二章 中文数词",
                "第一卷 卷标题",
                "第2部 部标题",
                "第三篇 篇标题",
                "第 1 章 带空格",
            ]
        );
    }

    #[test]
    fn bare_number_unit_without_di_prefix_matches() {
        // 无"第"分支：「数字+卷/部/篇/章」也算标题（如 "1章"、"一百章"）
        let text = "1章 开始\n    内容\n";
        let book = parse_ok(text, "bare.txt");
        assert_eq!(book.chapters.len(), 1);
        assert_eq!(book.chapters[0].title, "1章 开始");
    }

    #[test]
    fn indented_title_line_is_body_not_title() {
        // 标题必须顶格：带前导空白（全角/半角）的"第一章"是正文行
        let text = "第一章\n    正文\n　　第一章 不是标题\n    更多正文\n";
        let book = parse_ok(text, "indent.txt");

        assert_eq!(book.chapters.len(), 1);
        assert_eq!(book.chapters[0].title, "第一章");
        assert!(book.chapters[0].text.contains("第一章 不是标题"));
    }

    #[test]
    fn di_with_non_unit_suffix_is_body() {
        // "第二天"/"第一百个" 等数词后不是卷/部/篇/章的行不算标题
        let text = "\
第一章
    第二天他出发了。
    第一百个理由说不通。
    2013年的春天。
";
        let book = parse_ok(text, "nonunit.txt");

        assert_eq!(book.chapters.len(), 1);
        assert_eq!(book.chapters[0].text.lines().count(), 3);
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