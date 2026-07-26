//! 自治 Agent 运行时标准化工具集。
//!
//! 在 `crate::tools` 与 `crate::agent::tool_protocol` 之上提供 11 个内置工具,
//! 覆盖文件读写、Shell 执行、Git 操作三类能力,统一以 `AgentTool` trait 暴露。
//!
//! 工具内部 assume 已授权 (权限检查由 ToolDispatcher 在调用前完成),
//! 仅负责参数校验、路径越界检查与底层 `tools::*` 调用。

mod file_tools;
mod git_tools;
mod shell_tools;

use std::sync::Arc;

use file_tools::{FileDeleteTool, FileListTool, FileReadTool, FileSearchTool, FileWriteTool};
use git_tools::{GitBranchTool, GitCommitTool, GitDiffTool, GitLogTool, GitStatusTool};
use shell_tools::ShellExecTool;

use crate::agent::tool_protocol::SharedTool;

/// 注册全部内置工具,返回 `Vec<SharedTool>` 供 ToolDispatcher 装配。
pub fn register_builtin_tools() -> Vec<SharedTool> {
    vec![
        Arc::new(FileReadTool),
        Arc::new(FileWriteTool),
        Arc::new(FileListTool),
        Arc::new(FileSearchTool),
        Arc::new(FileDeleteTool),
        Arc::new(ShellExecTool),
        Arc::new(GitStatusTool),
        Arc::new(GitDiffTool),
        Arc::new(GitCommitTool),
        Arc::new(GitBranchTool),
        Arc::new(GitLogTool),
    ]
}
