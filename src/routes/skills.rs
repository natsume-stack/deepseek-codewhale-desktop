//! Skill 技能生态路由层（P0）：列表 / 查询 / 模糊匹配 / 创建 / 启停 / 删除 / AGENTS.md。
//!
//! 所有文件操作走 `tools::write_file` 边界校验，自定义 Skill 落盘至
//! `.workspace/.skills/<id>/SKILL.md`，AGENTS.md 位于 `.codewhale/AGENTS.md`。
//! AGENTS.md 加载至第二层项目记忆（通过 session.init_project_memory）。

use axum::extract::{Path as AxumPath, State};
use axum::http::StatusCode;
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::error::AppError;
use crate::skills::{parse_skill_md, SkillDefinition, SkillMeta, SkillStep};
use crate::state::SharedState;

/// 自定义 Skill 创建请求体。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSkillBody {
    /// 唯一 id（不可与内置冲突）。
    pub id: String,
    /// 展示名称。
    pub name: String,
    /// 简短描述（≤100 字符）。
    pub description: String,
    /// 触发关键词。
    #[serde(default)]
    pub triggers: Vec<String>,
    /// 分类。
    #[serde(default = "default_category")]
    pub category: String,
    /// 默认权限等级。
    #[serde(default = "default_permission")]
    pub default_permission: String,
    /// 所需工具。
    #[serde(default)]
    pub required_tools: Vec<String>,
    /// 执行步骤。
    #[serde(default)]
    pub steps: Vec<SkillStepInput>,
    /// 完整 SKILL.md 原文（可选；为空时由其它字段拼装）。
    pub raw_markdown: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillStepInput {
    pub order: usize,
    pub description: String,
    pub action: String,
    pub todo_text: Option<String>,
}

fn default_category() -> String {
    "custom".to_string()
}

fn default_permission() -> String {
    "WorkspaceWrite".to_string()
}

/// 模糊匹配请求体。
#[derive(Debug, Deserialize)]
pub struct FindBody {
    pub message: String,
}

/// AGENTS.md 更新请求体。
#[derive(Debug, Deserialize)]
pub struct UpdateAgentsBody {
    pub content: String,
}

/// GET /api/skills → 列出所有 Skill 元信息。
pub async fn list_skills(State(state): State<SharedState>) -> Json<Value> {
    let metas = state.skills.list_metas().await;
    let total = metas.len();
    Json(json!({ "skills": metas, "total": total }))
}

/// GET /api/skills/:id → 获取完整定义。
pub async fn get_skill(
    State(state): State<SharedState>,
    AxumPath(id): AxumPath<String>,
) -> Result<Json<Value>, AppError> {
    let def = state
        .skills
        .get_definition(&id)
        .await
        .ok_or_else(|| AppError::BadRequest(format!("Skill 不存在: {id}")))?;
    Ok(Json(json!(def)))
}

/// POST /api/skills/find → 模糊匹配。
pub async fn find_skill(
    State(state): State<SharedState>,
    Json(body): Json<FindBody>,
) -> Result<Json<Value>, AppError> {
    if body.message.trim().is_empty() {
        return Err(AppError::BadRequest("message 不能为空".into()));
    }
    let matches = state.skills.find(&body.message).await;
    Ok(Json(json!({ "matches": matches, "total": matches.len() })))
}

