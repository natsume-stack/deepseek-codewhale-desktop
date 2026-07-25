//! 内置工具端点: 文件读 / 文件写 / Git / Shell。
//! 所有工具均要求先加载项目目录 (GET /api/project.loaded == true)。
//!
//! P0-8 集成：写操作 / Shell 执行前先进行权限检查与审批流程。
//! - 权限不足直接返回 403 Forbidden
//! - 审批模式开启时返回 202 Accepted + 审批 ID，不立即执行工具

use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::PathBuf;

use crate::error::AppError;
use crate::state::{ApprovalKind, SharedState};
use crate::tools;

async fn require_root(state: &SharedState) -> Result<PathBuf, AppError> {
    state.project_root().await.ok_or_else(|| {
        AppError::BadRequest("未加载项目目录, 请先调用 POST /api/project/load".into())
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileReadBody {
    pub path: String,
}

pub async fn read_file_handler(
    State(state): State<SharedState>,
    Json(body): Json<FileReadBody>,
) -> Result<Json<Value>, AppError> {
    let root = require_root(&state).await?;
    // 读文件不限制权限等级
    let res = tools::read_file(&root, &body.path).await?;
    Ok(Json(json!(res)))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileWriteBody {
    pub path: String,
    pub content: String,
    pub create_dirs: Option<bool>,
}

pub async fn write_file_handler(
    State(state): State<SharedState>,
    Json(body): Json<FileWriteBody>,
) -> Result<(StatusCode, Json<Value>), AppError> {
    let root = require_root(&state).await?;
    let cfg = state.permission_config().await;

    // 权限检查：ReadOnly 禁止写文件
    if !cfg.level.can_write() {
        return Err(AppError::Forbidden("当前权限等级禁止写文件".into()));
    }

    // 审批模式：创建审批请求，不立即执行
    if cfg.approval_on_write {
        let approval = state
            .approvals
            .create(
                ApprovalKind::FileWrite,
                format!("写入文件: {}", body.path),
                Some(body.content.clone()),
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

    let res = tools::write_file(
        &root,
        &body.path,
        &body.content,
        body.create_dirs.unwrap_or(false),
        cfg.level,
    )
    .await?;
    Ok((StatusCode::OK, Json(json!(res))))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBody {
    pub args: Vec<String>,
}

pub async fn git_handler(
    State(state): State<SharedState>,
    Json(body): Json<GitBody>,
) -> Result<(StatusCode, Json<Value>), AppError> {
    let root = require_root(&state).await?;
    let cfg = state.permission_config().await;

    // 权限检查：Git 视为 Shell 类，需 can_shell
    if !cfg.level.can_shell() {
        return Err(AppError::Forbidden("当前权限等级禁止执行 Git".into()));
    }

    // 审批模式：创建审批请求，不立即执行
    if cfg.approval_on_shell {
        let approval = state
            .approvals
            .create(
                ApprovalKind::Git,
                format!("Git: {}", body.args.join(" ")),
                None,
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

    let res = tools::git(&root, body.args, cfg.level).await?;
    Ok((StatusCode::OK, Json(json!(res))))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellBody {
    pub command: String,
    pub timeout_secs: Option<u64>,
}

pub async fn shell_handler(
    State(state): State<SharedState>,
    Json(body): Json<ShellBody>,
) -> Result<(StatusCode, Json<Value>), AppError> {
    let root = require_root(&state).await?;
    let cfg = state.permission_config().await;

    // 权限检查：仅 FullAccess 允许执行 Shell
    if !cfg.level.can_shell() {
        return Err(AppError::Forbidden("当前权限等级禁止执行 Shell".into()));
    }

    // 审批模式：创建审批请求，不立即执行
    if cfg.approval_on_shell {
        let approval = state
            .approvals
            .create(
                ApprovalKind::Shell,
                format!("Shell: {}", body.command),
                Some(body.command.clone()),
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

    let res = tools::shell(
        &root,
        body.command,
        body.timeout_secs.unwrap_or(60),
        cfg.level,
    )
    .await?;
    Ok((StatusCode::OK, Json(json!(res))))
}
