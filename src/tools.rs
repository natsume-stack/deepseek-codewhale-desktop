//! 内置工具: 文件读写、Git、Shell。
//!
//! 所有路径操作均限制在会话绑定的项目根目录内 (调用 config::ensure_within 校验)。
//! Shell/Git 命令的工作目录固定为项目根, 支持超时。

use crate::config::{ensure_within, PermissionLevel};
use crate::error::{AppError, AppResult};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::process::Command;

#[derive(Debug, Clone, Serialize)]
pub struct FileReadResult {
    pub path: String,
    pub content: String,
    pub bytes: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct FileWriteResult {
    pub path: String,
    pub bytes: usize,
    pub created: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct CommandResult {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
    pub success: bool,
}

/// 解析相对路径并校验越界。空字符串视作项目根本身。
fn resolve(root: &Path, rel: &str) -> AppResult<PathBuf> {
    let rel = rel.trim();
    let target = if rel.is_empty() {
        root.to_path_buf()
    } else {
        root.join(rel)
    };
    ensure_within(root, &target)
}

pub async fn read_file(root: &Path, rel: &str) -> AppResult<FileReadResult> {
    let target = resolve(root, rel)?;
    let bytes = tokio::fs::read(&target).await?;
    let content = String::from_utf8_lossy(&bytes).into_owned();
    let n = bytes.len();
    Ok(FileReadResult {
        path: rel.to_string(),
        content,
        bytes: n,
    })
}

pub async fn write_file(
    root: &Path,
    rel: &str,
    content: &str,
    create_dirs: bool,
    permission: PermissionLevel,
) -> AppResult<FileWriteResult> {
    // 权限检查：ReadOnly 禁止写文件
    if !permission.can_write() {
        return Err(AppError::Forbidden("当前权限等级禁止写文件".into()));
    }
    if rel.trim().is_empty() {
        return Err(AppError::BadRequest("写入路径不能为空".into()));
    }
    let target = root.join(rel);
    // 越界校验: 目标可能尚不存在, 用父目录 canonicalize 后再拼文件名判断
    let parent = target.parent().unwrap_or(root);
    if !parent.exists() {
        if !create_dirs {
            return Err(AppError::BadRequest(format!(
                "父目录不存在: {} (可启用 createDirs 自动创建)",
                parent.display()
            )));
        }
        tokio::fs::create_dir_all(parent).await?;
    }
    // 校验父目录在项目根内
    ensure_within(root, parent)?;
    let existed = target.exists();
    tokio::fs::write(&target, content.as_bytes()).await?;
    Ok(FileWriteResult {
        path: rel.to_string(),
        bytes: content.as_bytes().len(),
        created: !existed,
    })
}

pub async fn git(
    root: &Path,
    args: Vec<String>,
    permission: PermissionLevel,
) -> AppResult<CommandResult> {
    // 权限检查：Git 视为 Shell 类，需 can_shell
    if !permission.can_shell() {
        return Err(AppError::Forbidden("当前权限等级禁止执行 Git".into()));
    }
    run_command("git", args, root, 60).await
}

pub async fn shell(
    root: &Path,
    command: String,
    timeout_secs: u64,
    permission: PermissionLevel,
) -> AppResult<CommandResult> {
    // 权限检查：仅 FullAccess 允许执行 Shell
    if !permission.can_shell() {
        return Err(AppError::Forbidden("当前权限等级禁止执行 Shell".into()));
    }
    if command.trim().is_empty() {
        return Err(AppError::BadRequest("shell 命令不能为空".into()));
    }
    // 跨平台: Windows 走 cmd /C, Unix 走 sh -c
    #[cfg(windows)]
    let (program, args) = ("cmd", vec!["/C".to_string(), command]);
    #[cfg(not(windows))]
    let (program, args) = ("sh", vec!["-c".to_string(), command]);

    run_command(program, args, root, timeout_secs).await
}

async fn run_command(
    program: &str,
    args: Vec<String>,
    cwd: &Path,
    timeout_secs: u64,
) -> AppResult<CommandResult> {
    let mut cmd = Command::new(program);
    cmd.args(&args);
    cmd.current_dir(cwd);
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    // Windows 隐藏控制台窗口
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let child = cmd.spawn().map_err(|e| {
        AppError::Tool(format!("启动 {program} 失败: {e}"))
    })?;

    let result = tokio::time::timeout(Duration::from_secs(timeout_secs), child.wait_with_output())
        .await;
    match result {
        Ok(Ok(output)) => {
            let exit_code = output.status.code().unwrap_or(-1);
            Ok(CommandResult {
                exit_code,
                stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
                stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
                success: output.status.success(),
            })
        }
        Ok(Err(e)) => Err(AppError::Tool(format!("{program} 执行失败: {e}"))),
        Err(_) => Err(AppError::Tool(format!(
            "{program} 执行超时 (>{timeout_secs}s)"
        ))),
    }
}

/* ============================================================
 * DSML 标签生成（供 Agent 输出模板使用）
 *
 * 不直接执行任何 IO，仅生成标准化 XML 标签交给前端解析审批后回调 tools::*
 * ============================================================ */

/// 生成 read_file 的 DSML 标签。
pub fn dsml_read_file(path: &str) -> String {
    crate::dsml::build_read_file(path).to_xml()
}

/// 生成 write_file 的 DSML 标签。
pub fn dsml_write_file(path: &str, content: &str) -> String {
    crate::dsml::build_write_file(path, content).to_xml()
}

/// 生成 shell 的 DSML 标签。
pub fn dsml_shell(command: &str) -> String {
    crate::dsml::build_shell(command).to_xml()
}
