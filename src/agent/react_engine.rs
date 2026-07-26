//! ReAct 循环引擎主逻辑 (P0 自治 Agent)。
//!
//! 实现 Reasoning → Acting → Observing → Reflecting 的迭代循环,
//! 复用现有 DeepSeekClient (流式聚合为完整字符串后解析 JSON 决策)。
//!
//! 设计要点:
//!   - LLM 调用复用 `DeepSeekClient::chat_stream`,聚合 SSE 流为完整字符串
//!   - 每轮迭代:Thought → Action (ToolCall) → Observation → Reflection → 终止判断
//!   - 工具错误转为 observation 继续循环;LLM 调用错误直接判 Failed
//!   - 迭代上限默认 25,超出强制 Failed
//!   - CancellationToken 支持暂停/取消
//!   - broadcast 通道推送 AgentEvent,SSE 路由层订阅转发

use chrono::Utc;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::{broadcast, RwLock};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::agent::mode_router::{ModeDecision, ModeRouter};
use crate::agent::state_machine::{ExecutionMode, TaskState};
use crate::agent::task_store::{AgentTask, ReActStep, TaskStep, TaskStore};
use crate::agent::tool_protocol::{ExecutionContext, SharedTool, ToolCall, ToolResult};
use crate::agent::tools;
use crate::config::{DeepSeekConfig, ReasoningEffort};
use crate::deepseek::{ChatMessage, ChatRequest, DeepSeekClient};
use crate::state::ApprovalStatus;

/// ReAct 循环事件,通过 broadcast 推送给订阅者 (SSE 路由层转发)。
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AgentEvent {
    /// 任务状态变更。
    StateChanged { state: TaskState, iteration: u32 },
    /// Thought 阶段输出。
    Thought { content: String },
    /// 工具调用发起。
    ToolCall { call: ToolCall },
    /// 工具执行结果。
    ToolResult { result: ToolResult },
    /// Reflection 阶段输出。
    Reflection {
        conclusion: String,
        next_action: Option<String>,
    },
    /// Plan 生成完成。
    PlanCreated { steps: Vec<String> },
    /// 任务完成。
    Completed { summary: String },
    /// 任务失败。
    Failed { error: String, recoverable: bool },
    /// 通用日志。
    Log { level: String, message: String },
}

/// LLM 决策结果 (从 JSON 响应解析)。
#[derive(Debug, Clone)]
pub struct LlmDecision {
    pub thought: String,
    pub action: Option<ToolCall>,
    pub reflection: String,
    pub terminate: bool,
    pub summary: Option<String>,
}

/// 工具元信息 (供 list_tools 接口返回)。
#[derive(Debug, Clone, Serialize)]
pub struct ToolInfo {
    pub name: String,
    pub description: String,
    pub schema: Value,
    pub required_permission: String,
}

/// Agent 运行时:管理任务、工具、LLM 调用、事件订阅。
///
/// 所有 RwLock 字段使用 Arc 包裹,使 AgentRuntime 可 Clone,
/// 便于 `tokio::spawn` 异步任务携带 owned 副本。
#[derive(Clone)]
pub struct AgentRuntime {
    pub task_store: Arc<TaskStore>,
    pub tools: Arc<RwLock<HashMap<String, SharedTool>>>,
    pub client: Arc<DeepSeekClient>,
    pub running_tasks: Arc<RwLock<HashMap<Uuid, CancellationToken>>>,
    pub event_subscribers: Arc<RwLock<HashMap<Uuid, broadcast::Sender<AgentEvent>>>>,
    /// DeepSeek 配置快照 (初始化时注入,运行时通过 update_config 刷新)。
    pub deepseek_config: Arc<RwLock<DeepSeekConfig>>,
    /// 全局默认执行模式 (GET/PUT /api/agent/mode)。
    pub default_mode: Arc<RwLock<ExecutionMode>>,
    /// 审批存储引用 (Approval 模式下提交审批请求)。
    pub approval_store: crate::state::ApprovalStore,
}

