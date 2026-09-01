// OPF (Open Packaging Format) 解析：metadata / manifest / spine。
// 对应 Python reader/opf.py。用 quick-xml 事件流解析。

use std::collections::HashMap;

use chrono::NaiveDate;

use crate::epub::errors::{EpubError, ParsePhase};

use quick_xml::events::Event;
use quick_xml::Reader;

#[derive(Debug, Default)]
pub struct ManifestItem {
    /// manifest item 的 id（唯一标识）
    pub id: String,
    /// 已相对 OPF 目录解析的完整路径
    pub href: String,
    /// MIME 类型（如 application/xhtml+xml / image/jpeg）
    pub media_type: String,
    /// properties 属性串（以空白分隔，如 `nav` / `cover-image`）
    pub properties: String,
}

#[derive(Debug)]
pub struct SpineItem {
    /// 指向 manifest item 的 idref（id 引用）
    pub idref: String,
    /// 是否线性阅读项（linear="no" 时为 false）
    pub linear: bool,
}

#[derive(Debug, Default)]
pub struct OpfPackage {
    /// dc 字段 → 值列表（如 title / creator / language / date）
    pub metadata: HashMap<String, Vec<String>>,
    /// manifest 条目列表
    pub manifest: Vec<ManifestItem>,
    /// spine 阅读顺序列表
    pub spine: Vec<SpineItem>,
    /// EPUB 3 nav 文档路径（有则优先用其做目录）
    pub nav_href: Option<String>,
    /// EPUB 2 风格 <meta name="cover"> 指向的封面 item id
    pub cover_meta_id: Option<String>,
}

/// 解析 OPF 字节为结构化包对象
pub fn parse_opf(opf_bytes: &[u8], opf_path: &str) -> Result<OpfPackage, EpubError> {
    let xml = String::from_utf8(opf_bytes.to_vec()).map_err(|e| EpubError::Corrupt(format!(
        "OPF 不是 UTF-8：{e}"
    )))?;

    let base_dir = opf_path.rsplit_once('/').map(|(d, _)| d).unwrap_or("");

    let mut reader = Reader::from_str(&xml);
    reader.config_mut().trim_text(true);

    let mut pkg = OpfPackage::default();
    // 当前所在的 section
    let mut section = Section::Other;
    // metadata 内当前正在读文本的 dc 字段
    let mut current_dc_tag: Option<String> = None;

    let mut buf = Vec::new();
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => {
                let local = local_name(e.name().as_ref());
                match local.as_str() {
                    "metadata" => section = Section::Metadata,
                    "manifest" => section = Section::Manifest,
                    "spine" => section = Section::Spine,
                    _ => {
                        // metadata 里的 dc:* 元素
                        if section == Section::Metadata && is_dc_field(&local) {
                            current_dc_tag = Some(local.clone());
                        }
                    }
                }
            }
            Ok(Event::Empty(e)) => {
                let local = local_name(e.name().as_ref());
                match (section, local.as_str()) {
                    (Section::Manifest, "item") => {
                        if let Some(item) = parse_manifest_item(&e, base_dir) {
                            // 检查 properties="nav"
                            if item.properties.split_whitespace().any(|p| p == "nav") {
                                pkg.nav_href = Some(item.href.clone());
                            }
                            pkg.manifest.push(item);
                        }
                    }
                    (Section::Metadata, "meta") => {
                        // EPUB 2 风格 <meta name="cover" content="..."/>
                        let mut name = None;
                        let mut content = None;
                        for attr in e.attributes().flatten() {
                            let key = String::from_utf8_lossy(attr.key.as_ref()).to_string();
                            let val = String::from_utf8_lossy(attr.value.as_ref()).to_string();
                            if key == "name" {
                                name = Some(val);
                            } else if key == "content" {
                                content = Some(val);
                            }
                        }
                        if name.as_deref() == Some("cover") {
                            if let Some(c) = content {
                                if !c.is_empty() {
                                    pkg.cover_meta_id = Some(c);
                                }
                            }
                        }
                    }
                    (Section::Spine, "itemref") => {
                        let mut idref = String::new();
                        let mut linear = true;
                        for attr in e.attributes().flatten() {
                            let key = String::from_utf8_lossy(attr.key.as_ref()).to_string();
                            let val = String::from_utf8_lossy(attr.value.as_ref()).to_string();
                            if key == "idref" {
                                idref = val;
                            } else if key == "linear" {
                                linear = val.to_lowercase() != "no";
                            }
                        }
                        if !idref.is_empty() {
                            pkg.spine.push(SpineItem { idref, linear });
                        }
                    }
                    _ => {}
                }
            }
            Ok(Event::Text(e)) => {
                // 收集 dc 字段文本
                if let Some(tag) = &current_dc_tag {
                    let text = e.unescape().map(|s| s.trim().to_string()).unwrap_or_default();
                    if !text.is_empty() {
                        pkg.metadata
                            .entry(tag.clone())
                            .or_default()
                            .push(text);
                    }
                }
            }
            Ok(Event::End(e)) => {
                let local = local_name(e.name().as_ref());
                match local.as_str() {
                    "metadata" | "manifest" | "spine" => section = Section::Other,
                    _ => {
                        if current_dc_tag.as_deref() == Some(local.as_str()) {
                            current_dc_tag = None;
                        }
                    }
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => {
                return Err(EpubError::Corrupt(format!("OPF 解析失败：{e}")));
            }
            _ => {}
        }
        buf.clear();
    }

    // 必填字段校验 + identifier fallback（与 Python 行为一致）
    let required: [&str; 3] = ["title", "language", "identifier"];
    let mut missing: Vec<String> = required
        .iter()
        .filter(|f| {
            let v = pkg.metadata.get(**f);
            v.is_none() || v.is_some_and(|v| v.is_empty())
        })
        .map(|s| s.to_string())
        .collect();

    // identifier 缺失时用 opf_path 派生稳定 fallback
    if missing.iter().any(|m| m == "identifier") {
        let fallback = format!("urn:fallback:{opf_path}");
        pkg.metadata
            .entry("identifier".to_string())
            .or_default()
            .push(fallback);
        missing.retain(|f| f != "identifier");
    }

    if !missing.is_empty() {
        return Err(EpubError::IncompleteMetadata {
            fields: missing.join(", "),
            missing,
        });
    }

    Ok(pkg)
}

