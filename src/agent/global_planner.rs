//! GlobalPlanner: 任务启动时生成顶层长期规划方案,持久保存,防止长任务跑偏。
//!
//! 设计借鉴 OpenHands 长周期自治任务引擎:
//! - 任务创建时调用 LLM 生成 GlobalPlan,持久化到 AgentTask
//! - 每轮 Reflecting 阶段,StepPlanner 读取 GlobalPlan 决定下一步
//! - LLM 漂移时,GlobalPlan 作为锚点拉回主线
//! - 任务进行中允许动态调整 plan (新增/完成/跳过步骤)

use std::path::Path;
use std::sync::Arc;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::RwLock;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::agent::react_engine::extract_json_object;
use crate::config::{DeepSeekConfig, ReasoningEffort};
use crate::deepseek::{ChatMessage, ChatRequest, DeepSeekClient};

/// 顶层规划步骤(比 TaskStep 更宏观,描述阶段性目标)。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlanStep {
    pub id: Uuid,
    /// 步骤序号(0-based)。
    pub index: usize,
    /// 阶段目标描述(如"克隆仓库到本地")。
    pub goal: String,
    /// 验收标准(如".git 目录存在")。
    pub success_criteria: String,
    pub status: PlanStepStatus,
    pub started_at: Option<DateTime<Utc>>,
    pub completed_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlanStepStatus {
    Pending,
    InProgress,
    Completed,
    Skipped,
    Failed,
}

impl PlanStepStatus {
    /// 渲染为提示词中使用的简短标记。
    fn marker(self) -> &'static str {
        match self {
            Self::Completed => "[✓]",
            Self::InProgress => "[→]",
            Self::Failed => "[✗]",
            Self::Skipped => "[↷]",
            Self::Pending => "[ ]",
        }
    }
}

/// 顶层长期规划。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GlobalPlan {
    pub task_id: Uuid,
    /// 总目标(原始用户需求摘要)。
    pub overall_goal: String,
    pub steps: Vec<PlanStep>,
    /// 当前执行到的步骤。
    pub current_step_index: usize,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl GlobalPlan {
    pub fn new(task_id: Uuid, overall_goal: String) -> Self {
        let now = Utc::now();
        Self {
            task_id,
            overall_goal,
            steps: Vec::new(),
            current_step_index: 0,
            created_at: now,
            updated_at: now,
        }
    }

    /// 获取当前步骤(未完成的第一个)。
    pub fn current_step(&self) -> Option<&PlanStep> {
        self.steps.get(self.current_step_index)
    }

    /// 标记当前步骤开始。
    pub fn start_current(&mut self) {
        if let Some(step) = self.steps.get_mut(self.current_step_index) {
            step.status = PlanStepStatus::InProgress;
            if step.started_at.is_none() {
                step.started_at = Some(Utc::now());
            }
        }
        self.updated_at = Utc::now();
    }

    /// 标记当前步骤完成,推进 current_step_index。
    pub fn complete_current(&mut self) {
        if let Some(step) = self.steps.get_mut(self.current_step_index) {
            step.status = PlanStepStatus::Completed;
            step.completed_at = Some(Utc::now());
        }
        if self.current_step_index < self.steps.len().saturating_sub(1) {
            self.current_step_index += 1;
        }
        self.updated_at = Utc::now();
    }

    /// 标记当前步骤失败。
    pub fn fail_current(&mut self, _reason: &str) {
        if let Some(step) = self.steps.get_mut(self.current_step_index) {
            step.status = PlanStepStatus::Failed;
            step.completed_at = Some(Utc::now());
        }
        self.updated_at = Utc::now();
    }

    /// 是否所有步骤完成(含 Skipped / Failed 视为已结束)。
    pub fn is_all_done(&self) -> bool {
        !self.steps.is_empty()
            && self
                .steps
                .iter()
                .all(|s| matches!(s.status, PlanStepStatus::Completed | PlanStepStatus::Skipped | PlanStepStatus::Failed))
    }

    /// 进度百分比 (0-100)。
    pub fn progress_percent(&self) -> u32 {
        if self.steps.is_empty() {
            return 0;
        }
        let done = self
            .steps
            .iter()
            .filter(|s| matches!(s.status, PlanStepStatus::Completed | PlanStepStatus::Skipped))
            .count();
        ((done as u64 * 100) / self.steps.len() as u64) as u32
    }

    /// 生成 LLM 可读的文本格式(注入到 ReAct 提示词)。
    pub fn to_prompt_text(&self) -> String {
        let mut out = String::new();
        out.push_str("## 顶层规划\n");
        out.push_str(&format!("总目标: {}\n", self.overall_goal));
        let done = self
            .steps
            .iter()
            .filter(|s| matches!(s.status, PlanStepStatus::Completed | PlanStepStatus::Skipped))
            .count();
        out.push_str(&format!(
            "进度: {}/{} ({}%)\n\n",
            done,
            self.steps.len(),
            self.progress_percent()
        ));
        for (i, step) in self.steps.iter().enumerate() {
            let cursor = if i == self.current_step_index && step.status == PlanStepStatus::InProgress
            {
                "▶ "
            } else {
                "  "
            };
            out.push_str(&format!(
                "{}{}. {} {}\n",
                cursor,
                i + 1,
                step.status.marker(),
                step.goal
            ));
            if !step.success_criteria.is_empty() {
                out.push_str(&format!("     验收: {}\n", step.success_criteria));
            }
        }
        out
    }
}

