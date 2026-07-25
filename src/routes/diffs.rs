//! Diff 管理路由层: 注册 / 列出 / 应用 / 拒绝 / 撤销 / 批量应用
//! 仅管理 Diff 状态与文件写入，不触碰 Agent 内核。
//!
//! 设计说明：
//! - 后端会话中的 Diff 项由 chat SSE 推送产生，前端通过 register_diff 显式注册
//! - 应用变更 = 将修改后内容写入磁盘
//! - 拒绝变更 = 标记为拒绝，不写入磁盘
//! - 撤销变更 = 将原始内容回写磁盘（如果已应用）

use axum::extract::{Path as AxumPath, State};
use axum::http::StatusCode;
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::RwLock;

use crate::error::AppError;
use crate::state::SharedState;

/// 单个 Diff 项的运行时状态。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffEntry {
    pub id: String,
    pub file_path: String,
    pub original_content: Option<String>,
    pub modified_content: String,
    pub status: DiffStatus,
    pub created_at: u64,
    /// Hunk 粒度列表（Option 兼容旧数据：未计算 hunks 时为 None）。
    pub hunks: Option<Vec<crate::diff::Hunk>>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum DiffStatus {
    Pending,
    Applied,
    Rejected,
    Reverted,
}

/// 全局 Diff 注册表（按 session_id 分组）。
/// 仅存活于进程内存，重启后丢失（与 CodeWhale 会话语义一致）。
pub type DiffRegistry = Arc<RwLock<HashMap<String, Vec<DiffEntry>>>>;

/// 注册新 Diff 请求体。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterDiffBody {
    pub session_id: Option<String>,
    pub file_path: String,
    pub original_content: Option<String>,
    pub modified_content: String,
}

/// POST /api/diffs
/// 注册一个新的 Diff（通常由 chat 内核在生成代码后内部调用，前端也可手动注册）。
pub async fn register_diff(
    State(state): State<SharedState>,
    Json(body): Json<RegisterDiffBody>,
) -> Result<(StatusCode, Json<Value>), AppError> {
    let root = state
        .project_root()
        .await
        .ok_or_else(|| AppError::BadRequest("尚未加载项目目录".into()))?;
    let target = PathBuf::from(&body.file_path);
    validate_within_root(&target, &root)?;

    // sessionId 缺省时归入 "default" 桶，便于前端在会话尚未建立时也能注册 Diff
    let session_id = body.session_id.clone().unwrap_or_else(|| "default".to_string());
    let id = format!(
        "diff_{}_{}",
        session_id,
        chrono::Utc::now().timestamp_millis()
    );

    // 原始内容缺省时自动读取磁盘文件当前内容，保证后续 revert 可回退
    let original_content = match body.original_content.clone() {
        Some(c) => Some(c),
        None => match std::fs::read_to_string(&target) {
            Ok(c) => Some(c),
            Err(_) => None, // 文件不存在（新建文件场景）
        },
    };

    // 计算 hunk 列表：当原始内容与修改后内容均存在时调用 diff_hunks
    let hunks = original_content
        .as_ref()
        .map(|old| crate::diff::diff_hunks(old, &body.modified_content));

    let entry = DiffEntry {
        id: id.clone(),
        file_path: body.file_path.clone(),
        original_content,
        modified_content: body.modified_content.clone(),
        status: DiffStatus::Pending,
        created_at: chrono::Utc::now().timestamp() as u64,
        hunks,
    };

    let mut map = state.diffs.write().await;
    map.entry(session_id.clone()).or_default().push(entry);

    tracing::info!("注册 Diff: id={}, file={}, session={}", id, body.file_path, session_id);
    Ok((
        StatusCode::CREATED,
        Json(json!({
            "id": id,
            "filePath": body.file_path,
            "status": "pending",
            "sessionId": session_id,
        })),
    ))
}

/// GET /api/diffs/:session_id
/// 列出指定会话的全部 Diff 项。
pub async fn list_diffs(
    State(state): State<SharedState>,
    AxumPath(session_id): AxumPath<String>,
) -> Result<Json<Value>, AppError> {
    let map = state.diffs.read().await;
    let entries = map.get(&session_id).cloned().unwrap_or_default();
    Ok(Json(json!({
        "sessionId": session_id,
        "diffs": entries,
        "total": entries.len(),
        "pending": entries.iter().filter(|e| e.status == DiffStatus::Pending).count(),
        "applied": entries.iter().filter(|e| e.status == DiffStatus::Applied).count(),
        "rejected": entries.iter().filter(|e| e.status == DiffStatus::Rejected).count(),
    })))
}

