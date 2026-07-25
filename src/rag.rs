//! 项目 RAG 检索: 分块索引 + 关键词召回。
//!
//! 实现 Reasonix 分块缓存方案: 项目源码按 500 行/块切分，
//! 索引后按关键词匹配评分召回，固定顺序注入上下文，不打乱前缀结构。
//!
//! 评分策略:
//!   - 文件名命中关键词 +5
//!   - 文件路径命中关键词 +3
//!   - 内容命中关键词 +1（按出现次数累计，单块封顶 50）

use axum::extract::State;
use axum::Json;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::hash_map::DefaultHasher;
use std::collections::HashSet;
use std::hash::{Hash, Hasher};
use std::path::Path;
use std::sync::{Arc, OnceLock};
use tokio::sync::RwLock;

use crate::config::IGNORED_DIRS;
use crate::error::AppError;
use crate::state::SharedState;

/// 单文件上限 50KB（Reasonix 缓存铁律）。
const MAX_FILE_BYTES: u64 = 50 * 1024;
/// 每块行数。
const CHUNK_LINES: usize = 500;
/// 支持的源码扩展名白名单（同时用于二进制文件过滤）。
const SUPPORTED_EXTS: &[&str] = &[
    "rs", "ts", "tsx", "js", "jsx", "py", "go", "java", "cs", "cpp", "c", "h", "md", "toml",
    "yaml", "yml", "json",
];

/* ============================================================
 * 数据结构
 * ============================================================ */

/// RAG 文档块
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RagChunk {
    /// 文件路径 + 行号范围
    pub id: String,
    pub file_path: String,
    pub start_line: usize,
    pub end_line: usize,
    pub content: String,
    /// 粗略估算
    pub tokens: usize,
    /// 内容哈希
    pub hash: u64,
}

/// RAG 索引
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RagIndex {
    pub project_root: String,
    pub chunks: Vec<RagChunk>,
    pub total_files: usize,
    pub total_tokens: usize,
    pub indexed_at: DateTime<Utc>,
}

/// RAG 召回结果
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RagRecall {
    pub chunks: Vec<RagChunk>,
    pub total_found: usize,
    /// 是否因窗口溢出裁剪
    pub truncated: bool,
    pub query: String,
}

/// 全局 RAG 索引存储
#[derive(Clone, Default)]
pub struct RagStore {
    inner: Arc<RwLock<Option<RagIndex>>>,
}

impl RagStore {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn get(&self) -> Option<RagIndex> {
        self.inner.read().await.clone()
    }

    pub async fn set(&self, index: RagIndex) {
        *self.inner.write().await = Some(index);
    }

    pub async fn clear(&self) {
        *self.inner.write().await = None;
    }

    pub async fn rebuild(&self, project_root: &Path) -> Result<RagIndex, AppError> {
        let index = build_index(project_root)?;
        self.set(index.clone()).await;
        Ok(index)
    }
}

/// 获取全局 RAG 存储（进程级单例）。
///
/// 因不能修改 state.rs，使用 OnceLock 在本模块内托管全局实例。
pub fn global_store() -> &'static RagStore {
    static STORE: OnceLock<RagStore> = OnceLock::new();
    STORE.get_or_init(RagStore::new)
}

/* ============================================================
 * 索引构建
 * ============================================================ */

/// 构建项目 RAG 索引。
/// 递归扫描项目根，过滤 IGNORED_DIRS，按文件分块（每块约 500 行）。
pub fn build_index(project_root: &Path) -> Result<RagIndex, AppError> {
    let canonical = project_root.canonicalize().map_err(|e| {
        AppError::BadRequest(format!("项目根目录无效: {}: {e}", project_root.display()))
    })?;

    let mut chunks: Vec<RagChunk> = Vec::new();
    let mut total_files = 0usize;
    let mut total_tokens = 0usize;

    walk_dir(
        &canonical,
        &canonical,
        &mut chunks,
        &mut total_files,
        &mut total_tokens,
    )?;

    Ok(RagIndex {
        project_root: canonical.display().to_string(),
        chunks,
        total_files,
        total_tokens,
        indexed_at: Utc::now(),
    })
}

