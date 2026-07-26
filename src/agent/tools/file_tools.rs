//! 文件工具集 (Agent Tool 包装层)。
//!
//! 在 `crate::tools` 之上包装为 `AgentTool` trait 实现,
//! 复用既有文件读写 / 列表 / 搜索逻辑,不重复实现 IO。

use async_trait::async_trait;
use serde_json::{json, Value};
use std::path::Path;

use crate::agent::tool_protocol::{
    AgentTool, ArtifactKind, ExecutionContext, ToolArtifact, ToolError, ToolResult,
    DEFAULT_MAX_OUTPUT_BYTES,
};
use crate::config::{ensure_within, PermissionLevel};

/// 列表 / 搜索时过滤的目录名 (与 `tools.rs` 保持一致)。
const IGNORED_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "build",
    "dist",
    ".next",
    "__pycache__",
    ".venv",
];

/// 校验相对路径不越出项目根。
///
/// 已存在的路径直接 canonicalize 后判断;不存在的路径 (如待写入的新文件)
/// 回退到校验现存的最长祖先目录,剩余越界检测交给底层 `tools::*`。
fn validate_path(ctx: &ExecutionContext, rel: &str) -> Result<(), ToolError> {
    if rel.trim().is_empty() {
        return Ok(());
    }
    let target = ctx.project_root.join(rel);
    if target.exists() {
        ensure_within(&ctx.project_root, &target)
            .map_err(|e| ToolError::PathEscape(e.to_string()))?;
        return Ok(());
    }
    if let Some(parent) = target.parent() {
        if parent.exists() {
            ensure_within(&ctx.project_root, parent)
                .map_err(|e| ToolError::PathEscape(e.to_string()))?;
        }
    }
    Ok(())
}

// ============================== FileReadTool ==============================

pub struct FileReadTool;

#[async_trait]
impl AgentTool for FileReadTool {
    fn name(&self) -> &'static str {
        "file.read"
    }

    fn description(&self) -> &'static str {
        "读取项目工作区内的文件内容 (相对项目根的路径)。"
    }

    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "相对项目根目录的文件路径"
                },
                "max_bytes": {
                    "type": "integer",
                    "description": "返回内容最大字节数,超出自动截断",
                    "minimum": 1
                }
            },
            "required": ["path"]
        })
    }

    fn required_permission(&self) -> PermissionLevel {
        PermissionLevel::ReadOnly
    }

    async fn execute(&self, args: Value, ctx: &ExecutionContext) -> Result<ToolResult, ToolError> {
        let path = args
            .get("path")
            .and_then(|v| v.as_str())
            .ok_or_else(|| ToolError::InvalidArgs("缺少 path 参数".into()))?
            .to_string();
        let max_bytes = args
            .get("max_bytes")
            .and_then(|v| v.as_u64())
            .map(|n| n as usize)
            .unwrap_or(DEFAULT_MAX_OUTPUT_BYTES);

        validate_path(ctx, &path)?;
        if ctx.is_cancelled() {
            return Err(ToolError::Cancelled);
        }

        let result = crate::tools::read_file(&ctx.project_root, &path)
            .await
            .map_err(|e| ToolError::Execution(e.to_string()))?;

        let mut tr = ToolResult::success(result.content);
        tr.truncate_output(max_bytes);
        Ok(tr)
    }
}

// ============================== FileWriteTool ==============================

pub struct FileWriteTool;

