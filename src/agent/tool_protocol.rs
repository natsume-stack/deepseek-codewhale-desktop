//! 工具调用协议 trait (P0 自治 Agent)。
//!
//! 定义 Agent 与工具之间的统一调用契约:
//! - `ToolCall` / `ToolResult` / `ToolArtifact`:数据载体 (可序列化,便于持久化与审计)。
//! - `ExecutionContext`:每次工具执行的运行时上下文 (任务 ID / 会话 ID / 工作目录 / 取消令牌)。
//! - `AgentTool` trait:所有工具实现的统一接口,可被注册到工具表中动态分发。
//!
//! 注意:本模块仅定义协议,具体工具实现 (read_file / write_file / git / shell 等)
//! 由后续 executor 模块在 `tools.rs` 之上进行适配包装,不修改原有 `tools.rs`。

use std::fmt;
use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::config::PermissionLevel;

/// 单次工具调用请求。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCall {
    /// 调用唯一 ID (用于关联 LLM function_call 与执行结果)。
    pub id: Uuid,
    /// 工具名,对应 `AgentTool::name`。
    pub tool_name: String,
    /// 工具参数,JSON Value (符合该工具 `schema()` 约束)。
    pub arguments: Value,
    /// LLM 给出的预期输出描述 (供 Reflect 阶段校验),可空。
    pub expected_output: Option<String>,
}

impl fmt::Display for ToolCall {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "ToolCall({}, {})", self.tool_name, self.id)
    }
}

/// 工具执行产物类型。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ArtifactKind {
    FileChange,
    DiffHunk,
    ShellOutput,
    GitCommit,
    FileCreated,
    FileDeleted,
}

/// 工具执行产物 (供 Diff 注册表 / 审计日志消费)。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolArtifact {
    pub kind: ArtifactKind,
    /// 受影响文件路径 (相对项目根),可空 (如 ShellOutput)。
    pub path: Option<String>,
    /// 关联的 Diff ID (若产生 Diff 并已注册到 DiffRegistry)。
    pub diff_id: Option<Uuid>,
    /// 人类可读摘要。
    pub summary: String,
}

/// 工具执行结果。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolResult {
    pub success: bool,
    pub output: String,
    pub error: Option<String>,
    pub artifacts: Vec<ToolArtifact>,
}

/// 默认输出截断阈值 (8 KiB),防止超大 stdout 撑爆 LLM 上下文。
pub const DEFAULT_MAX_OUTPUT_BYTES: usize = 8192;

impl ToolResult {
    /// 构造成功结果。
    pub fn success(output: impl Into<String>) -> Self {
        Self {
            success: true,
            output: output.into(),
            error: None,
            artifacts: vec![],
        }
    }

    /// 构造失败结果。
    pub fn failure(err: impl Into<String>) -> Self {
        Self {
            success: false,
            output: String::new(),
            error: Some(err.into()),
            artifacts: vec![],
        }
    }

    /// 截断输出到指定字节数,超出部分以 `... [truncated, original N bytes]` 标记。
    ///
    /// 注意:此处按字节边界截断,若 `max_bytes` 落在 UTF-8 多字节字符中间,
    /// 会回退到字符边界 (避免产生无效 UTF-8)。
    pub fn truncate_output(&mut self, max_bytes: usize) {
        if self.output.len() <= max_bytes {
            return;
        }
        let original_len = self.output.len();
        // 找到一个安全的 UTF-8 字符边界,避免切割多字节字符。
        let mut cut = max_bytes;
        while cut > 0 && !self.output.is_char_boundary(cut) {
            cut -= 1;
        }
        let head = &self.output[..cut];
        self.output = format!("{}\n... [truncated, original {} bytes]", head, original_len);
    }

    /// 使用默认阈值 (8 KiB) 截断输出。
    pub fn truncate_default(&mut self) {
        self.truncate_output(DEFAULT_MAX_OUTPUT_BYTES);
    }

    /// 追加一个产物。
    pub fn with_artifact(mut self, artifact: ToolArtifact) -> Self {
        self.artifacts.push(artifact);
        self
    }
}

