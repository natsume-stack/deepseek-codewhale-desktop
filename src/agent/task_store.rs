//! 任务持久化存储 (P0 自治 Agent)。
//!
//! 提供线程安全的 Agent 任务存储,支持断点续跑:
//! - 内存索引: `parking_lot::RwLock<HashMap<Uuid, AgentTask>>` (无锁读 / 写时短暂持锁)。
//! - 磁盘持久化: 每个任务一个 JSON 文件 `{persistence_dir}/{task_id}.json`。
//! - 启动时 `load_from_disk` 扫描目录恢复所有未结束任务。
//!
//! `Arc<TaskStore>` 可直接放入 Axum `State` 中跨 handler 共享。

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

use chrono::{DateTime, Utc};
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::agent::state_machine::{ExecutionMode, StepStatus, TaskState};
use crate::agent::tool_protocol::ToolCall;

/// Plan 中的单个步骤。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskStep {
    pub id: Uuid,
    pub description: String,
    pub status: StepStatus,
    pub tool_calls: Vec<ToolCall>,
}

/// ReAct 循环的单次迭代记录 (Thought → Action → Observation → Reflection)。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReActStep {
    /// 第几次迭代 (0-based)。
    pub iteration: u32,
    /// LLM 思考 (reasoning)。
    pub thought: String,
    /// 本次选择的工具调用 (None 表示 LLM 选择直接回答 / 结束)。
    pub action: Option<ToolCall>,
    /// 工具执行结果的人类可读摘要。
    pub observation: String,
    /// LLM 反思 (是否需要继续、是否达成目标)。
    pub reflection: Option<String>,
    pub timestamp: DateTime<Utc>,
}

/// 断点续跑检查点 (记录从哪里恢复)。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Checkpoint {
    pub iteration: u32,
    pub step_index: usize,
    pub saved_at: DateTime<Utc>,
}

/// Agent 任务完整状态。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentTask {
    pub id: Uuid,
    pub session_id: Uuid,
    pub user_request: String,
    pub state: TaskState,
    pub mode: ExecutionMode,
    pub plan: Vec<TaskStep>,
    pub current_step: usize,
    pub history: Vec<ReActStep>,
    pub max_iterations: u32,
    pub current_iteration: u32,
    pub checkpoint: Option<Checkpoint>,
    pub error: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl AgentTask {
    /// 创建新任务 (状态 = Pending, 默认 max_iterations = 25)。
    pub fn new(session_id: Uuid, user_request: String, mode: ExecutionMode) -> Self {
        let now = Utc::now();
        Self {
            id: Uuid::new_v4(),
            session_id,
            user_request,
            state: TaskState::Pending,
            mode,
            plan: Vec::new(),
            current_step: 0,
            history: Vec::new(),
            max_iterations: 25,
            current_iteration: 0,
            checkpoint: None,
            error: None,
            created_at: now,
            updated_at: now,
        }
    }

    /// 是否处于可恢复状态 (非终态且有进度记录)。
    pub fn is_resumable(&self) -> bool {
        !self.state.is_terminal() && (!self.history.is_empty() || self.checkpoint.is_some())
    }

    /// 是否已达迭代上限。
    pub fn is_iteration_exhausted(&self) -> bool {
        self.current_iteration >= self.max_iterations
    }
}

/// 线程安全的任务存储,支持磁盘持久化。
///
/// 推荐通过 `Arc<TaskStore>` 在 Axum State 中共享。
/// 所有写操作 (`create` / `update` / `delete`) 均会同步落盘
/// (失败时记录 warning 但不阻断内存更新,避免 IO 抖动影响在线请求)。
pub struct TaskStore {
    tasks: RwLock<HashMap<Uuid, AgentTask>>,
    persistence_dir: Option<PathBuf>,
}

impl TaskStore {
    /// 创建存储。
    ///
    /// - `persistence_dir = Some(dir)`: 启用磁盘持久化,任务文件写入 `dir/{task_id}.json`。
    /// - `persistence_dir = None`: 纯内存模式 (仅供测试使用)。
    pub fn new(persistence_dir: Option<PathBuf>) -> Self {
        Self {
            tasks: RwLock::new(HashMap::new()),
            persistence_dir,
        }
    }

    /// 创建任务 (插入内存 + 落盘)。
    pub fn create(&self, task: AgentTask) -> AgentTask {
        {
            let mut map = self.tasks.write();
            map.insert(task.id, task.clone());
        }
        if let Err(e) = self.save_to_disk(&task) {
            tracing::warn!(task_id = %task.id, error = %e, "task persist failed on create");
        }
        task
    }

    /// 读取单个任务。
    pub fn get(&self, id: Uuid) -> Option<AgentTask> {
        self.tasks.read().get(&id).cloned()
    }

    /// 列出所有任务,按 `created_at` 倒序。
    pub fn list(&self) -> Vec<AgentTask> {
        let mut all: Vec<AgentTask> = self.tasks.read().values().cloned().collect();
        all.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        all
    }

