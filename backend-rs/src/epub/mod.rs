// EPUB 解析模块入口。
//
// 对应 Python 的 reader/ 包：container / opf / nav / chapter / orchestrator。
// 解析流程：open_zip → mimetype → rootfile → parse_opf → nav/NCX → chapters。

pub mod chapter;
pub mod container;
pub mod errors;
pub mod html_rewrite;
pub mod nav;
pub mod opf;
pub mod path;
pub mod txt;

pub use errors::EpubError;
pub use opf::{ManifestItem, OpfPackage, SpineItem};
pub use txt::parse_txt;

use std::path::Path;

/// 来源格式：用于上传时按扩展名分流到不同的解析器。
/// EPUB/EPUB 重命名后(.epb)统一按 Epub 处理；TXT 走 txt 解析器。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceFormat {
    Epub,
    Txt,
}

impl SourceFormat {
    /// 按文件扩展名判断格式，无法识别返回 None。
    pub fn from_filename(filename: &str) -> Option<Self> {
        let ext = Path::new(filename)
            .extension()
            .and_then(|x| x.to_str())?
            .to_ascii_lowercase();
        match ext.as_str() {
            "epub" | "epb" => Some(Self::Epub),
            "txt" => Some(Self::Txt),
            _ => None,
        }
    }

    /// 落盘到 storage 目录时使用的扩展名（不带点）。
    pub fn storage_extension(self) -> &'static str {
        match self {
            Self::Epub => "epb",
            Self::Txt => "txt",
        }
    }
}

use std::io::Cursor;

use chrono::NaiveDate;

/// 解析后的领域模型（对应 Python reader/models.py 的 Book/Chapter/Asset）
#[derive(Debug)]
pub struct ParsedBook {
    pub title: String,
    pub authors: Vec<String>,
    pub language: String,
    pub publisher: Option<String>,
    pub description: Option<String>,
    pub pub_date: Option<NaiveDate>,
    pub identifier: String,
    pub chapters: Vec<ParsedChapter>,
    pub assets: Vec<ParsedAsset>,
    pub warnings: Vec<String>,
}

#[derive(Debug)]
pub struct ParsedChapter {
    pub id: String,
    pub title: String,
    pub order: i64,
    pub href: String,
    pub text: String,
    pub html: String,
    pub word_count: i64,
}

#[derive(Debug)]
pub struct ParsedAsset {
    pub id: String,
    pub href: String,
    pub media_type: String,
    pub size: u64,
    pub is_cover: bool,
}

/// 解析入口：接受 EPUB 字节，返回 ParsedBook。
/// 对应 Python 的 epub_reader.open_epub()。
pub fn parse_epub(bytes: Vec<u8>) -> Result<ParsedBook, EpubError> {
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes))
        .map_err(|e| EpubError::Corrupt(format!("无法打开 ZIP：{e}")))?;

    // 1. mimetype 校验
    container::validate_mimetype(&mut archive)?;
    // 2. DRM 检测
    if container::has_drm(&mut archive) {
        return Err(EpubError::Drm);
    }
    // 3. 找 rootfile（OPF 路径）
    let opf_path = container::find_rootfile(&mut archive)?;
    // 4. 解析 OPF
    let opf_bytes = container::read_member(&mut archive, &opf_path)?;
    let pkg = opf::parse_opf(&opf_bytes, &opf_path)?;

    // 5. 目录：EPUB 3 nav 优先，无则回退 NCX
    let mut warnings = Vec::new();
    let mut toc_by_href: std::collections::HashMap<String, String> = std::collections::HashMap::new();

    if let Some(nav_href) = &pkg.nav_href {
        match container::read_member(&mut archive, nav_href) {
            Ok(nav_bytes) => {
                toc_by_href = nav::parse_nav_toc(&nav_bytes, nav_href);
            }
            Err(_) => {}
        }
    }

    if toc_by_href.is_empty() {
        if let Some(ncx_name) = nav::find_ncx(archive.file_names()) {
            if let Ok(ncx_bytes) = container::read_member(&mut archive, &ncx_name) {
                let ncx_toc = nav::parse_ncx_toc(&ncx_bytes, &ncx_name);
                if !ncx_toc.is_empty() {
                    warnings.push("EPUB 2 NCX used for chapter titles (no EPUB 3 nav)".to_string());
                    toc_by_href = ncx_toc;
                }
            }
        }
    }

    // 6. 章节和资源
    let chapters = build_chapters(&mut archive, &pkg, &toc_by_href, &mut warnings)?;
    let assets = build_assets(&mut archive, &pkg)?;

    // 7. 元数据
    let pub_date = opf::parse_pub_date(pkg.metadata.get("date"));

    Ok(ParsedBook {
        title: pkg
            .metadata
            .get("title")
            .and_then(|v| v.first().cloned())
            .unwrap_or_default(),
        authors: pkg.metadata.get("creator").cloned().unwrap_or_default(),
        language: pkg
            .metadata
            .get("language")
            .and_then(|v| v.first().cloned())
            .unwrap_or_else(|| "und".to_string()),
        publisher: pkg.metadata.get("publisher").and_then(|v| v.first().cloned()),
        description: pkg.metadata.get("description").and_then(|v| v.first().cloned()),
        pub_date,
        identifier: pkg
            .metadata
            .get("identifier")
            .and_then(|v| v.first().cloned())
            .unwrap_or_default(),
        chapters,
        assets,
        warnings,
    })
}

