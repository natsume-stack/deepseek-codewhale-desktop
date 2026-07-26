//! 对话端点: POST /api/chat (SSE 流式), POST /api/chat/stop (中断)
//!
//! SSE 事件:
//!   event: session       data: {"sessionId":"..."}
//!   event: delta         data: {"content":"增量文本"}
//!   event: reasoning     data: {"content":"推理增量"}   (deepseek-reasoner)
//!   event: finish        data: {"finishReason":"stop"}
//!   event: cache_stats   data: {"hitRate":0.9,"hits":3,"misses":1}   (Reasonix P0+)
//!   event: error         data: {"message":"..."}
//!   event: done          data: {"sessionId":"..."}
//!
//! 客户端断连时, 后台转发任务会取消 DeepSeek 流并落地已累积内容, 避免会话卡在 running 状态。
//!
//! Reasonix 集成（P0+）：
//!   - 每轮 start_chat 会调用 `sessions.ensure_cache(session_id, system_prefix)` 初始化字节稳定前缀缓存
//!   - 附件挂载走 `sessions.mount_file`，进入第 3 层 mounted_files（会话期间不可变）
//!   - message_snapshot 自动从 cache 构建分层上下文（system + history + current_message）
//!   - finish 事件后追加 cache_stats 事件，推送命中率统计

use axum::extract::State;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::Json;
use futures_util::Stream;
use serde::Deserialize;
use serde_json::json;
use std::io;
use tokio::sync::mpsc;

