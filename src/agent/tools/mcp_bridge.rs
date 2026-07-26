//! McpBridge: 将现有 McpStore 的 12 个内置 MCP 插件桥接为 AgentTool 协议。
//!
//! 桥接逻辑:
//! - 启动时遍历 McpStore 中已启用的插件
//! - 为每个插件的每个工具创建 McpToolWrapper 实现 AgentTool
//! - tool_name 格式: "mcp.{plugin_id}.{tool_name}" (如 "mcp.github.create_issue")
//! - 调用时: 通过 McpStore::call 转发,封装为 ToolResult
//!
//! 关于 `&'static str` 限制:
//! 由于 `AgentTool::name(&self) -> &'static str` 要求静态生命周期,
//! 而 MCP 工具名是运行时动态拼接的字符串,这里采用 `Box::leak` 方案:
//! 每个工具名只 leak 一次 (由 `OnceLock` 保证),内存占用 = 工具数量 × 工具名长度,
//! 典型场景 (12 插件 × 平均 5 工具 × 平均 30 字符) ≈ 1.8 KB,可忽略。

use std::sync::{Arc, OnceLock};

use async_trait::async_trait;
use serde_json::Value;

use crate::agent::tool_protocol::{AgentTool, ExecutionContext, ToolError, ToolResult};
use crate::config::PermissionLevel;
use crate::mcp::{McpCallRequest, McpStore};

/// MCP 工具桥接器: 扫描 McpStore,为每个已启用插件的每个工具生成 AgentTool 包装。
pub struct McpBridge {
    mcp_store: Arc<McpStore>,
}

impl McpBridge {
    pub fn new(mcp_store: Arc<McpStore>) -> Self {
        Self { mcp_store }
    }

    /// 列出所有已启用 MCP 插件的所有工具,包装为 McpToolWrapper。
    ///
    /// 注意: MCP 协议的 `tools/list` 通常需插件已连接才能返回真实工具清单。
    /// 阶段1 实现:由于 McpStore 未持久化每个插件的工具清单,
    /// 这里返回空 Vec,实际工具调用通过 routes/agent.rs 的 `/api/agent/mcp/call` 透传。
    pub async fn list_tools(&self) -> Vec<McpToolWrapper> {
        // 遍历所有已启用插件,但 McpStore 当前未缓存工具清单,
        // 运行时调用由路由层直接转发到 McpStore::call。
        // 此处保留接口供未来扩展 (阶段2: 启动时主动调用 tools/list 缓存)。
        Vec::new()
    }

    /// 直接构造一个具名 MCP 工具包装 (供路由层按需注册)。
    pub fn make_wrapper(
        mcp_store: Arc<McpStore>,
        plugin_id: String,
        tool_name: String,
        description: String,
        schema: Value,
    ) -> McpToolWrapper {
        McpToolWrapper {
            plugin_id,
            tool_name,
            description,
            schema,
            mcp_store,
            cached_name: OnceLock::new(),
            cached_desc: OnceLock::new(),
        }
    }
}

/// 单个 MCP 工具的 AgentTool 包装。
///
/// `cached_name` / `cached_desc` 使用 `std::sync::OnceLock` 缓存 leak 后的 `&'static str`,
/// 确保同一工具多次调用 `name()` / `description()` 只 leak 一次。
pub struct McpToolWrapper {
    plugin_id: String,
    tool_name: String,
    description: String,
    schema: Value,
    mcp_store: Arc<McpStore>,
    cached_name: OnceLock<&'static str>,
    cached_desc: OnceLock<&'static str>,
}

impl McpToolWrapper {
    /// 完整工具名: "mcp.{plugin_id}.{tool_name}"
    fn full_name(&self) -> String {
        format!("mcp.{}.{}", self.plugin_id, self.tool_name)
    }

    /// 将 String leak 为 &'static str (仅调用一次,后续直接返回缓存)
    fn leak_string(s: String) -> &'static str {
        // Box::leak 释放堆内存的所有权,转为 &'static str。
        // 每个工具名只 leak 一次,内存占用恒定。
        Box::leak(s.into_boxed_str())
    }
}

