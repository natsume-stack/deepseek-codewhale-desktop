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
    Ok(Json(json!({
        "path": canonical.display().to_string(),
        "loaded": true,
    })))
}

pub async fn get_project(State(state): State<SharedState>) -> Json<Value> {
    let root = state.project_root().await;
    Json(json!({
        "path": root.as_ref().map(|p| p.display().to_string()),
        "loaded": root.is_some(),
    }))
}