/// 递归遍历目录，对支持的源码文件分块。
fn walk_dir(
    root: &Path,
    current: &Path,
    chunks: &mut Vec<RagChunk>,
    total_files: &mut usize,
    total_tokens: &mut usize,
) -> Result<(), AppError> {
    let entries = std::fs::read_dir(current)
        .map_err(|e| AppError::Tool(format!("读取目录 {} 失败: {e}", current.display())))?;

    for entry in entries.flatten() {
        let path = entry.path();
        let name = match path.file_name().and_then(|n| n.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };

        if path.is_dir() {
            // 过滤忽略目录
            if IGNORED_DIRS.contains(&name.as_str()) {
                continue;
            }
            walk_dir(root, &path, chunks, total_files, total_tokens)?;
            continue;
        }

        // 仅处理白名单扩展名（同时过滤二进制文件）
        let ext = match path.extension().and_then(|e| e.to_str()) {
            Some(e) => e.to_lowercase(),
            None => continue,
        };
        if !SUPPORTED_EXTS.contains(&ext.as_str()) {
            continue;
        }

        // 单文件上限 50KB
        let metadata = match std::fs::metadata(&path) {
            Ok(m) => m,
            Err(_) => continue,
        };
        if metadata.len() > MAX_FILE_BYTES {
            continue;
        }

        // 读取内容（UTF-8 失败则跳过）
        let content = match std::fs::read_to_string(&path) {
            Ok(c) => c,
            Err(_) => continue,
        };

        // 相对路径
        let rel = path
            .strip_prefix(root)
            .ok()
            .map(|p| p.display().to_string())
            .unwrap_or_else(|| path.display().to_string());

        *total_files += 1;

        // 按行分块（无重叠）
        let lines: Vec<&str> = content.lines().collect();
        for (idx, chunk_lines) in lines.chunks(CHUNK_LINES).enumerate() {
            let start_line = idx * CHUNK_LINES + 1;
            let end_line = start_line + chunk_lines.len() - 1;
            let block: String = chunk_lines.join("\n");
            let tokens = estimate_tokens(&block);
            let hash = content_hash(&block);
            let id = format!("{}:{}-{}", rel, start_line, end_line);
            chunks.push(RagChunk {
                id,
                file_path: rel.clone(),
                start_line,
                end_line,
                content: block,
                tokens,
                hash,
            });
            *total_tokens += tokens;
        }

        // 空文件保留一个空块占位
        if lines.is_empty() {
            let id = format!("{}:0-0", rel);
            chunks.push(RagChunk {
                id,
                file_path: rel.clone(),
                start_line: 0,
                end_line: 0,
                content: String::new(),
                tokens: 0,
                hash: content_hash(""),
            });
        }
    }

    Ok(())
}

/* ============================================================
 * 召回
 * ============================================================ */

/// 召回相关代码块。
/// 简化实现: 按关键词匹配（不引入向量数据库）。
/// 关键词来源: query 分词 + camelCase/snake_case 拆分。
pub fn recall(index: &RagIndex, query: &str, max_chunks: usize, max_tokens: usize) -> RagRecall {
    let keywords = extract_keywords(query);

    // 评分并筛选
    let mut scored: Vec<(usize, usize)> = Vec::with_capacity(index.chunks.len());
    for (idx, chunk) in index.chunks.iter().enumerate() {
        let score = score_chunk(chunk, &keywords);
        if score > 0 {
            scored.push((idx, score));
        }
    }

    // 按评分降序
    scored.sort_by(|a, b| b.1.cmp(&a.1));

    let total_found = scored.len();

    let mut selected: Vec<RagChunk> = Vec::new();
    let mut accumulated_tokens = 0usize;
    let mut truncated = false;

    if max_chunks > 0 && max_tokens > 0 {
        for (idx, _score) in scored {
            if selected.len() >= max_chunks {
                truncated = true;
                break;
            }
            let chunk = &index.chunks[idx];
            if accumulated_tokens + chunk.tokens > max_tokens {
                truncated = true;
                break;
            }
            accumulated_tokens += chunk.tokens;
            selected.push(chunk.clone());
        }
    }

    RagRecall {
        chunks: selected,
        total_found,
        truncated,
        query: query.to_string(),
    }
}

/// 评分单个 chunk。
/// 文件名匹配 +5，路径匹配 +3，内容匹配 +1（出现次数，单关键词封顶 50）。
fn score_chunk(chunk: &RagChunk, keywords: &[String]) -> usize {
    if keywords.is_empty() {
        return 0;
    }
    let file_name = chunk
        .file_path
        .rsplit(|c| c == '/' || c == '\\')
        .next()
        .unwrap_or("")
        .to_lowercase();
    let path_lower = chunk.file_path.to_lowercase();
    let content_lower = chunk.content.to_lowercase();

    let mut score = 0usize;
    for kw in keywords {
        if kw.is_empty() {
            continue;
        }
        if file_name.contains(kw) {
            score += 5;
        }
        if path_lower.contains(kw) {
            score += 3;
        }
        let count = content_lower.matches(kw.as_str()).count();
        // 单关键词内容命中封顶 50，避免长文件刷分
        score += count.min(50);
    }
    score
}

