//! 代码沙箱执行: Rust/Go/Python/TypeScript/Shell 多语言运行。
//!
//! 参考 DeepSeekAgents: 写入临时文件 → 调用编译器/解释器 → 收集输出。
//! 所有命令执行走 tools::shell（复用 CREATE_NO_WINDOW 隐藏控制台）。
//!
//! 权限要求: FullAccess (can_shell)；approval_on_shell=true 时创建审批请求。
//! 临时文件通过 RAII（TempWorkspace::drop）确保执行后删除。

use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use tokio_util::sync::CancellationToken;

use crate::config::{PermissionLevel, ReasoningEffort};
use crate::deepseek::{ChatMessage, ChatRequest};
use crate::error::AppError;
use crate::state::{ApprovalKind, SharedState};
use crate::tools;

/* ============================================================
 * 请求 / 响应结构
 * ============================================================ */

/// 沙箱执行请求
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxExecBody {
    /// "rust"|"go"|"python"|"typescript"|"shell"
    pub language: String,
    pub code: String,
    /// 输入 stdin
    pub stdin: Option<String>,
    /// 超时秒数（默认 30）
    #[serde(default = "default_timeout")]
    pub timeout_secs: Option<u64>,
    /// 是否自动生成修复 Diff（执行失败时）
    pub auto_fix: Option<bool>,
}

fn default_timeout() -> Option<u64> {
    Some(30)
}

/// 沙箱执行结果
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxResult {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
    pub success: bool,
    pub duration_ms: u64,
    /// 自动修复建议（auto_fix=true 且执行失败时）
    pub fix_suggestion: Option<String>,
    pub fix_diff: Option<String>,
}

/// 格式化请求体
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FormatBody {
    pub language: String,
    pub code: String,
}

/* ============================================================
 * HTTP 处理器
 * ============================================================ */

/// POST /api/sandbox/exec - 执行代码
pub async fn exec(
    State(state): State<SharedState>,
    Json(body): Json<SandboxExecBody>,
) -> Result<(StatusCode, Json<Value>), AppError> {
    // 校验语言
    let lang = normalize_language(&body.language)?;

    // 权限校验：必须 FullAccess (can_shell)
    let cfg = state.permission_config().await;
    if !cfg.level.can_shell() {
        return Err(AppError::Forbidden(
            "沙箱执行需要 FullAccess 权限 (can_shell)".into(),
        ));
    }

    // 审批模式：创建审批请求，不立即执行
    if cfg.approval_on_shell {
        let approval = state
            .approvals
            .create(
                ApprovalKind::Shell,
                format!("Sandbox[{}]: {}", lang, truncate(&body.code, 200)),
                Some(body.code.clone()),
                None,
            )
            .await;
        return Ok((
            StatusCode::ACCEPTED,
            Json(json!({
                "approvalId": approval.id,
                "pending": true,
                "message": "等待用户审批",
            })),
        ));
    }

    // 执行
    let timeout = body.timeout_secs.unwrap_or(30).clamp(1, 300);
    let root = state
        .project_root()
        .await
        .unwrap_or_else(std::env::temp_dir);
    let started = std::time::Instant::now();
    let result = run_language(&lang, &body.code, body.stdin.as_deref(), timeout, &root).await?;
    let mut sandbox = SandboxResult {
        exit_code: result.exit_code,
        stdout: result.stdout,
        stderr: result.stderr,
        success: result.success,
        duration_ms: started.elapsed().as_millis() as u64,
        fix_suggestion: None,
        fix_diff: None,
    };

    // 自动修复：执行失败时调用 DeepSeek 分析
    if body.auto_fix.unwrap_or(false) && !sandbox.success {
        let ds_cfg = state.deepseek_config().await;
        if !ds_cfg.api_key.trim().is_empty() {
            let error_text = format!(
                "exit_code={}\nstdout={}\nstderr={}",
                sandbox.exit_code, sandbox.stdout, sandbox.stderr
            );
            sandbox.fix_suggestion = generate_fix_suggestion(
                &state.client,
                &ds_cfg,
                &lang,
                &body.code,
                &error_text,
            )
            .await;
        }
    }

    Ok((StatusCode::OK, Json(json!(sandbox))))
}

