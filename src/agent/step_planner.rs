//! StepPlanner: 每轮 ReAct 局部动作规划,对齐 GlobalPlan 决定下一步。
//!
//! 与 GlobalPlanner 区别:
//! - GlobalPlanner: 任务启动时一次性生成,描述宏观阶段
//! - StepPlanner: 每轮迭代调用,根据 GlobalPlan + history + observation 决定当前轮的具体动作

use std::sync::Arc;

use serde_json::Value;
use tokio::sync::RwLock;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::agent::global_planner::GlobalPlan;
use crate::agent::react_engine::extract_json_object;
use crate::agent::task_store::ReActStep;
use crate::agent::tool_protocol::ToolCall;
use crate::config::{DeepSeekConfig, ReasoningEffort};
use crate::deepseek::{ChatMessage, ChatRequest, DeepSeekClient};

pub struct StepPlanner {
    client: Arc<DeepSeekClient>,
    config: Arc<RwLock<DeepSeekConfig>>,
}

impl StepPlanner {
    pub fn new(client: Arc<DeepSeekClient>, config: Arc<RwLock<DeepSeekConfig>>) -> Self {
        Self { client, config }
    }

    /// 决策当前轮动作:返回 thought + action(可能为 None) + reflection + terminate。
    ///
    /// 关键改进:在 user_prompt 中注入 GlobalPlan,要求 LLM 对齐当前 plan step。
    pub async fn decide_next_action(
        &self,
        user_request: &str,
        plan: &GlobalPlan,
        history: &[ReActStep],
        observation: &str,
        available_tools: &str,
        iteration: u32,
        max_iterations: u32,
        cancel: &CancellationToken,
    ) -> Result<LlmDecision, anyhow::Error> {
        let ds_cfg = self.config.read().await.clone();

        let system_prompt = r#"你是自治代码 Agent,根据 GlobalPlan 当前阶段与历史步骤决定下一步动作。

你必须输出严格的 JSON (不要包裹在 markdown 代码块中),格式如下:
{
  "thought": "对当前情况的分析思考 (必填)",
  "action": null,
  "reflection": "对观察结果的反思与下一步规划 (必填)",
  "terminate": false,
  "summary": null,
  "step_completed": false
}

字段说明:
- thought: 对当前情况的分析思考
- action: null 表示不调用工具 (仅思考);或 {"tool": "工具名", "args": {...}} 表示调用工具
- reflection: 对观察结果的反思,判断是否继续/完成
- terminate: true 表示任务全部完成 (此时 summary 必填为完成总结)
- summary: 仅 terminate=true 时填写完成总结
- step_completed: true 表示当前 plan step 已满足 success_criteria,可推进到下一步

输出 JSON 时不要包含任何额外文本、注释或 markdown 包裹。"#;

        let plan_text = plan.to_prompt_text();
        let current_step_info = match plan.current_step() {
            Some(s) => format!(
                "你正在执行步骤 {}: {}\n验收标准: {}",
                plan.current_step_index + 1,
                s.goal,
                s.success_criteria
            ),
            None => "(所有步骤已完成,考虑 terminate=true 收尾)".to_string(),
        };

        let history_text = if history.is_empty() {
            "(无历史步骤)".to_string()
        } else {
            history
                .iter()
                .map(|s| {
                    let action_str = s
                        .action
                        .as_ref()
                        .map(|c| format!("调用工具 {} (args: {})", c.tool_name, c.arguments))
                        .unwrap_or_else(|| "(仅思考,无工具调用)".to_string());
                    format!(
                        "[iter {}] Thought: {}\n  Action: {}\n  Observation: {}\n  Reflection: {}",
                        s.iteration,
                        s.thought,
                        action_str,
                        truncate(s.observation.as_str(), 500),
                        s.reflection.as_deref().unwrap_or("(无)")
                    )
                })
                .collect::<Vec<_>>()
                .join("\n---\n")
        };

        let user_prompt = format!(
            r#"# 顶层规划(对齐当前步骤)
{plan_text}

# 当前阶段
{current_step_info}

# 原始需求
{user_request}

# 已执行步骤历史
{history_text}

# 当前观察
{observation}

# 可用工具
{available_tools}

# 当前迭代
第 {iter}/{max} 次迭代

请决定下一步动作,输出 JSON。"#,
            iter = iteration + 1,
            max = max_iterations,
        );

        let messages = vec![
            ChatMessage::system(system_prompt),
            ChatMessage::user(user_prompt),
        ];

        let chat_req = ChatRequest {
            model: ds_cfg.model.clone(),
            messages,
            reasoning_effort: ReasoningEffort::Medium,
            enable_cache: false,
            max_tokens: Some(2048),
            temperature: Some(0.0),
        };

        let mut rx = self
            .client
            .chat_stream(chat_req, &ds_cfg, cancel.clone())
            .await
            .map_err(|e| anyhow::anyhow!("StepPlanner LLM 调用失败: {e}"))?;

        let mut full = String::new();
        while let Some(delta) = rx.recv().await {
            match delta {
                Ok(d) => {
                    if let Some(c) = d.content {
                        full.push_str(&c);
                    }
                    if d.finish_reason.is_some() {
                        break;
                    }
                }
                Err(e) => return Err(anyhow::anyhow!("StepPlanner LLM 流错误: {e}")),
            }
        }

        parse_decision(&full)
    }
}

