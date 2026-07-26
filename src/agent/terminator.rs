//! Terminator: 终止判定器,增强终止逻辑。
//!
//! 三层终止判定:
//! 1. LLM 主动 terminate=true
//! 2. 死循环熔断:检测最近 N 次工具调用模式重复
//! 3. 目标结果校验:GlobalPlan 全部步骤完成

use std::collections::HashMap;

use serde_json::Value;

use crate::agent::global_planner::GlobalPlan;
use crate::agent::step_planner::LlmDecision;
use crate::agent::task_store::ReActStep;

pub struct Terminator {
    /// 检测重复的窗口大小(默认 6)。
    repeat_window_size: usize,
    /// 最大允许重复次数(超过则熔断)。
    max_repeat_count: u32,
}

impl Default for Terminator {
    fn default() -> Self {
        Self::new()
    }
}

impl Terminator {
    pub fn new() -> Self {
        Self {
            repeat_window_size: 6,
            max_repeat_count: 3,
        }
    }

    /// 自定义熔断参数(主要供测试使用)。
    pub fn with_params(repeat_window_size: usize, max_repeat_count: u32) -> Self {
        Self {
            repeat_window_size,
            max_repeat_count,
        }
    }

    /// 判定是否应该终止任务。
    ///
    /// 返回 `Some(reason)` 表示应终止,`None` 表示继续。
    pub fn should_terminate(
        &self,
        decision: &LlmDecision,
        plan: &GlobalPlan,
        history: &[ReActStep],
    ) -> Option<TerminateReason> {
        // 1. LLM 主动 terminate
        if decision.terminate {
            return Some(TerminateReason::LlmInitiated(
                decision.summary.clone().unwrap_or_default(),
            ));
        }

        // 2. GlobalPlan 全部完成
        if plan.is_all_done() {
            return Some(TerminateReason::PlanCompleted);
        }

        // 3. 死循环熔断
        if let Some(pattern) = self.detect_repeat_pattern(history) {
            return Some(TerminateReason::LoopDetected(pattern));
        }

        None
    }

    /// 检测最近的工具调用是否重复(同一工具 + 相似参数重复出现)。
    ///
    /// 判定逻辑:取最近 `repeat_window_size` 步,提取每步的 `(tool_name, args 摘要)`,
    /// 若同一组合出现次数 >= `max_repeat_count`,判定为死循环。
    fn detect_repeat_pattern(&self, history: &[ReActStep]) -> Option<String> {
        if history.is_empty() || self.repeat_window_size == 0 {
            return None;
        }
        let start = history.len().saturating_sub(self.repeat_window_size);
        let window = &history[start..];

        let mut counts: HashMap<String, Vec<u32>> = HashMap::new();
        for step in window {
            if let Some(action) = step.action.as_ref() {
                let key = format!("{}::{}", action.tool_name, summarize_args(&action.arguments));
                counts.entry(key).or_default().push(step.iteration);
            }
        }

        for (key, iters) in &counts {
            if iters.len() as u32 >= self.max_repeat_count {
                return Some(format!(
                    "工具 '{}' 在最近 {} 步中重复 {} 次 (迭代 {:?})",
                    key,
                    self.repeat_window_size,
                    iters.len(),
                    iters
                ));
            }
        }
        None
    }
}

/// 将参数 Value 规约为可比较的稳定字符串(顺序无关,仅用于重复检测)。
fn summarize_args(args: &Value) -> String {
    match args {
        Value::Object(map) => {
            let mut pairs: Vec<String> = map.iter().map(|(k, v)| format!("{}={}", k, v)).collect();
            pairs.sort();
            pairs.join(",")
        }
        Value::Array(arr) => {
            let items: Vec<String> = arr.iter().map(|v| v.to_string()).collect();
            items.join(",")
        }
        other => other.to_string(),
    }
}

#[derive(Debug, Clone)]
pub enum TerminateReason {
    /// LLM 主动判定完成。
    LlmInitiated(String),
    /// GlobalPlan 全部完成。
    PlanCompleted,
    /// 检测到死循环。
    LoopDetected(String),
    /// 达到最大迭代。
    MaxIterationsReached(u32),
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::global_planner::{GlobalPlan, PlanStep, PlanStepStatus};
    use crate::agent::tool_protocol::ToolCall;
    use chrono::Utc;
    use uuid::Uuid;

