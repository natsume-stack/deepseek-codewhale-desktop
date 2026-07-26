//! 全局共享状态: 配置 (运行时可变) + 会话管理器 + DeepSeek 客户端 + 当前项目根 + Diff 注册表 + 代办任务 + 审批队列。

use crate::cache::CacheStore;
use crate::config::{AppConfig, PermissionConfig};
use crate::deepseek::DeepSeekClient;
use crate::routes::diffs::DiffRegistry;
use crate::session::SessionManager;
use chrono::{DateTime, Utc};
use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::{Mutex, RwLock};

#[derive(Clone)]
pub struct SharedState {
    pub config: Arc<RwLock<AppConfig>>,
    pub sessions: SessionManager,
    pub client: DeepSeekClient,
    pub project_root: Arc<RwLock<Option<PathBuf>>>,
    /// Diff 注册表：按 session_id 分组管理代码变更状态。
    pub diffs: DiffRegistry,
    /// 代办任务存储（P0-7）。
    pub todos: TodoStore,
    /// Agent 操作审批队列（P0-8）。
    pub approvals: ApprovalStore,
    /// Reasonix 字节稳定前缀缓存存储（P0+ 最高优先级）。
    pub caches: CacheStore,
    /// Skill 技能注册表（P0 Skill 生态）。
    pub skills: crate::skills::SkillStore,
    /// MCP 插件注册表（P1 MCP 生态）。
    pub mcp: crate::mcp::McpStore,
    /// 高危插件总开关。
    pub mcp_high_risk_enabled: Arc<RwLock<bool>>,
    /// Skill 默认权限等级（P2 设置页）：ReadOnly / WorkspaceWrite / FullAccess / ask。
    pub skills_default_permission: Arc<RwLock<String>>,
    /// 自治 Agent 运行时 (P0): ReAct 引擎 + 任务存储 + 工具协议 + 事件流。
    pub agent: Arc<crate::agent::react_engine::AgentRuntime>,
}

impl SharedState {
    pub fn new(config: AppConfig) -> Self {
        let deepseek_cfg = config.deepseek.clone();
        let client = DeepSeekClient::new();
        let approvals = ApprovalStore::new();
        // 初始化 Agent 运行时 (内置工具的注册推迟到 main.rs 中 await 调用)
        let agent = Arc::new(crate::agent::react_engine::AgentRuntime::new(
            Arc::new(client.clone()),
            None,
            deepseek_cfg,
            approvals.clone(),
        ));
        Self {
            config: Arc::new(RwLock::new(config)),
            sessions: SessionManager::new(),
            client,
            project_root: Arc::new(RwLock::new(None)),
            diffs: Arc::new(RwLock::new(HashMap::new())),
            todos: TodoStore::new(),
            approvals,
            caches: CacheStore::new(),
            skills: crate::skills::SkillStore::new(),
            mcp: crate::mcp::McpStore::new(),
            mcp_high_risk_enabled: Arc::new(RwLock::new(false)),
            skills_default_permission: Arc::new(RwLock::new("WorkspaceWrite".into())),
            agent,
        }
    }

    /// 快速读取当前 DeepSeek 配置 (克隆)。
    pub async fn deepseek_config(&self) -> crate::config::DeepSeekConfig {
        self.config.read().await.deepseek.clone()
    }

    pub async fn inference_defaults(&self) -> crate::config::InferenceDefaults {
        self.config.read().await.inference
    }

    /// 读取当前权限配置（P0-8）。
    pub async fn permission_config(&self) -> PermissionConfig {
        self.config.read().await.permission.clone()
    }

    /// 返回当前项目根的克隆 (供工具调用使用)。
    pub async fn project_root(&self) -> Option<PathBuf> {
        self.project_root.read().await.clone()
    }
}

/* ============================================================
 * 代办任务存储（P0-7）
 * ============================================================ */

/// 代办任务状态。
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TodoStatus {
    Pending,
    Running,
    Done,
}

/// 单条代办任务。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoItem {
    pub id: String,
    /// 绑定的来源会话 ID。
    pub session_id: Option<String>,
    /// 任务文本。
    pub text: String,
    /// 状态。
    pub status: TodoStatus,
    /// 来源消息标记（可选，用于溯源）。
    pub source: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// 代办任务存储：内存 + 按 session_id 索引。进程重启后丢失（与 Diff 注册表语义一致）。
#[derive(Clone, Default)]
pub struct TodoStore {
    inner: Arc<Mutex<HashMap<String, TodoItem>>>,
}

impl TodoStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// 新增代办任务，返回创建后的条目。
    pub async fn add(
        &self,
        session_id: Option<String>,
        text: String,
        source: Option<String>,
    ) -> TodoItem {
        // P0 修复：使用 UUID 替代毫秒时间戳，避免批量添加时 ID 碰撞
        let id = format!("todo_{}", uuid::Uuid::new_v4());
        let now = Utc::now();
        let item = TodoItem {
            id: id.clone(),
            session_id,
            text,
            status: TodoStatus::Pending,
            source,
            created_at: now,
            updated_at: now,
        };
        self.inner.lock().await.insert(id, item.clone());
        item
    }

    /// 批量新增（用于解析 `<todo>` 块后一次性推送）。
    pub async fn add_batch(&self, session_id: Option<String>, texts: Vec<String>) -> Vec<TodoItem> {
        let mut out = Vec::with_capacity(texts.len());
        for t in texts {
            out.push(self.add(session_id.clone(), t, None).await);
        }
        out
    }

    /// 列出全部代办（按创建时间升序）。
    pub async fn list(&self) -> Vec<TodoItem> {
        let mut v: Vec<TodoItem> = self.inner.lock().await.values().cloned().collect();
        v.sort_by(|a, b| a.created_at.cmp(&b.created_at));
        v
    }

    /// 列出指定会话的代办。
    pub async fn list_by_session(&self, session_id: &str) -> Vec<TodoItem> {
        let mut v: Vec<TodoItem> = self
            .inner
            .lock()
            .await
            .values()
            .filter(|t| t.session_id.as_deref() == Some(session_id))
            .cloned()
            .collect();
        v.sort_by(|a, b| a.created_at.cmp(&b.created_at));
        v
    }

    /// 更新状态。
    pub async fn set_status(&self, id: &str, status: TodoStatus) -> Option<TodoItem> {
        let mut map = self.inner.lock().await;
        let item = map.get_mut(id)?;
        item.status = status;
        item.updated_at = Utc::now();
        Some(item.clone())
    }

    /// 删除代办。
    pub async fn delete(&self, id: &str) -> bool {
        self.inner.lock().await.remove(id).is_some()
    }
}