/// 将召回结果格式化为上下文片段（固定顺序）。
///
/// 按 chunks 列表顺序输出，不重排，不打乱前缀结构。
pub fn format_context(recall: &RagRecall) -> String {
    let mut buf = String::new();
    buf.push_str("# 项目上下文（RAG 召回）\n\n");
    if recall.chunks.is_empty() {
        buf.push_str("（无匹配代码块）\n");
        return buf;
    }
    for chunk in &recall.chunks {
        buf.push_str(&format!(
            "## {} (L{}-L{})\n```\n{}\n```\n\n",
            chunk.file_path, chunk.start_line, chunk.end_line, chunk.content
        ));
    }
    buf
}

/* ============================================================
 * 工具函数
 * ============================================================ */

/// 粗略估算 token 数（bytes / 4）。
fn estimate_tokens(s: &str) -> usize {
    if s.is_empty() {
        0
    } else {
        (s.as_bytes().len() / 4).max(1)
    }
}

/// 内容哈希（DefaultHasher，进程内一致即可，不跨进程持久化）。
fn content_hash(s: &str) -> u64 {
    let mut h = DefaultHasher::new();
    s.hash(&mut h);
    h.finish()
}

/// 从查询字符串提取关键词。
/// 转小写 → 按非字母数字字符分词 → camelCase/snake_case/kebab-case 拆分 → 去重。
fn extract_keywords(query: &str) -> Vec<String> {
    let mut result: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    for raw in query.split(|c: char| !c.is_alphanumeric() && c != '_' && c != '-') {
        if raw.is_empty() {
            continue;
        }
        for part in split_identifier(raw) {
            let lower = part.to_lowercase();
            // 过滤过短 token（单字符噪声）与纯数字
            if lower.len() >= 2 && !lower.chars().all(|c| c.is_ascii_digit()) && seen.insert(lower.clone()) {
                result.push(lower);
            }
        }
    }
    result
}

/// 拆分标识符: camelCase / snake_case / kebab-case → 小写片段。
fn split_identifier(s: &str) -> Vec<String> {
    let mut result = Vec::new();
    let mut current = String::new();
    let mut prev_lower = false;

    for c in s.chars() {
        if c == '_' || c == '-' {
            if !current.is_empty() {
                result.push(current.clone());
                current.clear();
            }
            prev_lower = false;
        } else if c.is_uppercase() {
            if prev_lower && !current.is_empty() {
                // camelCase 边界
                result.push(current.clone());
                current.clear();
            }
            current.push(c.to_ascii_lowercase());
            prev_lower = false;
        } else {
            current.push(c);
            prev_lower = c.is_ascii_lowercase();
        }
    }
    if !current.is_empty() {
        result.push(current);
    }
    result
}

/* ============================================================
 * HTTP 处理器
 * ============================================================ */

/// GET /api/rag/index → 获取当前索引。
pub async fn get_index(State(_state): State<SharedState>) -> Json<Value> {
    let idx = global_store().get().await;
    Json(json!({
        "index": idx,
        "hasIndex": idx.is_some(),
    }))
}

/// POST /api/rag/index → 重建索引。
pub async fn build_index_handler(
    State(state): State<SharedState>,
) -> Result<Json<Value>, AppError> {
    let root = state.project_root().await.ok_or_else(|| {
        AppError::BadRequest("未加载项目目录, 请先调用 POST /api/project/load".into())
    })?;
    let index = global_store().rebuild(&root).await?;
    tracing::info!(
        "RAG 索引重建完成: {} 文件, {} 块, {} tokens",
        index.total_files,
        index.chunks.len(),
        index.total_tokens
    );
    Ok(Json(json!(index)))
}

/// POST /api/rag/recall 请求体。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecallBody {
    pub query: String,
    #[serde(default = "default_max_chunks")]
    pub max_chunks: usize,
    #[serde(default = "default_max_tokens")]
    pub max_tokens: usize,
}

fn default_max_chunks() -> usize {
    10
}

fn default_max_tokens() -> usize {
    4000
}

/// POST /api/rag/recall → 召回相关代码块。
pub async fn recall_handler(
    State(_state): State<SharedState>,
    Json(body): Json<RecallBody>,
) -> Result<Json<Value>, AppError> {
    if body.query.trim().is_empty() {
        return Err(AppError::BadRequest("query 不能为空".into()));
    }
    let index = global_store()
        .get()
        .await
        .ok_or_else(|| AppError::BadRequest("RAG 索引未构建, 请先 POST /api/rag/index".into()))?;
    let recall = recall(&index, &body.query, body.max_chunks, body.max_tokens);
    Ok(Json(json!(recall)))
}

/// DELETE /api/rag/clear → 清空索引。
pub async fn clear_index(State(_state): State<SharedState>) -> Json<Value> {
    global_store().clear().await;
    Json(json!({ "cleared": true }))
}
