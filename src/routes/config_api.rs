//! DeepSeek 配置端点: GET / PUT /api/config/deepseek, POST /api/config/deepseek/test
//! API Key 写入后落盘到 ~/.codewhale-server/config.toml。
//!
//! P2 扩展: 多模型多凭证 / RAG / 格式化 / 缓存 / 安全 / 快捷键 / 外观 配置 API。

use axum::extract::{Path, State};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::config::{
    mask_key, ApiProfile, AppearanceConfig, CacheDebugConfig, FormatterConfig, ModelProfilesConfig,
    PermissionLevel, RagConfig, SecurityConfig, ShortcutsConfig,
};
use crate::error::AppError;
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
    Ok(Json(
        json!({ "ok": true, "model": cfg.model, "baseUrl": cfg.base_url }),
    ))
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

/* ============================================================
 * P2 完整设置页面后端 API 扩展
 * ============================================================ */

/// 标准 base64 编码字符表。
const BASE64_CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// 简化的 base64 编码（用于 API key 加密存储，不引入新依赖）。
fn base64_encode(input: &[u8]) -> String {
    let mut out = String::with_capacity((input.len() + 2) / 3 * 4);
    for chunk in input.chunks(3) {
        let b0 = chunk[0];
        let b1 = chunk.get(1).copied().unwrap_or(0);
        let b2 = chunk.get(2).copied().unwrap_or(0);
        out.push(BASE64_CHARS[(b0 >> 2) as usize] as char);
        out.push(BASE64_CHARS[(((b0 & 0x03) << 4) | (b1 >> 4)) as usize] as char);
        if chunk.len() > 1 {
            out.push(BASE64_CHARS[(((b1 & 0x0f) << 2) | (b2 >> 6)) as usize] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(BASE64_CHARS[(b2 & 0x3f) as usize] as char);
        } else {
            out.push('=');
        }
    }
    out
}

/// Decode the locally stored base64 profile key. Profile activation needs the
/// original credential to update the request client's effective configuration.
fn base64_decode(input: &str) -> Result<Vec<u8>, AppError> {
    let mut output = Vec::with_capacity(input.len() / 4 * 3);
    let mut chunk = [0u8; 4];
    let mut count = 0usize;
    for byte in input.bytes().filter(|b| !b.is_ascii_whitespace()) {
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            b'=' => 64,
            _ => return Err(AppError::BadRequest("API 密钥编码无效".into())),
        };
        chunk[count] = value;
        count += 1;
        if count == 4 {
            if chunk[0] == 64 || chunk[1] == 64 {
                return Err(AppError::BadRequest("API 密钥编码无效".into()));
            }
            output.push((chunk[0] << 2) | (chunk[1] >> 4));
            if chunk[2] != 64 {
                output.push((chunk[1] << 4) | (chunk[2] >> 2));
            }
            if chunk[3] != 64 {
                output.push((chunk[2] << 6) | chunk[3]);
            }
            count = 0;
        }
    }
    if count != 0 {
        return Err(AppError::BadRequest("API 密钥编码无效".into()));
    }
    Ok(output)
}

/// 处理明文 API key：生成脱敏版本 + 加密版本（base64）。
/// 输入 `api_key_masked` 字段携带明文 key（来自前端），返回 (masked, encrypted)。
fn process_plain_key(plain: &str) -> (String, Option<String>) {
    if plain.is_empty() {
        return (String::new(), None);
    }
    let masked = mask_key(plain);
    let encrypted = base64_encode(plain.as_bytes());
    (masked, Some(encrypted))
}

/// 将 ApiProfile 序列化为脱敏的 JSON Value（不返回 encrypted 字段）。
fn profile_to_masked_json(p: &ApiProfile) -> Value {
    json!({
        "id": p.id,
        "name": p.name,
        "provider": p.provider,
        "apiKeyMasked": p.api_key_masked,
        "baseUrl": p.base_url,
        "model": p.model,
        "displayName": p.display_name,
        "supportsReasoning": p.supports_reasoning,
        "maxTokens": p.max_tokens,
    })
}

/* ---------- 模型 & API 卡片 ---------- */

/// GET /api/config/model-profiles → 返回多模型多凭证配置（脱敏）。
pub async fn get_model_profiles(State(state): State<SharedState>) -> Result<Json<Value>, AppError> {
    let cfg = state.config.read().await;
    let profiles: Vec<Value> = cfg
        .model_profiles
        .profiles
        .iter()
        .map(profile_to_masked_json)
        .collect();
    Ok(Json(json!({
        "profiles": profiles,
        "activeProfileId": cfg.model_profiles.active_profile_id,
    })))
}

