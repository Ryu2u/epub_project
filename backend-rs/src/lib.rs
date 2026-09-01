// 共享库：业务模块同时被两个 bin 使用——
//   - epub-backend-rs（HTTP 服务，src/main.rs）
//   - migrate_cos（一次性 COS 迁移工具，src/bin/migrate_cos.rs）
//
// 抽成 lib 的原因：bin 之间无法共享私有 mod（migrate_cos 只能 #[path] 重编译
// 同一批文件），导致每个 bin 各自做一次 dead_code 分析、互相误报"未使用"。
// lib 里 pub 项只要对外可见即不算 dead code，clippy 才能严格（-D warnings）通过。

pub mod api;
pub mod config;
pub mod cos;
pub mod db;
pub mod epub;
pub mod epub_writer;
pub mod error;
pub mod progress;
pub mod service;
pub mod storage;
pub mod txt_writer;

use std::sync::Arc;

/// 共享状态：handler 通过 State 提取
#[derive(Clone)]
pub struct AppState {
    /// 应用配置（全局单例，Arc 共享）
    pub config: Arc<config::Config>,
    /// 业务服务层（DB + 文件系统 + 可选 COS）
    pub service: Arc<service::BookService>,
    /// 异步任务表（导入/导出进度与结果）
    pub tasks: progress::TaskRegistry,
    /// 腾讯云 COS 客户端。未配置 EPUB_COS_* 时为 None，资源走本地存储。
    pub cos: Option<Arc<cos::CosClient>>,
}
