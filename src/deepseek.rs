//! DeepSeek (OpenAI 兼容) 流式客户端。
//!
//! 端点: `{base_url}/chat/completions`, 使用 Bearer 鉴权, SSE 流式返回。
//! 同时解析 `content` 与 `reasoning_content` (deepseek-reasoner 模型)。

use crate::config::{DeepSeekConfig, ReasoningEffort};
use crate::error::{AppError, AppResult};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

/// CodeWhale 工程级 Agent 默认系统提示（P0-1）。
///
/// 约束 Agent：
///   - 代码块头部必须标注完整文件路径（```lang:path/to/file）
///   - 输出最小增量修改，拒绝整文件无脑重写
///   - 不直接执行系统调用，所有 IO/命令交由客户端权限模块审批
///   - 复杂需求先输出 `<todo>` 块拆解子任务
///   - 适配 DeepSeek 流式输出（reasoning + content 双流）
///
/// 用户自定义 system_prompt 会拼接在此提示之后（而非覆盖），保留强制约束。
pub const DEFAULT_AGENT_SYSTEM_PROMPT: &str = r#"你是绑定 CodeWhale Desktop 的工程级 AI 编程 Agent，优先适配 DeepSeek 系列模型。

【输出规范 - 强制】
1. 所有代码块必须头部标注完整文件路径，格式：```语言:相对/项目路径```，例如 ```rust:src/utils.rs```。未标注路径的代码块无法生成 Diff。
2. 优先输出最小增量修改，拒绝整文件无脑重写。仅给出需要变更的函数/区块。
3. 遵循项目 Myers Diff 解析规则，确保代码块可被客户端右侧「变更」面板逐块应用。

【行为约束 - 强制】
1. 自动识别当前激活工作目录，过滤 node_modules/build/target/.git 等忽略目录。
2. 所有文件创建/修改/删除、shell 命令调用，全部交由客户端权限模块管控。你仅描述操作意图，不直接执行任何系统调用，等待客户端弹窗审批。
3. 遇到权限不足场景，主动告知用户前往设置调整权限等级。

【DeepSeek 能力适配】
1. 区分推理思考文本与正式代码块，思考过程走 reasoning，代码走 content。
2. 支持 effort 推理强度、ctx 上下文长度、上下文缓存三大原生参数，行为跟随客户端配置动态调整。

【代办任务 - 复杂需求强制】
收到大型复杂需求时，先输出 `<todo>` 标签块拆解子任务，每行一个，格式：
<todo>
实现 sha256 工具函数
补充单元测试
更新文档
</todo>
后端会解析并推送至客户端代办面板。

【输出流程】
用户输入开发需求 → 需求拆解（可选推送代办）→ 实现步骤规划 → 输出带文件路径增量代码变更 → 给出后续测试/Git 提交流程指引。"#;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ChatRole {
    System,
    User,
    Assistant,
    Tool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: ChatRole,
    pub content: String,
}

impl ChatMessage {
    pub fn system(content: impl Into<String>) -> Self {
        Self { role: ChatRole::System, content: content.into() }
    }
    pub fn user(content: impl Into<String>) -> Self {
        Self { role: ChatRole::User, content: content.into() }
    }
    pub fn assistant(content: impl Into<String>) -> Self {
        Self { role: ChatRole::Assistant, content: content.into() }
    }
}

/// 流式增量。
#[derive(Debug, Clone, Serialize)]
pub struct StreamDelta {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "reasoningContent")]
    pub reasoning: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "finishReason")]
    pub finish_reason: Option<String>,
}

pub struct ChatRequest {
    pub model: String,
    pub messages: Vec<ChatMessage>,
    pub reasoning_effort: ReasoningEffort,
    pub enable_cache: bool,
    pub max_tokens: Option<u32>,
    pub temperature: Option<f32>,
}

#[derive(Clone)]
pub struct DeepSeekClient {
    http: reqwest::Client,
}