use crate::config::ReasoningEffort;
use crate::deepseek::{ChatRequest as DsChatRequest, DEFAULT_AGENT_SYSTEM_PROMPT};
use crate::error::AppError;
use crate::state::SharedState;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatRequestBody {
    /// 用户本轮输入 (必填)
    pub message: String,
    /// 复用已有会话; 为空则新建
    pub session_id: Option<String>,
    /// 注入到消息历史首部的 system prompt
    pub system_prompt: Option<String>,
    pub max_tokens: Option<u32>,
    pub temperature: Option<f32>,
    /// 本轮覆盖推理强度
    pub reasoning_effort: Option<ReasoningEffort>,
    /// 本轮覆盖缓存开关
    pub cache_enabled: Option<bool>,
    /// 本轮覆盖上下文长度
    pub context_length: Option<usize>,
    /// P0-5: 斜杠指令（/refactor /test /explain /fix），注入对应系统提示前缀。
    pub slash_command: Option<String>,
    /// P0-6: @文件挂载附件列表（项目相对路径），读取后以 <attachment> 块拼接到消息末尾。
    pub attachments: Option<Vec<String>>,
    /// Agent 模式（参考 Cline/Roo Code）：
    ///   - "plan"：Plan 模式，只读分析+输出实施计划，强制 ReadOnly 权限，禁止写/Shell
    ///   - "act"：Act 模式（默认），按当前权限等级执行修改
    pub mode: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StopRequest {
    pub session_id: String,
}

pub async fn start_chat(
    State(state): State<SharedState>,
    Json(req): Json<ChatRequestBody>,
) -> Result<Sse<impl Stream<Item = Result<Event, io::Error>> + Send>, AppError> {
    if req.message.trim().is_empty() {
        return Err(AppError::BadRequest("message 不能为空".into()));
    }

    // 1. 解析 / 创建会话
    let session = match req.session_id.as_deref() {
        Some(id) if !id.is_empty() => state
            .sessions
            .get(id)
            .await
            .ok_or_else(|| AppError::SessionNotFound(id.to_string()))?,
        _ => {
            let project = state.project_root().await;
            state.sessions.create(project).await
        }
    };
    let session_id = session.id.clone();

    // 2. Reasonix P0+: 初始化字节稳定前缀缓存（system 全程不可变）
    // P0-1: Agent 系统提示固化。
    //   - 用户未传 system_prompt：注入默认 Agent 提示（强制约束代码块路径、增量修改、代办拆解等）
    //   - 用户传了 system_prompt：默认提示 + "\n\n" + 用户自定义（保留强制约束，允许追加场景指令）
    let mut system_prefix = match req.system_prompt.as_deref() {
        None | Some("") => DEFAULT_AGENT_SYSTEM_PROMPT.to_string(),
        Some(custom) => format!("{DEFAULT_AGENT_SYSTEM_PROMPT}\n\n{custom}"),
    };

    // P0-1+ 兜底：把项目根路径直接追加到 system_prefix 末尾。
    //   - 不依赖 init_project_memory（避免 let _ = 吞错导致 AI 看不到项目路径）。
    //   - 即便会话已存在 project_memory，system_prefix 中的兜底也能保证 AI 第一轮就看到项目路径。
    //   - 注意：会破坏字节稳定前缀缓存命中（system_prefix 随项目根变化），但优先保证功能正确。
    let root_opt = state.project_root().await;
    if let Some(root) = &root_opt {
        system_prefix.push_str(&format!(
            "\n\n# 当前项目根路径（兜底注入）\n{}\n（请基于此路径解析所有相对路径，严禁回复未提供项目路径）",
            root.display()
        ));
    }

    // Plan/Act 模式注入（参考 Cline/Roo Code）：
    //   - Plan 模式：注入只读分析提示，并在本轮临时覆盖权限为 ReadOnly
    //   - Act 模式：注入执行提示，使用当前配置的权限等级
    let mode = req.mode.as_deref().unwrap_or("act").to_lowercase();
    let is_plan_mode = mode == "plan";
    if is_plan_mode {
        system_prefix.push_str(r#"

# 当前 Agent 模式：Plan（规划模式）
你当前处于 Plan 模式，**严禁调用任何写工具**（write_file/edit_file/shell/git 写操作）。
仅可使用只读工具：read_file / list_files / search_files / git(只读子命令) / ask_followup_question / attempt_completion。

Plan 模式职责：
1. 充分使用只读工具调研项目结构、阅读关键文件、搜索相关代码
2. 输出详细的实施计划，包括：要修改的文件、修改内容概述、潜在风险、验证方式
3. 使用 attempt_completion 收尾，结果为完整的实施计划文本
4. 等待用户切换到 Act 模式后再执行实际修改

严禁在 Plan 模式下输出 write_file/edit_file/shell 工具调用，否则会被权限系统拒绝。
"#);
        // 临时覆盖权限为 ReadOnly（仅本轮，不持久化到配置）
        let mut perm_cfg = state.permission_config().await;
        perm_cfg.level = crate::config::PermissionLevel::ReadOnly;
        // 注：permission_config 返回的是克隆，这里覆盖不会影响全局配置
        // execute_dsml_tool 会重新读取 state.permission_config()，所以需要另一种方式
        // 简化处理：在 execute_dsml_tool 中通过 call.required_permission 判断，
        // Plan 模式下 write_file/edit_file/shell 的 required_permission 会被系统提示阻止
        // 后端额外校验：在 execute_dsml_tool 中检查 mode 标记
    } else {
        system_prefix.push_str(r#"

# 当前 Agent 模式：Act（执行模式）
你当前处于 Act 模式，可以调用所有工具（受当前权限等级限制）。
Act 模式职责：
1. 基于 Plan（若有）执行实际修改
2. 优先使用 edit_file 增量编辑而非 write_file 整文件重写
3. 修改完成后用 attempt_completion 收尾，说明变更内容
"#);
    }
    let is_plan_mode_for_loop = is_plan_mode;

    // 在 SharedState.caches 中登记（用于跨会话查询/统计），同时初始化 session.cache
    let _ = state.caches.get_or_init(&session_id, system_prefix.clone()).await;
    state.sessions.ensure_cache(&session_id, system_prefix.clone()).await?;

    // P0-1+: 将当前项目根目录、Git 分支、git status、最近修改文件注入第二层 project_memory。
    //   - 增强内容：项目根 + Git 分支 + git status 摘要 + 最近 5 条 commit + 最近修改文件
    //   - 失败时显式告警并兜底追加到 system_prefix（避免 let _ = 吞错）。
    if let Some(root) = root_opt.as_ref() {
        let root_display = root.display().to_string();
        let perm_cfg = state.permission_config().await;

        // 并行读取 git 信息（任一失败不影响其他）
        let branch_info = match crate::tools::git(
            root,
            vec!["rev-parse".to_string(), "--abbrev-ref".to_string(), "HEAD".to_string()],
            perm_cfg.level,
        ).await {
            Ok(r) if r.success => {
                let b = r.stdout.trim().to_string();
                if b.is_empty() || b == "HEAD" { "(detached)".to_string() } else { b }
            }
            _ => "(unknown)".to_string(),
        };

        let status_info = match crate::tools::git(
            root,
            vec!["status".to_string(), "--short".to_string()],
            perm_cfg.level,
        ).await {
            Ok(r) if r.success => {
                let s = r.stdout.trim();
                if s.is_empty() { "工作区干净".to_string() } else { s.to_string() }
            }
            _ => "(unknown)".to_string(),
        };

        let recent_commits = match crate::tools::git(
            root,
            vec!["log".to_string(), "--oneline".to_string(), "-n".to_string(), "5".to_string()],
            perm_cfg.level,
        ).await {
            Ok(r) if r.success => r.stdout.trim().to_string(),
            _ => "(unknown)".to_string(),
        };

        let recent_files = match crate::tools::git(
            root,
            vec!["log".to_string(), "--name-only".to_string(), "--pretty=format:".to_string(), "-n".to_string(), "10".to_string()],
            perm_cfg.level,
        ).await {
            Ok(r) if r.success => {
                let s = r.stdout.trim();
                if s.is_empty() { "(无)".to_string() } else { s.to_string() }
            }
            _ => "(unknown)".to_string(),
        };

        let memory = format!(
            "# 当前工作目录\n项目根: {root_display}\nGit 分支: {branch_info}\n\n## Git Status\n{status_info}\n\n## 最近 5 条 Commit\n{recent_commits}\n\n## 最近修改文件\n{recent_files}\n\n请基于此项目根路径解析相对路径，进行文件读写与代码修改。"
        );

        // 显式处理错误：失败时记录日志并兜底追加到 system_prefix
        if let Err(e) = state.sessions.init_project_memory(&session_id, memory.clone()).await {
            tracing::warn!("注入 project_memory 失败 (session={}): {e}", session_id);
            // 兜底：把 memory 追加到 system_prefix（虽然破坏字节稳定，但保证 AI 看到项目信息）
            // 注意：此时 system_prefix 已被 ensure_cache 使用，需要重新 init cache
            tracing::warn!("兜底：将 project_memory 追加到 system_prefix 并重新 init cache");
            let mut new_prefix = system_prefix.clone();
            new_prefix.push_str("\n\n[PROJECT_MEMORY]\n");
            new_prefix.push_str(&memory);
            let _ = state.caches.get_or_init(&session_id, new_prefix.clone()).await;
            let _ = state.sessions.ensure_cache(&session_id, new_prefix).await;
        }
    }

    // 3. 附件挂载 → 进入 cache.mounted_files（第 3 层，会话期间不可变）
    //    P0-6 @文件挂载：读取后挂载到缓存层，不再拼接到 user message，
    //    从而保持 current_message（第 5 层）字节精简，最大化前缀命中。
    if let Some(attachments) = req.attachments.as_ref() {
        if !attachments.is_empty() {
            if let Some(root) = state.project_root().await {
                for rel in attachments {
                    match crate::tools::read_file(&root, rel).await {
                        Ok(result) => {
                            // 单文件超 50KB 或二进制时 mount_file 会返回错误，仅告警不中断
                            if let Err(e) = state
                                .sessions
                                .mount_file(&session_id, result.path.clone(), result.content.clone())
                                .await
                            {
                                tracing::warn!("挂载附件到缓存失败 {}: {e}", rel);
                            }
                        }
                        Err(e) => {
                            tracing::warn!("读取附件失败 {}: {e}", rel);
                        }
                    }
                }
            }
        }
    }

    // 4. 写入用户消息（P0-5 斜杠指令前缀）
    let mut final_message = String::new();
    let slash_prefix = match req.slash_command.as_deref() {
        Some("/refactor") => Some("请对以下代码进行重构，输出最小增量修改："),
        Some("/test") => Some("请为以下代码补充单元测试："),
        Some("/explain") => Some("请解释以下代码："),
        Some("/fix") => Some("请定位并修复以下代码中的 bug："),
        Some("/search") => Some("请在当前项目中搜索相关代码片段并分析："),
        Some("/task") => Some("请将以下任务拆解为可执行的子任务（输出 todo 列表）："),
        Some("/plan") => Some("请基于以下需求生成实施计划（仅规划，不修改代码）："),
        Some("/commit") => Some("请基于以下变更说明生成 Conventional Commits 提交信息（仅输出 commit message，不执行 git）："),
        _ => None,
    };
    if let Some(p) = slash_prefix {
        final_message.push_str(p);
        final_message.push('\n');
    }
    final_message.push_str(&req.message);
    state
        .sessions
        .push_user_message(&session_id, final_message)
        .await?;

    // 5. 开启推理轮次, 取消令牌
    let cancel = state.sessions.start_turn(&session_id).await?;
    let mut cancel_for_task = cancel.clone();

    // 6. 构造消息快照（cache 存在时按分层顺序构建：system+memory+files / history / current）
    let inference = state.inference_defaults().await;
    let reasoning_effort = req.reasoning_effort.unwrap_or(inference.reasoning_effort);
    let cache_enabled = req.cache_enabled.unwrap_or(inference.cache_enabled);
    let context_length = req.context_length.unwrap_or(inference.context_length);

    // cache 已存在并初始化时，system_prefix 由 cache 提供，传入 None 走旧路径回退
    let snapshot_system = match state.sessions.get(&session_id).await {
        Some(ref s) if s.cache.as_ref().map(|c| !c.system_prefix.is_empty()).unwrap_or(false) => None,
        _ => Some(system_prefix),
    };
    let mut messages = state
        .sessions
        .message_snapshot(&session_id, context_length, snapshot_system)
        .await?;

    // P0 Skill 生态：skill_find 模糊匹配，命中时临时注入技能上下文（不修改第一层缓存）。
    //   - 仅取 score > 0.5 的首个命中
    //   - raw_markdown 追加到 system 消息末尾，本轮临时拼接，下一轮自动失效
    //   - 解析 steps 中的 todo_text 推送代办
    let skill_match_info: Option<crate::skills::SkillMatch> = {
        let hits = state.skills.find(&req.message).await;
        hits.into_iter().find(|h| h.score > 0.5)
    };
    let mut skill_todos_pushed: Option<Vec<crate::state::TodoItem>> = None;
    if let Some(ref m) = skill_match_info {
        if let Some(def) = state.skills.get_definition(&m.skill_id).await {
            // 将 raw_markdown 追加到 system 消息末尾（本轮临时拼接）
            if let Some(first) = messages.first_mut() {
                if first.role == crate::deepseek::ChatRole::System {
                    first.content.push_str("\n\n# 临时技能上下文\n");
                    first.content.push_str(&def.raw_markdown);
                }
            }
            // 解析 steps 中的 todo_text，推送代办
            let todo_texts: Vec<String> = def
                .steps
                .iter()
                .filter_map(|s| s.todo_text.clone())
                .filter(|t| !t.is_empty())
                .collect();
            if !todo_texts.is_empty() {
                let items = state
                    .todos
                    .add_batch(Some(session_id.clone()), todo_texts)
                    .await;
                skill_todos_pushed = Some(items);
            }
        }
    }

    // 7. 发起 DeepSeek 流式请求
    let ds_cfg = state.deepseek_config().await;
    let chat_req = DsChatRequest {
        model: ds_cfg.model.clone(),
        messages,
        reasoning_effort,
        enable_cache: cache_enabled,
        max_tokens: req.max_tokens,
        temperature: req.temperature,
    };

    let mut rx = match state.client.chat_stream(chat_req, &ds_cfg, cancel).await {
        Ok(r) => r,
        Err(e) => {
            // 清理: 释放 running 状态
            let _ = state
                .sessions
                .finish_turn(&session_id, String::new())
                .await;
            return Err(e);
        }
    };

    // 8. 后台转发任务: DeepSeek 增量 -> SSE 事件, 累积内容, 结束后落地 + 推送 cache_stats
    let (tx_sse, mut rx_sse) = mpsc::channel::<Event>(64);

    // P0 Skill 生态：在 DeepSeek 流之前推送 skill_match 事件与技能 todos（一次性）
    if let Some(m) = skill_match_info {
        let ev = Event::default()
            .event("skill_match")
            .data(json!({
                "skillId": m.skill_id,
                "skillName": m.skill_name,
                "score": m.score,
                "matchedKeywords": m.matched_keywords,
            }).to_string());
        let _ = tx_sse.send(ev).await;
    }
    if let Some(items) = skill_todos_pushed {
        let ev = Event::default()
            .event("todos")
            .data(json!({ "items": items }).to_string());
        let _ = tx_sse.send(ev).await;
    }

    let sessions = state.sessions.clone();
    let todos_store = state.todos.clone();
    let approvals_store = state.approvals.clone();
    let shared_state_for_loop = state.clone();
    let sid = session_id.clone();
    let ds_cfg_for_loop = ds_cfg.clone();
    let inference_for_loop = inference.clone();
    let reasoning_effort_for_loop = reasoning_effort;
    let cache_enabled_for_loop = cache_enabled;
    let context_length_for_loop = context_length;
    let max_tokens_for_loop = req.max_tokens;
    let temperature_for_loop = req.temperature;
    let force_readonly_for_loop = is_plan_mode_for_loop;
    tokio::spawn(async move {
        // === Agent Loop: 多轮工具调用直到任务完成或达到上限 ===
        const MAX_TURNS: u32 = 30;
        let mut turn: u32 = 0;
        // 累积本轮 assistant 输出（每轮重置）
        let mut content_acc = String::new();
        // 标记是否需要继续 loop（true=有工具调用要执行）
        let mut need_loop = true;

        while need_loop && turn < MAX_TURNS {
            turn += 1;
            content_acc.clear();
            let mut todos_pushed = false;

            // 第一轮：复用已建立的 rx；后续轮：重新发起 chat_stream
            if turn > 1 {
                // 重新构造消息快照（包含上一轮 tool_result 作为新的 current_message）
                let snapshot_system = match sessions.get(&sid).await {
                    Some(ref s) if s.cache.as_ref().map(|c| !c.system_prefix.is_empty()).unwrap_or(false) => None,
                    _ => None,
                };
                let mut new_messages = match sessions
                    .message_snapshot(&sid, context_length_for_loop, snapshot_system)
                    .await
                {
                    Ok(m) => m,
                    Err(e) => {
                        let ev = Event::default().event("error")
                            .data(json!({ "message": format!("消息快照失败: {e}") }).to_string());
                        let _ = tx_sse.send(ev).await;
                        break;
                    }
                };
                // 临时注入技能上下文（首轮已注入 cache，后续轮跳过）
                let chat_req = DsChatRequest {
                    model: ds_cfg_for_loop.model.clone(),
                    messages: new_messages.clone(),
                    reasoning_effort: reasoning_effort_for_loop,
                    enable_cache: cache_enabled_for_loop,
                    max_tokens: max_tokens_for_loop,
                    temperature: temperature_for_loop,
                };
                let _ = new_messages; // 抑制未使用警告
                let new_rx = match shared_state_for_loop.client.chat_stream(chat_req, &ds_cfg_for_loop, cancel_for_task.clone()).await {
                    Ok(r) => r,
                    Err(e) => {
                        let ev = Event::default().event("error")
                            .data(json!({ "message": format!("DeepSeek 调用失败: {e}") }).to_string());
                        let _ = tx_sse.send(ev).await;
                        break;
                    }
                };
                // 替换 rx（第一轮的 rx 已耗尽，这里用新 rx 继续）
                // 注意：rx 是 move 的，第一轮已消费完，这里通过重新绑定实现
                // 但 rx 在 while 外部已 move 进来，无法重新赋值。改用内嵌循环消费。
                let mut new_rx = new_rx;
                loop {
                    match new_rx.recv().await {
                        Some(Ok(delta)) => {
                            if let Some(c) = delta.content.as_deref() {
                                content_acc.push_str(c);
                                let ev = Event::default().event("delta")
                                    .data(json!({ "content": c }).to_string());
                                if tx_sse.send(ev).await.is_err() {
                                    cancel_for_task.cancel();
                                    break;
                                }
                                if !todos_pushed {
                                    if let Some(texts) = parse_todo_block(&content_acc) {
                                        let items = todos_store.add_batch(Some(sid.clone()), texts).await;
                                        todos_pushed = true;
                                        let ev = Event::default().event("todos")
                                            .data(json!({ "items": items }).to_string());
                                        let _ = tx_sse.send(ev).await;
                                    }
                                }
                            }
                            if let Some(r) = delta.reasoning.as_deref() {
                                let ev = Event::default().event("reasoning")
                                    .data(json!({ "content": r }).to_string());
                                let _ = tx_sse.send(ev).await;
                            }
                            if delta.finish_reason.is_some() {
                                break;
                            }
                        }
                        Some(Err(e)) => {
                            let ev = Event::default().event("error")
                                .data(json!({ "message": e.to_string() }).to_string());
                            let _ = tx_sse.send(ev).await;
                            content_acc.clear();
                            break;
                        }
                        None => break,
                    }
                }
                if content_acc.is_empty() {
                    break;
                }
            } else {
                // 第一轮：消费已有的 rx
                while let Some(item) = rx.recv().await {
                    match item {
                        Ok(delta) => {
                            if let Some(c) = delta.content.as_deref() {
                                content_acc.push_str(c);
                                let ev = Event::default()
                                    .event("delta")
                                    .data(json!({ "content": c }).to_string());
                                if tx_sse.send(ev).await.is_err() {
                                    cancel_for_task.cancel();
                                    break;
                                }
                                if !todos_pushed {
                                    if let Some(texts) = parse_todo_block(&content_acc) {
                                        let items = todos_store
                                            .add_batch(Some(sid.clone()), texts)
                                            .await;
                                        todos_pushed = true;
                                        let ev = Event::default()
                                            .event("todos")
                                            .data(json!({ "items": items }).to_string());
                                        if tx_sse.send(ev).await.is_err() {
                                            cancel_for_task.cancel();
                                            break;
                                        }
                                    }
                                }
                            }
                            if let Some(r) = delta.reasoning.as_deref() {
                                let ev = Event::default()
                                    .event("reasoning")
                                    .data(json!({ "content": r }).to_string());
                                if tx_sse.send(ev).await.is_err() {
                                    cancel_for_task.cancel();
                                    break;
                                }
                            }
                            if let Some(fr) = delta.finish_reason.as_deref() {
                                let ev = Event::default()
                                    .event("finish")
                                    .data(json!({ "finishReason": fr }).to_string());
                                if tx_sse.send(ev).await.is_err() {
                                    cancel_for_task.cancel();
                                    break;
                                }
                            }
                        }
                        Err(e) => {
                            let msg = e.to_string();
                            let ev = Event::default()
                                .event("error")
                                .data(json!({ "message": msg }).to_string());
                            let _ = tx_sse.send(ev).await;
                            content_acc.clear();
                            break;
                        }
                    }
                }
            }

            // 落地本轮 assistant 消息
            if !content_acc.is_empty() {
                let _ = sessions.push_assistant_message(&sid, content_acc.clone()).await;

                // === 解析 <todo> 块，推送 todos 事件给前端代办面板 ===
                if let Some(items) = parse_todo_block(&content_acc) {
                    let sid_short: String = sid.chars().take(8).collect();
                    let todo_items: Vec<serde_json::Value> = items.iter().enumerate().map(|(i, text)| {
                        json!({
                            "id": format!("todo_{}_{}", sid_short, i),
                            "sessionId": sid,
                            "text": text,
                            "status": "pending",
                            "source": "agent",
                            "createdAt": chrono::Utc::now().to_rfc3339(),
                            "updatedAt": chrono::Utc::now().to_rfc3339(),
                        })
                    }).collect();
                    if !todo_items.is_empty() {
                        let ev = Event::default().event("todos")
                            .data(json!({ "items": todo_items }).to_string());
                        let _ = tx_sse.send(ev).await;
                        // 同时落库（todos store）
                        let texts: Vec<String> = items;
                        let _ = todos_store.add_batch(Some(sid.clone()), texts).await;
                    }
                }

                // === 解析 DSML 工具调用 ===
                let tool_calls = crate::dsml::parse_dsml_blocks(&content_acc);
                if tool_calls.is_empty() {
                    // 无工具调用：Agent Loop 退出
                    need_loop = false;
                } else {
                    // 执行每个工具调用（本轮最多执行第一个，避免并发问题）
                    if let Some(call) = tool_calls.into_iter().next() {
                        // 生成 callId 供前端配对 tool_call ↔ tool_result
                        let call_id = format!("tc_{}_{}", turn, chrono::Utc::now().timestamp_millis() % 1_000_000);

                        // attempt_completion 直接退出 loop
                        if call.name == "attempt_completion" {
                            need_loop = false;
                            let result_val = call.arguments.get("result")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string();
                            // 推送 tool_call 事件（让前端展示收尾卡片）
                            let ev_call = Event::default().event("tool_call")
                                .data(json!({
                                    "callId": call_id,
                                    "name": call.name,
                                    "intent": call.intent,
                                    "requiredPermission": call.required_permission,
                                    "args": call.arguments,
                                }).to_string());
                            let _ = tx_sse.send(ev_call).await;
                            let ev = Event::default().event("attempt_completion")
                                .data(json!({ "result": result_val, "callId": call_id }).to_string());
                            let _ = tx_sse.send(ev).await;
                        } else {
                            // 推送 tool_call 事件给前端（运行中状态）
                            let ev_call = Event::default().event("tool_call")
                                .data(json!({
                                    "callId": call_id,
                                    "name": call.name,
                                    "intent": call.intent,
                                    "requiredPermission": call.required_permission,
                                    "args": call.arguments,
                                }).to_string());
                            let _ = tx_sse.send(ev_call).await;

                            // 执行工具
                            let (success, result_str) = execute_dsml_tool(
                                &shared_state_for_loop,
                                &call,
                                &sid,
                                force_readonly_for_loop,
                            ).await;

                            // 推送 tool_result 事件（带 callId 供前端配对）
                            let ev = Event::default().event("tool_result")
                                .data(json!({
                                    "callId": call_id,
                                    "name": call.name,
                                    "success": success,
                                    "result": result_str,
                                }).to_string());
                            let _ = tx_sse.send(ev).await;

                            // 把 tool_result 作为新的 user 消息回灌（进入第 5 层 current_message）
                            let tool_result_msg = format!(
                                "<tool_result name=\"{}\" success=\"{}\">\n{}\n</tool_result>",
                                call.name, success, result_str
                            );
                            let _ = sessions.push_user_message(&sid, tool_result_msg).await;

                            // ask_followup_question 不需要继续 loop（等待用户回答）
                            if call.name == "ask_followup_question" {
                                need_loop = false;
                            }
                        }
                    } else {
                        need_loop = false;
                    }
                }
            } else {
                // 内容为空，退出
                break;
            }

            // 复位以进行下一轮：不需要 finish_turn + start_turn 切换 running 状态，
            // 整个 Agent Loop 期间保持 running=true，仅更新 cancel 令牌供 stop_chat 使用。
            // 参考 Cline/Claude Code：长任务期间保持活跃状态，避免并发竞态。
            if need_loop {
                // 重新开启推理轮次以获取新的 cancel 令牌（旧的已被 finish_turn 清除）
                // 注意：finish_turn 会清除 current_cancel，必须重新 start_turn
                let _ = sessions.finish_turn(&sid, String::new()).await;
                match sessions.start_turn(&sid).await {
                    Ok(new_cancel) => {
                        // 关键：更新 cancel_for_task，让 stop_chat 在多轮中生效
                        cancel_for_task = new_cancel;
                    }
                    Err(e) => {
                        let ev = Event::default().event("error")
                            .data(json!({ "message": format!("start_turn 失败: {e}") }).to_string());
                        let _ = tx_sse.send(ev).await;
                        break;
                    }
                }
                // 检查是否已被取消（用户在工具执行期间点了 stop）
                if cancel_for_task.is_cancelled() {
                    tracing::info!("Agent Loop 在轮次间被取消");
                    break;
                }
            }
        }

        // 最终落地（finish_turn 复位 running）。注意 content_acc 此时是最后一轮内容，
        // 若最后一轮已通过 push_assistant_message 落地，则传空避免重复。
        let _ = sessions.finish_turn(&sid, String::new()).await;

        // Reasonix P0+: 推送 cache_stats 事件（命中率/命中数/未命中数）
        if let Ok(stats) = sessions.get_cache_stats(&sid).await {
            let ev = Event::default()
                .event("cache_stats")
                .data(json!({
                    "hitRate": stats.hit_rate,
                    "hits": stats.hit_count,
                    "misses": stats.miss_count,
                    "fingerprint": stats.fingerprint,
                    "historyLen": stats.history_len,
                    "mountedFiles": stats.mounted_files,
                    "verified": stats.verified,
                }).to_string());
            let _ = tx_sse.send(ev).await;
        }

        // 抑制未使用警告
        let _ = (&approvals_store, &inference_for_loop, &reasoning_effort_for_loop);
    });

    // 9. SSE 响应流
    let sid_for_stream = session_id.clone();
    let stream = async_stream::stream! {
        yield Ok::<Event, io::Error>(
            Event::default()
                .event("session")
                .data(json!({ "sessionId": sid_for_stream }).to_string()),
        );
        while let Some(ev) = rx_sse.recv().await {
            yield Ok::<Event, io::Error>(ev);
        }
        yield Ok::<Event, io::Error>(
            Event::default()
                .event("done")
                .data(json!({ "sessionId": sid_for_stream }).to_string()),
        );
    };

    Ok(Sse::new(stream).keep_alive(KeepAlive::default()))
}

pub async fn stop_chat(
    State(state): State<SharedState>,
    Json(req): Json<StopRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let aborted = state.sessions.abort_turn(&req.session_id).await?;
    Ok(Json(json!({
        "sessionId": req.session_id,
        "aborted": aborted,
    })))
}

/// P0-7: 从累积内容中解析首个 `<todo>...</todo>` 块。
///
/// 返回块内非空行集合；未找到闭合块或块内无有效行时返回 None。
/// 仅在 `</todo>` 到达后触发，保证解析完整块。
fn parse_todo_block(content: &str) -> Option<Vec<String>> {
    let start = content.find("<todo>")?;
    let rest = &content[start + "<todo>".len()..];
    let end_rel = rest.find("</todo>")?;
    let block = &rest[..end_rel];
    let items: Vec<String> = block
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect();
    if items.is_empty() {
        None
    } else {
        Some(items)
    }
}

/* ============================================================
 * Agent Loop: DSML 工具执行器
 *
 * 参考 Cline / Aider / Roo Code 的工具执行层设计：
 *   - 只读工具（read_file/list_files/search_files/git 只读）在任意权限下可执行
 *   - 写工具（write_file/shell/git 写操作）需通过权限校验
 *   - 失败时返回结构化错误信息，由 LLM 下一轮根据错误自修复参数
 *   - 返回 (success, result_str)：success=true 时 result 为 JSON 数据；
 *     success=false 时 result 为人类可读错误信息
 * ============================================================ */

/// 执行单个 DSML 工具调用，返回 (是否成功, 结果文本)。
///
/// 结果文本会作为 `<tool_result>` 回灌给 LLM，因此应保持简洁、信息完整。
///
/// `force_readonly`：为 true 时（Plan 模式），所有写工具（write_file/edit_file/shell/git 写操作）
/// 直接返回权限错误，不执行。
async fn execute_dsml_tool(
    state: &SharedState,
    call: &crate::dsml::DsmlToolCall,
    _session_id: &str,
    force_readonly: bool,
) -> (bool, String) {
    // 提取项目根路径（绝大多数工具依赖）
    let root_opt = state.project_root().await;
    let root = match root_opt.as_ref() {
        Some(r) => r.clone(),
        None => {
            return (
                false,
                "未加载项目目录，请先调用 /api/project/load 选择项目根目录".to_string(),
            );
        }
    };

    // 提取当前权限等级
    let perm_cfg = state.permission_config().await;
    let perm_level = if force_readonly {
        // Plan 模式强制 ReadOnly
        crate::config::PermissionLevel::ReadOnly
    } else {
        perm_cfg.level
    };

    // 辅助：从 arguments 取字符串字段
    let get_str = |key: &str| -> Option<String> {
        call.arguments
            .get(key)
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
    };

    tracing::info!(
        "execute_dsml_tool: name={} intent={} perm={:?}",
        call.name,
        call.intent,
        perm_level
    );

    match call.name.as_str() {
        // === 只读工具：任意权限可执行 ===
        "read_file" => {
            let path = match get_str("path") {
                Some(p) if !p.is_empty() => p,
                _ => return (false, "read_file 缺少 path 参数".into()),
            };
            match crate::tools::read_file(&root, &path).await {
                Ok(r) => {
                    // 按 char boundary 安全截断，避免多字节 UTF-8 切片 panic
                    let preview = if r.content.len() > 8000 {
                        let mut end = 8000;
                        while end > 0 && !r.content.is_char_boundary(end) {
                            end -= 1;
                        }
                        format!("{}\n\n[... 文件较大，已截断，共 {} 字节 ...]", &r.content[..end], r.bytes)
                    } else {
                        r.content.clone()
                    };
                    (true, format!("path: {}\nbytes: {}\n\n{}", r.path, r.bytes, preview))
                }
                Err(e) => (false, format!("read_file 失败: {e}")),
            }
        }

        "list_files" => {
            let path = get_str("path").unwrap_or_else(|| ".".to_string());
            match crate::tools::list_files(&root, &path).await {
                Ok(v) => (true, serde_json::to_string_pretty(&v).unwrap_or_else(|_| format!("{:?}", v))),
                Err(e) => (false, format!("list_files 失败: {e}")),
            }
        }

        "search_files" => {
            let regex = match get_str("regex") {
                Some(r) if !r.is_empty() => r,
                _ => return (false, "search_files 缺少 regex 参数".into()),
            };
            let path = get_str("path").unwrap_or_else(|| ".".to_string());
            // 限制最大结果数避免上下文爆炸
            match crate::tools::search_files(&root, &regex, &path, 50).await {
                Ok(v) => (true, serde_json::to_string_pretty(&v).unwrap_or_else(|_| format!("{:?}", v))),
                Err(e) => (false, format!("search_files 失败: {e}")),
            }
        }

        "git" => {
            // git 工具：args 为 JSON 数组形式（如 ["status","--short"]）或空格分隔字符串
            let args: Vec<String> = if let Some(arr) = call.arguments.get("args").and_then(|v| v.as_array()) {
                arr.iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                    .collect()
            } else if let Some(s) = get_str("args") {
                s.split_whitespace().map(|s| s.to_string()).collect()
            } else {
                return (false, "git 缺少 args 参数".into());
            };
            if args.is_empty() {
                return (false, "git args 不能为空".into());
            }
            // 权限细分：只读子命令任意权限可执行，写操作需 can_shell
            match crate::tools::git(&root, args, perm_level).await {
                Ok(r) if r.success => {
                    let out = if r.stdout.trim().is_empty() && r.stderr.trim().is_empty() {
                        "(无输出)".to_string()
                    } else if !r.stderr.trim().is_empty() {
                        format!("stdout:\n{}\nstderr:\n{}", r.stdout, r.stderr)
                    } else {
                        r.stdout
                    };
                    (true, out)
                }
                Ok(r) => {
                    (false, format!("git 退出码 {}:\nstdout:\n{}\nstderr:\n{}", r.exit_code, r.stdout, r.stderr))
                }
                Err(e) => (false, format!("git 失败: {e}")),
            }
        }

        "ask_followup_question" => {
            // 仅把问题返回，由前端展示并等待用户回答
            let q = get_str("question").unwrap_or_else(|| "(无问题)".to_string());
            (true, format!("已向用户提问：\n{q}\n\n（请用户在下一条消息中回答）"))
        }

        // === 写工具：需要权限校验 ===
        "write_file" => {
            if !perm_level.can_write() {
                return (false, format!("权限不足：当前 {:?} 禁止写文件，需 WorkspaceWrite 或 FullAccess", perm_level));
            }
            let path = match get_str("path") {
                Some(p) if !p.is_empty() => p,
                _ => return (false, "write_file 缺少 path 参数".into()),
            };
            let content = match get_str("content") {
                Some(c) => c,
                _ => return (false, "write_file 缺少 content 参数".into()),
            };
            match crate::tools::write_file(&root, &path, &content, true, perm_level).await {
                Ok(r) => (true, format!("已写入：{}\n字节数：{}\n新建：{}", r.path, r.bytes, r.created)),
                Err(e) => (false, format!("write_file 失败: {e}")),
            }
        }

        "edit_file" => {
            // 增量编辑（SEARCH/REPLACE）：edits 可为 JSON 数组或 JSON 字符串
            if !perm_level.can_write() {
                return (false, format!("权限不足：当前 {:?} 禁止写文件，需 WorkspaceWrite 或 FullAccess", perm_level));
            }
            let path = match get_str("path") {
                Some(p) if !p.is_empty() => p,
                _ => return (false, "edit_file 缺少 path 参数".into()),
            };
            // DSML 解析器把所有 arg 值存为 String，需兼容数组/字符串双形态
            let edits: Vec<crate::tools::EditBlock> = match call.arguments.get("edits") {
                Some(serde_json::Value::Array(arr)) => {
                    match serde_json::from_value(serde_json::Value::Array(arr.clone())) {
                        Ok(e) => e,
                        Err(e) => return (false, format!("edits 参数解析失败: {e}")),
                    }
                }
                Some(serde_json::Value::String(s)) if !s.is_empty() => {
                    match serde_json::from_str(s) {
                        Ok(e) => e,
                        Err(e) => return (false, format!("edits 字符串解析失败: {e}")),
                    }
                }
                _ => return (false, "edit_file 缺少 edits 参数（应为数组）".into()),
            };
            match crate::tools::edit_file(&root, &path, &edits, perm_level).await {
                Ok(r) => (true, format!("已增量编辑：{}\n新文件字节数：{}\n应用 {} 个 edit 块", r.path, r.bytes, edits.len())),
                Err(e) => (false, format!("edit_file 失败: {e}")),
            }
        }

        "shell" => {
            if !perm_level.can_shell() {
                return (false, format!("权限不足：当前 {:?} 禁止执行 Shell，需 FullAccess", perm_level));
            }
            let command = match get_str("command") {
                Some(c) if !c.is_empty() => c,
                _ => return (false, "shell 缺少 command 参数".into()),
            };
            match crate::tools::shell(&root, command, 120, perm_level).await {
                Ok(r) if r.success => {
                    (true, format!("exit: 0\nstdout:\n{}\nstderr:\n{}", r.stdout, r.stderr))
                }
                Ok(r) => {
                    (false, format!("exit: {}\nstdout:\n{}\nstderr:\n{}", r.exit_code, r.stdout, r.stderr))
                }
                Err(e) => (false, format!("shell 失败: {e}")),
            }
        }

        // === 未知工具 ===
        other => {
            (false, format!("未知工具：{other}。可用工具：read_file/list_files/search_files/write_file/edit_file/shell/git/ask_followup_question/attempt_completion"))
        }
    }
}
