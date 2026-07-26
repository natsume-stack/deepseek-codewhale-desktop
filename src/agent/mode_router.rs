//! 执行模式路由 (P0 自治 Agent)。
//!
//! 在工具执行前根据任务模式 (Autonomous / Approval) 决定是否放行:
//!   - Autonomous: 直接放行,工具立即执行
//!   - Approval: 提交审批请求到 ApprovalStore,等待用户决定
//!
//! 路由器是无状态的纯函数式组件,所有状态由 ApprovalStore 管理。

use serde_json::Value;

use crate::agent::state_machine::ExecutionMode;
use crate::agent::task_store::AgentTask;
use crate::agent::tool_protocol::SharedTool;
use crate::state::{ApprovalKind, ApprovalStatus, ApprovalStore};

/// 模式路由决策结果。
#[derive(Debug, Clone)]
pub enum ModeDecision {
    /// 直接放行,工具可立即执行。
    Proceed,
    /// 已提交审批,等待用户决定。值为审批请求 ID。
    ///
    /// 注:任务规范写为 `AwaitingApproval(Uuid)`,但 ApprovalStore 使用 `String` ID
    /// (格式 `appr_{uuid}`),为与现有审批系统一致此处使用 String。这是与规范的
    /// 一个接口调整,需在协调时同步。
    AwaitingApproval(String),
    /// 被拒绝 (如权限等级不匹配、参数非法等)。
    Rejected(String),
}

/// 模式路由器 (无状态)。
pub struct ModeRouter;

impl ModeRouter {
    /// 在工具执行前调用,根据任务模式决定是否放行。
    ///
    /// - Autonomous 模式直接放行
    /// - Approval 模式提交审批请求,返回 AwaitingApproval,调用方应轮询审批状态
    pub async fn before_tool_call(
        &self,
        task: &AgentTask,
        tool: &SharedTool,
        args: &Value,
        approval_store: &ApprovalStore,
    ) -> ModeDecision {
        match task.mode {
            ExecutionMode::Autonomous => ModeDecision::Proceed,
            ExecutionMode::Approval => {
                // 构造审批请求描述
                let description =
                    format!("Agent 请求执行工具: {} (任务: {})", tool.name(), task.id);
                let detail =
                    serde_json::to_string_pretty(args).unwrap_or_else(|_| args.to_string());

                // 根据工具所需权限映射审批类型
                let kind = map_tool_to_approval_kind(tool);

                let req = approval_store
                    .create(
                        kind,
                        description,
                        Some(detail),
                        Some(task.session_id.to_string()),
                    )
                    .await;

                ModeDecision::AwaitingApproval(req.id)
            }
        }
    }
}

/// 将工具所需权限映射到审批操作类型。
///
/// 简化映射:
///   - 工具名包含 "shell" / "exec" → Shell
///   - 工具名包含 "git" → Git
///   - 工具名包含 "delete" / "remove" → FileDelete
///   - 其他写操作 → FileWrite
fn map_tool_to_approval_kind(tool: &SharedTool) -> ApprovalKind {
    let name = tool.name().to_lowercase();
    if name.contains("shell") || name.contains("exec") {
        ApprovalKind::Shell
    } else if name.contains("git") {
        ApprovalKind::Git
    } else if name.contains("delete") || name.contains("remove") {
        ApprovalKind::FileDelete
    } else {
        ApprovalKind::FileWrite
    }
}

/// 检查审批是否已批准 (供 react_loop 在等待后调用)。
pub async fn is_approval_approved(
    approval_store: &ApprovalStore,
    approval_id: &str,
) -> ApprovalStatus {
    match approval_store.get(approval_id).await {
        Some(req) => req.status,
        None => ApprovalStatus::Rejected,
    }
}
