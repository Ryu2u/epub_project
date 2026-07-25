// EPUB 解析错误类型（对应 Python reader/errors.py）
//
// 用 thiserror 自动实现 Display + From。

#[derive(Debug, thiserror::Error)]
pub enum EpubError {
    #[error("EPUB 容器无效：{message}")]
    InvalidContainer { message: String, phase: ParsePhase },

    #[error("元数据不完整：缺少 {fields}")]
    IncompleteMetadata {
        fields: String,
        missing: Vec<String>,
    },

    #[error("EPUB 含 DRM（encryption.xml），不支持")]
    Drm,

    #[error("EPUB 文件损坏：{0}")]
    Corrupt(String),

    #[error("TXT 文件为空")]
    TxtEmpty,

    #[error("TXT 编码错误：{0}")]
    TxtEncoding(String),

    #[error("TXT 未识别到任何章节")]
    TxtNoChapters,

    #[error("文件系统错误：{0}")]
    FileSystem(String),

    #[error("重复文件：已存在 book_id={existing_book_id}")]
    DuplicateFile { existing_book_id: String },
}

/// 解析阶段（与 Python 的 ParsePhase 对应）
#[derive(Debug, Clone)]
pub enum ParsePhase {
    Container,
    Opf,
    Chapter,
    Nav,
}

impl EpubError {
    /// 错误码（用于 HTTP 响应，与 Python 端一致）
    pub fn code(&self) -> &'static str {
        match self {
            EpubError::InvalidContainer { .. } => "INVALID_CONTAINER",
            EpubError::IncompleteMetadata { .. } => "INCOMPLETE_METADATA",
            EpubError::Drm => "DRM_DETECTED",
            EpubError::Corrupt(_) => "CORRUPT_EPUB",
            EpubError::TxtEmpty => "TXT_EMPTY",
            EpubError::TxtEncoding(_) => "TXT_ENCODING",
            EpubError::TxtNoChapters => "TXT_NO_CHAPTERS",
            EpubError::FileSystem(_) => "FILESYSTEM_ERROR",
            EpubError::DuplicateFile { .. } => "DUPLICATE_FILE",
        }
    }

    pub fn phase(&self) -> Option<&str> {
        match self {
            EpubError::InvalidContainer { phase, .. } => Some(phase.as_str()),
            _ => None,
        }
    }
}

impl ParsePhase {
    pub fn as_str(&self) -> &'static str {
        match self {
            ParsePhase::Container => "container_parse",
            ParsePhase::Opf => "opf_parse",
            ParsePhase::Chapter => "chapter_parse",
            ParsePhase::Nav => "nav_parse",
        }
    }
}