/// LLM 决策结果 (从 JSON 响应解析)。
///
/// 在原 ReAct 引擎字段基础上新增 `step_completed`,用于驱动 GlobalPlan 推进。
#[derive(Debug, Clone)]
pub struct LlmDecision {
    pub thought: String,
    pub action: Option<ToolCall>,
    pub reflection: String,
    pub terminate: bool,
    pub summary: Option<String>,
    /// 当前 plan step 是否已完成(满足 success_criteria)。
    pub step_completed: bool,
}

impl LlmDecision {
    /// 构造一个 step_completed=false 的兼容决策(供旧版 ReAct 路径使用)。
    pub fn legacy(
        thought: String,
        action: Option<ToolCall>,
        reflection: String,
        terminate: bool,
        summary: Option<String>,
    ) -> Self {
        Self {
            thought,
            action,
            reflection,
            terminate,
            summary,
            step_completed: false,
        }
    }
}

/// 解析 LLM JSON 响应为 LlmDecision。
///
/// 容错策略:
///   1. 尝试直接解析完整响应为 JSON
///   2. 失败则尝试从响应中提取首个 {...} 块再解析
///   3. 仍失败则把整个响应作为 thought,terminate=false (避免硬失败阻塞循环)
pub(crate) fn parse_decision(raw: &str) -> Result<LlmDecision, anyhow::Error> {
    let json_str = extract_json_object(raw).unwrap_or_else(|| raw.to_string());
    match serde_json::from_str::<Value>(&json_str) {
        Ok(v) => {
            let thought = v
                .get("thought")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string();
            let action = parse_action_field(v.get("action"));
            let reflection = v
                .get("reflection")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string();
            let terminate = v.get("terminate").and_then(|x| x.as_bool()).unwrap_or(false);
            let summary = v
                .get("summary")
                .and_then(|x| x.as_str())
                .map(|s| s.to_string());
            let step_completed = v
                .get("step_completed")
                .and_then(|x| x.as_bool())
                .unwrap_or(false);
            Ok(LlmDecision {
                thought,
                action,
                reflection,
                terminate,
                summary,
                step_completed,
            })
        }
        Err(e) => {
            tracing::warn!(
                "StepPlanner 响应解析失败,降级为纯思考: {e}; raw={}",
                truncate(raw, 200)
            );
            Ok(LlmDecision {
                thought: raw.trim().to_string(),
                action: None,
                reflection: "LLM 响应非合法 JSON,无法解析下一步动作".to_string(),
                terminate: false,
                summary: None,
                step_completed: false,
            })
        }
    }
}

/// 解析 action 字段为 ToolCall (None 表示无工具调用)。
fn parse_action_field(v: Option<&Value>) -> Option<ToolCall> {
    let v = v?;
    if v.is_null() {
        return None;
    }
    let tool_name = v.get("tool").and_then(|x| x.as_str())?.to_string();
    let arguments = v.get("args").cloned().unwrap_or(Value::Null);
    Some(ToolCall {
        id: Uuid::new_v4(),
        tool_name,
        arguments,
        expected_output: None,
    })
}

/// 截断字符串到指定字符数 (按 char boundary 安全截断)。
fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max).collect();
    out.push_str("...");
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_decision_full_json_with_step_completed() {
        let raw = r#"{"thought":"分析","action":{"tool":"read_file","args":{"path":"a.rs"}},"reflection":"ok","terminate":false,"summary":null,"step_completed":true}"#;
        let d = parse_decision(raw).unwrap();
        assert_eq!(d.thought, "分析");
        let action = d.action.expect("action should exist");
        assert_eq!(action.tool_name, "read_file");
        assert_eq!(action.arguments["path"], "a.rs");
        assert!(!d.terminate);
        assert!(d.step_completed);
    }

    #[test]
    fn parse_decision_invalid_json_falls_back_to_thought() {
        let raw = "这不是 JSON";
        let d = parse_decision(raw).unwrap();
        assert_eq!(d.thought, "这不是 JSON");
        assert!(d.action.is_none());
        assert!(!d.terminate);
        assert!(!d.step_completed);
    }

    #[test]
    fn parse_decision_extracts_from_markdown_block() {
        let raw = "```json\n{\"thought\":\"go\",\"action\":null,\"terminate\":true,\"summary\":\"done\",\"step_completed\":true}\n```";
        let d = parse_decision(raw).unwrap();
        assert_eq!(d.thought, "go");
        assert!(d.terminate);
        assert_eq!(d.summary.as_deref(), Some("done"));
        assert!(d.step_completed);
    }

    #[test]
    fn legacy_constructor_defaults_step_completed_false() {
        let d = LlmDecision::legacy(
            "t".into(),
            None,
            "r".into(),
            false,
            None,
        );
        assert!(!d.step_completed);
    }
}
