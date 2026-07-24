// nav.xhtml / NCX 解析：提取 {href: title} 目录映射。
// 对应 Python reader/nav.py。

use std::collections::HashMap;

use quick_xml::events::Event;
use quick_xml::Reader;

/// 解析 EPUB 3 nav.xhtml，返回 {href: title}
pub fn parse_nav_toc(nav_bytes: &[u8], nav_href: &str) -> HashMap<String, String> {
    let xml = match std::str::from_utf8(nav_bytes) {
        Ok(s) => s,
        Err(_) => return HashMap::new(),
    };

    let base_dir = nav_href.rsplit_once('/').map(|(d, _)| d).unwrap_or("");

    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);

    let mut result: HashMap<String, String> = HashMap::new();
    let mut current_href: Option<String> = None;
    let mut buf = Vec::new();

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) | Ok(Event::Empty(e)) => {
                let local = local_name(e.name().as_ref());
                if local == "a" {
                    for attr in e.attributes().flatten() {
                        if attr.key.as_ref().ends_with(b"href") {
                            let href = String::from_utf8_lossy(attr.value.as_ref()).to_string();
                            let href = href.split('#').next().unwrap_or("").to_string();
                            if !href.is_empty() {
                                current_href = Some(href);
                            }
                        }
                    }
                }
            }
            Ok(Event::Text(e)) => {
                if let Some(href) = &current_href {
                    let title = e.unescape().map(|s| s.trim().to_string()).unwrap_or_default();
                    if !title.is_empty() {
                        // 归一化到 zip 内绝对路径
                        let full = if base_dir.is_empty() {
                            normalize(href)
                        } else {
                            normalize(&format!("{base_dir}/{href}"))
                        };
                        result.insert(full.clone(), title.clone());
                        result.insert(href.clone(), title);
                    }
                }
            }
            Ok(Event::End(e)) => {
                if local_name(e.name().as_ref()) == "a" {
                    current_href = None;
                }
            }
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
        buf.clear();
    }

    result
}

/// 在 ZIP 文件名列表中找 toc.ncx
pub fn find_ncx<'a, I>(names: I) -> Option<String>
where
    I: IntoIterator<Item = &'a str>,
{
    names.into_iter().find(|n| n.ends_with("toc.ncx")).map(|s| s.to_string())
}

/// 解析 EPUB 2 toc.ncx 的 navMap，返回 {href: title}
pub fn parse_ncx_toc(ncx_bytes: &[u8], ncx_href: &str) -> HashMap<String, String> {
    let xml = match std::str::from_utf8(ncx_bytes) {
        Ok(s) => s,
        Err(_) => return HashMap::new(),
    };

    let base_dir = ncx_href.rsplit_once('/').map(|(d, _)| d).unwrap_or("");

    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);

    let mut result: HashMap<String, String> = HashMap::new();
    // 状态：当前 navPoint 的 content src 和 label text
    let mut current_src: Option<String> = None;
    let mut in_text = false;
    let mut buf = Vec::new();

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => {
                let local = local_name(e.name().as_ref());
                if local == "content" {
                    for attr in e.attributes().flatten() {
                        if attr.key.as_ref().ends_with(b"src") {
                            let src = String::from_utf8_lossy(attr.value.as_ref()).to_string();
                            let src = src.split('#').next().unwrap_or("").to_string();
                            if !src.is_empty() {
                                current_src = Some(src);
                            }
                        }
                    }
                } else if local == "text" {
                    in_text = true;
                }
            }
            Ok(Event::Empty(e)) => {
                if local_name(e.name().as_ref()) == "content" {
                    for attr in e.attributes().flatten() {
                        if attr.key.as_ref().ends_with(b"src") {
                            let src = String::from_utf8_lossy(attr.value.as_ref()).to_string();
                            let src = src.split('#').next().unwrap_or("").to_string();
                            if !src.is_empty() {
                                current_src = Some(src);
                            }
                        }
                    }
                }
            }
            Ok(Event::Text(e)) => {
                if in_text {
                    if let Some(src) = &current_src {
                        let title = e.unescape().map(|s| s.trim().to_string()).unwrap_or_default();
                        if !title.is_empty() {
                            let full = if base_dir.is_empty() {
                                normalize(src)
                            } else {
                                normalize(&format!("{base_dir}/{src}"))
                            };
                            result.insert(full.clone(), title.clone());
                            result.insert(src.clone(), title);
                        }
                    }
                }
            }
            Ok(Event::End(e)) => {
                let local = local_name(e.name().as_ref());
                if local == "text" {
                    in_text = false;
                } else if local == "navPoint" {
                    current_src = None;
                }
            }
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
        buf.clear();
    }

    result
}

fn local_name(tag: &[u8]) -> String {
    let s = std::str::from_utf8(tag).unwrap_or("");
    if let Some(idx) = s.rfind(':') {
        s[idx + 1..].to_string()
    } else {
        s.to_string()
    }
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
