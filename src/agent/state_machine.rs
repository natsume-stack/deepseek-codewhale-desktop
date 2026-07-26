//! 任务状态机定义 (P0 自治 Agent)。
//!
//! 定义 Agent 任务生命周期中的全部状态枚举与执行模式 / 步骤状态。
//! 这些类型是 Agent 子系统各模块 (task_store / tool_protocol / 后续 executor)
//! 之间共享的接口契约,修改需同步其他 Agent 模块。

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::fmt;

/// Agent 任务生命周期状态。
///
/// 状态转移大致如下:
/// ```text
/// Pending -> Planning -> Acting -> Observing -> Reflecting --+
///    ^                                                      |
///    |--- Paused <--- (用户挂起)                              |
///    |--- AwaitingApproval ---> (用户批准) ---> Acting        |
///    v                                                      |
/// Completed / Failed / Cancelled  <-------------------------+
/// ```
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskState {
    Pending,
    Planning,
    Acting,
    Observing,
    Reflecting,
    Paused,
    AwaitingApproval,
    Completed,
    Failed,
    Cancelled,
}

impl TaskState {
    /// 是否为终态 (不可再转移)。
    pub fn is_terminal(&self) -> bool {
        matches!(self, Self::Completed | Self::Failed | Self::Cancelled)
    }

    /// 是否处于"运行中" (ReAct 循环活跃,未挂起 / 未等待审批 / 未结束)。
    pub fn is_running(&self) -> bool {
        !self.is_terminal()
            && !matches!(self, Self::Pending | Self::Paused | Self::AwaitingApproval)
    }
}

impl fmt::Display for TaskState {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Pending => write!(f, "pending"),
            Self::Planning => write!(f, "planning"),
            Self::Acting => write!(f, "acting"),
            Self::Observing => write!(f, "observing"),
            Self::Reflecting => write!(f, "reflecting"),
            Self::Paused => write!(f, "paused"),
            Self::AwaitingApproval => write!(f, "awaiting_approval"),
            Self::Completed => write!(f, "completed"),
            Self::Failed => write!(f, "failed"),
            Self::Cancelled => write!(f, "cancelled"),
        }
    }
}

/// Agent 执行模式。
///
/// - `Autonomous`:无人工干预,工具调用直接执行 (受 PermissionLevel 沙盒约束)。
/// - `Approval`:每个工具调用前进入 `AwaitingApproval`,等待用户批准。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionMode {
    Autonomous,
    Approval,
}

impl fmt::Display for ExecutionMode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Autonomous => write!(f, "autonomous"),
            Self::Approval => write!(f, "approval"),
        }
    }
}

/// 单个 Plan 步骤的执行状态。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StepStatus {
    Pending,
    InProgress,
    Done,
    Skipped,
    Failed,
}

impl fmt::Display for StepStatus {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Pending => write!(f, "pending"),
            Self::InProgress => write!(f, "in_progress"),
            Self::Done => write!(f, "done"),
            Self::Skipped => write!(f, "skipped"),
            Self::Failed => write!(f, "failed"),
        }
    }
}

/// 状态转移事件的时间戳记录 (供审计 / 调试使用)。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StateTransition {
    pub from: TaskState,
    pub to: TaskState,
    pub at: DateTime<Utc>,
    pub reason: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminal_states() {
        assert!(TaskState::Completed.is_terminal());
        assert!(TaskState::Failed.is_terminal());
        assert!(TaskState::Cancelled.is_terminal());
        assert!(!TaskState::Acting.is_terminal());
        assert!(!TaskState::Paused.is_terminal());
    }

    #[test]
    fn running_states() {
        assert!(TaskState::Planning.is_running());
        assert!(TaskState::Acting.is_running());
        assert!(TaskState::Observing.is_running());
        assert!(TaskState::Reflecting.is_running());
        assert!(!TaskState::Pending.is_running());
        assert!(!TaskState::Paused.is_running());
        assert!(!TaskState::AwaitingApproval.is_running());
        assert!(!TaskState::Completed.is_running());
    }

    #[test]
    fn display_snake_case() {
        assert_eq!(TaskState::AwaitingApproval.to_string(), "awaiting_approval");
        assert_eq!(ExecutionMode::Autonomous.to_string(), "autonomous");
        assert_eq!(StepStatus::InProgress.to_string(), "in_progress");
    }
}
