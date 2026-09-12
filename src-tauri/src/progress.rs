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
use std::time::{Duration, Instant};

use serde::Serialize;
use tokio::sync::RwLock;
use uuid::Uuid;

/// 任务进入终态(完成/失败)后在任务表里保留多久。
/// 前端要靠这段时间轮询到结果并把导出字节写到用户选定路径。
const TASK_RETENTION_SECS: u64 = 300;
/// 回收器轮询间隔。
const CLEANUP_POLL_SECS: u64 = 5;
/// 兜底:任务超过这个时长仍未结束(疑似卡死)才强制回收,避免任务表泄漏。
/// 注意这与保留期是两件事:正常的长任务(大书导出/整库迁移)绝不能被中途摘掉。
const TASK_ABSOLUTE_TTL_SECS: u64 = 6 * 3600;

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

/// 迁移任务(书库导出/导入)的结果占位:(JSON 摘要, 人类可读文本)。
pub type SharedMigrationResult = Arc<Mutex<Option<(String, String)>>>;

#[derive(Clone)]
pub struct TaskEntry {
    /// 任务类型（导入 / 导出）,导出时携带结果占位与书 ID
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
    /// 书库迁移(导出归档/导入合并)
    Migration {
        result: SharedMigrationResult,
    },
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

    /// 启动任务回收。
    ///
    /// 关键:**保留期从「终态」起算,而不是从创建起算**。
    /// 老实现是创建时就固定 sleep 300s 再删条目,于是跑得比 5 分钟久的长任务
    /// (大书导出、整库迁移、慢盘)会在执行途中被摘掉:前端轮询到 null 就报
    /// 「进度连接中断」,导出字节留在已无人可达的槽位里被丢弃 ——
    /// 用户选定的文件根本没生成,重试还会再撞一次同一堵墙。
    pub fn spawn_cleanup(&self, task_id: String) {
        self.spawn_cleanup_with(
            task_id,
            Duration::from_secs(CLEANUP_POLL_SECS),
            Duration::from_secs(TASK_RETENTION_SECS),
            Duration::from_secs(TASK_ABSOLUTE_TTL_SECS),
        );
    }

    /// 回收器实体(时长可注入,便于单测;生产走上面的常量)。
    fn spawn_cleanup_with(
        &self,
        task_id: String,
        poll: Duration,
        retention: Duration,
        max_alive: Duration,
    ) {
        let inner = self.inner.clone();
        tokio::spawn(async move {
            let started = Instant::now();
            let mut terminal_since: Option<Instant> = None;
            loop {
                tokio::time::sleep(poll).await;
                let Some(entry) = inner.read().await.get(&task_id).cloned() else {
                    return; // 已被移除(或应用退出)
                };
                // 锁中毒也按「已结束」处理:宁可回收也不要卡住
                let terminal = entry.progress.lock().map(|p| p.done).unwrap_or(true);
                if terminal {
                    let since = *terminal_since.get_or_insert_with(Instant::now);
                    if since.elapsed() >= retention {
                        inner.write().await.remove(&task_id);
                        return;
                    }
                } else if started.elapsed() >= max_alive {
                    tracing::warn!("任务 {task_id} 超过 {max_alive:?} 仍未结束,强制回收");
                    inner.write().await.remove(&task_id);
                    return;
                }
            }
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

/// 创建迁移任务(书库导出/导入):返回 task_id、进度句柄、结果占位
/// (完成后写入 (JSON 摘要, 人类可读文本))。
pub async fn create_migration_task(
    registry: &TaskRegistry,
    initial_message: &str,
) -> (String, SharedProgress, SharedMigrationResult) {
    let progress: SharedProgress =
        Arc::new(Mutex::new(Progress::start("preparing", initial_message)));
    let result: SharedMigrationResult = Arc::new(Mutex::new(None));
    let entry = TaskEntry {
        kind: TaskKind::Migration {
            result: result.clone(),
        },
        progress: progress.clone(),
    };
    let task_id = registry.insert(entry).await;
    registry.spawn_cleanup(task_id.clone());
    (task_id, progress, result)
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

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(done: bool) -> TaskEntry {
        let mut p = Progress::start("preparing", "测试");
        p.done = done;
        TaskEntry {
            kind: TaskKind::Import,
            progress: Arc::new(Mutex::new(p)),
        }
    }

    /// 老实现「创建后固定 5 分钟删除」会让长任务在跑的过程中被摘掉:
    /// 前端轮询到 null → 报「进度连接中断」→ 导出字节丢失、文件不生成。
    #[tokio::test]
    async fn long_running_task_is_not_reaped() {
        let reg = TaskRegistry::new();
        let id = reg.insert(entry(false)).await;
        reg.spawn_cleanup_with(
            id.clone(),
            Duration::from_millis(5),
            Duration::from_millis(20),
            Duration::from_secs(30), // 兜底远大于本用例等待时间
        );

        // 远超「保留期」的时间:只要还没结束就不该被回收
        tokio::time::sleep(Duration::from_millis(150)).await;
        assert!(reg.get(&id).await.is_some(), "未结束的任务不得被回收");
    }

    #[tokio::test]
    async fn terminal_task_is_reaped_after_retention() {
        let reg = TaskRegistry::new();
        let progress: SharedProgress =
            Arc::new(Mutex::new(Progress::start("exporting", "跑着")));
        let id = reg
            .insert(TaskEntry {
                kind: TaskKind::Import,
                progress: progress.clone(),
            })
            .await;
        reg.spawn_cleanup_with(
            id.clone(),
            Duration::from_millis(5),
            Duration::from_millis(40),
            Duration::from_secs(30),
        );

        // 还在跑:不能被回收
        tokio::time::sleep(Duration::from_millis(60)).await;
        assert!(reg.get(&id).await.is_some(), "终态前不得回收");

        // 标记完成:再过保留期后回收(前端要的就是这段时间取结果/写盘)
        progress.lock().unwrap().done = true;
        tokio::time::sleep(Duration::from_millis(60)).await;
        assert!(reg.get(&id).await.is_none(), "终态 + 保留期后应回收");
    }

    #[tokio::test]
    async fn stuck_task_is_force_reaped_by_ttl() {
        let reg = TaskRegistry::new();
        let id = reg.insert(entry(false)).await;
        reg.spawn_cleanup_with(
            id.clone(),
            Duration::from_millis(5),
            Duration::from_millis(20),
            Duration::from_millis(60), // 兜底 TTL 很小
        );
        tokio::time::sleep(Duration::from_millis(160)).await;
        assert!(reg.get(&id).await.is_none(), "卡死任务应由兜底 TTL 回收");
    }
}