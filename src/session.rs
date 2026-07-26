//! 会话管理: 消息历史、上下文重置、任务中断令牌。
//!
//! 一次会话同一时刻仅允许一个活跃推理轮次; 若已有轮次在跑, 再次 start_turn 会返回 409。
//!
//! Reasonix 集成（P0+）：每个 Session 可携带一个 `PrefixCache`，
//! 当 cache 存在时 `message_snapshot` 会按字节稳定分层顺序构建上下文，
//! 否则回退到旧的"取尾部 N 条"逻辑，保证向后兼容。

use crate::cache::{CacheMessage, PrefixCache};
use crate::deepseek::{ChatMessage, ChatRole};
use crate::error::{AppError, AppResult};
use chrono::{DateTime, Utc};
use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::RwLock;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    pub messages: Vec<ChatMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_root: Option<PathBuf>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub running: bool,
    #[serde(skip)]
    pub current_cancel: Option<CancellationToken>,
    /// Reasonix 字节稳定前缀缓存（可选，存在时优先用于 message_snapshot）。
    #[serde(skip)]
    pub cache: Option<PrefixCache>,
}

#[derive(Clone, Default)]
pub struct SessionManager {
    inner: Arc<RwLock<HashMap<String, Session>>>,
}

/// 缓存统计快照（供 /api 路由返回给前端）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheStats {
    pub session_id: String,
    pub hit_count: u64,
    pub miss_count: u64,
    pub hit_rate: f64,
    pub fingerprint: String,
    pub history_len: usize,
    pub mounted_files: usize,
    pub verified: bool,
}

impl SessionManager {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn create(&self, project_root: Option<PathBuf>) -> Session {
        let id = Uuid::new_v4().to_string();
        let now = Utc::now();
        let session = Session {
            id: id.clone(),
            messages: Vec::new(),
            project_root,
            created_at: now,
            updated_at: now,
            running: false,
            current_cancel: None,
            cache: None,
        };
        self.inner.write().await.insert(id, session.clone());
        session
    }

    pub async fn get(&self, id: &str) -> Option<Session> {
        self.inner.read().await.get(id).cloned()
    }

    pub async fn list(&self) -> Vec<Session> {
        let mut v: Vec<Session> = self.inner.read().await.values().cloned().collect();
        v.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        v
    }

    pub async fn delete(&self, id: &str) -> bool {
        self.inner.write().await.remove(id).is_some()
    }

    /// 重置上下文: 清空消息历史与缓存, 保留会话 id 与项目根。
    pub async fn reset(&self, id: &str) -> AppResult<()> {
        let mut map = self.inner.write().await;
        let s = map
            .get_mut(id)
            .ok_or_else(|| AppError::SessionNotFound(id.to_string()))?;
        s.messages.clear();
        if let Some(c) = s.cache.as_mut() {
            // 仅清空 history 与 current_message，保留 system_prefix / project_memory / mounted_files
            // 以维持前缀字节稳定（DeepSeek KV-Cache 仍可命中前 3 层）
            c.history.clear();
            c.current_message.clear();
            c.recompute_fingerprint();
        }
        s.updated_at = Utc::now();
        Ok(())
    }

    pub async fn set_project_root(&self, id: &str, root: PathBuf) -> AppResult<()> {
        let mut map = self.inner.write().await;
        let s = map
            .get_mut(id)
            .ok_or_else(|| AppError::SessionNotFound(id.to_string()))?;
        s.project_root = Some(root);
        s.updated_at = Utc::now();
        Ok(())
    }

    /// 开始一轮推理, 返回取消令牌的克隆。若已有轮次在跑则报错。
    pub async fn start_turn(&self, id: &str) -> AppResult<CancellationToken> {
        let mut map = self.inner.write().await;
        let s = map
            .get_mut(id)
            .ok_or_else(|| AppError::SessionNotFound(id.to_string()))?;
        if s.running {
            return Err(AppError::BadRequest(format!(
                "会话 {id} 已有推理任务在执行, 请先中断或等待完成"
            )));
        }
        let token = CancellationToken::new();
        s.current_cancel = Some(token.clone());
        s.running = true;
        s.updated_at = Utc::now();
        Ok(token)
    }