/// 按 spine 顺序构建章节列表（对应 Python epub_reader._build_chapters）
fn build_chapters<R: std::io::Read + std::io::Seek>(
    archive: &mut zip::ZipArchive<R>,
    pkg: &OpfPackage,
    toc_by_href: &std::collections::HashMap<String, String>,
    warnings: &mut Vec<String>,
) -> Result<Vec<ParsedChapter>, EpubError> {
    let manifest_by_id: std::collections::HashMap<&str, &ManifestItem> = pkg
        .manifest
        .iter()
        .map(|m| (m.id.as_str(), m))
        .collect();

    let mut chapters = Vec::new();
    let mut order = 0i64;

    for spine_item in &pkg.spine {
        if !spine_item.linear {
            continue;
        }
        let Some(manifest_item) = manifest_by_id.get(spine_item.idref.as_str()) else {
            continue;
        };
        // MIME 白名单（含 EPUB 2 OPS 类型）
        if !is_chapter_media_type(&manifest_item.media_type) {
            continue;
        }

        let xhtml_bytes = match container::read_member(archive, &manifest_item.href) {
            Ok(b) => b,
            Err(_) => continue,
        };

        let (plain_text, html, word_count) = chapter::parse_chapter(&xhtml_bytes);
        let title = derive_chapter_title(manifest_item, toc_by_href, order);

        chapters.push(ParsedChapter {
            id: manifest_item.id.clone(),
            title,
            order,
            href: manifest_item.href.clone(),
            text: plain_text,
            html,
            word_count,
        });
        order += 1;
    }

    Ok(chapters)
}

/// 判断 MIME 是否是章节类型
fn is_chapter_media_type(mt: &str) -> bool {
    matches!(
        mt,
        "application/xhtml+xml"
            | "application/xhtml"
            | "text/html"
            | "text/x-oebps-document"
            | "text/x-oebps-1"
    )
}

/// 章节标题优先级：TOC href → basename → 文件名 → Chapter N
fn derive_chapter_title(
    manifest_item: &ManifestItem,
    toc_by_href: &std::collections::HashMap<String, String>,
    order: i64,
) -> String {
    if let Some(t) = toc_by_href.get(&manifest_item.href) {
        return t.clone();
    }
    let basename = manifest_item.href.rsplit('/').next().unwrap_or(&manifest_item.href);
    let without_ext = basename.rsplit_once('.').map(|(base, _)| base).unwrap_or(basename);
    if !without_ext.is_empty() && without_ext != manifest_item.href {
        return without_ext.to_string();
    }
    format!("Chapter {}", order + 1)
}

/// 构建资源列表（对应 Python epub_reader._build_assets）
fn build_assets<R: std::io::Read + std::io::Seek>(
    archive: &mut zip::ZipArchive<R>,
    pkg: &OpfPackage,
) -> Result<Vec<ParsedAsset>, EpubError> {
    let cover_ids: std::collections::HashSet<&str> = pkg
        .manifest
        .iter()
        .filter(|m| m.properties.split_whitespace().any(|p| p == "cover-image"))
        .map(|m| m.id.as_str())
        .collect();
    let mut cover_ids = cover_ids;
    if let Some(id) = &pkg.cover_meta_id {
        cover_ids.insert(id.as_str());
    }

    let mut assets = Vec::new();
    for i in 0..archive.len() {
        let entry = archive.by_index(i).map_err(|e| {
            EpubError::Corrupt(format!("读取 ZIP entry {i} 失败：{e}"))
        })?;
        if entry.is_dir() {
            continue;
        }
        let name = entry.name().to_string();
        let size = entry.size();
        // 匹配 manifest
        let Some(m) = pkg.manifest.iter().find(|m| m.href == name) else {
            continue;
        };
        if is_chapter_media_type(&m.media_type) {
            continue; // 章节已在 chapters 里
        }
        assets.push(ParsedAsset {
            id: m.id.clone(),
            href: m.href.clone(),
            media_type: m.media_type.clone(),
            size,
            is_cover: cover_ids.contains(m.id.as_str()),
        });
    }
    Ok(assets)
}