impl AgentRuntime {
    /// 创建运行时。
    ///
    /// `deepseek_config` 与 `approval_store` 为任务规范外的扩展参数,
    /// 由 SharedState::new 注入,用于 LLM 调用与审批模式路由。
    pub fn new(
        client: Arc<DeepSeekClient>,
        persistence_dir: Option<PathBuf>,
        deepseek_config: DeepSeekConfig,
        approval_store: crate::state::ApprovalStore,
    ) -> Self {
        Self {
            task_store: Arc::new(TaskStore::new(persistence_dir)),
            tools: Arc::new(RwLock::new(HashMap::new())),
            client,
            running_tasks: Arc::new(RwLock::new(HashMap::new())),
            event_subscribers: Arc::new(RwLock::new(HashMap::new())),
            deepseek_config: Arc::new(RwLock::new(deepseek_config)),
            default_mode: Arc::new(RwLock::new(ExecutionMode::Autonomous)),
            approval_store,
        }
    }

    /// 刷新 DeepSeek 配置快照 (配置变更后调用)。
    pub async fn update_config(&self, cfg: DeepSeekConfig) {
        *self.deepseek_config.write().await = cfg;
    }

    /// 注册单个工具。
    pub async fn register_tool(&self, tool: SharedTool) {
        let name = tool.name().to_string();
        self.tools.write().await.insert(name, tool);
    }

    /// 注册内置工具集。
    pub async fn register_builtin(&self) {
        let builtins = tools::register_builtin_tools();
        let mut tools_map = self.tools.write().await;
        for tool in builtins {
            let name = tool.name().to_string();
            tools_map.insert(name, tool);
        }
    }

    /// 列出所有已注册工具的元信息。
    pub async fn list_tools(&self) -> Vec<ToolInfo> {
        self.tools
            .read()
            .await
            .values()
            .map(|t| ToolInfo {
                name: t.name().to_string(),
                description: t.description().to_string(),
                schema: t.schema(),
                required_permission: format!("{:?}", t.required_permission()),
            })
            .collect()
    }

    /// 创建任务,返回创建后的实体 (state=Pending)。
    pub async fn create_task(
        &self,
        session_id: Uuid,
        request: String,
        mode: ExecutionMode,
    ) -> AgentTask {
        let task = AgentTask::new(session_id, request, mode);
        self.task_store.create(task)
    }

    /// 启动任务:创建取消令牌,后台 spawn react_loop。
    pub async fn start_task(
        &self,
        task_id: Uuid,
        project_root: PathBuf,
    ) -> Result<(), anyhow::Error> {
        let task = self
            .task_store
            .get(task_id)
            .ok_or_else(|| anyhow::anyhow!("任务不存在: {}", task_id))?;
        if task.state.is_terminal() {
            return Err(anyhow::anyhow!("任务已处于终态: {}", task.state));
        }

        let token = CancellationToken::new();
        self.running_tasks
            .write()
            .await
            .insert(task_id, token.clone());

        // 确保事件通道存在 (允许客户端在任务启动前订阅)
        self.ensure_channel(task_id).await;

        // 后台运行 ReAct 循环
        let runtime = self.clone();
        let root = project_root.clone();
        let cancel = token.clone();
        tokio::spawn(async move {
            tracing::info!("react_loop 启动: task={}", task_id);
            if let Err(e) = runtime.react_loop(task_id, root, cancel).await {
                tracing::error!("react_loop 失败 (task={}): {e}", task_id);
                let _ = runtime
                    .set_state(task_id, TaskState::Failed, Some(e.to_string()))
                    .await;
                let _ = runtime
                    .emit(
                        task_id,
                        AgentEvent::Failed {
                            error: e.to_string(),
                            recoverable: false,
                        },
                    )
                    .await;
            }
            // 清理取消令牌
            runtime.running_tasks.write().await.remove(&task_id);
        });

        Ok(())
    }