/// POST /api/diffs/:id/apply
/// 应用指定 Diff：将修改后内容写入磁盘，标记为 Applied。
pub async fn apply_diff(
    State(state): State<SharedState>,
    AxumPath(diff_id): AxumPath<String>,
) -> Result<Json<Value>, AppError> {
    let root = state
        .project_root()
        .await
        .ok_or_else(|| AppError::BadRequest("尚未加载项目目录".into()))?;

    let mut map = state.diffs.write().await;
    let entry = find_diff_mut(&mut map, &diff_id)?
        .ok_or_else(|| AppError::BadRequest(format!("Diff 不存在: {diff_id}")))?;

    if entry.status != DiffStatus::Pending {
        return Err(AppError::BadRequest(format!(
            "Diff 状态不允许应用: {:?}",
            entry.status
        )));
    }

    let target = PathBuf::from(&entry.file_path);
    validate_within_root(&target, &root)?;

    // 确保父目录存在
    if let Some(p) = target.parent() {
        std::fs::create_dir_all(p)
            .map_err(|e| AppError::BadRequest(format!("创建父目录失败: {e}")))?;
    }

    std::fs::write(&target, &entry.modified_content)
        .map_err(|e| AppError::BadRequest(format!("应用 Diff 失败: {e}")))?;

    entry.status = DiffStatus::Applied;
    tracing::info!("已应用 Diff: id={}, file={}", diff_id, entry.file_path);

    Ok(Json(json!({
        "id": diff_id,
        "filePath": entry.file_path,
        "status": "applied",
    })))
}

/// POST /api/diffs/:id/reject
/// 拒绝指定 Diff：标记为 Rejected，不写入磁盘。
pub async fn reject_diff(
    State(state): State<SharedState>,
    AxumPath(diff_id): AxumPath<String>,
) -> Result<Json<Value>, AppError> {
    let mut map = state.diffs.write().await;
    let entry = find_diff_mut(&mut map, &diff_id)?
        .ok_or_else(|| AppError::BadRequest(format!("Diff 不存在: {diff_id}")))?;

    if entry.status != DiffStatus::Pending {
        return Err(AppError::BadRequest(format!(
            "Diff 状态不允许拒绝: {:?}",
            entry.status
        )));
    }

    entry.status = DiffStatus::Rejected;
    tracing::info!("已拒绝 Diff: id={}", diff_id);

    Ok(Json(json!({
        "id": diff_id,
        "status": "rejected",
    })))
}

/// POST /api/diffs/:id/revert
/// 撤销已应用的 Diff：将原始内容回写磁盘，标记为 Reverted。
pub async fn revert_diff(
    State(state): State<SharedState>,
    AxumPath(diff_id): AxumPath<String>,
) -> Result<Json<Value>, AppError> {
    let root = state
        .project_root()
        .await
        .ok_or_else(|| AppError::BadRequest("尚未加载项目目录".into()))?;

    let mut map = state.diffs.write().await;
    let entry = find_diff_mut(&mut map, &diff_id)?
        .ok_or_else(|| AppError::BadRequest(format!("Diff 不存在: {diff_id}")))?;

    if entry.status != DiffStatus::Applied {
        return Err(AppError::BadRequest(format!(
            "Diff 状态不允许撤销: {:?}",
            entry.status
        )));
    }

    let original = entry
        .original_content
        .clone()
        .ok_or_else(|| AppError::BadRequest("无原始内容，无法撤销".into()))?;

    let target = PathBuf::from(&entry.file_path);
    validate_within_root(&target, &root)?;

    if original.is_empty() {
        // 原始内容为空 = 新建文件，撤销则删除
        let _ = std::fs::remove_file(&target);
    } else {
        std::fs::write(&target, &original)
            .map_err(|e| AppError::BadRequest(format!("撤销 Diff 失败: {e}")))?;
    }

    entry.status = DiffStatus::Reverted;
    tracing::info!("已撤销 Diff: id={}, file={}", diff_id, entry.file_path);

    Ok(Json(json!({
        "id": diff_id,
        "filePath": entry.file_path,
        "status": "reverted",
    })))
}