/// GET /api/sandbox/languages - 支持的语言列表
pub async fn list_languages() -> Json<Value> {
    Json(json!({
        "languages": [
            { "id": "rust", "name": "Rust", "extension": "rs", "runner": "rustc" },
            { "id": "go", "name": "Go", "extension": "go", "runner": "go run" },
            { "id": "python", "name": "Python", "extension": "py", "runner": "python" },
            { "id": "typescript", "name": "TypeScript", "extension": "ts", "runner": "npx tsx" },
            { "id": "shell", "name": "Shell", "extension": "sh", "runner": "cmd/sh" }
        ]
    }))
}

/// POST /api/sandbox/format - 代码格式化
///
/// 调用 rustfmt/gofmt/black/prettier；失败则返回原代码。
pub async fn format_code(Json(body): Json<FormatBody>) -> Result<Json<Value>, AppError> {
    let lang = normalize_language(&body.language)?;
    let root = std::env::temp_dir();
    let formatted = format_language(&lang, &body.code, &root).await?;
    Ok(Json(json!({
        "language": lang,
        "formatted": formatted.formatted,
        "code": formatted.code,
        "success": formatted.success,
        "stderr": formatted.stderr,
    })))
}

/* ============================================================
 * 内部实现
 * ============================================================ */

/// 规范化语言名。
fn normalize_language(s: &str) -> Result<String, AppError> {
    let lower = s.trim().to_lowercase();
    match lower.as_str() {
        "rust" | "rs" => Ok("rust".into()),
        "go" | "golang" => Ok("go".into()),
        "python" | "py" => Ok("python".into()),
        "typescript" | "ts" => Ok("typescript".into()),
        "shell" | "sh" | "bash" => Ok("shell".into()),
        _ => Err(AppError::BadRequest(format!("不支持的语言: {s}"))),
    }
}

/// 临时工作目录（RAII 删除）。
///
/// Drop 时递归删除整个目录，确保临时文件不残留。
struct TempWorkspace {
    dir: PathBuf,
}