    /// 暂停任务:触发取消令牌,设置 Paused 状态,记录 checkpoint。
    pub async fn pause_task(&self, task_id: Uuid) {
        if let Some(token) = self.running_tasks.write().await.remove(&task_id) {
            token.cancel();
        }
        let _ = self.set_state(task_id, TaskState::Paused, None).await;
        let _ = self
            .emit(
                task_id,
                AgentEvent::StateChanged {
                    state: TaskState::Paused,
                    iteration: 0,
                },
            )
            .await;
    }

    /// 恢复任务:从 checkpoint 续跑。
    pub async fn resume_task(
        &self,
        task_id: Uuid,
        project_root: PathBuf,
    ) -> Result<(), anyhow::Error> {
        let task = self
            .task_store
            .get(task_id)
            .ok_or_else(|| anyhow::anyhow!("任务不存在: {}", task_id))?;
        if task.state != TaskState::Paused {
            return Err(anyhow::anyhow!(
                "任务未处于 Paused 状态,无法恢复 (当前: {})",
                task.state
            ));
        }
        // 复用 start_task 逻辑,从 checkpoint 续跑
        self.start_task(task_id, project_root).await
    }

    /// 终止任务:取消 + 标记 Cancelled。
    pub async fn stop_task(&self, task_id: Uuid) {
        if let Some(token) = self.running_tasks.write().await.remove(&task_id) {
            token.cancel();
        }
        let _ = self.set_state(task_id, TaskState::Cancelled, None).await;
        let _ = self
            .emit(
                task_id,
                AgentEvent::StateChanged {
                    state: TaskState::Cancelled,
                    iteration: 0,
                },
            )
            .await;
    }

    /// 订阅任务事件流。
    ///
    /// 若任务尚未启动,会预创建通道,允许客户端提前订阅。
    pub async fn subscribe(&self, task_id: Uuid) -> broadcast::Receiver<AgentEvent> {
        self.ensure_channel(task_id).await.subscribe()
    }

    /// 读取全局默认执行模式。
    pub async fn get_default_mode(&self) -> ExecutionMode {
        *self.default_mode.read().await
    }

    /// 设置全局默认执行模式。
    pub async fn set_default_mode(&self, mode: ExecutionMode) {
        *self.default_mode.write().await = mode;
    }

    // ============================================================
    // 内部核心方法
    // ============================================================

    /// 确保事件广播通道存在,返回通道 Sender 的克隆。
    ///
    /// 调用方可:
    ///   - 仅调用以建立通道 (忽略返回值)
    ///   - 调用 `.subscribe()` 获取 Receiver
    async fn ensure_channel(&self, task_id: Uuid) -> broadcast::Sender<AgentEvent> {
        let mut subs = self.event_subscribers.write().await;
        subs.entry(task_id)
            .or_insert_with(|| broadcast::channel::<AgentEvent>(256).0)
            .clone()
    }

    /// 推送事件给指定任务的所有订阅者。
    ///
    /// 无订阅者或通道关闭时静默忽略 (不阻塞循环)。
    async fn emit(&self, task_id: Uuid, ev: AgentEvent) {
        let subs = self.event_subscribers.read().await;
        if let Some(tx) = subs.get(&task_id) {
            // 发送失败表示无活跃接收者,忽略即可
            let _ = tx.send(ev);
        }
    }

    /// 更新任务状态并刷新 TaskStore。
    async fn set_state(
        &self,
        task_id: Uuid,
        state: TaskState,
        error: Option<String>,
    ) -> Option<AgentTask> {
        self.task_store.update(task_id, |t| {
            t.state = state;
            if let Some(e) = error {
                t.error = Some(e);
            }
        })
    }

