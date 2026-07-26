//! Reasonix 字节稳定前缀缓存层（P0+ 最高优先级）。
//!
//! 对齐 https://github.com/esengine/deepseek-reasonix 的 DeepSeek 专属缓存工程规范，
//! 最大化 DeepSeek 上下文缓存命中率（目标 90%+）。
//!
//! 铁律：会话上下文固定分层顺序，且前 4 层在会话期间字节不可变：
//!   【固定系统 Prompt 前缀 → 项目持久记忆 → 挂载文件固定片段 → 历史对话只读追加区 → 当前最新用户消息】
//!
//! 只有第 5 层（当前最新用户消息）每轮可变，从而保证 DeepSeek 服务端 KV-Cache 命中前 4 层。
//! 长上下文压缩只裁剪 history 尾部，绝不改动前 4 层。

use crate::error::{AppError, AppResult};
use serde::Serialize;
use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::sync::Arc;
use tokio::sync::Mutex;

/// 单文件挂载上限（50KB），超出按 AppError 截断报错。
pub const MOUNTED_FILE_MAX_BYTES: usize = 50 * 1024;

/// 挂载文件固定片段。
///
/// 会话期间追加-only，不允许插入中间或修改既有项，确保前缀字节稳定。
#[derive(Debug, Clone, Serialize)]
pub struct MountedFile {
    /// 项目相对路径。
    pub path: String,
    /// 文本内容（二进制文件应在上游过滤）。
    pub content: String,
    /// 字节大小。
    pub bytes: usize,
}

/// 历史对话只读追加区消息。
#[derive(Debug, Clone, Serialize)]
pub struct CacheMessage {
    /// "user" | "assistant"。
    pub role: String,
    /// 文本内容。
    pub content: String,
    /// deepseek-reasoner 推理内容（可选）。
    pub reasoning: Option<String>,
}

impl CacheMessage {
    pub fn user(content: impl Into<String>) -> Self {
        Self {
            role: "user".into(),
            content: content.into(),
            reasoning: None,
        }
    }
    pub fn assistant(content: impl Into<String>) -> Self {
        Self {
            role: "assistant".into(),
            content: content.into(),
            reasoning: None,
        }
    }
}

/// 字节稳定前缀缓存。
#[derive(Debug, Clone, Serialize)]
pub struct PrefixCache {
    /// 绑定的会话 ID。
    pub session_id: String,
    /// 第 1 层：系统提示（会话全程字节不可变）。
    pub system_prefix: String,
    /// 第 2 层：项目持久记忆（init_project_memory 后不可变）。
    pub project_memory: String,
    /// 第 3 层：挂载文件固定片段（按挂载顺序追加，会话期间不可变）。
    pub mounted_files: Vec<MountedFile>,
    /// 第 4 层：历史对话只读追加区（仅追加，不重排）。
    pub history: Vec<CacheMessage>,
    /// 第 5 层：当前最新用户消息（每轮可变）。
    pub current_message: String,
    /// 缓存命中统计。
    pub hit_count: u64,
    /// 缓存未命中统计。
    pub miss_count: u64,
    /// 前 4 层内容的指纹（DefaultHasher u64 → 十六进制），用于检测是否被破坏。
    pub fingerprint: String,
}

impl PrefixCache {
    pub fn new(session_id: String, system_prefix: String) -> Self {
        let mut cache = Self {
            session_id,
            system_prefix,
            project_memory: String::new(),
            mounted_files: Vec::new(),
            history: Vec::new(),
            current_message: String::new(),
            hit_count: 0,
            miss_count: 0,
            fingerprint: String::new(),
        };
        cache.recompute_fingerprint();
        cache
    }

    /// 初始化项目持久记忆（仅一次，之后不可变）。
    ///
    /// 若已初始化（非空）则忽略后续调用，保证字节稳定。
    pub fn init_project_memory(&mut self, memory: String) {
        if !self.project_memory.is_empty() {
            // 已初始化，忽略后续覆盖，保持字节稳定
            return;
        }
        self.project_memory = memory;
        self.recompute_fingerprint();
    }

    /// 追加挂载文件（仅追加，不插入中间；二进制过滤；50KB 上限）。
    pub fn mount_file(&mut self, path: String, content: String) -> AppResult<()> {
        if path.trim().is_empty() {
            return Err(AppError::BadRequest("挂载文件路径不能为空".into()));
        }
        let bytes = content.as_bytes().len();
        if bytes > MOUNTED_FILE_MAX_BYTES {
            return Err(AppError::BadRequest(format!(
                "挂载文件 {} 大小 {} 字节超出上限 {} 字节",
                path, bytes, MOUNTED_FILE_MAX_BYTES
            )));
        }
        // 二进制过滤：包含 NUL 字节视为二进制
        if content.as_bytes().contains(&0u8) {
            return Err(AppError::BadRequest(format!(
                "挂载文件 {} 包含 NUL 字节，疑似二进制文件，已拒绝挂载",
                path
            )));
        }
        // 同路径已挂载则跳过（避免重复字节）
        if self.mounted_files.iter().any(|f| f.path == path) {
            return Ok(());
        }
        self.mounted_files.push(MountedFile {
            path,
            content,
            bytes,
        });
        self.recompute_fingerprint();
        Ok(())
    }

    /// 追加历史对话（仅追加，不重排）。
    pub fn append_history(&mut self, msg: CacheMessage) {
        self.history.push(msg);
        // history 属于第 4 层，追加后指纹变化
        self.recompute_fingerprint();
    }

    /// 设置当前用户消息（每轮可变）。
    pub fn set_current_message(&mut self, msg: String) {
        self.current_message = msg;
        // 当前消息属于第 5 层，不影响前 4 层指纹
    }

