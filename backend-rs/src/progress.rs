// 进度共享状态 + 任务表。
//
// 用于异步导入/导出端点：
//   - 客户端 POST 触发后台任务，立即返回 task_id
//   - 客户端 GET /api/progress/{task_id} 订阅 SSE，持续接收 Progress
//   - 导出任务完成后，客户端 GET /api/tasks/{task_id}/download 拿文件
//
// 进度数据通过 std::sync::Mutex 共享：回调在 sync 上下文（spawn_blocking）中
// 调用，await 上下文也能用，因为持锁时间极短（单次赋值）。
//
// 任务表用 tokio::sync::RwLock<HashMap>，因为只有创建/查询任务时进入，
// 单用户本地工具场景下竞争极少。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tokio::sync::RwLock;
use uuid::Uuid;

/// 一份进度快照。前端按此格式解析渲染。
#[derive(Clone, Debug, Serialize)]
pub struct Progress {
    /// 当前阶段名（"parsing" / "writing_chapters" / "exporting" ...）
    pub phase: String,
    /// 人类可读的状态描述（"已解析 123/2255 章"）
    pub message: String,
    /// 总进度 0-100（粗略分配，足以驱动进度条）
    pub percent: u8,
    /// 任务是否结束（成功 or 失败都算结束）
    pub done: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
    /// 上传重复文件时携带的已有 book id（与同步接口 existing_book_id 对齐）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub existing_book_id: Option<String>,
    /// 导出任务完成后附带下载 URL（导入任务无此字段）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub download_url: Option<String>,
}

impl Progress {
    pub fn start(phase: &str, message: impl Into<String>) -> Self {
        Self {
            phase: phase.to_string(),
            message: message.into(),
            percent: 0,
            done: false,
            error_code: None,
            error_message: None,
            existing_book_id: None,
            download_url: None,
        }
    }

    pub fn update(phase: &str, message: impl Into<String>, percent: u8) -> Self {
        Self {
            phase: phase.to_string(),
            message: message.into(),
            percent: percent.min(100),
            done: false,
            error_code: None,
            error_message: None,
            existing_book_id: None,
            download_url: None,
        }
    }

    pub fn error(code: impl Into<String>, message: impl Into<String>) -> Self {
        let message = message.into();
        Self {
            phase: "error".to_string(),
            message: message.clone(),
            percent: 0,
            done: true,
            error_code: Some(code.into()),
            error_message: Some(message),
            existing_book_id: None,
            download_url: None,
        }
    }

    /// 用于重复上传：error_code = DUPLICATE_FILE，额外带 existing_book_id
    pub fn duplicate(existing_book_id: impl Into<String>) -> Self {
        Self {
            phase: "duplicate".to_string(),
            message: "文件已存在,跳过".to_string(),
            percent: 100,
            done: true,
            error_code: Some("DUPLICATE_FILE".to_string()),
            error_message: None,
            existing_book_id: Some(existing_book_id.into()),
            download_url: None,
        }
    }

    pub fn done(download_url: Option<String>) -> Self {
        Self {
            phase: "done".to_string(),
            message: if download_url.is_some() {
                "导出完成".to_string()
            } else {
                "导入完成".to_string()
            },
            percent: 100,
            done: true,
            error_code: None,
            error_message: None,
            existing_book_id: None,
            download_url,
        }
    }

    /// 自定义完成消息的终态（删除任务用"已删除"，与导入/导出区分）。
    pub fn done_message(message: impl Into<String>) -> Self {
        Self {
            phase: "done".to_string(),
            message: message.into(),
            percent: 100,
            done: true,
            error_code: None,
            error_message: None,
            existing_book_id: None,
            download_url: None,
        }
    }
}

/// 共享的进度句柄：回调写入、SSE handler 读取。
pub type SharedProgress = Arc<Mutex<Progress>>;

/// 导出任务的结果占位：bytes + filename。
pub type SharedExportResult = Arc<Mutex<Option<(Vec<u8>, String)>>>;

#[derive(Clone)]
pub struct TaskEntry {
    /// 任务类型（导入 / 导出），导出时携带结果占位与书 ID
    pub kind: TaskKind,
    /// 共享的进度句柄，回调写入、SSE handler 读取
    pub progress: SharedProgress,
}

#[derive(Clone)]
pub enum TaskKind {
    Import,
    Export {
        result: SharedExportResult,
        book_id: String,
    },
    Delete,
}

/// 全局任务表 + 创建辅助函数。
#[derive(Clone, Default)]
pub struct TaskRegistry {
    /// 以 task_id → TaskEntry 存储的任务表（RwLock 支持并发读写）
    inner: Arc<RwLock<HashMap<String, TaskEntry>>>,
}

impl TaskRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn insert(&self, entry: TaskEntry) -> String {
        let task_id = Uuid::new_v4().simple().to_string();
        self.inner.write().await.insert(task_id.clone(), entry);
        task_id
    }

    pub async fn get(&self, task_id: &str) -> Option<TaskEntry> {
        self.inner.read().await.get(task_id).cloned()
    }

    pub async fn remove(&self, task_id: &str) -> Option<TaskEntry> {
        self.inner.write().await.remove(task_id)
    }

    /// 启动一个延迟清理：5 分钟后移除该任务。
    /// 单用户本地工具场景下，足够看完一次 SSE 流并完成下载。
    pub fn spawn_cleanup(&self, task_id: String) {
        let inner = self.inner.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_secs(300)).await;
            inner.write().await.remove(&task_id);
        });
    }
}

/// 在异步上下文中插入导入任务并返回 task_id。
pub async fn create_import_task(registry: &TaskRegistry) -> (String, SharedProgress) {
    let progress: SharedProgress = Arc::new(Mutex::new(Progress::start(
        "parsing",
        "准备解析…",
    )));
    let entry = TaskEntry {
        kind: TaskKind::Import,
        progress: progress.clone(),
    };
    let task_id = registry.insert(entry).await;
    registry.spawn_cleanup(task_id.clone());
    (task_id, progress)
}

/// 在异步上下文中插入删除任务并返回 task_id。
pub async fn create_delete_task(registry: &TaskRegistry) -> (String, SharedProgress) {
    let progress: SharedProgress = Arc::new(Mutex::new(Progress::start("preparing", "准备删除…")));
    let entry = TaskEntry {
        kind: TaskKind::Delete,
        progress: progress.clone(),
    };
    let task_id = registry.insert(entry).await;
    registry.spawn_cleanup(task_id.clone());
    (task_id, progress)
}

/// 创建导出任务：返回 task_id、进度句柄、结果占位（用于完成后取文件字节）。
pub async fn create_export_task(
    registry: &TaskRegistry,
    book_id: &str,
) -> (String, SharedProgress, SharedExportResult) {
    let progress: SharedProgress = Arc::new(Mutex::new(Progress::start(
        "preparing",
        "准备导出…",
    )));
    let result: SharedExportResult = Arc::new(Mutex::new(None));
    let entry = TaskEntry {
        kind: TaskKind::Export {
            result: result.clone(),
            book_id: book_id.to_string(),
        },
        progress: progress.clone(),
    };
    let task_id = registry.insert(entry).await;
    registry.spawn_cleanup(task_id.clone());
    (task_id, progress, result)
}