    /// ReAct 循环主逻辑。
    ///
    /// 流程: Planning (生成 plan) → 循环 [Acting → Observing → Reflecting] → Completed/Failed
    async fn react_loop(
        &self,
        task_id: Uuid,
        project_root: PathBuf,
        cancel: CancellationToken,
    ) -> Result<(), anyhow::Error> {
        // 1. 进入 Planning 状态,生成 plan
        self.set_state(task_id, TaskState::Planning, None).await;
        self.emit(
            task_id,
            AgentEvent::StateChanged {
                state: TaskState::Planning,
                iteration: 0,
            },
        )
        .await;

        let task = self
            .task_store
            .get(task_id)
            .ok_or_else(|| anyhow::anyhow!("任务不存在: {}", task_id))?;

        let plan_steps = match self.generate_plan(&task, &project_root, &cancel).await {
            Ok(steps) if !steps.is_empty() => steps,
            Ok(_) => {
                // LLM 返回空 plan,退化为单步执行
                vec![task.user_request.clone()]
            }
            Err(e) => {
                tracing::warn!("生成 plan 失败,退化为单步: {e}");
                vec![task.user_request.clone()]
            }
        };

        // 持久化 plan (使用闭包模式更新)
        let plan_steps_for_closure = plan_steps.clone();
        self.task_store.update(task_id, |t| {
            t.plan = plan_steps_for_closure
                .iter()
                .map(|desc| TaskStep {
                    id: Uuid::new_v4(),
                    description: desc.clone(),
                    status: crate::agent::state_machine::StepStatus::Pending,
                    tool_calls: Vec::new(),
                })
                .collect();
        });

        self.emit(
            task_id,
            AgentEvent::PlanCreated {
                steps: plan_steps.clone(),
            },
        )
        .await;

        // 2. ReAct 主循环
        let mut observation = String::from("(任务开始)");
        loop {
            // 取消检查
            if cancel.is_cancelled() {
                self.set_state(task_id, TaskState::Cancelled, None).await;
                return Ok(());
            }

            // 重新加载任务 (可能被外部 pause/stop 修改)
            let task = match self.task_store.get(task_id) {
                Some(t) => t,
                None => return Err(anyhow::anyhow!("任务在循环中被删除")),
            };

            // 检查是否被外部暂停
            if task.state == TaskState::Paused {
                tracing::info!("任务被外部暂停,退出循环: {}", task_id);
                // 记录 checkpoint (使用 Agent A 提供的 Checkpoint 结构:
                // iteration / step_index / saved_at,丢失 last_observation 字段,
                // 由 history 中最后一条 ReActStep.observation 兜底)
                let checkpoint = crate::agent::task_store::Checkpoint {
                    iteration: task.current_iteration,
                    step_index: task.current_step,
                    saved_at: Utc::now(),
                };
                self.task_store.update(task_id, |t| {
                    t.checkpoint = Some(checkpoint);
                });
                return Ok(());
            }

            // 迭代上限检查
            if task.current_iteration >= task.max_iterations {
                let err = format!("达到最大迭代数 {} (task={})", task.max_iterations, task_id);
                self.set_state(task_id, TaskState::Failed, Some(err.clone()))
                    .await;
                self.emit(
                    task_id,
                    AgentEvent::Failed {
                        error: err.clone(),
                        recoverable: false,
                    },
                )
                .await;
                return Err(anyhow::anyhow!(err));
            }

            // 进入 Acting 状态,调用 LLM 决策
            self.set_state(task_id, TaskState::Acting, None).await;
            self.emit(
                task_id,
                AgentEvent::StateChanged {
                    state: TaskState::Acting,
                    iteration: task.current_iteration + 1,
                },
            )
            .await;

            let decision = match self
                .call_llm_for_decision(&task, &observation, &cancel)
                .await
            {
                Ok(d) => d,
                Err(e) => {
                    let err = format!("LLM 调用失败: {e}");
                    self.set_state(task_id, TaskState::Failed, Some(err.clone()))
                        .await;
                    self.emit(
                        task_id,
                        AgentEvent::Failed {
                            error: err.clone(),
                            recoverable: true,
                        },
                    )
                    .await;
                    return Err(anyhow::anyhow!(err));
                }
            };

            // 推送 Thought
            self.emit(
                task_id,
                AgentEvent::Thought {
                    content: decision.thought.clone(),
                },
            )
            .await;

            // 终止判断
            if decision.terminate {
                let summary = decision.summary.unwrap_or_else(|| "任务完成".to_string());
                self.set_state(task_id, TaskState::Completed, None).await;
                self.emit(task_id, AgentEvent::Completed { summary }).await;
                return Ok(());
            }

            // 执行工具调用
            let mut step_observation = String::new();
            if let Some(call) = decision.action.clone() {
                self.emit(task_id, AgentEvent::ToolCall { call: call.clone() })
                    .await;

                // 进入 Observing
                self.set_state(task_id, TaskState::Observing, None).await;
                self.emit(
                    task_id,
                    AgentEvent::StateChanged {
                        state: TaskState::Observing,
                        iteration: task.current_iteration + 1,
                    },
                )
                .await;

                let result = self
                    .execute_tool_call(&task, &call, &project_root, &cancel)
                    .await;
                self.emit(
                    task_id,
                    AgentEvent::ToolResult {
                        result: result.clone(),
                    },
                )
                .await;

                if result.success {
                    step_observation = result.output;
                } else {
                    // 工具错误转为 observation 继续循环
                    step_observation = format!(
                        "Error: {}",
                        result
                            .error
                            .clone()
                            .unwrap_or_else(|| result.output.clone())
                    );
                    self.emit(
                        task_id,
                        AgentEvent::Log {
                            level: "warn".into(),
                            message: format!(
                                "工具 {} 执行失败: {}",
                                call.tool_name, step_observation
                            ),
                        },
                    )
                    .await;
                }
            } else {
                // 无工具调用,仅思考。observation 保留上一轮的 (或初始化)
                step_observation = "(无工具调用,继续思考)".to_string();
            }

            // 进入 Reflecting
            self.set_state(task_id, TaskState::Reflecting, None).await;
            self.emit(
                task_id,
                AgentEvent::StateChanged {
                    state: TaskState::Reflecting,
                    iteration: task.current_iteration + 1,
                },
            )
            .await;

            // 记录 ReAct 历史 (使用闭包模式更新,与 TaskStore API 一致)
            let new_iteration = task.current_iteration + 1;
            let react_step = ReActStep {
                iteration: new_iteration,
                thought: decision.thought.clone(),
                action: decision.action.clone(),
                observation: step_observation.clone(),
                reflection: Some(decision.reflection.clone()),
                timestamp: Utc::now(),
            };
            self.task_store.update(task_id, |t| {
                t.history.push(react_step);
                t.current_iteration = new_iteration;
            });
            observation = step_observation;

            self.emit(
                task_id,
                AgentEvent::Reflection {
                    conclusion: decision.reflection.clone(),
                    next_action: decision.action.map(|c| c.tool_name),
                },
            )
            .await;

            // 短暂让出调度器,避免 busy loop
            tokio::task::yield_now().await;
        }
    }

