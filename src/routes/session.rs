//! 会话管理端点: 列表 / 创建 / 详情 / 删除 / 重置上下文。

use axum::extract::{Path, State};
use axum::Json;
use serde_json::{json, Value};

use crate::error::AppError;
use crate::state::SharedState;

pub async fn list_sessions(State(state): State<SharedState>) -> Json<Value> {
    let sessions = state.sessions.list().await;
    Json(json!({ "sessions": sessions, "count": sessions.len() }))
}

pub async fn create_session(State(state): State<SharedState>) -> Json<Value> {
    let project = state.project_root().await;
    let s = state.sessions.create(project).await;
    Json(json!(s))
}

pub async fn get_session(
    State(state): State<SharedState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, AppError> {
    let s = state
        .sessions
        .get(&id)
        .await
        .ok_or_else(|| AppError::SessionNotFound(id.clone()))?;
    Ok(Json(json!(s)))
}

pub async fn delete_session(
    State(state): State<SharedState>,
    Path(id): Path<String>,
) -> Json<Value> {
    let deleted = state.sessions.delete(&id).await;
    Json(json!({ "sessionId": id, "deleted": deleted }))
}

pub async fn reset_session(
    State(state): State<SharedState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, AppError> {
    state.sessions.reset(&id).await?;
    Ok(Json(json!({ "sessionId": id, "reset": true })))
}
