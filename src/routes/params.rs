//! 推理参数动态配置: GET / PUT /api/params
//! 字段: reasoningEffort / cacheEnabled / contextLength

use axum::extract::State;
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::config::ReasoningEffort;
use crate::error::AppError;
use crate::state::SharedState;

pub async fn get_params(State(state): State<SharedState>) -> Json<Value> {
    let inf = state.inference_defaults().await;
    Json(json!(inf))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateParamsBody {
    pub reasoning_effort: Option<ReasoningEffort>,
    pub cache_enabled: Option<bool>,
    pub context_length: Option<usize>,
}

pub async fn update_params(
    State(state): State<SharedState>,
    Json(body): Json<UpdateParamsBody>,
) -> Result<Json<Value>, AppError> {
    let mut cfg = state.config.write().await;
    if let Some(r) = body.reasoning_effort {
        cfg.inference.reasoning_effort = r;
    }
    if let Some(c) = body.cache_enabled {
        cfg.inference.cache_enabled = c;
    }
    if let Some(cl) = body.context_length {
        if cl == 0 {
            return Err(AppError::BadRequest("contextLength 必须 > 0".into()));
        }
        cfg.inference.context_length = cl;
    }
    cfg.save()?;
    let inf = cfg.inference;
    drop(cfg);
    Ok(Json(json!(inf)))
}