    /// 调用 LLM 进行 ReAct 决策。
    ///
    /// 复用 DeepSeekClient::chat_stream 流式接口,聚合为完整字符串后解析 JSON。
    async fn call_llm_for_decision(
        &self,
        task: &AgentTask,
        observation: &str,
        cancel: &CancellationToken,
    ) -> Result<LlmDecision, anyhow::Error> {
        let ds_cfg = self.deepseek_config.read().await.clone();

        let system_prompt = r#"你是自治代码 Agent,根据当前状态决定下一步动作。

你必须输出严格的 JSON (不要包裹在 markdown 代码块中),格式如下:
{
  "thought": "对当前情况的分析思考 (必填)",
  "action": null,
  "reflection": "对观察结果的反思与下一步规划 (必填)",
  "terminate": false,
  "summary": null
}

字段说明:
- thought: 对当前情况的分析思考
- action: null 表示不调用工具 (仅思考);或 {"tool": "工具名", "args": {...}} 表示调用工具
- reflection: 对观察结果的反思,判断是否继续/完成
- terminate: true 表示任务完成 (此时 summary 必填为完成总结)
- summary: 仅 terminate=true 时填写完成总结

可用工具:从下方"可用工具列表"中选择。若无可调用工具,action 设为 null,reflection 中说明原因并考虑 terminate=true。

输出 JSON 时不要包含任何额外文本、注释或 markdown 包裹。"#;

        let tool_list = self.format_tool_list().await;
        let history = self.format_history(task);
        let user_prompt = format!(
            r#"# 原始需求
{user_request}

# 可用工具列表
{tool_list}

# 已执行步骤历史
{history}

# 当前观察
{observation}

# 当前迭代
第 {iter}/{max} 次迭代

请决定下一步动作,输出 JSON。"#,
            user_request = task.user_request,
            iter = task.current_iteration + 1,
            max = task.max_iterations,
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
            .map_err(|e| anyhow::anyhow!("DeepSeek 调用失败: {e}"))?;

        // 聚合流为完整字符串
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
                Err(e) => return Err(anyhow::anyhow!("DeepSeek 流错误: {e}")),
            }
        }