    /// 追加用户消息 (在 start_turn 之前调用)。
    ///
    /// Reasonix 集成：若 cache 存在，将上一轮的 current_message 归档到 history，
    /// 然后用新消息覆盖 current_message。这样第 5 层始终是最新用户输入，
    /// 前 4 层保持字节稳定，最大化 DeepSeek KV-Cache 命中率。
    pub async fn push_user_message(&self, id: &str, content: String) -> AppResult<()> {
        let mut map = self.inner.write().await;
        let s = map
            .get_mut(id)
            .ok_or_else(|| AppError::SessionNotFound(id.to_string()))?;
        s.messages.push(ChatMessage::user(content.clone()));
        if let Some(cache) = s.cache.as_mut() {
            // 上一轮 current_message（非空）归档到 history
            if !cache.current_message.is_empty() {
                cache.append_history(CacheMessage::user(cache.current_message.clone()));
            }
            cache.set_current_message(content);
        }
        s.updated_at = Utc::now();
        Ok(())
    }

    /// 结束推理: 写入 assistant 消息, 清除令牌。
    ///
    /// Reasonix 集成：若 cache 存在，将 assistant 消息追加到 history（仅追加，不重排）。
    pub async fn finish_turn(&self, id: &str, assistant_content: String) -> AppResult<()> {
        let mut map = self.inner.write().await;
        let s = map
            .get_mut(id)
            .ok_or_else(|| AppError::SessionNotFound(id.to_string()))?;
        if !assistant_content.is_empty() {
            s.messages
                .push(ChatMessage::assistant(assistant_content.clone()));
            if let Some(cache) = s.cache.as_mut() {
                cache.append_history(CacheMessage::assistant(assistant_content));
            }
        }
        s.current_cancel = None;
        s.running = false;
        s.updated_at = Utc::now();
        Ok(())
    }

    /// Agent Loop 专用：写入 assistant 消息但不清除 running 状态，也不清除令牌。
    ///
    /// 与 finish_turn 的区别：
    ///   - 不清除 current_cancel（保持可中断）
    ///   - 不设置 running=false（保持会话活跃）
    ///   - 先把 current_message 归档到 history，再追加 assistant，保证 history 顺序正确
    ///     （user 在前，assistant 在后）
    ///
    /// 用于 Agent Loop 多轮工具调用中落地每轮 assistant 输出。
    pub async fn push_assistant_message(
        &self,
        id: &str,
        assistant_content: String,
    ) -> AppResult<()> {
        let mut map = self.inner.write().await;
        let s = map
            .get_mut(id)
            .ok_or_else(|| AppError::SessionNotFound(id.to_string()))?;
        if assistant_content.is_empty() {
            return Ok(());
        }
        s.messages
            .push(ChatMessage::assistant(assistant_content.clone()));
        if let Some(cache) = s.cache.as_mut() {
            // 先归档当前 current_message 到 history（保证 user 在 assistant 之前）
            if !cache.current_message.is_empty() {
                cache.append_history(CacheMessage::user(cache.current_message.clone()));
                cache.set_current_message(String::new());
            }
            // 再追加 assistant 消息
            cache.append_history(CacheMessage::assistant(assistant_content));
        }
        s.updated_at = Utc::now();
        Ok(())
    }

    /// 中断当前轮次。返回是否确实触发了中断。
    pub async fn abort_turn(&self, id: &str) -> AppResult<bool> {
        let mut map = self.inner.write().await;
        let s = map
            .get_mut(id)
            .ok_or_else(|| AppError::SessionNotFound(id.to_string()))?;
        if let Some(token) = s.current_cancel.take() {
            token.cancel();
            s.running = false;
            s.updated_at = Utc::now();
            Ok(true)
        } else {
            Ok(false)
        }
    }