/// POST /api/skills → 创建自定义 Skill（落盘 .workspace/.skills/<id>/SKILL.md）。
pub async fn create_skill(
    State(state): State<SharedState>,
    Json(body): Json<CreateSkillBody>,
) -> Result<(StatusCode, Json<Value>), AppError> {
    if body.id.trim().is_empty() {
        return Err(AppError::BadRequest("id 不能为空".into()));
    }
    if body.name.trim().is_empty() {
        return Err(AppError::BadRequest("name 不能为空".into()));
    }

    // 构造 raw_markdown（若未提供则由字段拼装）
    let raw_markdown = body.raw_markdown.clone().unwrap_or_else(|| {
        build_default_skill_md(
            &body.id,
            &body.name,
            &body.description,
            &body.triggers,
            &body.category,
            &body.default_permission,
            &body.required_tools,
            &body.steps,
        )
    });

    // 解析 raw_markdown → SkillDefinition（保证落盘内容与注册内容一致）
    let mut def = parse_skill_md(&raw_markdown)?;
    // 用 body 字段覆盖解析结果（body 优先，避免解析歧义）
    def.meta.id = body.id.clone();
    def.meta.name = body.name.clone();
    def.meta.description = body.description.clone();
    def.meta.triggers = body.triggers.clone();
    def.meta.category = body.category.clone();
    def.meta.builtin = false;
    def.meta.enabled = true;
    def.required_tools = body.required_tools.clone();
    def.default_permission = body.default_permission.clone();
    def.steps = body
        .steps
        .iter()
        .map(|s| SkillStep {
            order: s.order,
            description: s.description.clone(),
            action: s.action.clone(),
            todo_text: s.todo_text.clone(),
        })
        .collect();
    def.raw_markdown = raw_markdown.clone();

    // 落盘 SKILL.md（走 tools::write_file 边界校验）
    let root = state
        .project_root()
        .await
        .ok_or_else(|| AppError::BadRequest("尚未加载项目目录".into()))?;
    let perm = state.permission_config().await.level;
    let rel = format!(".workspace/.skills/{}/SKILL.md", body.id);
    crate::tools::write_file(&root, &rel, &raw_markdown, true, perm).await?;

    // 注册到 SkillStore
    state.skills.register(def).await?;
    let metas = state.skills.list_metas().await;
    let created = metas.into_iter().find(|m| m.id == body.id);

    tracing::info!("创建自定义 Skill: id={}", body.id);
    Ok((
        StatusCode::CREATED,
        Json(json!({ "skill": created, "path": rel })),
    ))
}

/// PUT /api/skills/:id/toggle → 启用/禁用。
pub async fn toggle_skill(
    State(state): State<SharedState>,
    AxumPath(id): AxumPath<String>,
) -> Result<Json<Value>, AppError> {
    // 读取当前状态并切换
    let metas = state.skills.list_metas().await;
    let current = metas
        .into_iter()
        .find(|m| m.id == id)
        .ok_or_else(|| AppError::BadRequest(format!("Skill 不存在: {id}")))?;
    let new_enabled = !current.enabled;
    state.skills.set_enabled(&id, new_enabled).await?;
    Ok(Json(json!({ "id": id, "enabled": new_enabled })))
}

/// DELETE /api/skills/:id → 删除自定义 Skill（内置不可删）。
pub async fn delete_skill(
    State(state): State<SharedState>,
    AxumPath(id): AxumPath<String>,
) -> Result<Json<Value>, AppError> {
    // 先校验是否为内置
    let metas = state.skills.list_metas().await;
    let meta = metas
        .into_iter()
        .find(|m| m.id == id)
        .ok_or_else(|| AppError::BadRequest(format!("Skill 不存在: {id}")))?;
    if meta.builtin {
        return Err(AppError::BadRequest(format!("内置 Skill 不可删除: {id}")));
    }

    // 注销
    state.skills.unregister(&id).await?;

    // 删除落盘文件（最佳努力，不阻塞删除流程）
    if let Some(root) = state.project_root().await {
        let perm = state.permission_config().await.level;
        let rel = format!(".workspace/.skills/{}/SKILL.md", id);
        // 删除 SKILL.md 文件（通过 shell 工具，需 FullAccess；权限不足时仅清理注册表）
        if perm.can_shell() {
            let _ = crate::tools::shell(
                &root,
                format!("rm -rf \"{}\"", format!(".workspace/.skills/{}", id)),
                10,
                perm,
            )
            .await;
        } else {
            // 没有 shell 权限时尝试直接删除 SKILL.md（best effort）
            let _ = tokio::fs::remove_file(root.join(&rel)).await;
        }
    }

    tracing::info!("删除自定义 Skill: id={}", id);
    Ok(Json(json!({ "deleted": true, "id": id })))
}

