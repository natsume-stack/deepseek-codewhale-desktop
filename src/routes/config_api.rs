//! DeepSeek 配置端点: GET / PUT /api/config/deepseek, POST /api/config/deepseek/test
//! API Key 写入后落盘到 ~/.codewhale-server/config.toml。

use axum::extract::State;
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::config::PermissionLevel;
use crate::state::SharedState;

pub async fn get_deepseek(State(state): State<SharedState>) -> Json<Value> {
    let cfg = state.config.read().await;
    Json(json!({
        "configured": cfg.is_configured(),
        "apiKeyMasked": cfg.masked_key(),
        "baseUrl": cfg.deepseek.base_url,
        "model": cfg.deepseek.model,
    }))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetDeepSeekBody {
    pub api_key: Option<String>,
    pub base_url: Option<String>,
    pub model: Option<String>,
}

pub async fn set_deepseek(
    State(state): State<SharedState>,
    Json(body): Json<SetDeepSeekBody>,
) -> Result<Json<Value>, crate::error::AppError> {
    let mut cfg = state.config.write().await;
    cfg.update_deepseek(body.api_key, body.base_url, body.model)?;
    let masked = cfg.masked_key();
    let model = cfg.deepseek.model.clone();
    let base_url = cfg.deepseek.base_url.clone();
    drop(cfg);
    Ok(Json(json!({
        "configured": true,
        "apiKeyMasked": masked,
        "baseUrl": base_url,
        "model": model,
    })))
}

pub async fn test_deepseek(
    State(state): State<SharedState>,
) -> Result<Json<Value>, crate::error::AppError> {
    let cfg = state.deepseek_config().await;
    state.client.probe(&cfg).await?;
    Ok(Json(json!({ "ok": true, "model": cfg.model, "baseUrl": cfg.base_url })))
}

/* ============================================================
 * 权限配置（P0-8）
 * ============================================================ */

/// 权限配置更新请求体（所有字段可选，仅更新传入字段）。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetPermissionBody {
    pub level: Option<PermissionLevel>,
    pub approval_on_write: Option<bool>,
    pub approval_on_shell: Option<bool>,
}

/// GET /api/config/permission → 返回当前权限配置。
pub async fn get_permission(State(state): State<SharedState>) -> Json<Value> {
    let cfg = state.permission_config().await;
    Json(json!(cfg))
}

/// PUT /api/config/permission → 更新权限配置并落盘，返回更新后的完整配置。
pub async fn set_permission(
    State(state): State<SharedState>,
    Json(body): Json<SetPermissionBody>,
) -> Result<Json<Value>, crate::error::AppError> {
    let mut cfg = state.config.write().await;
    if let Some(level) = body.level {
        cfg.permission.level = level;
    }
    if let Some(w) = body.approval_on_write {
        cfg.permission.approval_on_write = w;
    }
    if let Some(s) = body.approval_on_shell {
        cfg.permission.approval_on_shell = s;
    }
    cfg.save()?;
    let permission = cfg.permission.clone();
    drop(cfg);
    tracing::info!(
        "权限配置已更新: level={:?}, approvalOnWrite={}, approvalOnShell={}",
        permission.level,
        permission.approval_on_write,
        permission.approval_on_shell
    );
    Ok(Json(json!(permission)))
}
