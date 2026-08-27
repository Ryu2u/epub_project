// EPUB 容器解析：mimetype 校验 + container.xml 解析 + DRM 检测。
// 对应 Python reader/container.py。

use std::io::{Read, Seek};

use crate::epub::errors::{EpubError, ParsePhase};

use quick_xml::events::Event;
use quick_xml::Reader;

/// 预期的 mimetype 内容（EPUB 规范）
const EXPECTED_MIMETYPE: &str = "application/epub+zip";

/// 校验 mimetype entry 内容正确（EPUB 规范要求第一个 entry）
pub fn validate_mimetype<R: Read + Seek>(
    archive: &mut zip::ZipArchive<R>,
) -> Result<(), EpubError> {
    let mut file = archive
        .by_name("mimetype")
        .map_err(|_| EpubError::InvalidContainer {
            message: "压缩包缺少 mimetype 文件".to_string(),
            phase: ParsePhase::Container,
        })?;
    let mut content = String::new();
    file.read_to_string(&mut content).map_err(|_| {
        EpubError::InvalidContainer {
            message: "mimetype 文件读取失败".to_string(),
            phase: ParsePhase::Container,
        }
    })?;
    if content.trim() != EXPECTED_MIMETYPE {
        return Err(EpubError::InvalidContainer {
            message: format!("mimetype 内容错误：期望 '{EXPECTED_MIMETYPE}'，实际 '{content}'"),
            phase: ParsePhase::Container,
        });
    }
    Ok(())
}

/// 检测是否含 DRM（META-INF/encryption.xml）
pub fn has_drm<R: Read + Seek>(archive: &zip::ZipArchive<R>) -> bool {
    archive
        .file_names()
        .any(|n| n == "META-INF/encryption.xml")
}

/// 解析 container.xml 找到 OPF rootfile 路径
pub fn find_rootfile<R: Read + Seek>(
    archive: &mut zip::ZipArchive<R>,
) -> Result<String, EpubError> {
    let bytes = read_member(archive, "META-INF/container.xml")?;
    let xml = String::from_utf8(bytes).map_err(|_| EpubError::InvalidContainer {
        message: "container.xml 不是 UTF-8".to_string(),
        phase: ParsePhase::Container,
    })?;

    // 用 quick-xml 找 <rootfile full-path="..."> 元素
    let mut reader = Reader::from_str(&xml);
    reader.config_mut().trim_text(true);

    let mut buf = Vec::new();
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Empty(e)) | Ok(Event::Start(e)) => {
                // rootfile 元素在默认命名空间下，local name 是 "rootfile"
                let local = e.name();
                let local_str = local.as_ref();
                if local_str.ends_with(b"rootfile") {
                    for attr in e.attributes().flatten() {
                        if attr.key.as_ref().ends_with(b"full-path") {
                            let path = String::from_utf8_lossy(attr.value.as_ref()).to_string();
                            if !path.is_empty() {
                                return Ok(path);
                            }
                        }
                    }
                }
            }
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
        buf.clear();
    }

    Err(EpubError::InvalidContainer {
        message: "container.xml 中找不到 rootfile full-path".to_string(),
        phase: ParsePhase::Container,
    })
}

/// 读 ZIP 内某文件为字节
pub fn read_member<R: Read + Seek>(
    archive: &mut zip::ZipArchive<R>,
    member: &str,
) -> Result<Vec<u8>, EpubError> {
    let mut file = archive.by_name(member).map_err(|_| {
        EpubError::InvalidContainer {
            message: format!("ZIP 内找不到：{member}"),
            phase: ParsePhase::Container,
        }
    })?;
    let mut buf = Vec::new();
    file.read_to_end(&mut buf).map_err(|_| EpubError::InvalidContainer {
        message: format!("读取 {member} 失败"),
        phase: ParsePhase::Container,
    })?;
    Ok(buf)
}
