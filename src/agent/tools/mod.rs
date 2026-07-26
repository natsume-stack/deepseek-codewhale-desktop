//! 自治 Agent 运行时标准化工具集。
//!
//! 在 `crate::tools` 与 `crate::agent::tool_protocol` 之上提供 11 个内置工具,
//! 覆盖文件读写、Shell 执行、Git 操作三类能力,统一以 `AgentTool` trait 暴露。
//!
//! 工具内部 assume 已授权 (权限检查由 ToolDispatcher 在调用前完成),
//! 仅负责参数校验、路径越界检查与底层 `tools::*` 调用。
//!
//! 额外工具 (阶段1 扩展):
//! - `persistent_shell`: 持久交互式终端,目录上下文保留 (ShellSessionManager 单例)
//! - `mcp_bridge`: 将 McpStore 的 12 个 MCP 插件桥接为 AgentTool (动态注册)
//! - `browser_tools`: 静态网页抓取 (web.fetch / web.search)

mod browser_tools;
mod file_tools;
mod git_tools;
mod mcp_bridge;
mod persistent_shell;
mod shell_tools;

use std::sync::Arc;

use file_tools::{FileDeleteTool, FileListTool, FileReadTool, FileSearchTool, FileWriteTool};
use git_tools::{GitBranchTool, GitCommitTool, GitDiffTool, GitLogTool, GitStatusTool};
use shell_tools::ShellExecTool;

use crate::agent::tool_protocol::SharedTool;

// 公开导出供 routes/agent.rs 等模块复用 (同时供本模块内部使用)
pub use browser_tools::{WebFetchTool, WebSearchTool};
pub use mcp_bridge::{McpBridge, McpToolWrapper};
pub use persistent_shell::{
    global_shell_manager, PersistentShell, PersistentShellExecTool, ShellSessionCloseTool,
    ShellSessionCreateTool, ShellSessionManager,
};

/// 注册全部内置工具,返回 `Vec<SharedTool>` 供 ToolDispatcher 装配。
///
/// 内部使用 `global_shell_manager()` 获取全局单例 `ShellSessionManager`,
/// 确保 Agent 工具与 `/api/agent/terminal/*` 路由共享同一份会话池。
pub fn register_builtin_tools() -> Vec<SharedTool> {
    register_builtin_tools_with_shell(global_shell_manager())
}

/// 注册带共享 ShellSessionManager 的工具集。
///
/// `shell_manager` 由调用方提供 (通常来自 `global_shell_manager()`),
/// 确保前端 xterm.js 路由与 Agent 工具访问同一份会话池。
pub fn register_builtin_tools_with_shell(
    shell_manager: Arc<ShellSessionManager>,
) -> Vec<SharedTool> {
    vec![
        // 文件工具 (5)
        Arc::new(FileReadTool),
        Arc::new(FileWriteTool),
        Arc::new(FileListTool),
        Arc::new(FileSearchTool),
        Arc::new(FileDeleteTool),
        // Shell 工具 (1 单次 + 3 持久会话)
        Arc::new(ShellExecTool),
        Arc::new(PersistentShellExecTool::new(shell_manager.clone())),
        Arc::new(ShellSessionCreateTool::new(shell_manager.clone())),
        Arc::new(ShellSessionCloseTool::new(shell_manager)),
        // Git 工具 (5)
        Arc::new(GitStatusTool),
        Arc::new(GitDiffTool),
        Arc::new(GitCommitTool),
        Arc::new(GitBranchTool),
        Arc::new(GitLogTool),
        // 网页工具 (2)
        Arc::new(WebFetchTool),
        Arc::new(WebSearchTool),
    ]
}