    /// 返回裁剪到上下文 Token 预算的消息快照 (含可选 system 前缀)。
    ///
    /// Reasonix 集成：若 cache 存在且已初始化（system_prefix 非空），
    /// 按"system(前 3 层合并) → history → current_message"分层顺序构建，
    /// 其中 system 包含 system_prefix + project_memory + mounted_files，
    /// history 仅裁剪尾部以满足 Token 预算（保留前缀字节稳定）。
    /// 否则回退到旧逻辑。
    pub async fn message_snapshot(
        &self,
        id: &str,
        context_token_budget: usize,
        system_prefix: Option<String>,
    ) -> AppResult<Vec<ChatMessage>> {
        let map = self.inner.read().await;
        let s = map
            .get(id)
            .ok_or_else(|| AppError::SessionNotFound(id.to_string()))?;

        if let Some(cache) = s.cache.as_ref() {
            if !cache.system_prefix.is_empty() {
                return Ok(build_snapshot_from_cache(cache, context_token_budget));
            }
        }

        let history = trim_to_token_budget(&s.messages, context_token_budget);
        let mut out: Vec<ChatMessage> = Vec::with_capacity(history.len() + 1);
        if let Some(sys) = system_prefix {
            out.push(ChatMessage::system(sys));
        }
        out.extend(history);
        Ok(out)
    }

    /* ============================================================
     * Reasonix 缓存集成新方法
     * ============================================================ */

    /// 初始化或获取会话的 PrefixCache。system_prefix 仅在首次创建时生效。
    pub async fn ensure_cache(&self, id: &str, system_prefix: String) -> AppResult<PrefixCache> {
        let mut map = self.inner.write().await;
        let s = map
            .get_mut(id)
            .ok_or_else(|| AppError::SessionNotFound(id.to_string()))?;
        if s.cache.is_none() {
            s.cache = Some(PrefixCache::new(id.to_string(), system_prefix));
        }
        Ok(s.cache.as_ref().expect("cache just initialized").clone())
    }

    /// 写回缓存（外部修改后持久化到 session 内）。
    pub async fn save_cache(&self, id: &str, cache: PrefixCache) -> AppResult<()> {
        let mut map = self.inner.write().await;
        let s = map
            .get_mut(id)
            .ok_or_else(|| AppError::SessionNotFound(id.to_string()))?;
        s.cache = Some(cache);
        s.updated_at = Utc::now();
        Ok(())
    }

    /// 挂载文件到会话缓存（仅追加，不插入中间）。
    pub async fn mount_file(&self, id: &str, path: String, content: String) -> AppResult<()> {
        let mut map = self.inner.write().await;
        let s = map
            .get_mut(id)
            .ok_or_else(|| AppError::SessionNotFound(id.to_string()))?;
        let cache = s
            .cache
            .as_mut()
            .ok_or_else(|| AppError::BadRequest("会话缓存未初始化，无法挂载文件".into()))?;
        cache.mount_file(path, content)
    }

    /// 初始化项目持久记忆（仅一次，之后不可变）。
    pub async fn init_project_memory(&self, id: &str, memory: String) -> AppResult<()> {
        let mut map = self.inner.write().await;
        let s = map
            .get_mut(id)
            .ok_or_else(|| AppError::SessionNotFound(id.to_string()))?;
        let cache = s
            .cache
            .as_mut()
            .ok_or_else(|| AppError::BadRequest("会话缓存未初始化，无法设置项目记忆".into()))?;
        cache.init_project_memory(memory);
        Ok(())
    }

