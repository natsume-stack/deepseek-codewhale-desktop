//! 健康检测: GET /ping, GET /health

use axum::extract::State;
use axum::Json;
use serde_json::{json, Value};

use crate::state::SharedState;

pub async fn ping(State(state): State<SharedState>) -> Json<Value> {
    let (configured, project) = {
        let cfg = state.config.read().await;
        let configured = cfg.is_configured();
        drop(cfg);
        let project = state.project_root().await.map(|p| p.display().to_string());
        (configured, project)
    };
    Json(json!({
        "status": "ok",
        "service": "codewhale-server",
        "version": env!("CARGO_PKG_VERSION"),
        "deepseekConfigured": configured,
        "projectLoaded": project.is_some(),
        "projectRoot": project,
        "timestamp": chrono::Utc::now().to_rfc3339(),
    }))
}