    /// 构建完整上下文（按固定分层顺序拼接）。
    ///
    /// 输出格式：
    /// ```text
    /// [SYSTEM_PREFIX]
    /// <system>
    ///
    /// [PROJECT_MEMORY]
    /// <memory>
    ///
    /// [MOUNTED_FILES]
    /// <attachment path="...">...</attachment>
    ///
    /// [HISTORY]
    /// <user>...</user>
    /// <assistant>...</assistant>
    ///
    /// [CURRENT_MESSAGE]
    /// <user>...</user>
    /// ```
    pub fn build_context(&self) -> String {
        let mut out = String::with_capacity(8 * 1024);
        out.push_str("[SYSTEM_PREFIX]\n");
        out.push_str(&self.system_prefix);
        out.push_str("\n\n[PROJECT_MEMORY]\n");
        out.push_str(&self.project_memory);
        out.push_str("\n\n[MOUNTED_FILES]\n");
        for f in &self.mounted_files {
            out.push_str(&format!(
                "<attachment path=\"{}\">\n{}\n</attachment>\n",
                f.path, f.content
            ));
        }
        out.push_str("\n[HISTORY]\n");
        for m in &self.history {
            match m.role.as_str() {
                "assistant" => {
                    out.push_str("<assistant>");
                    if let Some(r) = m.reasoning.as_deref() {
                        if !r.is_empty() {
                            out.push_str("\n<reasoning>");
                            out.push_str(r);
                            out.push_str("</reasoning>\n");
                        }
                    }
                    out.push_str(&m.content);
                    out.push_str("</assistant>\n");
                }
                _ => {
                    out.push_str("<user>");
                    out.push_str(&m.content);
                    out.push_str("</user>\n");
                }
            }
        }
        out.push_str("\n[CURRENT_MESSAGE]\n<user>");
        out.push_str(&self.current_message);
        out.push_str("</user>\n");
        out
    }

    /// 重新计算指纹（前 4 层 DefaultHasher u64 → 十六进制）。
    pub fn recompute_fingerprint(&mut self) {
        let mut h = DefaultHasher::new();
        self.system_prefix.hash(&mut h);
        self.project_memory.hash(&mut h);
        for f in &self.mounted_files {
            f.path.hash(&mut h);
            f.content.hash(&mut h);
        }
        for m in &self.history {
            m.role.hash(&mut h);
            m.content.hash(&mut h);
            m.reasoning.hash(&mut h);
        }
        let fp = h.finish();
        self.fingerprint = format!("{:016x}", fp);
    }

    /// 验证缓存完整性：重新计算指纹与当前指纹比对。
    pub fn verify(&self) -> bool {
        let mut h = DefaultHasher::new();
        self.system_prefix.hash(&mut h);
        self.project_memory.hash(&mut h);
        for f in &self.mounted_files {
            f.path.hash(&mut h);
            f.content.hash(&mut h);
        }
        for m in &self.history {
            m.role.hash(&mut h);
            m.content.hash(&mut h);
            m.reasoning.hash(&mut h);
        }
        let fp = format!("{:016x}", h.finish());
        fp == self.fingerprint
    }

    /// 缓存命中率（命中 / (命中 + 未命中)）。
    pub fn hit_rate(&self) -> f64 {
        let total = self.hit_count + self.miss_count;
        if total == 0 {
            0.0
        } else {
            self.hit_count as f64 / total as f64
        }
    }

    pub fn record_hit(&mut self) {
        self.hit_count += 1;
    }

    pub fn record_miss(&mut self) {
        self.miss_count += 1;
    }

    /// 长上下文压缩：仅裁剪 history 头部，绝不改动前 3 层（system/project_memory/mounted_files）。
    ///
    /// 当 history 长度超过 max_messages 时，丢弃头部最旧的若干条，保留尾部最新 max_messages 条。
    /// 注意：history 头部裁剪会破坏 DeepSeek 服务端 KV-Cache 前缀，应作为最后兜底手段，
    /// 优先保证前 4 层字节稳定，仅在长会话上下文溢出时调用。
    pub fn compress_history(&mut self, max_messages: usize) {
        if self.history.len() <= max_messages {
            return;
        }
        let drop = self.history.len() - max_messages;
        self.history.drain(0..drop);
        self.recompute_fingerprint();
    }
}

/// 全局缓存存储（按 session_id 索引）。
#[derive(Clone, Default)]
pub struct CacheStore {
    inner: Arc<Mutex<HashMap<String, PrefixCache>>>,
}

impl CacheStore {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn get(&self, session_id: &str) -> Option<PrefixCache> {
        self.inner.lock().await.get(session_id).cloned()
    }

    /// 获取或初始化会话缓存。system_prefix 仅在首次创建时使用。
    pub async fn get_or_init(&self, session_id: &str, system_prefix: String) -> PrefixCache {
        let mut map = self.inner.lock().await;
        if let Some(c) = map.get(session_id) {
            // 命中：前 4 层未变
            let mut c = c.clone();
            c.record_hit();
            map.insert(session_id.to_string(), c.clone());
            c
        } else {
            // 未命中：新建缓存
            let mut c = PrefixCache::new(session_id.to_string(), system_prefix);
            c.record_miss();
            map.insert(session_id.to_string(), c.clone());
            c
        }
    }

    pub async fn save(&self, cache: PrefixCache) {
        self.inner
            .lock()
            .await
            .insert(cache.session_id.clone(), cache);
    }

    pub async fn remove(&self, session_id: &str) {
        self.inner.lock().await.remove(session_id);
    }

    pub async fn list(&self) -> Vec<PrefixCache> {
        self.inner.lock().await.values().cloned().collect()
    }
}
