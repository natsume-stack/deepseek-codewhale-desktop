//! Agent 操作审批路由层（P0-8）：列表 / 待审 / 创建 / 查询 / 决定。
//!
//! ApprovalKind 在 state.rs 中仅有 Serialize（未派生 Deserialize），
//! 故本模块对 kind 字符串手动解析。序列化输出为 lowercase：
//! "filewrite" / "filedelete" / "shell" / "git"。

use axum::extract::{Path as AxumPath, State};
use axum::http::StatusCode;
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::error::AppError;
use crate::state::{ApprovalKind, SharedState};

/// 创建审批请求体。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateApprovalBody {
    /// 操作类型，对应 ApprovalKind 的 lowercase 序列化值。
    pub kind: String,
    pub description: String,
    pub detail: Option<String>,
    pub session_id: Option<String>,
}

/// 审批决定请求体。
#[derive(Debug, Deserialize)]
pub struct DecideBody {
    pub approved: bool,
}

/// 将字符串解析为 ApprovalKind（与 state.rs 中 serde lowercase 输出一致）。
fn parse_kind(s: &str) -> Result<ApprovalKind, AppError> {
    match s {
        "filewrite" => Ok(ApprovalKind::FileWrite),
        "filedelete" => Ok(ApprovalKind::FileDelete),
        "shell" => Ok(ApprovalKind::Shell),
        "git" => Ok(ApprovalKind::Git),
        _ => Err(AppError::BadRequest(format!("未知审批类型: {s}"))),
    }
}

/// GET /api/approvals → 列出全部审批请求（按创建时间降序）。
pub async fn list_approvals(State(state): State<SharedState>) -> Json<Value> {
    let approvals = state.approvals.list().await;
    let total = approvals.len();
    Json(json!({ "approvals": approvals, "total": total }))
}

/// GET /api/approvals/pending → 列出待审批请求。
pub async fn list_pending(State(state): State<SharedState>) -> Json<Value> {
    let approvals = state.approvals.list_pending().await;
    let total = approvals.len();
    Json(json!({ "approvals": approvals, "total": total }))
}

/// POST /api/approvals → 创建一条审批请求（状态初始化为 Pending）。
pub async fn create_approval(
    State(state): State<SharedState>,
    Json(body): Json<CreateApprovalBody>,
) -> Result<(StatusCode, Json<Value>), AppError> {
    if body.description.trim().is_empty() {
        return Err(AppError::BadRequest("description 不能为空".into()));
    }
    let kind = parse_kind(&body.kind)?;
    let req = state
        .approvals
        .create(kind, body.description, body.detail, body.session_id)
        .await;
    tracing::info!("创建审批: id={}, kind={:?}", req.id, req.kind);
    Ok((StatusCode::CREATED, Json(json!(req))))
}

/// GET /api/approvals/:id → 查询单条审批请求。
pub async fn get_approval(
    State(state): State<SharedState>,
    AxumPath(id): AxumPath<String>,
) -> Result<Json<Value>, AppError> {
    let req = state
        .approvals
        .get(&id)
        .await
        .ok_or_else(|| AppError::BadRequest(format!("审批不存在: {id}")))?;
    Ok(Json(json!(req)))
}

/// POST /api/approvals/:id/decide → 作出审批决定（批准/拒绝）。
///
/// 批准时若有 pending_action，自动回放执行：
///   - ApplyDiff：写盘指定文件内容，并标记对应 DiffEntry 为 Applied
///   - GitExec：调用 tools::git 执行 git 命令（如 commit / branch create）
///   - ShellExec：调用 tools::shell 执行 shell 命令
/// 失败仅记录到返回值的 executionError 字段，不影响审批状态。
pub async fn decide_approval(
    State(state): State<SharedState>,
    AxumPath(id): AxumPath<String>,
    Json(body): Json<DecideBody>,
) -> Result<Json<Value>, AppError> {
    let (req, action) = state
        .approvals
        .decide(&id, body.approved)
        .await
        .ok_or_else(|| AppError::BadRequest(format!("审批不存在: {id}")))?;
    tracing::info!("审批决定: id={}, approved={}", id, body.approved);

    // 拒绝：无需执行
    if !body.approved {
        return Ok(Json(json!({
            "approval": req,
            "executed": false,
        })));
    }

    // 批准：回放执行 pending_action
    let mut executed = false;
    let mut execution_error: Option<String> = None;
    let mut execution_result: Option<Value> = None;

    if let Some(action) = action {
        match action {
            crate::state::PendingAction::ApplyDiff { diff_id, file_path, content } => {
                // 确保父目录存在
                if let Some(p) = file_path.parent() {
                    if let Err(e) = std::fs::create_dir_all(p) {
                        execution_error = Some(format!("创建父目录失败: {e}"));
                    }
                }
                match std::fs::write(&file_path, &content) {
                    Ok(_) => {
                        // 标记对应 DiffEntry 为 Applied
                        if let Ok(mut map) = state.diffs.try_write() {
                            for entries in map.values_mut() {
                                if let Some(e) = entries.iter_mut().find(|e| e.id == diff_id) {
                                    e.status = crate::routes::diffs::DiffStatus::Applied;
                                    break;
                                }
                            }
                        }
                        executed = true;
                        tracing::info!("审批回放 ApplyDiff: diff_id={}, file={}", diff_id, file_path.display());
                    }
                    Err(e) => {
                        execution_error = Some(format!("写盘失败: {e}"));
                    }
                }
            }
            crate::state::PendingAction::GitExec { args } => {
                let root = state.project_root().await;
                if let Some(root) = root {
                    // 回放时强制使用 FullAccess（用户已审批通过）
                    match crate::tools::git(&root, args.clone(), crate::config::PermissionLevel::FullAccess).await {
                        Ok(r) => {
                            executed = r.success;
                            execution_result = Some(json!({
                                "stdout": r.stdout,
                                "stderr": r.stderr,
                                "exitCode": r.exit_code,
                                "success": r.success,
                            }));
                            if !r.success {
                                execution_error = Some(format!("Git 命令退出码 {}", r.exit_code));
                            }
                            tracing::info!("审批回放 GitExec: args={:?}", args);
                        }
                        Err(e) => {
                            execution_error = Some(format!("Git 执行失败: {e}"));
                        }
                    }
                } else {
                    execution_error = Some("未加载项目目录".into());
                }
            }
            crate::state::PendingAction::ShellExec { program, args, cwd } => {
                // tools::shell 签名：(root, command, timeout_secs, permission)
                // args 用空格拼接为单条命令字符串（与 sandbox 行为一致）
                let full_cmd = if args.is_empty() {
                    program.clone()
                } else {
                    format!("{} {}", program, args.join(" "))
                };
                match crate::tools::shell(&cwd, full_cmd, 120, crate::config::PermissionLevel::FullAccess).await {
                    Ok(r) => {
                        executed = r.success;
                        execution_result = Some(json!({
                            "stdout": r.stdout,
                            "stderr": r.stderr,
                            "exitCode": r.exit_code,
                            "success": r.success,
                        }));
                        if !r.success {
                            execution_error = Some(format!("Shell 退出码 {}", r.exit_code));
                        }
                        tracing::info!("审批回放 ShellExec: program={}, args={:?}", program, args);
                    }
                    Err(e) => {
                        execution_error = Some(format!("Shell 执行失败: {e}"));
                    }
                }
            }
        }
    }

    Ok(Json(json!({
        "approval": req,
        "executed": executed,
        "executionError": execution_error,
        "executionResult": execution_result,
    })))
}
