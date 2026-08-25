// 腾讯云对象存储 COS 封装。
//
// SDK: cos_rs 0.1.1 (https://crates.io/crates/cos_rs)
// 设计目标：
//   - 把 cos_rs 0.1.1 的 API 收拢成项目用的窄接口，handler 只看到 put/get/delete/presigned
//   - 客户端持有 Arc，多 handler 可共享（HTTP 连接 + 签名复用）
//   - Key 拼装统一在 make_key(book_id, asset_id) 一处，便于以后改 prefix
//
// 存储布局：books/{book_id}/assets/{asset_id}（asset_id 与 DB 中 assets.id 对齐）。

use std::sync::Arc;
use std::time::Duration;

use cos_rs::{BucketGetOptions, Client, Credential, ObjectPutOptions};
use reqwest::Method;

/// COS 错误封装（项目侧），handler 转 AppError。
#[derive(Debug)]
pub enum CosError {
    Other(String),
}

impl std::fmt::Display for CosError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CosError::Other(msg) => write!(f, "{msg}"),
        }
    }
}

impl From<cos_rs::Error> for CosError {
    fn from(e: cos_rs::Error) -> Self {
        CosError::Other(format!("{e:?}"))
    }
}

impl std::error::Error for CosError {}

/// 项目用 COS client。包成 Arc 让 handler 共享。
#[derive(Clone)]
pub struct CosClient {
    /// 底层 cos_rs 客户端（持 HTTP 连接 + 签名，Arc 支持多 handler 共享）
    inner: Arc<Client>,
    /// 签名凭据，生成预签名 URL 时复用
    credential: Arc<Credential>,
    /// COS 存储桶短名
    bucket: String,
    /// COS 地域（如 `ap-guangzhou`），用于拼接 bucket 域名
    pub region: String,
    /// 对象 Key 前缀，通常含 `{book_id}` / `{asset_id}` 占位符
    pub key_prefix: String,
}

impl CosClient {
    /// 创建客户端。`key_prefix` 通常含 `{book_id}` 和 `{asset_id}` 占位符。
    pub fn new(
        secret_id: impl Into<String>,
        secret_key: impl Into<String>,
        bucket: impl Into<String>,
        region: impl Into<String>,
        key_prefix: impl Into<String>,
    ) -> Result<Self, CosError> {
        let bucket = bucket.into();
        let region = region.into();
        let bucket_url = cos_rs::BaseUrl::bucket_url(&bucket, &region, true)?;
        let credential = Credential::new(secret_id, secret_key);
        let client = Client::builder()
            .bucket_url(bucket_url)
            .credential(credential.clone())
            .build()?;
        Ok(Self {
            inner: Arc::new(client),
            credential: Arc::new(credential),
            bucket,
            region,
            key_prefix: key_prefix.into(),
        })
    }

    /// 拼装一个资源的 COS Key。
    /// 例：make_key("abc", "x.png") → "books/abc/assets/x.png"
    pub fn make_key(&self, book_id: &str, asset_id: &str) -> String {
        self.key_prefix
            .replace("{book_id}", book_id)
            .replace("{asset_id}", asset_id)
    }

    /// 上传对象。content-type 必传，浏览器读图时用得上。
    pub async fn put_object(
        &self,
        key: &str,
        bytes: Vec<u8>,
        content_type: &str,
    ) -> Result<(), CosError> {
        let mut opts = ObjectPutOptions::default();
        opts.content_type = Some(content_type.to_string());
        self.inner
            .object()
            .put(key, bytes, Some(opts))
            .await?;
        Ok(())
    }

    /// 下载对象（导出 EPUB 时用）。
    pub async fn get_object(&self, key: &str) -> Result<Vec<u8>, CosError> {
        let resp = self.inner.object().get(key, None).await?;
        Ok(resp.bytes().to_vec())
    }

    /// 删除单个对象。
    pub async fn delete_object(&self, key: &str) -> Result<(), CosError> {
        self.inner.object().delete(key, None).await?;
        Ok(())
    }

    /// 检查对象是否存在（用于迁移工具避免重复上传）。
    pub async fn is_exist_object(&self, key: &str) -> Result<bool, CosError> {
        self.inner.object().is_exist(key).await.map_err(CosError::from)
    }

    /// 删除某 book 下的全部资源（prefix = books/{book_id}/assets/）。
    /// COS 没有原子的"按 prefix 删"，用 list_objects + delete 循环。
    pub async fn delete_book_assets(&self, book_id: &str) -> Result<(), CosError> {
        let prefix = format!(
            "{}/",
            self.key_prefix
                .replace("{book_id}", book_id)
                .replace("{asset_id}", "")
                .trim_end_matches('/')
        );
        loop {
            let keys = self.list_object_keys(&prefix).await?;
            if keys.is_empty() {
                break;
            }
            for key in &keys {
                self.delete_object(key).await?;
            }
            if keys.len() < 1000 {
                break;
            }
        }
        Ok(())
    }

    /// 列举 prefix 下所有对象 key（仅 key，不含元数据）。
    async fn list_object_keys(&self, prefix: &str) -> Result<Vec<String>, CosError> {
        let mut all_keys = Vec::new();
        let mut marker: Option<String> = None;
        loop {
            let mut opts = BucketGetOptions::default();
            opts.prefix = Some(prefix.to_string());
            opts.max_keys = Some(1000);
            if let Some(m) = &marker {
                opts.marker = Some(m.clone());
            }
            let (result, _resp) = self.inner.bucket().get(Some(opts)).await?;
            for obj in &result.contents {
                all_keys.push(obj.key.clone());
            }
            if !result.is_truncated {
                break;
            }
            if result.next_marker.is_empty() {
                break;
            }
            marker = Some(result.next_marker);
        }
        Ok(all_keys)
    }

    /// 生成 5 分钟有效的 GET 预签名 URL（私有读 bucket）。
    /// 前端直接拿这个 URL 拉图，不必走后端。
    pub fn presigned_get_url(&self, key: &str, ttl_secs: u32) -> Result<String, CosError> {
        let url = self.inner.object().get_presigned_url(
            Method::GET,
            key,
            &self.credential,
            Duration::from_secs(ttl_secs as u64),
            None,
        )?;
        Ok(url.to_string())
    }
}