/// PUT /api/config/model-profiles → 整体替换多模型多凭证配置。
pub async fn set_model_profiles(
    State(state): State<SharedState>,
    Json(body): Json<ModelProfilesConfig>,
) -> Result<Json<Value>, AppError> {
    let mut cfg = state.config.write().await;
    cfg.model_profiles = body;
    cfg.save()?;
    let profiles: Vec<Value> = cfg
        .model_profiles
        .profiles
        .iter()
        .map(profile_to_masked_json)
        .collect();
    let active = cfg.model_profiles.active_profile_id.clone();
    drop(cfg);
    Ok(Json(json!({
        "profiles": profiles,
        "activeProfileId": active,
    })))
}

/// POST /api/config/profiles → 新增一个 profile。
/// 请求体 `apiKeyMasked` 字段携带明文 key，服务端生成脱敏 + 加密版本。
pub async fn add_profile(
    State(state): State<SharedState>,
    Json(mut body): Json<ApiProfile>,
) -> Result<Json<Value>, AppError> {
    // 处理明文 key
    let (masked, encrypted) = process_plain_key(&body.api_key_masked);
    body.api_key_masked = masked;
    body.api_key_encrypted = encrypted;
    // 确保 id 非空
    if body.id.trim().is_empty() {
        body.id = format!("profile_{}", chrono::Utc::now().timestamp_millis());
    }
    let profile_json = profile_to_masked_json(&body);
    let mut cfg = state.config.write().await;
    cfg.model_profiles.profiles.push(body);
    cfg.save()?;
    drop(cfg);
    Ok(Json(json!({ "ok": true, "profile": profile_json })))
}

/// PUT /api/config/profiles/:id → 更新指定 profile。
pub async fn update_profile(
    State(state): State<SharedState>,
    Path(id): Path<String>,
    Json(body): Json<ApiProfile>,
) -> Result<Json<Value>, AppError> {
    let mut cfg = state.config.write().await;
    let profile = cfg
        .model_profiles
        .profiles
        .iter_mut()
        .find(|p| p.id == id)
        .ok_or_else(|| AppError::BadRequest(format!("profile 不存在: {id}")))?;
    // 处理明文 key：若前端传入了非空 key 则更新，否则保留原 encrypted
    let (masked, encrypted) = process_plain_key(&body.api_key_masked);
    if !masked.is_empty() {
        profile.api_key_masked = masked;
        profile.api_key_encrypted = encrypted;
    }
    profile.name = body.name;
    profile.provider = body.provider;
    profile.base_url = body.base_url;
    profile.model = body.model;
    profile.display_name = body.display_name;
    profile.supports_reasoning = body.supports_reasoning;
    profile.max_tokens = body.max_tokens;
    let profile_json = profile_to_masked_json(profile);
    cfg.save()?;
    drop(cfg);
    Ok(Json(json!({ "ok": true, "profile": profile_json })))
}

