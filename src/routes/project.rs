//! 本地项目目录加载: POST /api/project/load, GET /api/project

use axum::extract::State;
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::PathBuf;

use crate::error::AppError;
use crate::state::SharedState;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadProjectBody {
    pub path: String,
}

pub async fn load_project(
    State(state): State<SharedState>,
    Json(body): Json<LoadProjectBody>,
) -> Result<Json<Value>, AppError> {
    let raw = PathBuf::from(&body.path);
    let canonical = raw
        .canonicalize()
        .map_err(|e| AppError::BadRequest(format!("项目目录无效: {}: {e}", body.path)))?;
    if !canonical.is_dir() {
        return Err(AppError::BadRequest(format!(
            "目标不是目录: {}",
            canonical.display()
        )));
    }
    *state.project_root.write().await = Some(canonical.clone());
    tracing::info!("项目目录已加载: {}", canonical.display());

    // 主动为所有现有会话初始化 project_memory（仅对 project_memory 为空的会话生效）
    // 这样用户选目录后，下次对话 AI 一定能看到项目信息（即便会话已存在）
    let sessions = state.sessions.list().await;
    let mut init_count = 0u32;
    for s in &sessions {
        // 仅对 project_memory 为空的会话初始化（init_project_memory 内部会判断）
        let memory = format!(
            "# 当前工作目录\n项目根: {}\n（请基于此项目根路径解析相对路径）",
            canonical.display()
        );
        if state.sessions.init_project_memory(&s.id, memory).await.is_ok() {
            init_count += 1;
        }
    }
    if init_count > 0 {
        tracing::info!("已为 {} 个会话注入 project_memory", init_count);
    }

    Ok(Json(json!({
        "path": canonical.display().to_string(),
        "loaded": true,
        "sessionsUpdated": init_count,
    })))
}

pub async fn get_project(State(state): State<SharedState>) -> Json<Value> {
    let root = state.project_root().await;
    Json(json!({
        "path": root.as_ref().map(|p| p.display().to_string()),
        "loaded": root.is_some(),
    }))
}