/// POST /api/diffs/apply-all
/// 批量应用指定会话下所有 Pending 状态的 Diff。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyAllBody {
    pub session_id: Option<String>,
}

pub async fn apply_all_diffs(
    State(state): State<SharedState>,
    Json(body): Json<ApplyAllBody>,
) -> Result<Json<Value>, AppError> {
    let root = state
        .project_root()
        .await
        .ok_or_else(|| AppError::BadRequest("尚未加载项目目录".into()))?;

    let session_id = body.session_id.clone().unwrap_or_else(|| "default".to_string());

    let mut map = state.diffs.write().await;
    let entries = map
        .get_mut(&session_id)
        .ok_or_else(|| AppError::BadRequest(format!("会话不存在: {}", session_id)))?;

    let mut applied: Vec<String> = Vec::new();
    let mut failed = 0u32;
    let mut errors: Vec<String> = Vec::new();

    for entry in entries.iter_mut() {
        if entry.status != DiffStatus::Pending {
            continue;
        }
        let target = PathBuf::from(&entry.file_path);
        if let Err(e) = validate_within_root(&target, &root) {
            failed += 1;
            errors.push(format!("{}: {}", entry.file_path, e));
            continue;
        }
        if let Some(p) = target.parent() {
            if let Err(e) = std::fs::create_dir_all(p) {
                failed += 1;
                errors.push(format!("{}: 创建父目录失败: {e}", entry.file_path));
                continue;
            }
        }
        match std::fs::write(&target, &entry.modified_content) {
            Ok(_) => {
                entry.status = DiffStatus::Applied;
                applied.push(entry.id.clone());
            }
            Err(e) => {
                failed += 1;
                errors.push(format!("{}: {e}", entry.file_path));
            }
        }
    }

    tracing::info!(
        "批量应用 Diff: session={}, applied={}, failed={}",
        session_id,
        applied.len(),
        failed
    );

    Ok(Json(json!({
        "sessionId": session_id,
        "applied": applied,
        "failed": failed,
        "errors": errors,
    })))
}

/// POST /api/diffs/:id/hunks/:hunk_index/apply
/// 应用指定 Diff 的单个 hunk：读取磁盘当前内容，应用 hunk，写回磁盘。
///
/// 注意：hunk.old_start 引用原始文件行号，若已有其他 hunk 应用过，
/// 需根据已应用 hunk 的累计行号偏移调整 old_start。
pub async fn apply_hunk_handler(
    State(state): State<SharedState>,
    AxumPath((diff_id, hunk_index)): AxumPath<(String, usize)>,
) -> Result<Json<Value>, AppError> {
    let root = state
        .project_root()
        .await
        .ok_or_else(|| AppError::BadRequest("尚未加载项目目录".into()))?;

    let mut map = state.diffs.write().await;
    let entry = find_diff_mut(&mut map, &diff_id)?
        .ok_or_else(|| AppError::BadRequest(format!("Diff 不存在: {diff_id}")))?;

    // 检查 hunk 存在性与状态
    let hunks = entry
        .hunks
        .as_ref()
        .ok_or_else(|| AppError::BadRequest("该 Diff 无 hunk 信息".into()))?;
    if hunk_index >= hunks.len() {
        return Err(AppError::BadRequest(format!("hunk 索引越界: {hunk_index}")));
    }
    if hunks[hunk_index].status != "pending" {
        return Err(AppError::BadRequest(format!(
            "hunk 状态不允许应用: {}",
            hunks[hunk_index].status
        )));
    }

    let file_path = entry.file_path.clone();
    let current_old_start = hunks[hunk_index].old_start;

    // 计算已应用 hunk 的累计行号偏移（仅 old_start 更靠前的已应用 hunk）
    let offset: i64 = hunks
        .iter()
        .filter(|h| h.status == "applied" && h.old_start < current_old_start)
        .map(|h| h.new_lines as i64 - h.old_lines as i64)
        .sum();

    // 克隆 hunk 并调整 old_start 以匹配磁盘当前内容
    let mut adjusted_hunk = hunks[hunk_index].clone();
    adjusted_hunk.old_start =
        ((adjusted_hunk.old_start as i64) + offset).max(1) as usize;

    // 读取磁盘当前文件内容
    let target = PathBuf::from(&file_path);
    validate_within_root(&target, &root)?;
    let current_content = std::fs::read_to_string(&target).unwrap_or_default();

    // 应用 hunk
    let new_content = crate::diff::apply_hunk(&current_content, &adjusted_hunk);

    // 写回磁盘
    if let Some(p) = target.parent() {
        std::fs::create_dir_all(p)
            .map_err(|e| AppError::BadRequest(format!("创建父目录失败: {e}")))?;
    }
    std::fs::write(&target, &new_content)
        .map_err(|e| AppError::BadRequest(format!("应用 hunk 失败: {e}")))?;

    // 更新 hunk 状态，若全部 applied 则更新 DiffEntry 状态
    let all_applied = {
        let hunks = entry.hunks.as_mut().unwrap();
        hunks[hunk_index].status = "applied".into();
        hunks.iter().all(|h| h.status == "applied")
    };
    if all_applied {
        entry.status = DiffStatus::Applied;
    }

    tracing::info!("已应用 hunk: diff={}, hunk={}", diff_id, hunk_index);
    Ok(Json(json!({
        "id": diff_id,
        "hunkIndex": hunk_index,
        "status": "applied",
    })))
}