        tracing::debug!("LLM 原始响应 (task={}): {}", task.id, full);
        self.parse_decision(&full)
    }

    /// 生成任务执行计划 (Planning 阶段)。
    async fn generate_plan(
        &self,
        task: &AgentTask,
        project_root: &PathBuf,
        cancel: &CancellationToken,
    ) -> Result<Vec<String>, anyhow::Error> {
        let ds_cfg = self.deepseek_config.read().await.clone();

        let system_prompt = r#"你是任务规划助手。将用户需求拆解为 3-7 个可执行的子步骤。
输出严格 JSON 数组 (不要 markdown 包裹),每项为步骤描述字符串。例如:
["读取相关文件", "实现核心函数", "补充单元测试", "运行测试验证"]"#;

        let user_prompt = format!(
            r#"需求: {req}

项目根: {root}

请输出执行步骤的 JSON 数组。"#,
            req = task.user_request,
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
            max_tokens: Some(1024),
            temperature: Some(0.0),
        };

        let mut rx = self
            .client
            .chat_stream(chat_req, &ds_cfg, cancel.clone())
            .await
            .map_err(|e| anyhow::anyhow!("规划 LLM 调用失败: {e}"))?;

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
                Err(e) => return Err(anyhow::anyhow!("规划 LLM 流错误: {e}")),
            }
        }

        let json_str = extract_json_array(&full)
            .ok_or_else(|| anyhow::anyhow!("无法从响应中提取 JSON 数组: {full}"))?;
        let steps: Vec<String> = serde_json::from_str(&json_str)
            .map_err(|e| anyhow::anyhow!("解析步骤数组失败: {e}; raw={json_str}"))?;
        Ok(steps)
    }

    /// 执行单个工具调用,经过 ModeRouter 路由 (Autonomous 直接执行 / Approval 等待审批)。
    async fn execute_tool_call(
        &self,
        task: &AgentTask,
        call: &ToolCall,
        project_root: &PathBuf,
        cancel: &CancellationToken,
    ) -> ToolResult {
        let tools = self.tools.read().await;
        let tool = match tools.get(&call.tool_name) {
            Some(t) => t.clone(),
            None => {
                return ToolResult::failure(format!(
                    "未知工具: {}。可用工具: {}",
                    call.tool_name,
                    tools.keys().cloned().collect::<Vec<_>>().join(", ")
                ));
            }
        };
        drop(tools);

        let ctx = ExecutionContext {
            task_id: task.id,
            session_id: task.session_id,
            project_root: project_root.clone(),
            working_dir: project_root.clone(),
            cancellation: cancel.clone(),
        };

        // 模式路由
        let router = ModeRouter;
        let decision = router
            .before_tool_call(task, &tool, &call.arguments, &self.approval_store)
            .await;

        match decision {
            ModeDecision::Proceed => match tool.execute(call.arguments.clone(), &ctx).await {
                Ok(r) => r,
                Err(e) => ToolResult::failure(format!("工具执行错误: {e}")),
            },
            ModeDecision::AwaitingApproval(approval_id) => {
                // 推送等待审批事件
                self.emit(
                    task.id,
                    AgentEvent::StateChanged {
                        state: TaskState::AwaitingApproval,
                        iteration: task.current_iteration + 1,
                    },
                )
                .await;
                self.set_state(task.id, TaskState::AwaitingApproval, None)
                    .await;

                // 轮询审批结果 (最多等待 10 分钟)
                let resolved = self.wait_for_approval(&approval_id).await;

                // 恢复状态
                self.set_state(task.id, TaskState::Acting, None).await;

                match resolved {
                    ApprovalOutcome::Approved => {
                        match tool.execute(call.arguments.clone(), &ctx).await {
                            Ok(r) => r,
                            Err(e) => ToolResult::failure(format!("工具执行错误 (审批后): {e}")),
                        }
                    }
                    ApprovalOutcome::Rejected => {
                        ToolResult::failure("用户拒绝执行此工具调用".to_string())
                    }
                    ApprovalOutcome::Timeout => {
                        ToolResult::failure("审批超时,工具未执行".to_string())
                    }
                }
            }
            ModeDecision::Rejected(msg) => ToolResult::failure(msg),
        }
    }

    /// 等待审批结果 (轮询 ApprovalStore,最多 10 分钟)。
    async fn wait_for_approval(&self, approval_id: &str) -> ApprovalOutcome {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(600);
        while std::time::Instant::now() < deadline {
            if let Some(req) = self.approval_store.get(approval_id).await {
                match req.status {
                    ApprovalStatus::Approved => return ApprovalOutcome::Approved,
                    ApprovalStatus::Rejected => return ApprovalOutcome::Rejected,
                    ApprovalStatus::Pending => {}
                }
            } else {
                return ApprovalOutcome::Rejected;
            }
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        }
        ApprovalOutcome::Timeout
    }

    /// 格式化已注册工具列表为 LLM 可读文本。
    async fn format_tool_list(&self) -> String {
        let tools = self.tools.read().await;
        if tools.is_empty() {
            return "(无已注册工具)".to_string();
        }
        tools
            .values()
            .map(|t| format!("- {} : {}", t.name(), t.description()))
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// 格式化任务历史为 LLM 可读文本。
    fn format_history(&self, task: &AgentTask) -> String {
        if task.history.is_empty() {
            return "(无历史步骤)".to_string();
        }
        task.history
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
                    truncate_str(&s.observation, 500),
                    s.reflection.as_deref().unwrap_or("(无)")
                )
            })
            .collect::<Vec<_>>()
            .join("\n---\n")
    }

    /// 解析 LLM JSON 响应为 LlmDecision。
    ///
    /// 容错策略:
    ///   1. 尝试直接解析完整响应为 JSON
    ///   2. 失败则尝试从响应中提取首个 {...} 块再解析
    ///   3. 仍失败则把整个响应作为 thought,terminate=false (避免硬失败阻塞循环)
    fn parse_decision(&self, raw: &str) -> Result<LlmDecision, anyhow::Error> {
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
                let terminate = v
                    .get("terminate")
                    .and_then(|x| x.as_bool())
                    .unwrap_or(false);
                let summary = v
                    .get("summary")
                    .and_then(|x| x.as_str())
                    .map(|s| s.to_string());
                Ok(LlmDecision {
                    thought,
                    action,
                    reflection,
                    terminate,
                    summary,
                })
            }
            Err(e) => {
                tracing::warn!(
                    "LLM 响应解析失败,降级为纯思考: {e}; raw={}",
                    truncate_str(raw, 200)
                );
                Ok(LlmDecision {
                    thought: raw.trim().to_string(),
                    action: None,
                    reflection: "LLM 响应非合法 JSON,无法解析下一步动作".to_string(),
                    terminate: false,
                    summary: None,
                })
            }
        }
    }
}