/// 解析日期：尝试多种 ISO 格式
pub fn parse_pub_date(values: Option<&Vec<String>>) -> Option<NaiveDate> {
    let v = values?.first()?;
    let text = v.trim();
    for fmt in &["%Y-%m-%d", "%Y-%m", "%Y"] {
        if let Ok(d) = NaiveDate::parse_from_str(text, fmt) {
            return Some(d);
        }
        // 带时间的格式：取前 10 字符（YYYY-MM-DD）
        if text.len() >= 10 {
            if let Ok(d) = NaiveDate::parse_from_str(&text[..10], "%Y-%m-%d") {
                return Some(d);
            }
        }
    }
    None
}

#[derive(PartialEq, Clone, Copy)]
enum Section {
    Metadata,
    Manifest,
    Spine,
    Other,
}

fn local_name(tag: &[u8]) -> String {
    // 跳过命名空间前缀：{uri}local 或 prefix:local
    let s = std::str::from_utf8(tag).unwrap_or("");
    if let Some(idx) = s.rfind(':') {
        s[idx + 1..].to_string()
    } else {
        s.to_string()
    }
}

fn is_dc_field(local: &str) -> bool {
    matches!(
        local,
        "title" | "creator" | "language" | "identifier" | "publisher" | "description" | "date"
    )
}

fn parse_manifest_item(
    e: &quick_xml::events::BytesStart,
    base_dir: &str,
) -> Option<ManifestItem> {
    let mut id = String::new();
    let mut href = String::new();
    let mut media_type = String::new();
    let mut properties = String::new();

    for attr in e.attributes().flatten() {
        let key = String::from_utf8_lossy(attr.key.as_ref()).to_string();
        let val = String::from_utf8_lossy(attr.value.as_ref()).to_string();
        match key.as_str() {
            "id" => id = val,
            "href" => href = val,
            "media-type" => media_type = val,
            "properties" => properties = val,
            _ => {}
        }
    }

    if id.is_empty() || href.is_empty() || media_type.is_empty() {
        return None;
    }

    // 相对路径解析：把 href 相对 OPF 所在目录拼成完整 zip 内路径
    let full_href = if base_dir.is_empty() {
        super::path::normalize_path(&href)
    } else {
        super::path::normalize_path(&format!("{base_dir}/{href}"))
    };

    Some(ManifestItem {
        id,
        href: full_href,
        media_type,
        properties,
    })
}

// ParsePhase 占位，避免 unused（opf 解析错误用 Corrupt）
#[allow(dead_code)]
fn _phase() -> ParsePhase {
    ParsePhase::Opf
}

// 让 EpubError::IncompleteMetadata 的 missing 字段类型对齐
// （Python 端 missing 是 list[str]）
impl EpubError {
    #[allow(dead_code)]
    fn _missing_hint() -> Vec<String> {
        vec![]
    }
}