/// POST /api/diffs/:id/hunks/:hunk_index/reject
/// 拒绝指定 Diff 的单个 hunk：仅标记状态，不写磁盘。
/// 若所有 hunk 均 rejected/applied，则把 DiffEntry 状态改为 Rejected。
pub async fn reject_hunk_handler(
    State(state): State<SharedState>,
    AxumPath((diff_id, hunk_index)): AxumPath<(String, usize)>,
) -> Result<Json<Value>, AppError> {
    let mut map = state.diffs.write().await;
    let entry = find_diff_mut(&mut map, &diff_id)?
        .ok_or_else(|| AppError::BadRequest(format!("Diff 不存在: {diff_id}")))?;

    // 检查 hunk 存在性与状态
    let hunks = entry
        .hunks
        .as_ref()
        .ok_or_else(|| AppError::BadRequest("该 Diff 无 hunk 信息".into()))?;
    if hunk_index >= hunks.len() {
        return Err(AppError::BadRequest(format!("hunk 索引越界: {hunk_index}")));
    }
    if hunks[hunk_index].status != "pending" {
        return Err(AppError::BadRequest(format!(
            "hunk 状态不允许拒绝: {}",
            hunks[hunk_index].status
        )));
    }

    // 更新 hunk 状态，若全部 rejected/applied 则标记 DiffEntry 为 Rejected
    let all_done = {
        let hunks = entry.hunks.as_mut().unwrap();
        hunks[hunk_index].status = "rejected".into();
        hunks
            .iter()
            .all(|h| h.status == "rejected" || h.status == "applied")
    };
    if all_done {
        entry.status = DiffStatus::Rejected;
    }

    tracing::info!("已拒绝 hunk: diff={}, hunk={}", diff_id, hunk_index);
    Ok(Json(json!({
        "id": diff_id,
        "hunkIndex": hunk_index,
        "status": "rejected",
    })))
}

/// 在 Diff 注册表中查找指定 ID 的可变引用。
fn find_diff_mut<'a>(
    map: &'a mut HashMap<String, Vec<DiffEntry>>,
    diff_id: &str,
) -> Result<Option<&'a mut DiffEntry>, AppError> {
    for entries in map.values_mut() {
        if let Some(pos) = entries.iter().position(|e| e.id == diff_id) {
            return Ok(Some(&mut entries[pos]));
        }
    }
    Ok(None)
}

/// 校验目标路径必须位于项目根之内（防止路径穿越）。
/// 目标文件可能尚不存在，此时校验其父目录。
fn validate_within_root(target: &Path, root: &Path) -> Result<(), AppError> {
    let canonical_root = root
        .canonicalize()
        .map_err(|e| AppError::BadRequest(format!("项目根无效: {e}")))?;

    let check_path: PathBuf = if target.exists() {
        target
            .canonicalize()
            .map_err(|e| AppError::BadRequest(format!("路径无效: {e}")))?
    } else if let Some(parent) = target.parent() {
        parent
            .canonicalize()
            .map_err(|e| AppError::BadRequest(format!("父目录无效: {e}")))?
            .join(target.file_name().unwrap_or_default())
    } else {
        canonical_root.clone()
    };

    if !check_path.starts_with(&canonical_root) {
        return Err(AppError::BadRequest(format!(
            "路径越界: {} 不在项目根 {} 之内",
            target.display(),
            canonical_root.display()
        )));
    }
    Ok(())
}
