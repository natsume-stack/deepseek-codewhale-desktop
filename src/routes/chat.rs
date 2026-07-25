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
    let system_prefix = match req.system_prompt.as_deref() {
        None | Some("") => DEFAULT_AGENT_SYSTEM_PROMPT.to_string(),
        Some(custom) => format!("{DEFAULT_AGENT_SYSTEM_PROMPT}\n\n{custom}"),
    };
    // 在 SharedState.caches 中登记（用于跨会话查询/统计），同时初始化 session.cache
    let _ = state.caches.get_or_init(&session_id, system_prefix.clone()).await;
    state.sessions.ensure_cache(&session_id, system_prefix.clone()).await?;

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
    let cancel_for_task = cancel.clone();

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
    let sid = session_id.clone();
    tokio::spawn(async move {
        let mut content_acc = String::new();
        // P0-7: <todo> 块只推送一次，避免重复
        let mut todos_pushed = false;
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
                        // P0-7: 检测 <todo>...</todo> 块，解析多行任务并推送
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
                    content_acc.clear(); // 出错不落地
                    break;
                }
            }
        }
        // 落地 assistant 消息并复位 running
        let _ = sessions.finish_turn(&sid, content_acc).await;

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
