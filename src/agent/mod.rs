//! 自治 Agent 运行时模块。
//!
//! 汇聚工具调用协议、任务状态机、任务持久化与工具实现。
//!
//! 模块划分:
//!   - `state_machine`: 任务状态枚举 (TaskState / ExecutionMode / StepStatus)
//!   - `tool_protocol`: 工具调用接口契约 (AgentTool trait / ToolCall / ToolResult)
//!   - `task_store`: 任务持久化 (AgentTask / TaskStore,JSON 文件 + 内存索引)
//!   - `tools`: 内置工具实现 (file / git / shell 适配层)
//!   - `react_engine`: ReAct 循环引擎主逻辑 (AgentRuntime / AgentEvent)
//!   - `mode_router`: 执行模式路由 (Autonomous vs Approval)

pub mod mode_router;
pub mod react_engine;
pub mod state_machine;
pub mod task_store;
pub mod tool_protocol;
pub mod tools;

// 顶层 re-export: 使外部可直接 `use crate::agent::TaskState` 等而无需深入子模块。
// 仅 re-export 本基座模块 (state_machine / tool_protocol / task_store) 的公共类型;
// react_engine / mode_router / tools 的导出由各自模块负责。
//
// 当前因 Agent executor 尚未完全接线,这些项可能暂未被 crate 内部消费,允许 unused_imports。
#[allow(unused_imports)]
pub use state_machine::{ExecutionMode, StateTransition, StepStatus, TaskState};
#[allow(unused_imports)]
pub use task_store::{AgentTask, Checkpoint, ReActStep, TaskStep, TaskStore};
#[allow(unused_imports)]
pub use tool_protocol::{
    AgentTool, ArtifactKind, ExecutionContext, SharedTool, ToolArtifact, ToolCall, ToolError,
    ToolResult, DEFAULT_MAX_OUTPUT_BYTES,
};
