// 应用配置：从环境变量读取，与 Python 版同前缀 EPUB_*。
// 用 OnceCell 做全局单例（axum 的 AppState 也可以，但配置启动时读一次就够）。

use std::path::PathBuf;

pub struct Config {
    /// EPUB 文件存放目录
    pub storage_dir: PathBuf,
    /// SQLite 连接 URL（如 sqlite:./data/library.db）
    pub database_url: String,
    /// 单文件上传上限（字节）
    pub max_upload_bytes: u64,
    /// 监听端口
    pub port: u16,
    /// 允许跨域的前端源
    pub cors_origins: Vec<String>,
}

impl Config {
    pub fn from_env() -> Self {
        // dotenvy 尝试加载 .env，没有就忽略（生产环境用真实环境变量）
        let _ = dotenvy::dotenv();

        let storage_dir = std::env::var("EPUB_STORAGE_DIR")
            .unwrap_or_else(|_| "../data/storage".to_string())
            .into();

        // Python 用 sqlite+aiosqlite:///./data/library.db，Rust sqlx 用 sqlite:./data/library.db
        // （sqlx 不支持三斜杠相对路径，会当成绝对路径解析失败）
        let database_url = std::env::var("EPUB_DATABASE_URL").unwrap_or_else(|_| {
            let raw = std::env::var("EPUB_DB_URL")
                .unwrap_or_else(|_| "sqlite:../data/library.db".to_string());
            // 剥掉 Python 前缀和多余的斜杠，统一成 sqlx 格式 sqlite:path
            let raw = raw.replace("sqlite+aiosqlite:", "sqlite:");
            // sqlite:///./x → sqlite:./x；sqlite://x → sqlite:x
            let raw = raw.replacen("sqlite://", "sqlite:", 1);
            raw
        });

        let max_upload_mb: u64 = std::env::var("EPUB_MAX_UPLOAD_MB")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(100);
        let max_upload_bytes = max_upload_mb * 1024 * 1024;

        let port: u16 = std::env::var("EPUB_PORT")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(8001);

        // CORS 源：Python 默认 ["http://localhost:5173"]
        let cors_origins = std::env::var("EPUB_CORS_ORIGINS")
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_else(|| vec!["http://localhost:5173".to_string()]);

        Self {
            storage_dir,
            database_url,
            max_upload_bytes,
            port,
            cors_origins,
        }
    }
}