/// 单次工具执行的运行时上下文。
///
/// 由 Agent executor 在调用 `AgentTool::execute` 前构造,
/// 工具实现可读取其中的工作目录、监听取消信号。
#[derive(Debug, Clone)]
pub struct ExecutionContext {
    /// 当前任务 ID。
    pub task_id: Uuid,
    /// 关联会话 ID。
    pub session_id: Uuid,
    /// 项目根 (绝对路径,已 canonicalize)。
    pub project_root: PathBuf,
    /// 工作目录 (相对项目根的子目录,默认等于 project_root)。
    pub working_dir: PathBuf,
    /// 取消令牌:用户点击"停止"时触发,工具实现应在长任务中轮询 `is_cancelled()`。
    pub cancellation: CancellationToken,
}

impl ExecutionContext {
    /// 创建一个新的上下文,working_dir 默认等于 project_root。
    pub fn new(
        task_id: Uuid,
        session_id: Uuid,
        project_root: PathBuf,
        cancellation: CancellationToken,
    ) -> Self {
        let working_dir = project_root.clone();
        Self {
            task_id,
            session_id,
            project_root,
            working_dir,
            cancellation,
        }
    }

    /// 是否已被取消。
    pub fn is_cancelled(&self) -> bool {
        self.cancellation.is_cancelled()
    }
}

/// 工具执行错误。
#[derive(Debug, thiserror::Error)]
pub enum ToolError {
    #[error("invalid arguments: {0}")]
    InvalidArgs(String),

    #[error("permission denied: required {required:?}, current {current:?}")]
    Permission {
        required: PermissionLevel,
        current: PermissionLevel,
    },

    #[error("path escapes workspace: {0}")]
    PathEscape(String),

    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("execution error: {0}")]
    Execution(String),

    #[error("cancelled")]
    Cancelled,
}

impl ToolError {
    /// 是否为用户主动取消。
    pub fn is_cancelled(&self) -> bool {
        matches!(self, Self::Cancelled)
    }
}

/// Agent 工具统一 trait。
///
/// 所有工具实现必须是 `Send + Sync` (可在 Tokio 多线程 runtime 中跨线程共享)。
/// 工具通过 `Arc<dyn AgentTool>` 注册到工具表,executor 根据 LLM 返回的
/// `tool_name` 查表分发。
#[async_trait]
pub trait AgentTool: Send + Sync {
    /// 工具名 (LLM 可见,需与 function_call 名字一致)。
    fn name(&self) -> &'static str;

    /// 工具描述 (写入 LLM 系统提示)。
    fn description(&self) -> &'static str;

    /// 参数 JSON Schema (OpenAI function calling 格式)。
    fn schema(&self) -> Value;

    /// 该工具所需的最低权限等级。
    fn required_permission(&self) -> PermissionLevel;

    /// 执行工具。
    async fn execute(&self, args: Value, ctx: &ExecutionContext) -> Result<ToolResult, ToolError>;
}

/// 共享工具句柄 (注册表 / State 中使用)。
pub type SharedTool = Arc<dyn AgentTool>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn success_constructor() {
        let r = ToolResult::success("hello");
        assert!(r.success);
        assert_eq!(r.output, "hello");
        assert!(r.error.is_none());
        assert!(r.artifacts.is_empty());
    }

    #[test]
    fn failure_constructor() {
        let r = ToolResult::failure("boom");
        assert!(!r.success);
        assert!(r.output.is_empty());
        assert_eq!(r.error.as_deref(), Some("boom"));
    }

    #[test]
    fn truncate_under_threshold_is_noop() {
        let mut r = ToolResult::success("abc");
        r.truncate_output(100);
        assert_eq!(r.output, "abc");
    }

    #[test]
    fn truncate_above_threshold_appends_marker() {
        let big = "x".repeat(10_000);
        let mut r = ToolResult::success(big);
        r.truncate_output(100);
        assert!(r.output.contains("[truncated, original 10000 bytes]"));
        assert!(r.output.starts_with(&"x".repeat(100)));
    }

    #[test]
    fn truncate_respects_char_boundary() {
        // 中文字符占 3 字节,在 4 字节处切割会落到字符中间,应回退到 3 字节边界。
        let s = "你好世界".repeat(1000);
        let mut r = ToolResult::success(s);
        r.truncate_output(4);
        assert!(r.output.starts_with('你'));
    }

    #[test]
    fn default_max_output_bytes_is_8192() {
        assert_eq!(DEFAULT_MAX_OUTPUT_BYTES, 8192);
    }
}
