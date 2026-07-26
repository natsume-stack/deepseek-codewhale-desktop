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
    // 权限检查：
    //   - ReadOnly 允许只读子命令（status / log / diff / branch -v / show / rev-parse / ls-files）
    //   - 写操作子命令（commit / push / pull / merge / rebase / checkout / reset）需 can_shell
    if !permission.can_shell() && !is_readonly_git_args(&args) {
        return Err(AppError::Forbidden(
            "当前权限等级禁止执行 Git 写操作".into(),
        ));
    }
    run_command("git", args, root, 60).await
}

/// 判断 git 子命令是否为只读（ReadOnly 权限也允许）
fn is_readonly_git_args(args: &[String]) -> bool {
    let first = match args.first().map(|s| s.as_str()) {
        Some(s) => s,
        None => return false,
    };
    matches!(
        first,
        "status"
            | "log"
            | "diff"
            | "show"
            | "rev-parse"
            | "ls-files"
            | "ls-tree"
            | "branch"
            | "blame"
            | "shortlog"
            | "describe"
            | "name-rev"
            | "reflog"
    ) && !args.iter().any(|a| {
        // branch 子命令带 -d / -D / -m 等写操作参数时不算只读
        matches!(
            a.as_str(),
            "-d" | "-D" | "-m" | "-M" | "--delete" | "--move"
        )
    })
}

/// 只读 git（强制只读子命令，权限不足时也允许，用于 Agent Loop 中的环境感知）
pub async fn git_readonly(root: &Path, args: Vec<String>) -> AppResult<CommandResult> {
    if !is_readonly_git_args(&args) {
        return Err(AppError::BadRequest(format!(
            "git_readonly 仅允许只读子命令，收到: {:?}",
            args.first()
        )));
    }
    run_command("git", args, root, 60).await
}

/// 列出目录内容（只读，权限不限）
pub async fn list_files(root: &Path, rel: &str) -> AppResult<serde_json::Value> {
    let target = resolve(root, rel)?;
    if !target.exists() {
        return Err(AppError::BadRequest(format!(
            "路径不存在: {}",
            target.display()
        )));
    }
    if !target.is_dir() {
        return Err(AppError::BadRequest(format!(
            "不是目录: {}",
            target.display()
        )));
    }
    let mut entries: Vec<serde_json::Value> = Vec::new();
    let mut rd = tokio::fs::read_dir(&target)
        .await
        .map_err(|e| AppError::BadRequest(format!("读取目录失败: {e}")))?;
    while let Some(entry) = rd
        .next_entry()
        .await
        .map_err(|e| AppError::BadRequest(format!("读取条目失败: {e}")))?
    {
        let name = entry.file_name().to_string_lossy().to_string();
        // 过滤忽略目录
        if matches!(
            name.as_str(),
            "node_modules"
                | "target"
                | "build"
                | ".git"
                | "dist"
                | ".next"
                | "__pycache__"
                | ".venv"
        ) {
            continue;
        }
        let ft = entry
            .file_type()
            .await
            .map_err(|e| AppError::BadRequest(format!("读取类型失败: {e}")))?;
        let metadata = entry.metadata().await.ok();
        let size = metadata.as_ref().map(|m| m.len()).unwrap_or(0);
        entries.push(serde_json::json!({
            "name": name,
            "isDir": ft.is_dir(),
            "isFile": ft.is_file(),
            "size": size,
        }));
    }
    // 目录优先在前，文件在后，各自按名称排序
    entries.sort_by(|a, b| {
        let a_dir = a["isDir"].as_bool().unwrap_or(false);
        let b_dir = b["isDir"].as_bool().unwrap_or(false);
        match (a_dir, b_dir) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => {
                let an = a["name"].as_str().unwrap_or("");
                let bn = b["name"].as_str().unwrap_or("");
                an.cmp(bn)
            }
        }
    });
    Ok(serde_json::json!({
        "path": rel,
        "entries": entries,
        "total": entries.len(),
    }))
}

/// 正则搜索文件内容（只读，权限不限）。返回匹配的文件+行号+内容。
pub async fn search_files(
    root: &Path,
    regex: &str,
    rel: &str,
    max_results: usize,
) -> AppResult<serde_json::Value> {
    let target = resolve(root, rel)?;
    let re = regex::Regex::new(regex)
        .map_err(|e| AppError::BadRequest(format!("正则表达式无效: {e}")))?;
    let mut matches: Vec<serde_json::Value> = Vec::new();
    walk_and_search(&target, &re, max_results, &mut matches).await?;
    Ok(serde_json::json!({
        "regex": regex,
        "path": rel,
        "matches": matches,
        "total": matches.len(),
    }))
}