    /// 清除指定会话已初始化的项目记忆，并刷新前缀指纹。
    pub async fn clear_project_memory(&self, id: &str) -> AppResult<()> {
        let mut map = self.inner.write().await;
        let session = map
            .get_mut(id)
            .ok_or_else(|| AppError::SessionNotFound(id.to_string()))?;
        if let Some(cache) = session.cache.as_mut() {
            cache.project_memory.clear();
            cache.recompute_fingerprint();
        }
        session.updated_at = Utc::now();
        Ok(())
    }

    /// 获取会话缓存统计（命中率、指纹、长度等）。
    pub async fn get_cache_stats(&self, id: &str) -> AppResult<CacheStats> {
        let map = self.inner.read().await;
        let s = map
            .get(id)
            .ok_or_else(|| AppError::SessionNotFound(id.to_string()))?;
        match s.cache.as_ref() {
            None => Err(AppError::BadRequest(format!("会话 {id} 未启用缓存"))),
            Some(c) => Ok(CacheStats {
                session_id: c.session_id.clone(),
                hit_count: c.hit_count,
                miss_count: c.miss_count,
                hit_rate: c.hit_rate(),
                fingerprint: c.fingerprint.clone(),
                history_len: c.history.len(),
                mounted_files: c.mounted_files.len(),
                verified: c.verify(),
            }),
        }
    }
}

/// 从 PrefixCache 构建消息快照。
///
/// 分层顺序：
///   1. system: system_prefix + project_memory + mounted_files（合并为单条 system）
///   2. history: 转为 user/assistant 消息（按 Token 预算裁剪尾部）
///   3. current_message: 作为最后一条 user 消息
fn build_snapshot_from_cache(cache: &PrefixCache, context_token_budget: usize) -> Vec<ChatMessage> {
    // 1. 合并 system 层
    let mut sys = String::new();
    sys.push_str(&cache.system_prefix);
    if !cache.project_memory.is_empty() {
        sys.push_str("\n\n[PROJECT_MEMORY]\n");
        sys.push_str(&cache.project_memory);
    }
    if !cache.mounted_files.is_empty() {
        sys.push_str("\n\n[MOUNTED_FILES]\n");
        for f in &cache.mounted_files {
            sys.push_str(&format!(
                "<attachment path=\"{}\">\n{}\n</attachment>\n",
                f.path, f.content
            ));
        }
    }

    // 2. history 裁剪：在 Token 预算内保留最新消息，当前消息始终单独保留。
    let mut used = 0usize;
    let mut history_slice = Vec::new();
    for message in cache.history.iter().rev() {
        let estimate = estimate_tokens(&message.content);
        if used.saturating_add(estimate) > context_token_budget {
            break;
        }
        used = used.saturating_add(estimate);
        history_slice.push(message);
    }
    history_slice.reverse();

    let mut out: Vec<ChatMessage> = Vec::with_capacity(history_slice.len() + 2);
    out.push(ChatMessage::system(sys));
    for m in history_slice {
        let role = match m.role.as_str() {
            "assistant" => ChatRole::Assistant,
            "system" => ChatRole::System,
            "tool" => ChatRole::Tool,
            _ => ChatRole::User,
        };
        out.push(ChatMessage {
            role,
            content: m.content.clone(),
        });
    }
    // 3. 当前用户消息
    if !cache.current_message.is_empty() {
        out.push(ChatMessage::user(cache.current_message.clone()));
    }
    out
}

fn estimate_tokens(content: &str) -> usize {
    content.chars().count().div_ceil(4).max(1)
}

fn trim_to_token_budget(messages: &[ChatMessage], token_budget: usize) -> Vec<ChatMessage> {
    let mut used = 0usize;
    let mut kept = Vec::new();
    for message in messages.iter().rev() {
        let estimate = estimate_tokens(&message.content);
        if used.saturating_add(estimate) > token_budget {
            break;
        }
        used = used.saturating_add(estimate);
        kept.push(message.clone());
    }
    kept.reverse();
    kept
}