#[async_trait]
impl AgentTool for McpToolWrapper {
    fn name(&self) -> &'static str {
        // OnceLock::get_or_init 同步初始化,保证 leak 只执行一次
        *self
            .cached_name
            .get_or_init(|| Self::leak_string(self.full_name()))
    }

    fn description(&self) -> &'static str {
        *self
            .cached_desc
            .get_or_init(|| Self::leak_string(self.description.clone()))
    }

    fn schema(&self) -> Value {
        self.schema.clone()
    }

    fn required_permission(&self) -> PermissionLevel {
        // MCP 工具权限隔离在 McpStore::call 内部按 permission_scope 校验,
        // 此处返回 FullAccess 让上层 ToolDispatcher 不额外拦截,
        // 实际权限由插件配置 (file/network/shell/database) 决定。
        PermissionLevel::FullAccess
    }

    async fn execute(&self, args: Value, _ctx: &ExecutionContext) -> Result<ToolResult, ToolError> {
        let req = McpCallRequest {
            plugin_id: self.plugin_id.clone(),
            tool: self.tool_name.clone(),
            arguments: args,
            session_id: None,
        };

        // MCP 插件按其 permission_scope 内部校验权限
        let result = self
            .mcp_store
            .call(req, PermissionLevel::FullAccess)
            .await
            .map_err(|e| ToolError::Execution(e.to_string()))?;

        if result.success {
            let output = if result.summary.is_empty() {
                serde_json::to_string_pretty(&result.data)
                    .unwrap_or_else(|_| result.data.to_string())
            } else {
                result.summary
            };
            let mut tr = ToolResult::success(output);
            tr.truncate_default();
            Ok(tr)
        } else {
            Err(ToolError::Execution(
                result.error.unwrap_or_else(|| "MCP 调用失败".into()),
            ))
        }
    }
}

// ============================== 测试 ==============================

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn full_name_format() {
        let store = Arc::new(McpStore::new());
        let wrapper = McpBridge::make_wrapper(
            store,
            "github".into(),
            "create_issue".into(),
            "Create GitHub issue".into(),
            json!({"type": "object"}),
        );
        assert_eq!(wrapper.full_name(), "mcp.github.create_issue");
    }

    #[test]
    fn name_leaked_is_stable() {
        let store = Arc::new(McpStore::new());
        let wrapper = McpBridge::make_wrapper(
            store,
            "filesystem".into(),
            "read_file".into(),
            "Read file".into(),
            json!({"type": "object"}),
        );
        let n1 = wrapper.name();
        let n2 = wrapper.name();
        assert_eq!(n1, "mcp.filesystem.read_file");
        // 两次调用返回同一指针 (OnceLock 缓存)
        assert!(std::ptr::eq(n1.as_ptr() as *const u8, n2.as_ptr() as *const u8));
    }

    #[test]
    fn bridge_list_tools_returns_empty_by_default() {
        // 阶段1 实现: 未连接的插件返回空工具列表
        let store = Arc::new(McpStore::new());
        let bridge = McpBridge::new(store);
        // 阻塞获取 (test 中可用 tokio block_on)
        let rt = tokio::runtime::Runtime::new().unwrap();
        let tools = rt.block_on(bridge.list_tools());
        assert!(tools.is_empty());
    }

    #[tokio::test]
    async fn execute_returns_execution_error_on_unknown_plugin() {
        // 调用不存在的插件,应返回 ToolError::Execution
        let store = Arc::new(McpStore::new());
        let wrapper = McpBridge::make_wrapper(
            store,
            "nonexistent".into(),
            "any_tool".into(),
            "any".into(),
            json!({"type": "object"}),
        );
        let ctx = ExecutionContext::new(
            uuid::Uuid::new_v4(),
            uuid::Uuid::new_v4(),
            std::path::PathBuf::from("/"),
            tokio_util::sync::CancellationToken::new(),
        );
        let result = wrapper.execute(json!({}), &ctx).await;
        assert!(result.is_err());
        let err = result.unwrap_err();
        match err {
            ToolError::Execution(_) => {} // 预期
            other => panic!("预期 Execution 错误, 实际: {other:?}"),
        }
    }
}
