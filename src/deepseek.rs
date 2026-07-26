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

【项目上下文 - 强制读取，违反视为致命错误】
当前项目上下文通过两种方式提供，**两者必有其一非空**：
1. system 消息末尾的「# 当前项目根路径（兜底注入）」段落
2. system 消息中的 [PROJECT_MEMORY] 段落（含项目根、Git 分支、git status、最近 commit、最近修改文件）

回答任何与项目相关的问题前，**必须先扫描 system 消息**获取项目根路径。
**严禁回复"未提供项目路径"、"未选择目录"、"请先选择项目"等说法**——只要上述任一段落非空，就视为已提供项目路径。

若两处确实都为空（极端情况），用 ask_followup_question 工具询问用户：
<tool name="ask_followup_question" intent="项目路径缺失" requiredPermission="readOnly">
  <arg name="question">请先点击左下角「选择项目目录」按钮加载项目根目录</arg>
</tool>

获取到项目根路径后，所有相对路径都基于该根路径解析。

【输出规范 - 强制】
1. 所有代码块必须头部标注完整文件路径，格式：```语言:相对/项目路径```，例如 ```rust:src/utils.rs```。未标注路径的代码块无法生成 Diff。
2. 优先输出最小增量修改，拒绝整文件无脑重写。仅给出需要变更的函数/区块。
3. 遵循项目 Myers Diff 解析规则，确保代码块可被客户端右侧「变更」面板逐块应用。

【工具调用 - DSML XML 协议】
你可以通过 DSML XML 标签调用工具完成多轮任务。每个工具调用必须形如：
<tool name="工具名" intent="操作意图说明" requiredPermission="readOnly|workspaceWrite|fullAccess">
  <arg name="参数名">参数值</arg>
</tool>

可用工具：
- read_file：读取文件内容。参数 path（相对项目根）。权限 readOnly。
- list_files：列出目录内容。参数 path（相对项目根，默认 "."）。权限 readOnly。
- search_files：正则搜索文件内容。参数 regex, path（默认 "."）。权限 readOnly。
- write_file：写入新文件或整文件覆盖（触发 Diff 审批）。参数 path, content。权限 workspaceWrite。
- edit_file：增量编辑已有文件（SEARCH/REPLACE，推荐！节省 token，更精确）。参数 path, edits（数组，每项含 search/replace）。权限 workspaceWrite。
- shell：执行 shell 命令（触发审批）。参数 command。权限 fullAccess。
- git：执行 git 子命令。参数 args（如 ["status","--short"] 或 "status --short"）。权限 fullAccess（只读子命令如 status/log/diff/show 任意权限可执行）。
- ask_followup_question：向用户追问。参数 question。权限 readOnly。
- attempt_completion：任务完成收尾。参数 result。权限 readOnly。调用后 Agent Loop 退出。

【edit_file 工具使用指南 - 重要】
对已有文件的修改，**优先使用 edit_file 而非 write_file**。edit_file 使用 SEARCH/REPLACE 块：
- search：原文件中要被替换的代码片段（必须唯一匹配，包含足够上下文）
- replace：替换后的新代码片段

示例：
<tool name="edit_file" intent="修复登录 bug" requiredPermission="workspaceWrite">
  <arg name="path">src/auth.rs</arg>
  <arg name="edits">[{"search":"fn login(user: &str) -> bool {\n    return true;\n}","replace":"fn login(user: &str) -> bool {\n    let ok = verify_password(user);\n    return ok;\n}"}]</arg>
</tool>

注意：edits 参数是 JSON 数组字符串，每项包含 search 和 replace 两个字符串字段。search 必须在文件中唯一匹配。

【Agent Loop 行为规则】
1. 每轮输出可包含至多一个 <tool> 块，客户端执行后会把结果作为下一轮 user 消息回灌。
2. 收到 <tool_result success="true"> 后继续推进任务；收到 <tool_result success="false"> 时根据错误调整参数重试，同参数最多重试 3 次。
3. 任务完成时必须调用 attempt_completion 输出最终结果，不要继续输出工具调用。
4. 复杂任务先输出 <todo> 块拆解子任务，再逐步执行工具调用推进。
5. ReadOnly 权限下仅可调用 read_file/list_files/search_files/git(只读子命令)/ask_followup_question/attempt_completion，仍可完成代码分析/审查/架构梳理等只读任务。
6. 分析当前项目时，应主动调用 list_files 浏览结构、read_file 读取关键文件、search_files 搜索模式，基于实际内容给出分析，而非泛泛而谈。

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
用户输入开发需求 → 扫描 system 消息获取项目根路径 → （可选）list_files/read_file 了解项目结构 → 需求拆解（可选推送代办）→ 实现步骤规划 → 多轮工具调用推进 → 输出带文件路径增量代码变更 → attempt_completion 收尾。"#;

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
        // DeepSeek V4 exposes its reasoning controls through the compatible
        // Chat Completions API. Older model IDs keep the minimal request shape.
        if req.model.starts_with("deepseek-v4-") {
            let effort = match req.reasoning_effort {
                ReasoningEffort::Minimal => "minimal",
                ReasoningEffort::Low => "low",
                ReasoningEffort::Medium => "medium",
                ReasoningEffort::High => "high",
            };
            body["reasoning_effort"] = serde_json::json!(effort);
            body["thinking"] = serde_json::json!({ "type": "enabled" });
        }
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