/// 审批等待结果。
enum ApprovalOutcome {
    Approved,
    Rejected,
    Timeout,
}

/// 从文本中提取首个 JSON 对象 `{...}` (处理 LLM 可能包裹 markdown 的情况)。
fn extract_json_object(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    // 直接尝试解析
    if serde_json::from_str::<Value>(trimmed).is_ok() {
        return Some(trimmed.to_string());
    }
    // 提取 ```json ... ``` 块
    if let Some(start) = trimmed.find("```") {
        let after = &trimmed[start + 3..];
        let after = after.strip_prefix("json").unwrap_or(after);
        if let Some(end) = after.find("```") {
            let candidate = after[..end].trim();
            if serde_json::from_str::<Value>(candidate).is_ok() {
                return Some(candidate.to_string());
            }
        }
    }
    // 提取首个 {...} 块
    let start = trimmed.find('{')?;
    let mut depth = 0i32;
    let mut end_idx = None;
    for (i, c) in trimmed.bytes().enumerate().skip(start) {
        match c {
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    end_idx = Some(i + 1);
                    break;
                }
            }
            _ => {}
        }
    }
    let end = end_idx?;
    let candidate = &trimmed[start..end];
    if serde_json::from_str::<Value>(candidate).is_ok() {
        Some(candidate.to_string())
    } else {
        None
    }
}

