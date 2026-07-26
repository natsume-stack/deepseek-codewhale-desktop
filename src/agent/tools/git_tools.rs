//! Git 工具集 (Agent Tool 包装层)。
//!
//! 复用 `crate::tools::git`,包装为 `AgentTool`。每个子命令对应一个独立工具,
//! 便于 ToolDispatcher 按权限等级 (ReadOnly / FullAccess) 精细分发。

use async_trait::async_trait;
use serde_json::{json, Value};

use crate::agent::tool_protocol::{
    AgentTool, ArtifactKind, ExecutionContext, ToolArtifact, ToolError, ToolResult,
};
use crate::config::PermissionLevel;
use crate::tools::CommandResult;

/// 运行 git 子命令,统一错误转换。
async fn run_git(
    ctx: &ExecutionContext,
    args: Vec<String>,
    permission: PermissionLevel,
) -> Result<CommandResult, ToolError> {
    crate::tools::git(&ctx.project_root, args, permission)
        .await
        .map_err(|e| ToolError::Execution(e.to_string()))
}

// ============================== GitStatusTool ==============================

pub struct GitStatusTool;

#[async_trait]
impl AgentTool for GitStatusTool {
    fn name(&self) -> &'static str {
        "git.status"
    }

    fn description(&self) -> &'static str {
        "运行 git status --porcelain,输出工作区改动概览。"
    }

    fn schema(&self) -> Value {
        json!({ "type": "object", "properties": {} })
    }

    fn required_permission(&self) -> PermissionLevel {
        PermissionLevel::ReadOnly
    }

    async fn execute(&self, _args: Value, ctx: &ExecutionContext) -> Result<ToolResult, ToolError> {
        if ctx.is_cancelled() {
            return Err(ToolError::Cancelled);
        }
        let result = run_git(
            ctx,
            vec!["status".into(), "--porcelain".into()],
            self.required_permission(),
        )
        .await?;
        let mut tr = ToolResult::success(result.stdout);
        tr.truncate_default();
        Ok(tr)
    }
}

// ============================== GitDiffTool ==============================

pub struct GitDiffTool;

#[async_trait]
impl AgentTool for GitDiffTool {
    fn name(&self) -> &'static str {
        "git.diff"
    }

    fn description(&self) -> &'static str {
        "运行 git diff,可选 staged (--cached) 与指定路径。"
    }

    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "staged": {
                    "type": "boolean",
                    "description": "是否只看已暂存的改动 (git diff --cached)"
                },
                "path": {
                    "type": "string",
                    "description": "限定查看的路径 (相对项目根)"
                }
            }
        })
    }

    fn required_permission(&self) -> PermissionLevel {
        PermissionLevel::ReadOnly
    }

    async fn execute(&self, args: Value, ctx: &ExecutionContext) -> Result<ToolResult, ToolError> {
        let staged = args
            .get("staged")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let path = args.get("path").and_then(|v| v.as_str());

        let mut git_args = vec!["diff".to_string()];
        if staged {
            git_args.push("--cached".into());
        }
        if let Some(p) = path {
            git_args.push("--".into());
            git_args.push(p.to_string());
        }

        if ctx.is_cancelled() {
            return Err(ToolError::Cancelled);
        }
        let result = run_git(ctx, git_args, self.required_permission()).await?;
        let mut tr = ToolResult::success(result.stdout);
        tr.truncate_default();
        Ok(tr)
    }
}

// ============================== GitCommitTool ==============================

pub struct GitCommitTool;

#[async_trait]
impl AgentTool for GitCommitTool {
    fn name(&self) -> &'static str {
        "git.commit"
    }

    fn description(&self) -> &'static str {
        "提交暂存区改动 (可选 add -A 全量暂存)。"
    }

    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "message": {
                    "type": "string",
                    "description": "提交信息"
                },
                "add_all": {
                    "type": "boolean",
                    "description": "提交前是否执行 git add -A,默认 false"
                }
            },
            "required": ["message"]
        })
    }

    fn required_permission(&self) -> PermissionLevel {
        PermissionLevel::FullAccess
    }

    async fn execute(&self, args: Value, ctx: &ExecutionContext) -> Result<ToolResult, ToolError> {
        let message = args
            .get("message")
            .and_then(|v| v.as_str())
            .ok_or_else(|| ToolError::InvalidArgs("缺少 message 参数".into()))?
            .to_string();
        let add_all = args
            .get("add_all")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        if ctx.is_cancelled() {
            return Err(ToolError::Cancelled);
        }
        if add_all {
            run_git(
                ctx,
                vec!["add".into(), "-A".into()],
                self.required_permission(),
            )
            .await?;
        }
        let result = run_git(
            ctx,
            vec!["commit".into(), "-m".into(), message],
            self.required_permission(),
        )
        .await?;

        let summary = result.stdout.lines().next().unwrap_or("").to_string();
        let mut tr = ToolResult::success(format!(
            "[exit {}]\n{}{}",
            result.exit_code,
            result.stdout,
            if result.stderr.is_empty() {
                String::new()
            } else {
                format!("\n{}", result.stderr)
            }
        ));
        tr.artifacts.push(ToolArtifact {
            kind: ArtifactKind::GitCommit,
            path: None,
            diff_id: None,
            summary,
        });
        tr.truncate_default();
        Ok(tr)
    }
}

