//! MCP 插件管理路由（P1 MCP 生态）：
//! 列表 / 注册 / 卸载 / 启停 / 连接 / 断开 / 调用 / 高危开关。
//!
//! ## 路由
//! - `GET    /api/mcp`                       - 列出所有插件元信息+状态
//! - `POST   /api/mcp`                       - 注册新插件
//! - `DELETE /api/mcp/:id`                   - 卸载插件
//! - `PUT    /api/mcp/:id/toggle`            - 启用/禁用
//! - `POST   /api/mcp/:id/connect`           - 连接插件
//! - `POST   /api/mcp/:id/disconnect`        - 断开
//! - `POST   /api/mcp/call`                  - 调用插件工具（含权限检查+审批）
//! - `GET    /api/mcp/high-risk/switch`      - 获取高危插件总开关
//! - `PUT    /api/mcp/high-risk/switch`      - 设置高危插件总开关
//!
//! ## 权限策略
//! - file 类插件继承当前三级权限，写操作需 can_write
//! - network 类插件禁止访问本地文件系统
//! - shell 类插件需 can_shell（FullAccess）
//! - high_risk 插件需先开启总开关，每次调用创建审批请求

use axum::extract::{Path as AxumPath, State};
use axum::http::StatusCode;
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::error::AppError;
use crate::mcp::{McpCallRequest, McpConfig};
use crate::state::{ApprovalKind, SharedState};

/// 高危开关请求体
#[derive(Debug, Deserialize)]
pub struct HighRiskBody {
    pub enabled: bool,
}

/// GET /api/mcp - 列出所有插件完整配置+状态
///
/// 返回 `plugins: Array<McpConfig & { status: McpStatus }>`，前端可直接读取 `plugin.meta.id` 等嵌套字段。
pub async fn list_mcp(State(state): State<SharedState>) -> Json<Value> {
    let configs = state.mcp.list_configs().await;
    let statuses = state.mcp.list_statuses().await;
    let high_risk_enabled = *state.mcp_high_risk_enabled.read().await;
    use std::collections::HashMap as StdHashMap;
    let mut status_map: StdHashMap<String, Value> = StdHashMap::new();
    for s in &statuses {
        status_map.insert(s.id.clone(), serde_json::to_value(s).unwrap_or(Value::Null));
    }
    let plugins: Vec<Value> = configs
        .iter()
        .map(|c| {
            let st = status_map.get(&c.meta.id).cloned().unwrap_or(Value::Null);
            let mut obj = serde_json::to_value(c).unwrap_or(Value::Null);
            if let Some(o) = obj.as_object_mut() {
                o.insert("status".into(), st);
            }
            obj
        })
        .collect();
    Json(json!({
        "plugins": plugins,
        "highRiskEnabled": high_risk_enabled,
        "total": plugins.len(),
    }))
}

/// POST /api/mcp - 注册新插件
pub async fn register_mcp(
    State(state): State<SharedState>,
    Json(body): Json<McpConfig>,
) -> Result<(StatusCode, Json<Value>), AppError> {
    if body.meta.id.trim().is_empty() {
        return Err(AppError::BadRequest("meta.id 不能为空".into()));
    }
    let id = body.meta.id.clone();
    state.mcp.register(body).await?;
    tracing::info!("注册 MCP 插件: id={}", id);
    Ok((
        StatusCode::CREATED,
        Json(json!({ "registered": true, "id": id })),
    ))
}

/// DELETE /api/mcp/:id - 卸载插件
pub async fn delete_mcp(
    State(state): State<SharedState>,
    AxumPath(id): AxumPath<String>,
) -> Result<Json<Value>, AppError> {
    state.mcp.unregister(&id).await;
    Ok(Json(json!({ "deleted": true, "id": id })))
}

/// PUT /api/mcp/:id/toggle - 启用/禁用
pub async fn toggle_mcp(
    State(state): State<SharedState>,
    AxumPath(id): AxumPath<String>,
) -> Result<Json<Value>, AppError> {
    let config = state
        .mcp
        .get_config(&id)
        .await
        .ok_or_else(|| AppError::BadRequest(format!("插件不存在: {id}")))?;
    let new_enabled = !config.meta.enabled;
    state.mcp.set_enabled(&id, new_enabled).await?;
    Ok(Json(json!({ "id": id, "enabled": new_enabled })))
}

