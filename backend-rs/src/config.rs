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
    /// 监听地址（如 0.0.0.0 / 127.0.0.1 / 192.168.1.5），默认 0.0.0.0 支持局域网访问
    pub bind: String,
    /// 监听端口
    pub port: u16,
    /// 允许跨域的前端源（空列表 = 允许所有来源；仅在直连后端时起作用，前端走 Vite 代理则同源）
    pub cors_origins: Vec<String>,

    /// 腾讯云 COS 配置（可选；未配置时不启用 COS，资源仍走本地存储）。
    /// SecretId / SecretKey / Bucket 短名 / Region。
    pub cos: Option<CosConfig>,
}

pub struct CosConfig {
    /// 腾讯云 API 密钥 SecretId
    pub secret_id: String,
    /// 腾讯云 API 密钥 SecretKey
    pub secret_key: String,
    /// COS 存储桶短名（不含地域后缀，如 `example-1250000000`）
    pub bucket: String,
    /// COS 地域（如 `ap-guangzhou`）
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

        let bind = std::env::var("EPUB_BIND").unwrap_or_else(|_| "0.0.0.0".to_string());

        let port: u16 = std::env::var("EPUB_PORT")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(8002);

        // CORS 源：默认空列表 = 允许所有来源（个人书库场景，手机/电脑直连更方便）。
        // 需要收紧时设置 EPUB_CORS_ORIGINS，如 ["http://localhost:3000","http://192.168.1.5:3000"]。
        let cors_origins = std::env::var("EPUB_CORS_ORIGINS")
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();

        // COS 配置：四个变量「非空」才启用。SecretKey 缺失/为空时不报错，
        // 未配置 COS 的环境也能正常运行（资源全走本地存储）。
        // 注意用 .filter(|s| !s.trim().is_empty()) —— 否则环境变量里即便存在但值为空
        // （如 Docker compose 里 ${VAR:-} 脱空），也会被当作"已配置"进 COS 分支。
        let cos = match (
            std::env::var("EPUB_COS_SECRET_ID").ok().filter(|s| !s.trim().is_empty()),
            std::env::var("EPUB_COS_SECRET_KEY").ok().filter(|s| !s.trim().is_empty()),
            std::env::var("EPUB_COS_BUCKET").ok().filter(|s| !s.trim().is_empty()),
            std::env::var("EPUB_COS_REGION").ok().filter(|s| !s.trim().is_empty()),
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
            bind,
            port,
            cors_origins,
            cos,
        }
    }
}