impl DeepSeekClient {
    pub fn new() -> Self {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(300))
            .build()
            .expect("failed to build reqwest client");
        Self { http }
    }

    /// 发起流式对话, 返回增量接收通道。任务在 cancel 被触发或流结束时退出。
    pub async fn chat_stream(
        &self,
        req: ChatRequest,
        cfg: &DeepSeekConfig,
        cancel: CancellationToken,
    ) -> AppResult<mpsc::Receiver<AppResult<StreamDelta>>> {
        if cfg.api_key.trim().is_empty() {
            return Err(AppError::Config("DeepSeek API Key 未配置".into()));
        }

        let url = format!("{}/chat/completions", cfg.base_url.trim_end_matches('/'));
        let body = self.build_body(&req);

        let resp = self
            .http
            .post(&url)
            .bearer_auth(&cfg.api_key)
            .json(&body)
            .send()
            .await?;

        let status = resp.status();
        if !status.is_success() {
            let text = resp.text().await.unwrap_or_default();
            return Err(AppError::DeepSeek {
                status: status.as_u16(),
                body: text,
            });
        }

        let (tx, rx) = mpsc::channel::<AppResult<StreamDelta>>(64);

        let byte_stream = resp.bytes_stream();
        tokio::spawn(async move {
            let result = run_stream(byte_stream, tx.clone(), cancel).await;
            if let Err(e) = result {
                let _ = tx.send(Err(e)).await;
            }
        });

        Ok(rx)
    }

    fn build_body(&self, req: &ChatRequest) -> serde_json::Value {
        let mut body = serde_json::json!({
            "model": req.model,
            "messages": req.messages,
            "stream": true,
        });
        if let Some(mt) = req.max_tokens {
            body["max_tokens"] = serde_json::json!(mt);
        }
        if let Some(t) = req.temperature {
            body["temperature"] = serde_json::json!(t);
        }
        // DeepSeek's direct Chat Completions endpoint accepts the OpenAI-compatible
        // request shape. Context caching and effort selection are local agent
        // concerns; sending them as undocumented fields makes many compatible
        // gateways reject an otherwise valid request.
        body
    }

    /// 非流式 ping: 用极小请求探测 Key 是否有效 (供 /api/config/deepseek/test 复用)。
    pub async fn probe(&self, cfg: &DeepSeekConfig) -> AppResult<()> {
        if cfg.api_key.trim().is_empty() {
            return Err(AppError::Config("DeepSeek API Key 未配置".into()));
        }
        let url = format!("{}/models", cfg.base_url.trim_end_matches('/'));
        let resp = self.http.get(&url).bearer_auth(&cfg.api_key).send().await?;
        let status = resp.status();
        if !status.is_success() {
            let text = resp.text().await.unwrap_or_default();
            return Err(AppError::DeepSeek { status: status.as_u16(), body: text });
        }
        Ok(())
    }
}

async fn run_stream<S>(
    byte_stream: S,
    tx: mpsc::Sender<AppResult<StreamDelta>>,
    cancel: CancellationToken,
) -> AppResult<()>
where
    S: futures_util::Stream<Item = Result<bytes::Bytes, reqwest::Error>>,
{
    tokio::pin!(byte_stream);
    let mut buffer = String::new();
    loop {
        tokio::select! {
            biased;
            _ = cancel.cancelled() => {
                tracing::info!("chat stream cancelled by client");
                return Ok(());
            }
            chunk = byte_stream.next() => {
                match chunk {
                    None => break,
                    Some(Err(e)) => return Err(AppError::DeepSeekTransport(e)),
                    Some(Ok(bytes)) => {
                        buffer.push_str(&String::from_utf8_lossy(&bytes));
                        // SSE 事件以空行分隔
                        while let Some(idx) = buffer.find("\n\n") {
                            let block: String = buffer.drain(..idx + 2).collect();
                            for ev in parse_sse_block(&block) {
                                if tx.send(ev).await.is_err() {
                                    return Ok(()); // 接收端已关闭
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    // flush 残留
    if !buffer.trim().is_empty() {
        for ev in parse_sse_block(&buffer) {
            if tx.send(ev).await.is_err() {
                return Ok(());
            }
        }
    }
    Ok(())
}

fn parse_sse_block(block: &str) -> Vec<AppResult<StreamDelta>> {
    let data: String = block
        .lines()
        .filter_map(|l| l.strip_prefix("data:").map(|s| s.trim().to_string()))
        .collect::<Vec<_>>()
        .join("");
    if data.is_empty() {
        return Vec::new();
    }
    if data.trim() == "[DONE]" {
        return vec![Ok(StreamDelta {
            content: None,
            reasoning: None,
            finish_reason: Some("stop".into()),
        })];
    }
    match serde_json::from_str::<serde_json::Value>(&data) {
        Ok(v) => {
            let choice = v.get("choices").and_then(|c| c.get(0));
            match choice {
                Some(c) => {
                    let delta = c.get("delta");
                    let content = delta
                        .and_then(|d| d.get("content"))
                        .and_then(|x| x.as_str())
                        .map(|s| s.to_string());
                    let reasoning = delta
                        .and_then(|d| d.get("reasoning_content"))
                        .and_then(|x| x.as_str())
                        .map(|s| s.to_string());
                    let finish_reason = c
                        .get("finish_reason")
                        .and_then(|x| x.as_str())
                        .map(|s| s.to_string());
                    if content.is_none() && reasoning.is_none() && finish_reason.is_none() {
                        Vec::new()
                    } else {
                        vec![Ok(StreamDelta { content, reasoning, finish_reason })]
                    }
                }
                None => Vec::new(),
            }
        }
        Err(e) => {
            tracing::warn!("failed to parse sse json: {e}; raw={data}");
            Vec::new()
        }
    }
}
