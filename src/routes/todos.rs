//! 代办任务路由层（P0-7）：列表 / 创建 / 查询 / 删除 / 状态更新 / 按会话列表。
//!
//! 所有端点直接操作 SharedState.todos（TodoStore），进程重启后数据丢失
//! （与 Diff 注册表语义一致）。

use axum::extract::{Path as AxumPath, State};
use axum::http::StatusCode;
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::error::AppError;
use crate::state::{SharedState, TodoStatus};

/// 创建代办请求体。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTodoBody {
    pub session_id: Option<String>,
    pub text: String,
    pub source: Option<String>,
}

/// 状态更新请求体（status 走 lowercase 序列化，与 TodoStatus 一致）。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TodoStatusBody {
    Pending,
    Running,
    Done,
}

#[derive(Debug, Deserialize)]
pub struct UpdateStatusBody {
    pub status: TodoStatusBody,
}

/// GET /api/todos → 列出全部代办（按创建时间升序）。
pub async fn list_todos(State(state): State<SharedState>) -> Json<Value> {
    let todos = state.todos.list().await;
    let total = todos.len();
    Json(json!({ "todos": todos, "total": total }))
}

/// POST /api/todos → 创建一条代办。
pub async fn create_todo(
    State(state): State<SharedState>,
    Json(body): Json<CreateTodoBody>,
) -> Result<(StatusCode, Json<Value>), AppError> {
    if body.text.trim().is_empty() {
        return Err(AppError::BadRequest("text 不能为空".into()));
    }
    let item = state
        .todos
        .add(body.session_id, body.text, body.source)
        .await;
    tracing::info!("创建代办: id={}, text={}", item.id, item.text);
    Ok((StatusCode::CREATED, Json(json!(item))))
}

/// GET /api/todos/:id → 查询单条代办。
pub async fn get_todo(
    State(state): State<SharedState>,
    AxumPath(id): AxumPath<String>,
) -> Result<Json<Value>, AppError> {
    let todos = state.todos.list().await;
    let item = todos
        .into_iter()
        .find(|t| t.id == id)
        .ok_or_else(|| AppError::BadRequest(format!("代办不存在: {id}")))?;
    Ok(Json(json!(item)))
}

/// DELETE /api/todos/:id → 删除单条代办。
pub async fn delete_todo(
    State(state): State<SharedState>,
    AxumPath(id): AxumPath<String>,
) -> Json<Value> {
    let deleted = state.todos.delete(&id).await;
    Json(json!({ "deleted": deleted }))
}

/// POST /api/todos/:id/status → 更新代办状态。
pub async fn update_todo_status(
    State(state): State<SharedState>,
    AxumPath(id): AxumPath<String>,
    Json(body): Json<UpdateStatusBody>,
) -> Result<Json<Value>, AppError> {
    let status = match body.status {
        TodoStatusBody::Pending => TodoStatus::Pending,
        TodoStatusBody::Running => TodoStatus::Running,
        TodoStatusBody::Done => TodoStatus::Done,
    };
    let item = state
        .todos
        .set_status(&id, status)
        .await
        .ok_or_else(|| AppError::BadRequest(format!("代办不存在: {id}")))?;
    Ok(Json(json!(item)))
}

/// GET /api/todos/session/:session_id → 列出指定会话的代办。
pub async fn list_session_todos(
    State(state): State<SharedState>,
    AxumPath(session_id): AxumPath<String>,
) -> Json<Value> {
    let todos = state.todos.list_by_session(&session_id).await;
    let total = todos.len();
    Json(json!({ "todos": todos, "total": total }))
}