/// DELETE /api/config/profiles/:id → 删除指定 profile。
pub async fn delete_profile(
    State(state): State<SharedState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, AppError> {
    let mut cfg = state.config.write().await;
    let before = cfg.model_profiles.profiles.len();
    cfg.model_profiles.profiles.retain(|p| p.id != id);
    if cfg.model_profiles.profiles.len() == before {
        return Err(AppError::BadRequest(format!("profile 不存在: {id}")));
    }
    // 若删除的是当前激活 profile，清空 active_profile_id
    if cfg.model_profiles.active_profile_id.as_deref() == Some(&id) {
        cfg.model_profiles.active_profile_id = None;
    }
    cfg.save()?;
    drop(cfg);
    Ok(Json(json!({ "ok": true, "id": id })))
}

/// POST /api/config/profiles/:id/active → 设置当前激活 profile。
pub async fn set_active_profile(
    State(state): State<SharedState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, AppError> {
    let mut cfg = state.config.write().await;
    let profile = cfg
        .model_profiles
        .profiles
        .iter()
        .find(|p| p.id == id)
        .cloned()
        .ok_or_else(|| AppError::BadRequest(format!("profile 不存在: {id}")))?;
    let encrypted_key = profile.api_key_encrypted.as_deref().ok_or_else(|| {
        AppError::BadRequest("该模型档案没有可用 API 密钥，请先编辑并保存密钥".into())
    })?;
    let api_key = String::from_utf8(base64_decode(encrypted_key)?)
        .map_err(|_| AppError::BadRequest("API 密钥编码无效".into()))?;
    cfg.model_profiles.active_profile_id = Some(id.clone());
    cfg.deepseek.api_key = api_key;
    cfg.deepseek.base_url = profile.base_url;
    cfg.deepseek.model = profile.model;
    cfg.normalize_deepseek_urls();
    cfg.save()?;
    drop(cfg);
    Ok(Json(json!({ "ok": true, "activeProfileId": id })))
}

/* ---------- RAG 卡片 ---------- */

/// GET /api/config/rag → 返回 RAG 配置。
pub async fn get_rag_config(State(state): State<SharedState>) -> Result<Json<Value>, AppError> {
    let cfg = state.config.read().await;
    Ok(Json(json!(cfg.rag)))
}

/// PUT /api/config/rag → 更新 RAG 配置并落盘。
pub async fn set_rag_config(
    State(state): State<SharedState>,
    Json(body): Json<RagConfig>,
) -> Result<Json<Value>, AppError> {
    let mut cfg = state.config.write().await;
    cfg.rag = body;
    cfg.save()?;
    let rag = cfg.rag.clone();
    drop(cfg);
    Ok(Json(json!(rag)))
}

/* ---------- 格式化卡片 ---------- */

/// GET /api/config/formatter → 返回格式化配置。
pub async fn get_formatter_config(
    State(state): State<SharedState>,
) -> Result<Json<Value>, AppError> {
    let cfg = state.config.read().await;
    Ok(Json(json!(cfg.formatter)))
}

/// PUT /api/config/formatter → 更新格式化配置并落盘。
pub async fn set_formatter_config(
    State(state): State<SharedState>,
    Json(body): Json<FormatterConfig>,
) -> Result<Json<Value>, AppError> {
    let mut cfg = state.config.write().await;
    cfg.formatter = body;
    cfg.save()?;
    let formatter = cfg.formatter.clone();
    drop(cfg);
    Ok(Json(json!(formatter)))
}

/* ---------- 缓存卡片 ---------- */

/// GET /api/config/cache → 返回缓存调试配置。
pub async fn get_cache_config(State(state): State<SharedState>) -> Result<Json<Value>, AppError> {
    let cfg = state.config.read().await;
    Ok(Json(json!(cfg.cache_debug)))
}

/// PUT /api/config/cache → 更新缓存调试配置并落盘。
pub async fn set_cache_config(
    State(state): State<SharedState>,
    Json(body): Json<CacheDebugConfig>,
) -> Result<Json<Value>, AppError> {
    let mut cfg = state.config.write().await;
    cfg.cache_debug = body;
    cfg.save()?;
    let cache_debug = cfg.cache_debug.clone();
    drop(cfg);
    Ok(Json(json!(cache_debug)))
}

/// 清空会话缓存请求体。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearCacheBody {
    pub session_id: String,
}

/// POST /api/config/cache/clear-session → 清空指定会话的字节稳定前缀缓存。
pub async fn clear_session_cache(
    State(state): State<SharedState>,
    Json(body): Json<ClearCacheBody>,
) -> Result<Json<Value>, AppError> {
    state.caches.remove(&body.session_id).await;
    tracing::info!("已清空会话缓存: {}", body.session_id);
    Ok(Json(json!({ "ok": true, "sessionId": body.session_id })))
}

/// 清空项目记忆请求体。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearMemoryBody {
    pub session_id: String,
}

/// POST /api/config/cache/clear-memory → 清空第二层项目持久记忆。
///
pub async fn clear_project_memory(
    State(state): State<SharedState>,
    Json(body): Json<ClearMemoryBody>,
) -> Result<Json<Value>, AppError> {
    state
        .sessions
        .clear_project_memory(&body.session_id)
        .await?;
    tracing::info!("已清空项目记忆: {}", body.session_id);
    Ok(Json(json!({ "ok": true, "sessionId": body.session_id })))
}

/* ---------- 外观卡片 ---------- */

/// GET /api/config/appearance → 返回外观配置。
pub async fn get_appearance(State(state): State<SharedState>) -> Result<Json<Value>, AppError> {
    let cfg = state.config.read().await;
    Ok(Json(json!(cfg.appearance)))
}

/// PUT /api/config/appearance → 更新外观配置并落盘。
pub async fn set_appearance(
    State(state): State<SharedState>,
    Json(body): Json<AppearanceConfig>,
) -> Result<Json<Value>, AppError> {
    let mut cfg = state.config.write().await;
    cfg.appearance = body;
    cfg.save()?;
    let appearance = cfg.appearance.clone();
    drop(cfg);
    Ok(Json(json!(appearance)))
}

