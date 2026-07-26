//! Shell 工具集 (Agent Tool 包装层)。
//!
//! 复用 `crate::tools::shell` (内置危险命令黑名单: rm -rf /、mkfs、fork bomb、
//! format 等),包装为 `AgentTool`。命中黑名单时底层返回 `AppError::Forbidden`,
//! 此处统一转换为 `ToolError::Execution`,即命中直接返回执行错误。

use async_trait::async_trait;
use serde_json::{json, Value};

use crate::agent::tool_protocol::{
    AgentTool, ArtifactKind, ExecutionContext, ToolArtifact, ToolError, ToolResult,
};
use crate::config::{ensure_within, PermissionLevel};

/// 默认 Shell 超时 (秒)。
const DEFAULT_TIMEOUT_SECS: u64 = 60;

// ============================== ShellExecTool ==============================

pub struct ShellExecTool;

#[async_trait]
impl AgentTool for ShellExecTool {
    fn name(&self) -> &'static str {
        "shell.exec"
    }

    fn description(&self) -> &'static str {
        "在工作区内执行 Shell 命令 (受危险命令黑名单拦截)。"
    }

    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "command": {
                    "type": "string",
                    "description": "Shell 命令"
                },
                "timeout_secs": {
                    "type": "integer",
                    "description": "超时秒数,默认 60",
                    "minimum": 1
                },
                "cwd": {
                    "type": "string",
                    "description": "工作目录 (相对项目根),缺省为项目根"
                }
            },
            "required": ["command"]
        })
    }

    fn required_permission(&self) -> PermissionLevel {
        PermissionLevel::FullAccess
    }

    async fn execute(&self, args: Value, ctx: &ExecutionContext) -> Result<ToolResult, ToolError> {
        let command = args
            .get("command")
            .and_then(|v| v.as_str())
            .ok_or_else(|| ToolError::InvalidArgs("缺少 command 参数".into()))?
            .to_string();
        let timeout_secs = args
            .get("timeout_secs")
            .and_then(|v| v.as_u64())
            .unwrap_or(DEFAULT_TIMEOUT_SECS);
        let cwd = args.get("cwd").and_then(|v| v.as_str());

        // 解析工作目录: 缺省 / 空字符串 → 项目根; 否则校验越界
        let work_dir = if let Some(c) = cwd {
            if c.trim().is_empty() {
                ctx.project_root.clone()
            } else {
                let target = ctx.project_root.join(c);
                ensure_within(&ctx.project_root, &target)
                    .map_err(|e| ToolError::PathEscape(e.to_string()))?
            }
        } else {
            ctx.project_root.clone()
        };

        if ctx.is_cancelled() {
            return Err(ToolError::Cancelled);
        }

        // 危险命令黑名单由 `crate::tools::shell` 内置强制拦截 (rm -rf /、mkfs、
        // fork bomb、format、>/dev/sd 等),FullAccess 也无法绕过。命中返回
        // AppError::Forbidden → 此处统一转 ToolError::Execution。
        let result =
            crate::tools::shell(&work_dir, command, timeout_secs, self.required_permission())
                .await
                .map_err(|e| ToolError::Execution(e.to_string()))?;

        let output = format!(
            "[exit {}]\n--- stdout ---\n{}\n--- stderr ---\n{}",
            result.exit_code, result.stdout, result.stderr
        );
        let mut tr = ToolResult::success(output);
        tr.artifacts.push(ToolArtifact {
            kind: ArtifactKind::ShellOutput,
            path: None,
            diff_id: None,
            summary: format!("exit={}, success={}", result.exit_code, result.success),
        });
        tr.truncate_default();
        Ok(tr)
    }
}
