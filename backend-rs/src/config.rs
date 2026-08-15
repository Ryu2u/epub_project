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

    /// 腾讯云 COS 配置（可选；未配置时不启用 COS，资源仍走本地存储）。
    /// SecretId / SecretKey / Bucket 短名 / Region。
    pub cos: Option<CosConfig>,
}

pub struct CosConfig {
    pub secret_id: String,
    pub secret_key: String,
    pub bucket: String,
    pub region: String,
    /// COS 对象 Key 前缀（默认 `books/{book_id}/assets/{asset_id}`，由调用方拼入 book_id/asset_id）
    pub key_prefix: String,
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
            .unwrap_or(8002);

        // CORS 源：Python 默认 ["http://localhost:3000"]
        let cors_origins = std::env::var("EPUB_CORS_ORIGINS")
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_else(|| vec!["http://localhost:3000".to_string()]);

        // COS 配置：四个变量全有才启用。SecretKey 缺失时打印警告但不报错，
        // 让未配置 COS 的环境也能正常运行（资源全走本地存储）。
        let cos = match (
            std::env::var("EPUB_COS_SECRET_ID").ok(),
            std::env::var("EPUB_COS_SECRET_KEY").ok(),
            std::env::var("EPUB_COS_BUCKET").ok(),
            std::env::var("EPUB_COS_REGION").ok(),
        ) {
            (Some(secret_id), Some(secret_key), Some(bucket), Some(region)) => Some(CosConfig {
                secret_id,
                secret_key,
                bucket,
                region,
                key_prefix: std::env::var("EPUB_COS_KEY_PREFIX")
                    .unwrap_or_else(|_| "books/{book_id}/assets/{asset_id}".to_string()),
            }),
            _ => None,
        };

        Self {
            storage_dir,
            database_url,
            max_upload_bytes,
            port,
            cors_origins,
            cos,
        }
    }
}
