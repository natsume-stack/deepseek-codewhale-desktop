//! Agent REST API 路由层 (P0 自治 Agent)。
//!
//! 端点:
//!   POST   /api/agent/tasks              创建任务
//!   GET    /api/agent/tasks              列出任务 (可选 ?session_id= 过滤)
//!   GET    /api/agent/tasks/:id          查询任务详情 (含 history)
//!   POST   /api/agent/tasks/:id/start    启动任务
//!   POST   /api/agent/tasks/:id/pause    暂停任务
//!   POST   /api/agent/tasks/:id/resume   恢复任务
//!   POST   /api/agent/tasks/:id/stop     终止任务
//!   GET    /api/agent/tasks/:id/stream   SSE 事件流 (转发 AgentEvent)
//!   GET    /api/agent/tools              列出已注册工具
//!   GET    /api/agent/mode               读取全局默认模式
//!   PUT    /api/agent/mode               设置全局默认模式
//!
//! SSE 事件格式 (与 chat.rs 风格一致):
//!   event: task_state    data: {"state":"acting","iteration":3}
//!   event: thought       data: {"content":"..."}
//!   event: tool_call     data: {...}
//!   event: tool_result   data: {...}
//!   event: reflection    data: {...}
//!   event: plan_created   data: {"steps":["..."]}
//!   event: task_complete data: {"summary":"..."}
//!   event: task_failed   data: {"error":"...","recoverable":false}
//!   event: log           data: {"level":"info","message":"..."}

use axum::extract::{Path as AxumPath, Query, State};
use axum::http::StatusCode;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::routing::{get, post};
use axum::Json;
use axum::Router;
use futures_util::Stream;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io;
use uuid::Uuid;

use crate::agent::react_engine::AgentEvent;
use crate::agent::state_machine::ExecutionMode;
use crate::error::AppError;
use crate::state::SharedState;