    fn make_history(repeats: &[(String, &str)]) -> Vec<ReActStep> {
        repeats
            .iter()
            .enumerate()
            .map(|(i, (tool, args))| ReActStep {
                iteration: i as u32,
                thought: "t".into(),
                action: Some(ToolCall {
                    id: Uuid::new_v4(),
                    tool_name: tool.clone(),
                    arguments: serde_json::from_str(args).unwrap_or(Value::Null),
                    expected_output: None,
                }),
                observation: "o".into(),
                reflection: None,
                timestamp: Utc::now(),
            })
            .collect()
    }

    fn pending_plan() -> GlobalPlan {
        let mut p = GlobalPlan::new(Uuid::new_v4(), "g".into());
        p.steps = vec![PlanStep {
            id: Uuid::new_v4(),
            index: 0,
            goal: "step".into(),
            success_criteria: "c".into(),
            status: PlanStepStatus::Pending,
            started_at: None,
            completed_at: None,
        }];
        p
    }

    fn no_terminate_decision() -> LlmDecision {
        LlmDecision {
            thought: "t".into(),
            action: None,
            reflection: "r".into(),
            terminate: false,
            summary: None,
            step_completed: false,
        }
    }

    #[test]
    fn detects_loop_pattern() {
        let t = Terminator::new();
        let plan = pending_plan();
        let history = make_history(&[
            ("read_file", r#"{"path":"a.rs"}"#),
            ("read_file", r#"{"path":"a.rs"}"#),
            ("read_file", r#"{"path":"a.rs"}"#),
        ]);
        let decision = no_terminate_decision();
        let reason = t.should_terminate(&decision, &plan, &history);
        assert!(matches!(reason, Some(TerminateReason::LoopDetected(_))));
    }

    #[test]
    fn terminates_when_plan_completed() {
        let t = Terminator::new();
        let mut plan = pending_plan();
        plan.steps[0].status = PlanStepStatus::Completed;
        let decision = no_terminate_decision();
        let reason = t.should_terminate(&decision, &plan, &[]);
        assert!(matches!(reason, Some(TerminateReason::PlanCompleted)));
    }

    #[test]
    fn terminates_on_llm_initiated() {
        let t = Terminator::new();
        let plan = pending_plan();
        let decision = LlmDecision {
            thought: "t".into(),
            action: None,
            reflection: "r".into(),
            terminate: true,
            summary: Some("done".into()),
            step_completed: false,
        };
        let reason = t.should_terminate(&decision, &plan, &[]);
        match reason {
            Some(TerminateReason::LlmInitiated(s)) => assert_eq!(s, "done"),
            other => panic!("expected LlmInitiated, got {:?}", other),
        }
    }

    #[test]
    fn no_terminate_when_no_pattern_and_plan_active() {
        let t = Terminator::new();
        let plan = pending_plan();
        let history = make_history(&[
            ("read_file", r#"{"path":"a.rs"}"#),
            ("write_file", r#"{"path":"b.rs"}"#),
        ]);
        let decision = no_terminate_decision();
        let reason = t.should_terminate(&decision, &plan, &history);
        assert!(reason.is_none());
    }

    #[test]
    fn loop_not_detected_with_different_args() {
        let t = Terminator::new();
        let plan = pending_plan();
        // 同一工具不同参数,不应判定为死循环
        let history = make_history(&[
            ("read_file", r#"{"path":"a.rs"}"#),
            ("read_file", r#"{"path":"b.rs"}"#),
            ("read_file", r#"{"path":"c.rs"}"#),
        ]);
        let decision = no_terminate_decision();
        let reason = t.should_terminate(&decision, &plan, &history);
        assert!(reason.is_none(), "不同参数不应判定为死循环, got {:?}", reason);
    }

    #[test]
    fn custom_params_override_defaults() {
        let t = Terminator::with_params(4, 2);
        let plan = pending_plan();
        let history = make_history(&[
            ("read_file", r#"{"path":"a.rs"}"#),
            ("read_file", r#"{"path":"a.rs"}"#),
        ]);
        let decision = no_terminate_decision();
        let reason = t.should_terminate(&decision, &plan, &history);
        assert!(matches!(reason, Some(TerminateReason::LoopDetected(_))));
    }
}