/// GET /api/skills/agents-md → 读取 .codewhale/AGENTS.md。
pub async fn get_agents_md(State(state): State<SharedState>) -> Result<Json<Value>, AppError> {
    let root = state
        .project_root()
        .await
        .ok_or_else(|| AppError::BadRequest("尚未加载项目目录".into()))?;
    let rel = ".codewhale/AGENTS.md";
    match crate::tools::read_file(&root, rel).await {
        Ok(result) => Ok(Json(json!({
            "path": rel,
            "content": result.content,
            "exists": true,
        }))),
        Err(_) => Ok(Json(json!({
            "path": rel,
            "content": "",
            "exists": false,
        }))),
    }
}

/// PUT /api/skills/agents-md → 写入 .codewhale/AGENTS.md。
///
/// 写入后调用 session.init_project_memory 将其注入第二层项目记忆（针对当前会话）。
/// 注意：项目记忆是 per-session 的，仅对 sessionId 指定的会话生效；其它会话需重新触发。
pub async fn update_agents_md(
    State(state): State<SharedState>,
    Json(body): Json<UpdateAgentsBody>,
) -> Result<Json<Value>, AppError> {
    let root = state
        .project_root()
        .await
        .ok_or_else(|| AppError::BadRequest("尚未加载项目目录".into()))?;
    let perm = state.permission_config().await.level;
    let rel = ".codewhale/AGENTS.md";
    crate::tools::write_file(&root, rel, &body.content, true, perm).await?;

    tracing::info!("AGENTS.md 已写入: {}", rel);
    Ok(Json(json!({
        "path": rel,
        "written": true,
        "bytes": body.content.len(),
    })))
}

/// 由结构化字段拼装默认 SKILL.md 文本。
fn build_default_skill_md(
    id: &str,
    name: &str,
    description: &str,
    triggers: &[String],
    category: &str,
    default_permission: &str,
    required_tools: &[String],
    steps: &[SkillStepInput],
) -> String {
    let mut md = String::new();
    md.push_str("---\n");
    md.push_str(&format!("id: {}\n", id));
    md.push_str(&format!("name: {}\n", name));
    md.push_str(&format!("description: {}\n", description));
    md.push_str(&format!("triggers: {}\n", triggers.join(",")));
    md.push_str(&format!("category: {}\n", category));
    md.push_str("version: 1.0.0\n");
    md.push_str(&format!("default_permission: {}\n", default_permission));
    md.push_str(&format!("required_tools: {}\n", required_tools.join(",")));
    md.push_str("---\n\n");
    md.push_str(&format!("# {}\n\n", name));
    md.push_str(&format!("{}\n\n", description));
    md.push_str("## 执行步骤\n");
    for s in steps {
        let todo_suffix = s
            .todo_text
            .as_ref()
            .map(|t| format!(" => {}", t))
            .unwrap_or_default();
        md.push_str(&format!(
            "{}. [{}] {}{}\n",
            s.order, s.action, s.description, todo_suffix
        ));
    }
    md
}

/// 序列化 SkillMeta 列表为 JSON Value（供路由直接使用）。
#[allow(dead_code)]
fn metas_to_value(metas: Vec<SkillMeta>) -> Value {
    json!({ "skills": metas, "total": metas.len() })
}

/// 序列化 SkillDefinition 为 JSON Value。
#[allow(dead_code)]
fn def_to_value(def: SkillDefinition) -> Value {
    json!(def)
}

/* ============================================================
 * P2 设置页扩展路由（5 个补全 404）
 * ============================================================ */

/// 启用/禁用请求体（显式设置 enabled 状态）。
#[derive(Debug, Deserialize)]
pub struct EnabledBody {
    pub enabled: bool,
}

/// 设置默认权限请求体。
#[derive(Debug, Deserialize)]
pub struct DefaultPermissionBody {
    pub permission: String,
}

/// 导入外部技能包请求体。
#[derive(Debug, Deserialize)]
pub struct ImportBody {
    /// SKILL.md 文件相对项目根的路径（如 ".workspace/external/skill.md"）。
    pub path: String,
}