/// 从文本中提取首个 JSON 数组 `[...]`。
fn extract_json_array(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if serde_json::from_str::<Value>(trimmed).is_ok() {
        return Some(trimmed.to_string());
    }
    // 提取 ```json ... ``` 块
    if let Some(start) = trimmed.find("```") {
        let after = &trimmed[start + 3..];
        let after = after.strip_prefix("json").unwrap_or(after);
        if let Some(end) = after.find("```") {
            let candidate = after[..end].trim();
            if serde_json::from_str::<Value>(candidate).is_ok() {
                return Some(candidate.to_string());
            }
        }
    }
    let start = trimmed.find('[')?;
    let mut depth = 0i32;
    let mut end_idx = None;
    for (i, c) in trimmed.bytes().enumerate().skip(start) {
        match c {
            b'[' => depth += 1,
            b']' => {
                depth -= 1;
                if depth == 0 {
                    end_idx = Some(i + 1);
                    break;
                }
            }
            _ => {}
        }
    }
    let end = end_idx?;
    let candidate = &trimmed[start..end];
    if serde_json::from_str::<Value>(candidate).is_ok() {
        Some(candidate.to_string())
    } else {
        None
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
fn truncate_str(s: &str, max: usize) -> String {
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
    fn extract_plain_json_object() {
        let raw = r#"{"thought":"分析","action":null,"terminate":false}"#;
        let extracted = extract_json_object(raw).unwrap();
        let v: Value = serde_json::from_str(&extracted).unwrap();
        assert_eq!(v["thought"], "分析");
    }

    #[test]
    fn extract_markdown_wrapped_json() {
        let raw = "```json\n{\"thought\":\"x\",\"terminate\":true}\n```";
        let extracted = extract_json_object(raw).unwrap();
        let v: Value = serde_json::from_str(&extracted).unwrap();
        assert_eq!(v["terminate"], true);
    }

    #[test]
    fn extract_json_with_prefix() {
        let raw =
            "好的,这是我的决策:\n{\"thought\":\"go\",\"action\":null,\"terminate\":false}\n以上。";
        let extracted = extract_json_object(raw).unwrap();
        let v: Value = serde_json::from_str(&extracted).unwrap();
        assert_eq!(v["thought"], "go");
    }

    #[test]
    fn parse_action_null() {
        assert!(parse_action_field(Some(&Value::Null)).is_none());
        assert!(parse_action_field(None).is_none());
    }

    #[test]
    fn parse_action_with_tool() {
        let v = json!({"tool": "read_file", "args": {"path": "src/lib.rs"}});
        let call = parse_action_field(Some(&v)).unwrap();
        assert_eq!(call.tool_name, "read_file");
        assert_eq!(call.arguments["path"], "src/lib.rs");
    }

    #[test]
    fn extract_array_simple() {
        let raw = r#"["a","b","c"]"#;
        let extracted = extract_json_array(raw).unwrap();
        let v: Vec<String> = serde_json::from_str(&extracted).unwrap();
        assert_eq!(v, vec!["a", "b", "c"]);
    }
}