#[async_trait]
impl AgentTool for FileWriteTool {
    fn name(&self) -> &'static str {
        "file.write"
    }

    fn description(&self) -> &'static str {
        "写入或覆盖项目工作区内的文件。"
    }

    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "相对项目根目录的文件路径"
                },
                "content": {
                    "type": "string",
                    "description": "文件内容"
                },
                "create_dirs": {
                    "type": "boolean",
                    "description": "父目录不存在时是否自动创建,默认 false"
                }
            },
            "required": ["path", "content"]
        })
    }

    fn required_permission(&self) -> PermissionLevel {
        PermissionLevel::WorkspaceWrite
    }

    async fn execute(&self, args: Value, ctx: &ExecutionContext) -> Result<ToolResult, ToolError> {
        let path = args
            .get("path")
            .and_then(|v| v.as_str())
            .ok_or_else(|| ToolError::InvalidArgs("缺少 path 参数".into()))?
            .to_string();
        let content = args
            .get("content")
            .and_then(|v| v.as_str())
            .ok_or_else(|| ToolError::InvalidArgs("缺少 content 参数".into()))?
            .to_string();
        let create_dirs = args
            .get("create_dirs")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        validate_path(ctx, &path)?;
        if ctx.is_cancelled() {
            return Err(ToolError::Cancelled);
        }

        let result = crate::tools::write_file(
            &ctx.project_root,
            &path,
            &content,
            create_dirs,
            self.required_permission(),
        )
        .await
        .map_err(|e| ToolError::Execution(e.to_string()))?;

        let kind = if result.created {
            ArtifactKind::FileCreated
        } else {
            ArtifactKind::FileChange
        };
        let mut tr = ToolResult::success(format!(
            "已{}文件 {} ({} bytes)",
            if result.created { "创建" } else { "更新" },
            result.path,
            result.bytes
        ));
        tr.artifacts.push(ToolArtifact {
            kind,
            path: Some(result.path),
            diff_id: None,
            summary: format!("{} bytes", result.bytes),
        });
        Ok(tr)
    }
}

// ============================== FileListTool ==============================

pub struct FileListTool;

#[async_trait]
impl AgentTool for FileListTool {
    fn name(&self) -> &'static str {
        "file.list"
    }

    fn description(&self) -> &'static str {
        "列出目录内容 (过滤 node_modules/.git/build/target 等忽略目录)。"
    }

    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "相对项目根的目录路径,缺省为项目根"
                },
                "recursive": {
                    "type": "boolean",
                    "description": "是否递归列出子目录,默认 false"
                },
                "max_entries": {
                    "type": "integer",
                    "description": "最大返回条目数,默认 1000",
                    "minimum": 1
                }
            }
        })
    }

    fn required_permission(&self) -> PermissionLevel {
        PermissionLevel::ReadOnly
    }

    async fn execute(&self, args: Value, ctx: &ExecutionContext) -> Result<ToolResult, ToolError> {
        let path = args.get("path").and_then(|v| v.as_str()).unwrap_or("");
        let recursive = args
            .get("recursive")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let max_entries = args
            .get("max_entries")
            .and_then(|v| v.as_u64())
            .map(|n| n as usize)
            .unwrap_or(1000);

        validate_path(ctx, path)?;
        if ctx.is_cancelled() {
            return Err(ToolError::Cancelled);
        }

        if !recursive {
            let val = crate::tools::list_files(&ctx.project_root, path)
                .await
                .map_err(|e| ToolError::Execution(e.to_string()))?;
            let mut tr =
                ToolResult::success(serde_json::to_string_pretty(&val).unwrap_or_default());
            tr.truncate_default();
            return Ok(tr);
        }

        // 递归列出 (list_files 仅支持单层)
        let start = if path.is_empty() {
            ctx.project_root.clone()
        } else {
            ctx.project_root.join(path)
        };
        let mut entries: Vec<Value> = Vec::new();
        walk_list(&start, path, max_entries, &mut entries).await?;
        let payload = json!({
            "path": path,
            "entries": entries,
            "total": entries.len(),
        });
        let mut tr =
            ToolResult::success(serde_json::to_string_pretty(&payload).unwrap_or_default());
        tr.truncate_default();
        Ok(tr)
    }
}