impl TempWorkspace {
    fn new(prefix: &str) -> Result<Self, AppError> {
        let dir = std::env::temp_dir()
            .join(format!("{}_{}", prefix, uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir)
            .map_err(|e| AppError::Tool(format!("创建临时目录失败: {e}")))?;
        Ok(Self { dir })
    }

    /// 在工作目录下写入文件，返回绝对路径。
    fn write(&self, name: &str, content: &str) -> Result<PathBuf, AppError> {
        let path = self.dir.join(name);
        std::fs::write(&path, content)
            .map_err(|e| AppError::Tool(format!("写入临时文件失败: {e}")))?;
        Ok(path)
    }
}

impl Drop for TempWorkspace {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// 按语言执行代码。
async fn run_language(
    lang: &str,
    code: &str,
    stdin: Option<&str>,
    timeout: u64,
    root: &Path,
) -> Result<tools::CommandResult, AppError> {
    let ws = TempWorkspace::new("codewhale_sandbox")?;
    match lang {
        "rust" => run_rust(&ws, code, stdin, timeout, root).await,
        "go" => run_go(&ws, code, stdin, timeout, root).await,
        "python" => run_python(&ws, code, stdin, timeout, root).await,
        "typescript" => run_typescript(&ws, code, stdin, timeout, root).await,
        "shell" => run_shell(&ws, code, stdin, timeout, root).await,
        _ => Err(AppError::BadRequest(format!("不支持的语言: {lang}"))),
    }
}

/// 构造 stdin 重定向片段（Windows cmd / Unix sh 均支持 `<` 重定向）。
fn stdin_redirect(stdin_file: &Path) -> String {
    format!(" < \"{}\"", stdin_file.display())
}

/// 写入 stdin 文件并返回重定向片段。
fn prepare_stdin(ws: &TempWorkspace, stdin: Option<&str>) -> Result<String, AppError> {
    match stdin {
        None | Some("") => Ok(String::new()),
        Some(content) => {
            let path = ws.write("stdin.txt", content)?;
            Ok(stdin_redirect(&path))
        }
    }
}

/// Rust: 写入 main.rs → rustc 编译 → 运行（无 cargo 依赖管理）。
async fn run_rust(
    ws: &TempWorkspace,
    code: &str,
    stdin: Option<&str>,
    timeout: u64,
    root: &Path,
) -> Result<tools::CommandResult, AppError> {
    let src = ws.write("main.rs", code)?;
    #[cfg(windows)]
    let exe = ws.dir.join("main.exe");
    #[cfg(not(windows))]
    let exe = ws.dir.join("main");

    // 编译
    let compile_cmd = format!(
        "rustc --edition 2021 \"{}\" -o \"{}\"",
        src.display(),
        exe.display()
    );
    let compile = tools::shell(root, compile_cmd, timeout, PermissionLevel::FullAccess).await?;
    if !compile.success {
        return Ok(compile);
    }

    // 运行
    let stdin_redir = prepare_stdin(ws, stdin)?;
    let run_cmd = format!("\"{}\"{}", exe.display(), stdin_redir);
    tools::shell(root, run_cmd, timeout, PermissionLevel::FullAccess).await
}

/// Go: 写入 main.go → go run。
async fn run_go(
    ws: &TempWorkspace,
    code: &str,
    stdin: Option<&str>,
    timeout: u64,
    root: &Path,
) -> Result<tools::CommandResult, AppError> {
    let src = ws.write("main.go", code)?;
    let stdin_redir = prepare_stdin(ws, stdin)?;
    let cmd = format!("go run \"{}\"{}", src.display(), stdin_redir);
    tools::shell(root, cmd, timeout, PermissionLevel::FullAccess).await
}

/// Python: 写入 .py → python。
async fn run_python(
    ws: &TempWorkspace,
    code: &str,
    stdin: Option<&str>,
    timeout: u64,
    root: &Path,
) -> Result<tools::CommandResult, AppError> {
    let src = ws.write("script.py", code)?;
    let stdin_redir = prepare_stdin(ws, stdin)?;
    let cmd = format!("python \"{}\"{}", src.display(), stdin_redir);
    tools::shell(root, cmd, timeout, PermissionLevel::FullAccess).await
}

/// TypeScript: 写入 .ts → npx tsx（失败回退提示）。
async fn run_typescript(
    ws: &TempWorkspace,
    code: &str,
    stdin: Option<&str>,
    timeout: u64,
    root: &Path,
) -> Result<tools::CommandResult, AppError> {
    let src = ws.write("script.ts", code)?;
    let stdin_redir = prepare_stdin(ws, stdin)?;
    // 优先 npx tsx（直接执行 TS，无需预编译）
    let cmd = format!("npx --yes tsx \"{}\"{}", src.display(), stdin_redir);
    tools::shell(root, cmd, timeout, PermissionLevel::FullAccess).await
}

/// Shell: 直接调用 cmd /C 或 sh -c（tools::shell 内部处理）。
async fn run_shell(
    ws: &TempWorkspace,
    code: &str,
    stdin: Option<&str>,
    timeout: u64,
    root: &Path,
) -> Result<tools::CommandResult, AppError> {
    let stdin_redir = prepare_stdin(ws, stdin)?;
    let cmd = format!("{}{}", code, stdin_redir);
    tools::shell(root, cmd, timeout, PermissionLevel::FullAccess).await
}

/* ============================================================
 * 代码格式化
 * ============================================================ */

/// 格式化结果。
struct FormatResult {
    formatted: bool,
    code: String,
    success: bool,
    stderr: String,
}

/// 按语言调用格式化工具。
///
/// - rust → rustfmt
/// - go → gofmt
/// - python → black
/// - typescript → prettier
/// - shell → 不支持，返回原代码
///
/// 失败则返回原代码。
async fn format_language(lang: &str, code: &str, root: &Path) -> Result<FormatResult, AppError> {
    let ws = TempWorkspace::new("codewhale_fmt")?;

    let file_name: &str = match lang {
        "rust" => "main.rs",
        "go" => "main.go",
        "python" => "script.py",
        "typescript" => "script.ts",
        "shell" => {
            return Ok(FormatResult {
                formatted: false,
                code: code.to_string(),
                success: true,
                stderr: "shell 不支持格式化".into(),
            });
        }
        _ => return Err(AppError::BadRequest(format!("不支持的语言: {lang}"))),
    };

    let path = ws.write(file_name, code)?;
    let cmd = match lang {
        "rust" => format!("rustfmt --edition 2021 \"{}\"", path.display()),
        "go" => format!("gofmt -w \"{}\"", path.display()),
        "python" => format!("black \"{}\"", path.display()),
        "typescript" => format!("prettier --write \"{}\"", path.display()),
        _ => unreachable!(),
    };

    let res = tools::shell(root, cmd, 30, PermissionLevel::FullAccess).await?;

    if res.success {
        // 读取格式化后的文件
        let formatted = std::fs::read_to_string(&path).unwrap_or_else(|_| code.to_string());
        Ok(FormatResult {
            formatted: formatted != code,
            code: formatted,
            success: true,
            stderr: res.stderr,
        })
    } else {
        // 格式化失败，返回原代码
        Ok(FormatResult {
            formatted: false,
            code: code.to_string(),
            success: false,
            stderr: res.stderr,
        })
    }
}

/* ============================================================
 * 自动修复
 * ============================================================ */

/// 调用 DeepSeek 生成修复建议（消费流式响应，累积 content）。
///
/// 简化实现：仅返回 fix_suggestion 文本，不实际生成 Diff。
async fn generate_fix_suggestion(
    client: &crate::deepseek::DeepSeekClient,
    cfg: &crate::config::DeepSeekConfig,
    lang: &str,
    code: &str,
    error: &str,
) -> Option<String> {
    let prompt = format!(
        "以下是 {lang} 代码执行失败的错误信息。请分析错误原因并给出简洁的修复建议（仅文本说明，不需要重新输出完整代码）：\n\n\
         【代码】\n{code}\n\n\
         【错误输出】\n{error}\n\n\
         修复建议："
    );
    let req = ChatRequest {
        model: cfg.model.clone(),
        messages: vec![
            ChatMessage::system("你是代码修复助手。分析错误并给出简洁的修复建议。"),
            ChatMessage::user(prompt),
        ],
        reasoning_effort: ReasoningEffort::Medium,
        enable_cache: false,
        max_tokens: Some(800),
        temperature: Some(0.3),
    };
    let cancel = CancellationToken::new();
    let mut rx = client.chat_stream(req, cfg, cancel).await.ok()?;
    let mut content = String::new();
    while let Some(item) = rx.recv().await {
        match item {
            Ok(delta) => {
                if let Some(c) = delta.content {
                    content.push_str(&c);
                }
            }
            Err(_) => break,
        }
    }
    if content.trim().is_empty() {
        None
    } else {
        Some(content)
    }
}

/* ============================================================
 * 工具函数
 * ============================================================ */

/// 截断字符串用于审批描述。
fn truncate(s: &str, max: usize) -> String {
    let count = s.chars().count();
    if count <= max {
        s.to_string()
    } else {
        let truncated: String = s.chars().take(max).collect();
        format!("{truncated}...")
    }
}