/// 增量编辑文件（SEARCH/REPLACE 块，参考 Aider search-replace 算法）。
///
/// 输入一组 (search, replace) 对，在原文件内容中查找 search 块并替换为 replace 块。
/// 所有 search 必须唯一匹配且存在，否则返回错误不写入任何变更。
///
/// 相比 write_file 整文件重写：
///   - 节省 70%+ token（只传输变更区块）
///   - 更精确，避免无关代码被意外改动
///   - 自带冲突检测，search 不唯一或不存在时报错
pub async fn edit_file(
    root: &Path,
    rel: &str,
    edits: &[EditBlock],
    permission: PermissionLevel,
) -> AppResult<FileWriteResult> {
    if !permission.can_write() {
        return Err(AppError::Forbidden("当前权限等级禁止写文件".into()));
    }
    if rel.trim().is_empty() {
        return Err(AppError::BadRequest("编辑路径不能为空".into()));
    }
    if edits.is_empty() {
        return Err(AppError::BadRequest("edits 不能为空".into()));
    }
    let target = root.join(rel);
    if !target.exists() {
        return Err(AppError::BadRequest(format!(
            "目标文件不存在: {}（edit_file 仅支持编辑已有文件，新文件请用 write_file）",
            target.display()
        )));
    }
    // 读取原内容
    let original = tokio::fs::read_to_string(&target)
        .await
        .map_err(|e| AppError::BadRequest(format!("读取原文件失败: {e}")))?;

    // 顺序应用所有 edit blocks
    let mut current = original.clone();
    for (i, edit) in edits.iter().enumerate() {
        current = apply_search_replace(&current, &edit.search, &edit.replace, i)?;
    }

    // 校验父目录在项目根内
    let parent = target.parent().unwrap_or(root);
    ensure_within(root, parent)?;
    tokio::fs::write(&target, current.as_bytes()).await?;
    Ok(FileWriteResult {
        path: rel.to_string(),
        bytes: current.as_bytes().len(),
        created: false,
    })
}

/// 单个 SEARCH/REPLACE 编辑块。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct EditBlock {
    /// 要查找的原文（必须唯一匹配）。前后空白会被 trim 后比较。
    pub search: String,
    /// 替换为的新内容。
    pub replace: String,
}

/// 应用单个 search → replace 替换。
///
/// 匹配策略（参考 Aider）：
///   1. 精确匹配（trim 前后空白后整体匹配）
///   2. 若精确匹配出现多次 → 报错"不唯一"
///   3. 若精确匹配 0 次 → 尝试行级模糊匹配（忽略首尾空白行）
///   4. 仍 0 次 → 报错"未找到"
fn apply_search_replace(
    content: &str,
    search: &str,
    replace: &str,
    idx: usize,
) -> AppResult<String> {
    let search_trimmed = search.trim();
    let replace_trimmed = replace.trim();

    if search_trimmed.is_empty() {
        return Err(AppError::BadRequest(format!(
            "edit #{} 的 search 块为空",
            idx + 1
        )));
    }

    // 策略 1：精确匹配
    let exact_count = content.matches(search_trimmed).count();
    if exact_count == 1 {
        return Ok(content.replacen(search_trimmed, replace_trimmed, 1));
    }
    if exact_count > 1 {
        return Err(AppError::BadRequest(format!(
            "edit #{} 的 search 块在文件中出现 {} 次，必须唯一。请补充更多上下文行使其唯一",
            idx + 1,
            exact_count
        )));
    }

    // 策略 2：行级匹配（按行 trim 后比较，忽略空白差异）
    let search_lines: Vec<&str> = search_trimmed.lines().collect();
    if search_lines.is_empty() {
        return Err(AppError::BadRequest(format!(
            "edit #{} 的 search 块无有效行",
            idx + 1
        )));
    }
    let content_lines: Vec<&str> = content.lines().collect();
    let match_idx = find_line_range(&content_lines, &search_lines);
    if let Some(start) = match_idx {
        let end = start + search_lines.len();
        let mut new_lines: Vec<String> = content_lines[..start]
            .iter()
            .map(|s| s.to_string())
            .collect();
        new_lines.extend(replace_trimmed.lines().map(|s| s.to_string()));
        new_lines.extend(content_lines[end..].iter().map(|s| s.to_string()));
        return Ok(new_lines.join("\n"));
    }

    Err(AppError::BadRequest(format!(
        "edit #{} 的 search 块在文件中未找到匹配。请检查缩进/空白/换行是否与原文件一致",
        idx + 1
    )))
}

/// 在 content_lines 中查找首个与 search_lines（行级 trim 比较）匹配的起始位置。
fn find_line_range(content_lines: &[&str], search_lines: &[&str]) -> Option<usize> {
    if search_lines.is_empty() || search_lines.len() > content_lines.len() {
        return None;
    }
    let search_trimmed: Vec<String> = search_lines.iter().map(|s| s.trim().to_string()).collect();
    'outer: for start in 0..=(content_lines.len() - search_trimmed.len()) {
        for (i, sl) in search_trimmed.iter().enumerate() {
            if content_lines[start + i].trim() != *sl {
                continue 'outer;
            }
        }
        return Some(start);
    }
    None
}