/// 递归收集目录条目 (过滤忽略目录)。
async fn walk_list(
    dir: &Path,
    rel_prefix: &str,
    max: usize,
    out: &mut Vec<Value>,
) -> Result<(), ToolError> {
    if out.len() >= max {
        return Ok(());
    }
    let mut rd = tokio::fs::read_dir(dir).await?;
    while let Some(entry) = rd.next_entry().await? {
        if out.len() >= max {
            return Ok(());
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if IGNORED_DIRS.contains(&name.as_str()) {
            continue;
        }
        let ft = entry.file_type().await?;
        let rel = if rel_prefix.is_empty() {
            name.clone()
        } else {
            format!("{rel_prefix}/{name}")
        };
        out.push(json!({
            "path": rel,
            "name": name,
            "isDir": ft.is_dir(),
            "isFile": ft.is_file(),
        }));
        if ft.is_dir() {
            Box::pin(walk_list(&entry.path(), &rel, max, out)).await?;
        }
    }
    Ok(())
}

// ============================== FileSearchTool ==============================

pub struct FileSearchTool;

#[async_trait]
impl AgentTool for FileSearchTool {
    fn name(&self) -> &'static str {
        "file.search"
    }

    fn description(&self) -> &'static str {
        "使用正则表达式搜索文件内容,返回匹配的文件+行号+内容。"
    }

    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "pattern": {
                    "type": "string",
                    "description": "正则表达式"
                },
                "path": {
                    "type": "string",
                    "description": "搜索起始目录 (相对项目根),缺省为项目根"
                },
                "max_results": {
                    "type": "integer",
                    "description": "最大返回匹配数,默认 100",
                    "minimum": 1
                }
            },
            "required": ["pattern"]
        })
    }

    fn required_permission(&self) -> PermissionLevel {
        PermissionLevel::ReadOnly
    }

    async fn execute(&self, args: Value, ctx: &ExecutionContext) -> Result<ToolResult, ToolError> {
        let pattern = args
            .get("pattern")
            .and_then(|v| v.as_str())
            .ok_or_else(|| ToolError::InvalidArgs("缺少 pattern 参数".into()))?
            .to_string();
        let path = args.get("path").and_then(|v| v.as_str()).unwrap_or("");
        let max_results = args
            .get("max_results")
            .and_then(|v| v.as_u64())
            .map(|n| n as usize)
            .unwrap_or(100);

        validate_path(ctx, path)?;
        if ctx.is_cancelled() {
            return Err(ToolError::Cancelled);
        }

        let val = crate::tools::search_files(&ctx.project_root, &pattern, path, max_results)
            .await
            .map_err(|e| ToolError::Execution(e.to_string()))?;
        let mut tr = ToolResult::success(serde_json::to_string_pretty(&val).unwrap_or_default());
        tr.truncate_default();
        Ok(tr)
    }
}

// ============================== FileDeleteTool ==============================

pub struct FileDeleteTool;

#[async_trait]
impl AgentTool for FileDeleteTool {
    fn name(&self) -> &'static str {
        "file.delete"
    }

    fn description(&self) -> &'static str {
        "删除项目工作区内的文件。"
    }

    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "相对项目根目录的文件路径"
                }
            },
            "required": ["path"]
        })
    }

    fn required_permission(&self) -> PermissionLevel {
        PermissionLevel::WorkspaceWrite
    }

    async fn execute(&self, args: Value, ctx: &ExecutionContext) -> Result<ToolResult, ToolError> {
        let path = args
            .get("path")
            .and_then(|v| v.as_str())
            .ok_or_else(|| ToolError::InvalidArgs("缺少 path 参数".into()))?
            .to_string();

        validate_path(ctx, &path)?;
        if ctx.is_cancelled() {
            return Err(ToolError::Cancelled);
        }

        let target = ctx.project_root.join(&path);
        tokio::fs::remove_file(&target).await?;

        let mut tr = ToolResult::success(format!("已删除文件 {path}"));
        tr.artifacts.push(ToolArtifact {
            kind: ArtifactKind::FileDeleted,
            path: Some(path),
            diff_id: None,
            summary: "file deleted".into(),
        });
        Ok(tr)
    }
}