/* ============================================================
 * Agent 操作审批队列（P0-8）
 * ============================================================ */

/// 审批操作类型。
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ApprovalKind {
    /// 文件写入。
    FileWrite,
    /// 文件删除。
    FileDelete,
    /// Shell 命令执行。
    Shell,
    /// Git 操作。
    Git,
}

/// 审批状态。
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ApprovalStatus {
    /// 待审批。
    Pending,
    /// 已批准。
    Approved,
    /// 已拒绝。
    Rejected,
}

/// 单条审批请求。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalRequest {
    pub id: String,
    pub kind: ApprovalKind,
    /// 操作描述（如文件路径、命令文本）。
    pub description: String,
    /// 详细内容（如待写入的文件内容、命令完整文本）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// 绑定的会话 ID。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    pub status: ApprovalStatus,
    pub created_at: DateTime<Utc>,
    /// 关联的待执行动作（审批通过后由 decide_approval 路由回放执行）。
    /// 不序列化到前端（含文件内容/命令参数，避免泄露）。
    #[serde(skip)]
    pub pending_action: Option<PendingAction>,
}

/// 审批通过后待执行的动作。
///
/// 设计：审批创建时由各路由（diffs/git/sandbox/tools）填充，
/// decide_approval 在批准时取出并执行。失败不影响审批状态，仅记录 last_error。
#[derive(Debug, Clone)]
pub enum PendingAction {
    /// 应用 Diff：写盘指定文件内容。
    ApplyDiff {
        diff_id: String,
        file_path: std::path::PathBuf,
        content: String,
    },
    /// 执行 Git 命令（如 commit / branch create / branch delete）。
    GitExec { args: Vec<String> },
    /// 执行 Shell 命令（沙箱）。
    ShellExec {
        program: String,
        args: Vec<String>,
        cwd: std::path::PathBuf,
    },
}

/// 审批存储：内存队列。Agent 发起操作 → 创建审批 → 等待用户决定。
#[derive(Clone, Default)]
pub struct ApprovalStore {
    inner: Arc<Mutex<HashMap<String, ApprovalRequest>>>,
}

impl ApprovalStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// 创建审批请求，返回完整条目（状态为 Pending）。
    pub async fn create(
        &self,
        kind: ApprovalKind,
        description: String,
        detail: Option<String>,
        session_id: Option<String>,
    ) -> ApprovalRequest {
        self.create_with_action(kind, description, detail, session_id, None)
            .await
    }

    /// 创建带待执行动作的审批请求（审批通过后由 decide_approval 回放）。
    pub async fn create_with_action(
        &self,
        kind: ApprovalKind,
        description: String,
        detail: Option<String>,
        session_id: Option<String>,
        pending_action: Option<PendingAction>,
    ) -> ApprovalRequest {
        let id = format!("appr_{}", uuid::Uuid::new_v4());
        let req = ApprovalRequest {
            id: id.clone(),
            kind,
            description,
            detail,
            session_id,
            status: ApprovalStatus::Pending,
            created_at: Utc::now(),
            pending_action,
        };
        self.inner.lock().await.insert(id, req.clone());
        req
    }

    /// 列出全部审批请求（按创建时间降序，最新在前）。
    pub async fn list(&self) -> Vec<ApprovalRequest> {
        let mut v: Vec<ApprovalRequest> = self.inner.lock().await.values().cloned().collect();
        v.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        v
    }

    /// 列出待审批的请求。
    pub async fn list_pending(&self) -> Vec<ApprovalRequest> {
        self.inner
            .lock()
            .await
            .values()
            .filter(|r| r.status == ApprovalStatus::Pending)
            .cloned()
            .collect()
    }

    /// 获取单条审批请求。
    pub async fn get(&self, id: &str) -> Option<ApprovalRequest> {
        self.inner.lock().await.get(id).cloned()
    }

    /// 作出审批决定（批准/拒绝）。返回 (审批条目, 待执行动作)。
    /// 待执行动作仅在 approved=true 且原请求含 pending_action 时返回 Some，
    /// 由调用方负责回放执行。
    pub async fn decide(
        &self,
        id: &str,
        approved: bool,
    ) -> Option<(ApprovalRequest, Option<PendingAction>)> {
        let mut map = self.inner.lock().await;
        let req = map.get_mut(id)?;
        req.status = if approved {
            ApprovalStatus::Approved
        } else {
            ApprovalStatus::Rejected
        };
        // 批准时取出 pending_action（避免重复执行）
        let action = if approved {
            req.pending_action.take()
        } else {
            None
        };
        Some((req.clone(), action))
    }
}