pub struct GlobalPlanner {
    client: Arc<DeepSeekClient>,
    config: Arc<RwLock<DeepSeekConfig>>,
}

impl GlobalPlanner {
    pub fn new(client: Arc<DeepSeekClient>, config: Arc<RwLock<DeepSeekConfig>>) -> Self {
        Self { client, config }
    }

    /// 调用 LLM 生成顶层规划(3-7 个步骤,每步含 goal + success_criteria)。
    pub async fn generate_plan(
        &self,
        task_id: Uuid,
        user_request: &str,
        project_root: &Path,
        cancel: &CancellationToken,
    ) -> Result<GlobalPlan, anyhow::Error> {
        let ds_cfg = self.config.read().await.clone();

        let system_prompt = r#"你是任务规划专家。将用户需求拆解为 3-7 个阶段性步骤。
每步必须包含:
- goal: 阶段目标(动词开头,如'克隆仓库'、'安装依赖')
- success_criteria: 可验证的完成标准(如'.git 目录存在'、'node_modules 创建')

输出严格 JSON (不要 markdown 包裹),格式:
{"overall_goal": "...", "steps": [{"goal": "...", "success_criteria": "..."}, ...]}"#;

        let user_prompt = format!(
            r#"需求: {req}

项目根: {root}

请输出顶层规划的 JSON 对象。"#,
            req = user_request,
            root = project_root.display()
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
            .map_err(|e| anyhow::anyhow!("GlobalPlanner LLM 调用失败: {e}"))?;

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
                Err(e) => return Err(anyhow::anyhow!("GlobalPlanner LLM 流错误: {e}")),
            }
        }

        let json_str = extract_json_object(&full)
            .ok_or_else(|| anyhow::anyhow!("无法从 GlobalPlanner 响应中提取 JSON 对象: {full}"))?;
        let v: Value = serde_json::from_str(&json_str)
            .map_err(|e| anyhow::anyhow!("解析 GlobalPlan 失败: {e}; raw={json_str}"))?;

        let overall_goal = v
            .get("overall_goal")
            .and_then(|x| x.as_str())
            .unwrap_or(user_request)
            .to_string();
        let steps_v = v
            .get("steps")
            .and_then(|x| x.as_array())
            .ok_or_else(|| anyhow::anyhow!("GlobalPlan 缺少 steps 数组"))?;

        let now = Utc::now();
        let mut steps = Vec::with_capacity(steps_v.len());
        for (i, s) in steps_v.iter().enumerate() {
            let goal = s
                .get("goal")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string();
            let success_criteria = s
                .get("success_criteria")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string();
            steps.push(PlanStep {
                id: Uuid::new_v4(),
                index: i,
                goal,
                success_criteria,
                status: PlanStepStatus::Pending,
                started_at: None,
                completed_at: None,
            });
        }

        if steps.is_empty() {
            return Err(anyhow::anyhow!("GlobalPlan 生成为空"));
        }

        Ok(GlobalPlan {
            task_id,
            overall_goal,
            steps,
            current_step_index: 0,
            created_at: now,
            updated_at: now,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_step(index: usize, goal: &str, status: PlanStepStatus) -> PlanStep {
        PlanStep {
            id: Uuid::new_v4(),
            index,
            goal: goal.into(),
            success_criteria: format!("c{index}"),
            status,
            started_at: None,
            completed_at: None,
        }
    }

    #[test]
    fn plan_progresses_through_steps() {
        let mut plan = GlobalPlan::new(Uuid::new_v4(), "test goal".into());
        plan.steps = vec![
            make_step(0, "step-a", PlanStepStatus::Pending),
            make_step(1, "step-b", PlanStepStatus::Pending),
        ];
        assert!(!plan.is_all_done());
        assert_eq!(plan.progress_percent(), 0);

        plan.start_current();
        assert_eq!(
            plan.current_step().unwrap().status,
            PlanStepStatus::InProgress
        );

        plan.complete_current();
        assert_eq!(plan.current_step_index, 1);
        assert_eq!(plan.progress_percent(), 50);
        assert!(!plan.is_all_done());

        plan.start_current();
        plan.complete_current();
        assert!(plan.is_all_done());
        assert_eq!(plan.progress_percent(), 100);
    }

    #[test]
    fn prompt_text_contains_markers_and_current_step() {
        let mut plan = GlobalPlan::new(Uuid::new_v4(), "build project".into());
        plan.steps = vec![
            make_step(0, "step one", PlanStepStatus::Completed),
            make_step(1, "step two", PlanStepStatus::InProgress),
            make_step(2, "step three", PlanStepStatus::Pending),
        ];
        plan.current_step_index = 1;
        let text = plan.to_prompt_text();
        assert!(text.contains("顶层规划"));
        assert!(text.contains("build project"));
        assert!(text.contains("[✓]"));
        assert!(text.contains("[→]"));
        assert!(text.contains("[ ]"));
        assert!(text.contains("step two"));
        // 当前进行中的步骤应带 ▶ 标记
        assert!(text.contains("▶ 2. [→] step two"));
    }

    #[test]
    fn fail_current_marks_failed() {
        let mut plan = GlobalPlan::new(Uuid::new_v4(), "g".into());
        plan.steps = vec![make_step(0, "s", PlanStepStatus::InProgress)];
        plan.fail_current("network down");
        assert_eq!(plan.steps[0].status, PlanStepStatus::Failed);
        assert!(plan.is_all_done(), "Failed 步骤也视为已结束");
    }
}
