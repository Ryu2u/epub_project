// 共享库:业务核心,被桌面客户端(src-tauri)复用。
//
// Tauri 2 改造后 axum HTTP 层已移除(api/、error.rs、main.rs),
// 对外接口为 #[tauri::command](见 src-tauri/src/commands.rs),
// 本库只承载业务:DB / 解析 / 导出 / 迁移 / 进度任务。
//
// lib 里 pub 项只要对外可见即不算 dead code,clippy 才能严格(-D warnings)通过。

pub mod config;
pub mod cos;
pub mod db;
pub mod epub;
pub mod epub_writer;
pub mod migration;
pub mod progress;
pub mod schema;
pub mod service;
pub mod storage;
pub mod txt_writer;

use std::sync::Arc;

/// 共享状态:前端命令通过 tauri::State 提取
#[derive(Clone)]
pub struct AppState {
    /// 应用配置(全局单例,Arc 共享)
    pub config: Arc<config::Config>,
    /// 业务服务层(DB + 文件系统 + 可选 COS)
    pub service: Arc<service::BookService>,
    /// 异步任务表(导入/导出/删除/迁移进度与结果)
    pub tasks: progress::TaskRegistry,
    /// 腾讯云 COS 客户端。未配置 EPUB_COS_* 时为 None,资源走本地存储。
    pub cos: Option<Arc<cos::CosClient>>,
}