    /// 列出指定会话下的所有任务,按 `created_at` 倒序。
    pub fn list_by_session(&self, session_id: Uuid) -> Vec<AgentTask> {
        let mut all: Vec<AgentTask> = self
            .tasks
            .read()
            .values()
            .filter(|t| t.session_id == session_id)
            .cloned()
            .collect();
        all.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        all
    }

    /// 修改任务 (`f` 内部对 `&mut AgentTask` 做任意修改),
    /// 自动更新 `updated_at` 并落盘。返回更新后的克隆。
    pub fn update<F>(&self, id: Uuid, f: F) -> Option<AgentTask>
    where
        F: FnOnce(&mut AgentTask),
    {
        let updated = {
            let mut map = self.tasks.write();
            let task = map.get_mut(&id)?;
            f(task);
            task.updated_at = Utc::now();
            task.clone()
        };
        if let Err(e) = self.save_to_disk(&updated) {
            tracing::warn!(task_id = %id, error = %e, "task persist failed on update");
        }
        Some(updated)
    }

    /// 删除任务 (从内存移除 + 删除磁盘文件)。
    ///
    /// 返回 `true` 表示内存中存在该任务 (无论磁盘文件是否删除成功)。
    pub fn delete(&self, id: Uuid) -> bool {
        let existed = { self.tasks.write().remove(&id).is_some() };
        if existed {
            if let Some(dir) = self.persistence_dir.as_ref() {
                let path = dir.join(format!("{id}.json"));
                if path.exists() {
                    if let Err(e) = fs::remove_file(&path) {
                        tracing::warn!(task_id = %id, error = %e, "task file removal failed");
                    }
                }
            }
        }
        existed
    }

    /// 持久化单个任务到磁盘 (JSON 文件)。
    ///
    /// 文件路径: `{persistence_dir}/{task_id}.json`。
    /// 若 `persistence_dir` 为 `None`,直接返回 `Ok(())`。
    /// 若目录不存在,会自动创建。
    pub fn save_to_disk(&self, task: &AgentTask) -> anyhow::Result<()> {
        let dir = match self.persistence_dir.as_ref() {
            Some(d) => d,
            None => return Ok(()),
        };
        fs::create_dir_all(dir)
            .map_err(|e| anyhow::anyhow!("create persistence dir failed: {e}"))?;
        let path = dir.join(format!("{}.json", task.id));
        let json = serde_json::to_string_pretty(task)
            .map_err(|e| anyhow::anyhow!("serialize task failed: {e}"))?;
        // 先写临时文件再原子重命名,避免崩溃导致半写文件。
        let tmp = dir.join(format!("{}.json.tmp", task.id));
        fs::write(&tmp, json.as_bytes())
            .map_err(|e| anyhow::anyhow!("write task tmp file failed: {e}"))?;
        fs::rename(&tmp, &path).map_err(|e| {
            // 重命名失败时清理 tmp 文件避免堆积。
            let _ = fs::remove_file(&tmp);
            anyhow::anyhow!("rename task file failed: {e}")
        })?;
        Ok(())
    }

    /// 启动时扫描持久化目录,加载所有任务文件。
    ///
    /// - 解析失败的单个文件会被跳过 (记录 warning),不阻断整体加载。
    /// - 已在内存中的任务不会被磁盘文件覆盖 (避免启动后未持久化的更新丢失)。
    pub fn load_from_disk(&self) -> anyhow::Result<()> {
        let dir = match self.persistence_dir.as_ref() {
            Some(d) => d,
            None => return Ok(()),
        };
        if !dir.exists() {
            return Ok(());
        }
        let mut loaded = 0u32;
        let mut skipped = 0u32;
        for entry in fs::read_dir(dir)? {
            let entry = match entry {
                Ok(e) => e,
                Err(e) => {
                    tracing::warn!(error = %e, "read dir entry failed during load_from_disk");
                    continue;
                }
            };
            let path = entry.path();
            // 仅处理 {uuid}.json,忽略 .tmp 与其他文件。
            if path.extension().and_then(|s| s.to_str()) != Some("json") {
                continue;
            }
            let stem = match path.file_stem().and_then(|s| s.to_str()) {
                Some(s) => s,
                None => continue,
            };
            let task_id = match Uuid::parse_str(stem) {
                Ok(u) => u,
                Err(_) => {
                    // 非 UUID 文件名 (例如 *.json.tmp 已被 ext 过滤,这里兜底)。
                    skipped += 1;
                    continue;
                }
            };
            let text = match fs::read_to_string(&path) {
                Ok(t) => t,
                Err(e) => {
                    tracing::warn!(path = %path.display(), error = %e, "read task file failed");
                    skipped += 1;
                    continue;
                }
            };
            match serde_json::from_str::<AgentTask>(&text) {
                Ok(task) => {
                    self.tasks.write().insert(task_id, task);
                    loaded += 1;
                }
                Err(e) => {
                    tracing::warn!(path = %path.display(), error = %e, "parse task file failed");
                    skipped += 1;
                }
            }
        }
        tracing::info!(loaded, skipped, "task store loaded from disk");
        Ok(())
    }
}