/* ---------- 快捷键卡片 ---------- */

/// GET /api/config/shortcuts → 返回快捷键配置。
pub async fn get_shortcuts(State(state): State<SharedState>) -> Result<Json<Value>, AppError> {
    let cfg = state.config.read().await;
    Ok(Json(json!(cfg.shortcuts)))
}

/// PUT /api/config/shortcuts → 更新快捷键配置并落盘。
pub async fn set_shortcuts(
    State(state): State<SharedState>,
    Json(body): Json<ShortcutsConfig>,
) -> Result<Json<Value>, AppError> {
    let mut cfg = state.config.write().await;
    cfg.shortcuts = body;
    cfg.save()?;
    let shortcuts = cfg.shortcuts.clone();
    drop(cfg);
    Ok(Json(json!(shortcuts)))
}

/// POST /api/config/shortcuts → 重置快捷键为默认值。
pub async fn reset_shortcuts(State(state): State<SharedState>) -> Result<Json<Value>, AppError> {
    let mut cfg = state.config.write().await;
    cfg.shortcuts = ShortcutsConfig::default();
    cfg.save()?;
    let shortcuts = cfg.shortcuts.clone();
    drop(cfg);
    Ok(Json(json!({ "ok": true, "shortcuts": shortcuts })))
}

/* ---------- 安全卡片 ---------- */

/// GET /api/config/security → 返回安全配置。
pub async fn get_security(State(state): State<SharedState>) -> Result<Json<Value>, AppError> {
    let cfg = state.config.read().await;
    Ok(Json(json!(cfg.security)))
}

/// PUT /api/config/security → 更新安全配置并落盘。
pub async fn set_security(
    State(state): State<SharedState>,
    Json(body): Json<SecurityConfig>,
) -> Result<Json<Value>, AppError> {
    let mut cfg = state.config.write().await;
    cfg.security = body;
    cfg.save()?;
    let security = cfg.security.clone();
    drop(cfg);
    Ok(Json(json!(security)))
}

/// GET /api/config/security/export-audit → 导出审计日志。
///
/// 简化实现: 若配置了 audit_log_path 则尝试读取，否则返回空数组。
pub async fn export_audit_log(State(state): State<SharedState>) -> Result<Json<Value>, AppError> {
    let cfg = state.config.read().await;
    let path = cfg.security.audit_log_path.clone();
    drop(cfg);
    if let Some(p) = path {
        if !p.trim().is_empty() {
            if let Ok(text) = std::fs::read_to_string(&p) {
                let lines: Vec<&str> = text.lines().collect();
                return Ok(Json(
                    json!({ "log": text, "entries": lines, "count": lines.len() }),
                ));
            }
        }
    }
    Ok(Json(json!({ "log": "", "entries": [], "count": 0 })))
}

/* ============================================================
 * P2 补全 404 路由（2 个）
 * ============================================================ */

/// GET /api/config/cache/stats → 缓存实时统计（仪表盘用）。
///
/// 遍历 state.caches 聚合统计：
/// - hits = Σ hit_count
/// - misses = Σ miss_count
/// - hitRate = hits / (hits + misses)，全 0 时返回 0.0
/// - totalSessions = 缓存条目数
/// - fingerprint = 第一条缓存的前 4 层指纹（无缓存时为空字符串）
pub async fn get_cache_stats(State(state): State<SharedState>) -> Json<Value> {
    let caches = state.caches.list().await;
    let total_sessions = caches.len();
    let hits: u64 = caches.iter().map(|c| c.hit_count).sum();
    let misses: u64 = caches.iter().map(|c| c.miss_count).sum();
    let hit_rate = {
        let total = hits + misses;
        if total == 0 {
            0.0
        } else {
            hits as f64 / total as f64
        }
    };
    let fingerprint = caches
        .first()
        .map(|c| c.fingerprint.clone())
        .unwrap_or_default();
    Json(json!({
        "hitRate": hit_rate,
        "hits": hits,
        "misses": misses,
        "totalSessions": total_sessions,
        "fingerprint": fingerprint,
    }))
}

/// GET /api/model-profiles → 模型档案列表（前端 modelProfilesApi.list）。
///
/// 使用 smart_router::builtin_profiles() 作为内置档案来源。
pub async fn list_model_profiles(State(_state): State<SharedState>) -> Json<Value> {
    let profiles = crate::smart_router::builtin_profiles();
    Json(json!({ "profiles": profiles }))
}