/// POST /api/mcp/:id/connect - 连接插件
pub async fn connect_mcp(
    State(state): State<SharedState>,
    AxumPath(id): AxumPath<String>,
) -> Result<Json<Value>, AppError> {
    state.mcp.connect(&id).await?;
    Ok(Json(json!({ "id": id, "connected": true })))
}

/// POST /api/mcp/:id/disconnect - 断开
pub async fn disconnect_mcp(
    State(state): State<SharedState>,
    AxumPath(id): AxumPath<String>,
) -> Result<Json<Value>, AppError> {
    state.mcp.disconnect(&id).await?;
    Ok(Json(json!({ "id": id, "connected": false })))
}

/// POST /api/mcp/call - 调用插件工具（含权限检查+审批）
///
/// - high_risk 插件：检查总开关，开启则创建审批请求返回 202
/// - 其他插件：执行权限隔离检查后调用
pub async fn call_mcp(
    State(state): State<SharedState>,
    Json(body): Json<McpCallRequest>,
) -> Result<(StatusCode, Json<Value>), AppError> {
    let cfg = state.permission_config().await;
    let level = cfg.level;

    let config = state
        .mcp
        .get_config(&body.plugin_id)
        .await
        .ok_or_else(|| AppError::BadRequest(format!("插件不存在: {}", body.plugin_id)))?;

    // 高危插件：检查总开关 + 创建审批
    if config.meta.high_risk {
        let high_risk_enabled = *state.mcp_high_risk_enabled.read().await;
        if !high_risk_enabled {
            return Err(AppError::Forbidden(
                "高危插件总开关未开启，请在设置面板启用".into(),
            ));
        }
        let approval = state
            .approvals
            .create(
                ApprovalKind::Shell,
                format!("MCP[{}] 调用工具: {}", body.plugin_id, body.tool),
                Some(serde_json::to_string(&body.arguments).unwrap_or_default()),
                body.session_id.clone(),
            )
            .await;
        return Ok((
            StatusCode::ACCEPTED,
            Json(json!({
                "approvalId": approval.id,
                "pending": true,
                "message": "高危插件调用等待审批",
            })),
        ));
    }

    // 普通插件：直接调用（权限隔离在 mcp.call 内部执行）
    let result = state.mcp.call(body, level).await?;
    Ok((StatusCode::OK, Json(json!(result))))
}

/// GET /api/mcp/high-risk/switch - 获取高危插件总开关
pub async fn get_high_risk_switch(State(state): State<SharedState>) -> Json<Value> {
    let enabled = *state.mcp_high_risk_enabled.read().await;
    Json(json!({ "enabled": enabled }))
}

/// PUT /api/mcp/high-risk/switch - 设置高危插件总开关
pub async fn set_high_risk_switch(
    State(state): State<SharedState>,
    Json(body): Json<HighRiskBody>,
) -> Json<Value> {
    let mut guard = state.mcp_high_risk_enabled.write().await;
    *guard = body.enabled;
    tracing::info!("高危插件总开关: enabled={}", body.enabled);
    Json(json!({ "enabled": body.enabled }))
}

/* ============================================================
 * P2 设置页扩展路由（4 个补全 404）
 * ============================================================ */

/// 设置页添加服务请求体（简化视图）。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddServiceBody {
    pub name: String,
    /// "sse" | "stdio"
    pub transport: String,
    /// stdio: 命令路径（如 "npx -y @mcp/server-xxx"）；sse: 服务 URL
    pub endpoint: String,
    /// 权限作用域列表：file / network / shell / database
    #[serde(default)]
    pub permissions: Vec<String>,
}

/// 全局总开关请求体。
#[derive(Debug, Deserialize)]
pub struct GlobalEnabledBody {
    pub enabled: bool,
}

/// 启用/禁用请求体（与 skills 模块一致）。
#[derive(Debug, Deserialize)]
pub struct EnabledBody {
    pub enabled: bool,
}