impl TaskStore {
    /// 当前内存中任务总数。
    pub fn len(&self) -> usize {
        self.tasks.read().len()
    }

    /// 是否为空。
    pub fn is_empty(&self) -> bool {
        self.tasks.read().is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn create_get_update_delete_roundtrip() {
        let dir = tempdir().unwrap();
        let store = TaskStore::new(Some(dir.path().to_path_buf()));
        let task = AgentTask::new(
            Uuid::new_v4(),
            "test task".into(),
            ExecutionMode::Autonomous,
        );
        let id = task.id;
        let created = store.create(task);
        assert_eq!(created.state, TaskState::Pending);
        assert_eq!(store.len(), 1);

        let got = store.get(id).expect("task should exist");
        assert_eq!(got.user_request, "test task");

        let updated = store
            .update(id, |t| {
                t.state = TaskState::Planning;
                t.current_iteration = 3;
            })
            .expect("update should return Some");
        assert_eq!(updated.state, TaskState::Planning);
        assert_eq!(updated.current_iteration, 3);
        // updated_at 应被自动刷新。
        assert!(updated.updated_at >= got.updated_at);

        assert!(store.delete(id));
        assert!(store.get(id).is_none());
        assert!(store.is_empty());
        // 磁盘文件也应被删除。
        let path = dir.path().join(format!("{id}.json"));
        assert!(!path.exists());
    }

    #[test]
    fn list_sorted_by_created_at_desc() {
        let store = TaskStore::new(None);
        let t1 = store.create(AgentTask::new(
            Uuid::new_v4(),
            "first".into(),
            ExecutionMode::Autonomous,
        ));
        // 手动调整 created_at 以保证顺序确定性。
        store.update(t1.id, |t| {
            t.created_at = Utc::now() - chrono::Duration::seconds(10);
        });
        let t2 = store.create(AgentTask::new(
            Uuid::new_v4(),
            "second".into(),
            ExecutionMode::Autonomous,
        ));
        let list = store.list();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].id, t2.id, "newer task should come first");
        assert_eq!(list[1].id, t1.id);
    }

    #[test]
    fn list_by_session_filters_correctly() {
        let store = TaskStore::new(None);
        let s1 = Uuid::new_v4();
        let s2 = Uuid::new_v4();
        store.create(AgentTask::new(s1, "a".into(), ExecutionMode::Autonomous));
        store.create(AgentTask::new(s1, "b".into(), ExecutionMode::Approval));
        store.create(AgentTask::new(s2, "c".into(), ExecutionMode::Autonomous));
        assert_eq!(store.list_by_session(s1).len(), 2);
        assert_eq!(store.list_by_session(s2).len(), 1);
        assert_eq!(store.list_by_session(Uuid::new_v4()).len(), 0);
    }

    #[test]
    fn load_from_disk_recovers_tasks() {
        let dir = tempdir().unwrap();
        let path = dir.path().to_path_buf();

        // 第一次:创建并落盘。
        let store_a = TaskStore::new(Some(path.clone()));
        let task = store_a.create(AgentTask::new(
            Uuid::new_v4(),
            "persist me".into(),
            ExecutionMode::Autonomous,
        ));
        let task_id = task.id;
        // 修改并落盘 (验证 update 路径也写盘)。
        store_a.update(task_id, |t| {
            t.state = TaskState::Acting;
            t.current_iteration = 7;
        });
        // 磁盘上应有对应文件。
        let file = path.join(format!("{task_id}.json"));
        assert!(file.exists(), "task file should exist after update");

        // 第二次:新建 store,从磁盘加载,应能恢复。
        let store_b = TaskStore::new(Some(path));
        store_b.load_from_disk().unwrap();
        let recovered = store_b.get(task_id).expect("task should be recovered");
        assert_eq!(recovered.user_request, "persist me");
        assert_eq!(recovered.state, TaskState::Acting);
        assert_eq!(recovered.current_iteration, 7);
    }

    #[test]
    fn in_memory_mode_skips_disk() {
        let store = TaskStore::new(None);
        let task = store.create(AgentTask::new(
            Uuid::new_v4(),
            "ephemeral".into(),
            ExecutionMode::Autonomous,
        ));
        // 不应报错,也不应产生文件。
        assert!(store.save_to_disk(&task).is_ok());
    }

    #[test]
    fn is_resumable_and_iteration_exhausted() {
        let mut task = AgentTask::new(Uuid::new_v4(), "x".into(), ExecutionMode::Autonomous);
        assert!(!task.is_resumable());
        task.history.push(ReActStep {
            iteration: 0,
            thought: "t".into(),
            action: None,
            observation: "o".into(),
            reflection: None,
            timestamp: Utc::now(),
        });
        assert!(task.is_resumable());

        assert!(!task.is_iteration_exhausted());
        task.current_iteration = task.max_iterations;
        assert!(task.is_iteration_exhausted());

        // 终态任务不可恢复。
        task.state = TaskState::Completed;
        assert!(!task.is_resumable());
    }
}
