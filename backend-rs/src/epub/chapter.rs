// 章节 XHTML 解析：提取纯文本 + 字数统计。
// 对应 Python reader/chapter.py。
//
// 用 scraper（基于 html5ever）解析，天然容错（等价 lxml recover=True）。
// 真实 EPUB 常有非严格 XHTML，html5ever 能正确解析 tag-soup。

use scraper::{Html, Selector};

/// 解析章节 XHTML，返回 (纯文本, 原始 HTML, 字数)
pub fn parse_chapter(bytes: &[u8]) -> (String, String, i64) {
    let html = String::from_utf8_lossy(bytes).to_string();
    let document = Html::parse_document(&html);

    let text = extract_text(&document);
    let word_count = count_words(&text);

    (text, html, word_count)
}

/// 提取纯文本：选 body（或 fallback 到 html 根），收集所有文本节点。
///
/// TODO（后续精化）：当前不区分 block/inline，所有文本直接拼接。
/// Python 版会按 p/div/h*/li 等 block 元素加 \n 分隔。如果搜索片段质量不佳，
/// 可改成遍历 DOM 树对 block 元素插换行。MVP 阶段够用。
fn extract_text(document: &Html) -> String {
    let raw: String = if let Ok(sel) = Selector::parse("body") {
        document
            .select(&sel)
            .next()
            .map(|b| b.text().collect::<Vec<_>>().join(""))
            .unwrap_or_default()
    } else {
        document.root_element().text().collect::<Vec<_>>().join("")
    };

    // 压缩连续空白（含 &nbsp; 的 \u{a0} 保留为普通空格）
    let mut out = String::with_capacity(raw.len());
    let mut prev_ws = false;
    for ch in raw.chars() {
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

/// 字数统计：CJK 字符每个算 1，其余按 ASCII 词数（空白分隔）。
/// 与 Python chapter._count_words 逻辑一致。
pub(super) fn count_words(text: &str) -> i64 {
    let mut cjk = 0i64;
    let mut ascii_words = 0i64;

    for token in text.split_whitespace() {
        let mut has_ascii = false;
        for ch in token.chars() {
            if is_cjk(ch) {
                cjk += 1;
            } else if ch.is_ascii_graphic() {
                has_ascii = true;
            }
        }
        if has_ascii {
            ascii_words += 1;
        }
    }

    cjk + ascii_words
}

/// 判断是否是 CJK 字符（中日韩统一表意文字 + 假名）
pub(super) fn is_cjk(ch: char) -> bool {
    let c = ch as u32;
    // CJK 统一表意文字：U+4E00 - U+9FFF
    (0x4E00..=0x9FFF).contains(&c)
    // 平假名 + 片假名：U+3040 - U+30FF
    || (0x3040..=0x30FF).contains(&c)
}