// ============================== GitBranchTool ==============================

pub struct GitBranchTool;

#[async_trait]
impl AgentTool for GitBranchTool {
    fn name(&self) -> &'static str {
        "git.branch"
    }

    fn description(&self) -> &'static str {
        "分支管理: create / switch / list / delete。"
    }

    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["create", "switch", "list", "delete"],
                    "description": "分支操作类型"
                },
                "name": {
                    "type": "string",
                    "description": "分支名 (create/switch/delete 必填,list 可省略)"
                }
            },
            "required": ["action"]
        })
    }

    fn required_permission(&self) -> PermissionLevel {
        PermissionLevel::FullAccess
    }

    async fn execute(&self, args: Value, ctx: &ExecutionContext) -> Result<ToolResult, ToolError> {
        let action = args
            .get("action")
            .and_then(|v| v.as_str())
            .ok_or_else(|| ToolError::InvalidArgs("缺少 action 参数".into()))?;
        let name = args.get("name").and_then(|v| v.as_str());

        let git_args: Vec<String> = match action {
            "list" => vec!["branch".into()],
            "create" => {
                let n =
                    name.ok_or_else(|| ToolError::InvalidArgs("create 需要 name 参数".into()))?;
                vec!["branch".into(), n.to_string()]
            }
            "switch" => {
                let n =
                    name.ok_or_else(|| ToolError::InvalidArgs("switch 需要 name 参数".into()))?;
                vec!["checkout".into(), n.to_string()]
            }
            "delete" => {
                let n =
                    name.ok_or_else(|| ToolError::InvalidArgs("delete 需要 name 参数".into()))?;
                vec!["branch".into(), "-d".into(), n.to_string()]
            }
            other => {
                return Err(ToolError::InvalidArgs(format!(
                    "不支持的 action: {other} (允许 create/switch/list/delete)"
                )))
            }
        };

        if ctx.is_cancelled() {
            return Err(ToolError::Cancelled);
        }
        let result = run_git(ctx, git_args, self.required_permission()).await?;
        // branch/checkout 成功时常无 stdout,有信息时在 stderr
        let output = if result.stdout.is_empty() && !result.stderr.is_empty() {
            result.stderr
        } else {
            result.stdout
        };
        let mut tr = ToolResult::success(format!("[exit {}]\n{}", result.exit_code, output));
        tr.truncate_default();
        Ok(tr)
    }
}

// ============================== GitLogTool ==============================

pub struct GitLogTool;

#[async_trait]
impl AgentTool for GitLogTool {
    fn name(&self) -> &'static str {
        "git.log"
    }

    fn description(&self) -> &'static str {
        "查看提交历史 (git log)。"
    }

    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "limit": {
                    "type": "integer",
                    "description": "返回最近 N 条提交",
                    "minimum": 1
                },
                "oneline": {
                    "type": "boolean",
                    "description": "是否使用 --oneline 紧凑格式"
                }
            }
        })
    }

    fn required_permission(&self) -> PermissionLevel {
        PermissionLevel::ReadOnly
    }

    async fn execute(&self, args: Value, ctx: &ExecutionContext) -> Result<ToolResult, ToolError> {
        let limit = args.get("limit").and_then(|v| v.as_u64());
        let oneline = args
            .get("oneline")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        let mut git_args = vec!["log".to_string()];
        if oneline {
            git_args.push("--oneline".into());
        }
        if let Some(n) = limit {
            git_args.push(format!("-n{n}"));
        }

        if ctx.is_cancelled() {
            return Err(ToolError::Cancelled);
        }
        let result = run_git(ctx, git_args, self.required_permission()).await?;
        let mut tr = ToolResult::success(result.stdout);
        tr.truncate_default();
        Ok(tr)
    }
}