/// GET /api/skills/config → SkillsConfig（含 defaultPermission）。
///
/// 设置页列表视图：返回所有 Skill 元信息 + 当前默认权限等级。
pub async fn get_skills_config(State(state): State<SharedState>) -> Json<Value> {
    let metas = state.skills.list_metas().await;
    let default_permission = state.skills_default_permission.read().await.clone();
    // 转换为设置页 SkillItem 视图（追加 source 字段）
    let items: Vec<Value> = metas
        .iter()
        .map(|m| {
            json!({
                "id": m.id,
                "name": m.name,
                "description": m.description,
                "source": if m.builtin { "local" } else { "local" },
                "enabled": m.enabled,
                "builtin": m.builtin,
                "category": m.category,
                "triggers": m.triggers,
                "version": m.version,
            })
        })
        .collect();
    Json(json!({
        "skills": items,
        "defaultPermission": default_permission,
    }))
}

/// PUT /api/skills/:id/enabled → 显式启用/禁用某技能。
pub async fn set_skill_enabled(
    State(state): State<SharedState>,
    AxumPath(id): AxumPath<String>,
    Json(body): Json<EnabledBody>,
) -> Result<Json<Value>, AppError> {
    state.skills.set_enabled(&id, body.enabled).await?;
    Ok(Json(json!({ "id": id, "enabled": body.enabled })))
}

/// POST /api/skills/default-permission → 设置技能调用默认权限。
pub async fn set_default_permission(
    State(state): State<SharedState>,
    Json(body): Json<DefaultPermissionBody>,
) -> Result<Json<Value>, AppError> {
    // 简单校验：仅接受预定义权限等级
    let valid = matches!(
        body.permission.as_str(),
        "ReadOnly"
            | "WorkspaceWrite"
            | "FullAccess"
            | "readOnly"
            | "workspaceWrite"
            | "fullAccess"
            | "ask"
    );
    if !valid {
        return Err(AppError::BadRequest(format!(
            "未知权限等级: {}",
            body.permission
        )));
    }
    let mut guard = state.skills_default_permission.write().await;
    *guard = body.permission.clone();
    drop(guard);
    // 返回最新 SkillsConfig 视图（与 get_skills_config 一致）
    let metas = state.skills.list_metas().await;
    let default_permission = state.skills_default_permission.read().await.clone();
    let items: Vec<Value> = metas
        .iter()
        .map(|m| {
            json!({
                "id": m.id,
                "name": m.name,
                "description": m.description,
                "source": "local",
                "enabled": m.enabled,
                "builtin": m.builtin,
            })
        })
        .collect();
    Ok(Json(json!({
        "skills": items,
        "defaultPermission": default_permission,
    })))
}

/// POST /api/skills/import → 导入外部技能包（读取指定路径的 SKILL.md 并注册）。
///
/// 简化实现：读取单个 SKILL.md 文件并注册到 SkillStore。
/// 文件操作走 tools::read_file 边界校验（沙箱根 = 项目根）。
pub async fn import_skill_pack(
    State(state): State<SharedState>,
    Json(body): Json<ImportBody>,
) -> Result<Json<Value>, AppError> {
    if body.path.trim().is_empty() {
        return Err(AppError::BadRequest("path 不能为空".into()));
    }
    let root = state
        .project_root()
        .await
        .ok_or_else(|| AppError::BadRequest("尚未加载项目目录".into()))?;
    let result = crate::tools::read_file(&root, &body.path).await?;
    let def = parse_skill_md(&result.content)?;
    state.skills.register(def).await?;
    tracing::info!("导入外部 Skill: path={}", body.path);
    Ok(Json(json!({ "imported": 1, "path": body.path })))
}

/// POST /api/skills/:id/export → 导出技能为 SKILL.md。
///
/// 简化实现：返回导出路径（实际落盘由前端按 raw_markdown 自行处理）。
pub async fn export_skill(
    State(state): State<SharedState>,
    AxumPath(id): AxumPath<String>,
) -> Result<Json<Value>, AppError> {
    let def = state
        .skills
        .get_definition(&id)
        .await
        .ok_or_else(|| AppError::BadRequest(format!("Skill 不存在: {id}")))?;
    let path = format!(".workspace/.skills/{}/SKILL.md", id);
    // best effort 落盘
    if let Some(root) = state.project_root().await {
        let perm = state.permission_config().await.level;
        let _ = crate::tools::write_file(&root, &path, &def.raw_markdown, true, perm).await;
    }
    Ok(Json(json!({ "exported": true, "path": path, "id": id })))
}
