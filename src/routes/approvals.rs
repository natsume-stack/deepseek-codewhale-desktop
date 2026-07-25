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
pub async fn decide_approval(
    State(state): State<SharedState>,
    AxumPath(id): AxumPath<String>,
    Json(body): Json<DecideBody>,
) -> Result<Json<Value>, AppError> {
    let req = state
        .approvals
        .decide(&id, body.approved)
        .await
        .ok_or_else(|| AppError::BadRequest(format!("审批不存在: {id}")))?;
    tracing::info!("审批决定: id={}, approved={}", id, body.approved);
    Ok(Json(json!(req)))
}