async fn walk_and_search(
    dir: &Path,
    re: &regex::Regex,
    max: usize,
    out: &mut Vec<serde_json::Value>,
) -> AppResult<()> {
    if out.len() >= max {
        return Ok(());
    }
    let mut rd = tokio::fs::read_dir(dir)
        .await
        .map_err(|e| AppError::BadRequest(format!("读取目录失败: {e}")))?;
    while let Some(entry) = rd
        .next_entry()
        .await
        .map_err(|e| AppError::BadRequest(format!("读取条目失败: {e}")))?
    {
        if out.len() >= max {
            return Ok(());
        }
        let name = entry.file_name().to_string_lossy().to_string();
        // 过滤忽略目录
        if matches!(
            name.as_str(),
            "node_modules"
                | "target"
                | "build"
                | ".git"
                | "dist"
                | ".next"
                | "__pycache__"
                | ".venv"
        ) {
            continue;
        }
        let ft = entry
            .file_type()
            .await
            .map_err(|e| AppError::BadRequest(format!("读取类型失败: {e}")))?;
        if ft.is_dir() {
            Box::pin(walk_and_search(&entry.path(), re, max, out)).await?;
        } else if ft.is_file() {
            // 跳过二进制文件（粗略判断扩展名）
            let ext_ok = entry
                .path()
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| {
                    matches!(
                        e,
                        "rs" | "ts"
                            | "tsx"
                            | "js"
                            | "jsx"
                            | "py"
                            | "go"
                            | "java"
                            | "md"
                            | "toml"
                            | "json"
                            | "yaml"
                            | "yml"
                            | "sh"
                            | "css"
                            | "html"
                    )
                })
                .unwrap_or(false);
            if !ext_ok {
                continue;
            }
            if let Ok(content) = tokio::fs::read_to_string(entry.path()).await {
                for (line_no, line) in content.lines().enumerate() {
                    if re.is_match(line) {
                        out.push(serde_json::json!({
                            "file": entry.path().strip_prefix(dir.parent().unwrap_or(dir)).unwrap_or(&entry.path()).display().to_string(),
                            "line": line_no + 1,
                            "content": line,
                        }));
                        if out.len() >= max {
                            return Ok(());
                        }
                    }
                }
            }
        }
    }
    Ok(())
}

/// 危险命令黑名单（标准化后小写匹配）。
///
/// 命中任一即拒绝执行。黑名单为硬保护，FullAccess 模式下同样生效，
/// 无法被权限等级绕过。匹配在标准化（小写 + 折叠空白为单空格）后的
/// 完整命令字符串上进行子串匹配，可拦截 `rm -rf /`、`mkfs`、`format` 等。
const DANGEROUS_PATTERNS: &[&str] = &[
    "rm -rf /",
    "rm -rf ~",
    "rm -rf $home",
    "rm -rf /*",
    "mkfs",
    "dd if=",
    "del /f /s /q",
    "shutdown",
    "reboot",
    "chmod -r 777 /",
    // Windows format 命令需带参数（format + 空格），避免误伤 git format-patch
    "format ",
];

/// 去全部空白后匹配的危险子串（兼容空格/换行绕过变体）。
///
/// 用于 fork bomb（`:(){ :|:& };:`）与裸重定向（`>/dev/sda`）等
/// 对空白不敏感的危险模式。
const DANGEROUS_PATTERNS_NO_SPACE: &[&str] = &[
    ":(){:|:&};:", // fork bomb 规范形
    ":|:&",        // fork bomb 核心，兼容带空格变体
    ">/dev/sd",    // 直写块设备（> /dev/sda、>/dev/sdb 等）
];

/// 判断命令是否命中危险黑名单。
///
/// 标准化策略：
/// 1. `collapsed`：小写 + 折叠连续空白为单空格（拦截 `rm  -rf  /`）
/// 2. `no_space`：小写 + 去除全部空白（拦截 `:(){ :|:& };:`、`> /dev/sda`）
fn is_dangerous_command(command: &str) -> bool {
    let collapsed: String = command
        .trim()
        .to_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let no_space: String = command
        .trim()
        .to_lowercase()
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect();
    DANGEROUS_PATTERNS.iter().any(|p| collapsed.contains(p))
        || DANGEROUS_PATTERNS_NO_SPACE
            .iter()
            .any(|p| no_space.contains(p))
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
    // 危险命令黑名单（硬保护）：即便 FullAccess 也强制拦截，不可绕过
    if is_dangerous_command(&command) {
        return Err(AppError::Forbidden(
            "命令命中危险黑名单，已被拦截（rm -rf /、mkfs、fork bomb、format 等）".into(),
        ));
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
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let child = cmd
        .spawn()
        .map_err(|e| AppError::Tool(format!("启动 {program} 失败: {e}")))?;

    let result =
        tokio::time::timeout(Duration::from_secs(timeout_secs), child.wait_with_output()).await;
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