// ============================================================
// 请求/响应体定义
// ============================================================

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTaskBody {
    pub session_id: String,
    pub user_request: String,
    pub mode: Option<ExecutionMode>,
    /// 启动时附带的项目根 (可选,若提供则在创建后立即 start)。
    pub project_root: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ListTasksQuery {
    pub session_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartTaskBody {
    pub project_root: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumeTaskBody {
    pub project_root: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModeBody {
    Autonomous,
    Approval,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DefaultModeResponse {
    pub mode: ExecutionMode,
}

// ============================================================
// 路由注册
// ============================================================

/// 构建 agent 路由树,挂在 /api/agent 下。
pub fn router() -> Router<SharedState> {
    Router::new()
        .route("/tasks", post(create_task).get(list_tasks))
        .route("/tasks/:id", get(get_task))
        .route("/tasks/:id/start", post(start_task))
        .route("/tasks/:id/pause", post(pause_task))
        .route("/tasks/:id/resume", post(resume_task))
        .route("/tasks/:id/stop", post(stop_task))
        .route("/tasks/:id/stream", get(stream_task))
        .route("/tools", get(list_tools))
        .route("/mode", get(get_mode).put(set_mode))
}

// ============================================================
// 处理函数
// ============================================================

/// POST /api/agent/tasks - 创建任务。
pub async fn create_task(
    State(state): State<SharedState>,
    Json(body): Json<CreateTaskBody>,
) -> Result<(StatusCode, Json<Value>), AppError> {
    if body.user_request.trim().is_empty() {
        return Err(AppError::BadRequest("user_request 不能为空".into()));
    }
    let session_id = Uuid::parse_str(&body.session_id)
        .map_err(|e| AppError::BadRequest(format!("session_id 非法 UUID: {e}")))?;

    // 若 body.mode 为 None,使用运行时默认模式
    let mode = match body.mode {
        Some(m) => m,
        None => state.agent.get_default_mode().await,
    };

    let task = state
        .agent
        .create_task(session_id, body.user_request, mode)
        .await;
    tracing::info!("创建 Agent 任务: id={}, mode={}", task.id, mode);

    // 若提供了 project_root,立即启动
    if let Some(root) = body.project_root {
        let project_root = std::path::PathBuf::from(root);
        if let Err(e) = state.agent.start_task(task.id, project_root).await {
            tracing::warn!("启动任务失败 (已创建): {e}");
        }
    }

    Ok((StatusCode::CREATED, Json(json!(task))))
}

/// GET /api/agent/tasks - 列出任务 (可选按 session_id 过滤)。
pub async fn list_tasks(
    State(state): State<SharedState>,
    Query(q): Query<ListTasksQuery>,
) -> Json<Value> {
    let tasks = if let Some(sid) = q.session_id.as_deref() {
        match Uuid::parse_str(sid) {
            Ok(uuid) => state.agent.task_store.list_by_session(uuid),
            Err(_) => Vec::new(),
        }
    } else {
        state.agent.task_store.list()
    };
    let total = tasks.len();
    Json(json!({ "tasks": tasks, "total": total }))
}

/// GET /api/agent/tasks/:id - 查询任务详情。
pub async fn get_task(
    State(state): State<SharedState>,
    AxumPath(id): AxumPath<String>,
) -> Result<Json<Value>, AppError> {
    let uuid = parse_uuid(&id)?;
    let task = state
        .agent
        .task_store
        .get(uuid)
        .ok_or_else(|| AppError::BadRequest(format!("任务不存在: {id}")))?;
    Ok(Json(json!(task)))
}

/// POST /api/agent/tasks/:id/start - 启动任务。
pub async fn start_task(
    State(state): State<SharedState>,
    AxumPath(id): AxumPath<String>,
    Json(body): Json<StartTaskBody>,
) -> Result<Json<Value>, AppError> {
    let uuid = parse_uuid(&id)?;
    let project_root = std::path::PathBuf::from(body.project_root);
    state.agent.start_task(uuid, project_root).await?;
    Ok(Json(json!({ "taskId": id, "started": true })))
}

/// POST /api/agent/tasks/:id/pause - 暂停任务。
pub async fn pause_task(
    State(state): State<SharedState>,
    AxumPath(id): AxumPath<String>,
) -> Result<Json<Value>, AppError> {
    let uuid = parse_uuid(&id)?;
    state.agent.pause_task(uuid).await;
    Ok(Json(json!({ "taskId": id, "paused": true })))
}

/// POST /api/agent/tasks/:id/resume - 恢复任务。
pub async fn resume_task(
    State(state): State<SharedState>,
    AxumPath(id): AxumPath<String>,
    Json(body): Json<ResumeTaskBody>,
) -> Result<Json<Value>, AppError> {
    let uuid = parse_uuid(&id)?;
    let project_root = std::path::PathBuf::from(body.project_root);
    state.agent.resume_task(uuid, project_root).await?;
    Ok(Json(json!({ "taskId": id, "resumed": true })))
}

/// POST /api/agent/tasks/:id/stop - 终止任务。
pub async fn stop_task(
    State(state): State<SharedState>,
    AxumPath(id): AxumPath<String>,
) -> Result<Json<Value>, AppError> {
    let uuid = parse_uuid(&id)?;
    state.agent.stop_task(uuid).await;
    Ok(Json(json!({ "taskId": id, "stopped": true })))
}

/// GET /api/agent/tasks/:id/stream - SSE 事件流。
///
/// 订阅 AgentRuntime 的 broadcast 通道,将 AgentEvent 转为 SSE 事件推送。
/// 客户端断开时流自动结束,无需特殊清理 (broadcast Receiver drop 即可)。
pub async fn stream_task(
    State(state): State<SharedState>,
    AxumPath(id): AxumPath<String>,
) -> Result<Sse<impl Stream<Item = Result<Event, io::Error>> + Send>, AppError> {
    let uuid = parse_uuid(&id)?;

    // 验证任务存在
    let task = state
        .agent
        .task_store
        .get(uuid)
        .ok_or_else(|| AppError::BadRequest(format!("任务不存在: {id}")))?;

    let mut rx = state.agent.subscribe(uuid).await;

    let stream = async_stream::stream! {
        // 首个事件:推送任务当前快照
        let snapshot = json!({
            "taskId": task.id,
            "state": task.state,
            "iteration": task.current_iteration,
            "maxIterations": task.max_iterations,
        });
        yield Ok::<Event, io::Error>(
            Event::default()
                .event("task_snapshot")
                .data(snapshot.to_string()),
        );

        loop {
            match rx.recv().await {
                Ok(ev) => {
                    let (event_name, data) = agent_event_to_sse(ev);
                    yield Ok::<Event, io::Error>(
                        Event::default()
                            .event(event_name)
                            .data(data.to_string()),
                    );
                    // 终态事件后结束流
                    if matches!(
                        event_name,
                        "task_complete" | "task_failed" | "task_state"
                    ) {
                        // task_state 也可能是终态,需检查
                        if event_name == "task_state" {
                            let st = data.get("state").and_then(|v| v.as_str()).unwrap_or("");
                            if matches!(
                                st,
                                "completed" | "failed" | "cancelled" | "paused"
                            ) {
                                break;
                            }
                        } else {
                            break;
                        }
                    }
                }
                Err(broadcast_err) => match broadcast_err {
                    tokio::sync::broadcast::error::RecvError::Closed => {
                        // 通道关闭 (任务循环退出),发送 done 事件并结束
                        yield Ok::<Event, io::Error>(
                            Event::default()
                                .event("done")
                                .data(json!({ "taskId": id }).to_string()),
                        );
                        break;
                    }
                    tokio::sync::broadcast::error::RecvError::Lagged(n) => {
                        // 滞后,跳过 n 条历史,发送 warning 事件
                        yield Ok::<Event, io::Error>(
                            Event::default()
                                .event("lagged")
                                .data(json!({ "skipped": n }).to_string()),
                        );
                    }
                },
            }
        }
    };

    Ok(Sse::new(stream).keep_alive(KeepAlive::default()))
}

/// GET /api/agent/tools - 列出已注册工具。
pub async fn list_tools(State(state): State<SharedState>) -> Json<Value> {
    let tools = state.agent.list_tools().await;
    let total = tools.len();
    Json(json!({ "tools": tools, "total": total }))
}

/// GET /api/agent/mode - 读取全局默认模式。
pub async fn get_mode(State(state): State<SharedState>) -> Json<DefaultModeResponse> {
    let mode = state.agent.get_default_mode().await;
    Json(DefaultModeResponse { mode })
}

/// PUT /api/agent/mode - 设置全局默认模式。
pub async fn set_mode(State(state): State<SharedState>, Json(body): Json<ModeBody>) -> Json<Value> {
    let mode = match body {
        ModeBody::Autonomous => ExecutionMode::Autonomous,
        ModeBody::Approval => ExecutionMode::Approval,
    };
    state.agent.set_default_mode(mode).await;
    Json(json!({ "mode": mode }))
}

// ============================================================
// 辅助函数
// ============================================================

/// 将 UUID 字符串解析为 Uuid,失败返回 BadRequest。
fn parse_uuid(s: &str) -> Result<Uuid, AppError> {
    Uuid::parse_str(s).map_err(|e| AppError::BadRequest(format!("非法 UUID {s:?}: {e}")))
}

/// 将 AgentEvent 映射为 SSE 事件名与 JSON 数据。
///
/// 返回 (event_name, data_value)。event_name 与前端约定一致。
fn agent_event_to_sse(ev: AgentEvent) -> (&'static str, Value) {
    match ev {
        AgentEvent::StateChanged { state, iteration } => (
            "task_state",
            json!({ "state": state, "iteration": iteration }),
        ),
        AgentEvent::Thought { content } => ("thought", json!({ "content": content })),
        AgentEvent::ToolCall { call } => ("tool_call", json!({ "call": call })),
        AgentEvent::ToolResult { result } => ("tool_result", json!({ "result": result })),
        AgentEvent::Reflection {
            conclusion,
            next_action,
        } => (
            "reflection",
            json!({ "conclusion": conclusion, "nextAction": next_action }),
        ),
        AgentEvent::PlanCreated { steps } => ("plan_created", json!({ "steps": steps })),
        AgentEvent::Completed { summary } => ("task_complete", json!({ "summary": summary })),
        AgentEvent::Failed { error, recoverable } => (
            "task_failed",
            json!({ "error": error, "recoverable": recoverable }),
        ),
        AgentEvent::Log { level, message } => {
            ("log", json!({ "level": level, "message": message }))
        }
    }
}