/// GET /api/mcp/services - 获取 MCP 服务列表配置（设置页视图）。
///
/// 返回 { services: [...], globalEnabled }，services 包含 id/name/transport/endpoint/permissions/enabled/status。
pub async fn list_mcp_services(State(state): State<SharedState>) -> Json<Value> {
    let metas = state.mcp.list_metas().await;
    let statuses = state.mcp.list_statuses().await;
    // 构建 status 索引
    use std::collections::HashMap as StdHashMap;
    let mut status_map: StdHashMap<String, String> = StdHashMap::new();
    for s in &statuses {
        let st = if s.connected { "connected" } else { "disconnected" };
        if s.last_error.is_some() {
            status_map.insert(s.id.clone(), "error".into());
        } else {
            status_map.insert(s.id.clone(), st.into());
        }
    }
    let services: Vec<Value> = metas
        .iter()
        .map(|m| {
            let endpoint = if m.transport == "sse" {
                // SSE 模式：endpoint 取 url（无法在此处直接拿到 url，返回空字符串）
                String::new()
            } else {
                // stdio 模式：endpoint 取 command（无法在此处拿到 command，返回 name）
                m.name.clone()
            };
            json!({
                "id": m.id,
                "name": m.name,
                "transport": m.transport,
                "endpoint": endpoint,
                "permissions": [],  // 设置页轻量视图，permissions 从配置中读取由前端展示
                "enabled": m.enabled,
                "status": status_map.get(&m.id).cloned().unwrap_or_else(|| "disconnected".into()),
            })
        })
        .collect();
    let global_enabled = *state.mcp_high_risk_enabled.read().await;
    Json(json!({
        "services": services,
        "globalEnabled": global_enabled,
    }))
}

/// POST /api/mcp/services - 添加服务（设置页简化视图）。
///
/// 根据传输协议构造 McpConfig 并注册：
/// - stdio: endpoint 解析为 command + args（按空格切分）
/// - sse: endpoint 直接作为 url
pub async fn add_mcp_service(
    State(state): State<SharedState>,
    Json(body): Json<AddServiceBody>,
) -> Result<(StatusCode, Json<Value>), AppError> {
    if body.name.trim().is_empty() {
        return Err(AppError::BadRequest("name 不能为空".into()));
    }
    if body.transport != "sse" && body.transport != "stdio" {
        return Err(AppError::BadRequest(format!(
            "未知 transport: {}（仅支持 sse/stdio）",
            body.transport
        )));
    }
    let id = format!("svc_{}", chrono::Utc::now().timestamp_millis());
    let permission_scope = body.permissions.first().cloned().unwrap_or_else(|| "network".into());
    let (command, args, url) = match body.transport.as_str() {
        "stdio" => {
            // endpoint 按空格切分：第一段为 command，其余为 args
            let parts: Vec<&str> = body.endpoint.split_whitespace().collect();
            if parts.is_empty() {
                return Err(AppError::BadRequest("endpoint 不能为空".into()));
            }
            let cmd = parts[0].to_string();
            let args: Vec<String> = parts[1..].iter().map(|s| s.to_string()).collect();
            (Some(cmd), Some(args), None)
        }
        "sse" => (None, None, Some(body.endpoint.clone())),
        _ => (None, None, None),
    };
    let config = crate::mcp::McpConfig {
        meta: crate::mcp::McpMeta {
            id: id.clone(),
            name: body.name.clone(),
            description: format!("用户添加的 {} 服务", body.transport),
            version: "1.0.0".to_string(),
            transport: body.transport.clone(),
            enabled: true,
            high_risk: matches!(permission_scope.as_str(), "database" | "shell"),
            category: "other".to_string(),
            capabilities: String::new(),
        },
        command,
        args,
        env: None,
        url,
        permission_scope,
        timeout_secs: 30,
    };
    state.mcp.register(config).await?;
    tracing::info!("添加 MCP 服务: id={}, name={}", id, body.name);
    Ok((StatusCode::CREATED, Json(json!({ "id": id }))))
}

/// POST /api/mcp/global-enabled - 设置 MCP 全局总开关。
///
/// 与 high-risk/switch 共用 mcp_high_risk_enabled 字段（全局总开关语义）。
pub async fn set_mcp_global_enabled(
    State(state): State<SharedState>,
    Json(body): Json<GlobalEnabledBody>,
) -> Json<Value> {
    let mut guard = state.mcp_high_risk_enabled.write().await;
    *guard = body.enabled;
    tracing::info!("MCP 全局总开关: enabled={}", body.enabled);
    Json(json!({ "globalEnabled": body.enabled }))
}

/// POST /api/mcp/:id/enabled - 显式启用/禁用某服务。
pub async fn set_mcp_enabled(
    State(state): State<SharedState>,
    AxumPath(id): AxumPath<String>,
    Json(body): Json<EnabledBody>,
) -> Result<Json<Value>, AppError> {
    state.mcp.set_enabled(&id, body.enabled).await?;
    Ok(Json(json!({ "id": id, "enabled": body.enabled })))
}
