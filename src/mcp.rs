//! MCP 插件注册表与客户端（P1 MCP 生态）。
//!
//! 实现：
//! - stdio 协议：tokio::process 启动子进程，stdin/stdout 传递 JSON-RPC 2.0（每行一个 JSON）
//! - SSE 协议：reqwest POST 到插件 URL，简化为单次请求/响应
//! - 权限隔离：file / network / shell / database 四类，按 scope 拦截高危工具
//! - 轻量化摘要：调用结果截断至 2000 字符作为 summary，原始数据不长期占用
//! - 超时：默认 30 秒，防插件卡死

use crate::config::PermissionLevel;
use crate::error::AppError;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::RwLock;

/* ============================================================
 * 数据结构
 * ============================================================ */

/// MCP 插件元信息（存入第一层缓存精简清单）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpMeta {
    /// 插件 ID（如 "lsp-rust"、"feishu-wiki"）
    pub id: String,
    /// 展示名称
    pub name: String,
    /// 描述
    pub description: String,
    /// 版本号
    pub version: String,
    /// 传输协议："stdio" | "sse"
    pub transport: String,
    /// 是否启用
    pub enabled: bool,
    /// 高危插件默认禁用
    pub high_risk: bool,
    /// 分类：lsp / knowledge / ci / database / security / other
    pub category: String,
    /// 能力简述（≤200 字符，用于第一层缓存）
    pub capabilities: String,
}

/// MCP 插件完整配置
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpConfig {
    pub meta: McpMeta,
    /// stdio 模式：可执行文件路径
    pub command: Option<String>,
    /// stdio 模式：启动参数
    pub args: Option<Vec<String>>,
    /// stdio 模式：环境变量
    pub env: Option<HashMap<String, String>>,
    /// SSE 模式：服务地址
    pub url: Option<String>,
    /// 权限隔离：file / network / shell / database
    pub permission_scope: String,
    /// 超时秒数（默认 30）
    pub timeout_secs: u64,
}

/// MCP 插件运行时状态
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpStatus {
    pub id: String,
    pub connected: bool,
    pub last_error: Option<String>,
    pub last_call_at: Option<String>,
    pub call_count: u64,
}

/// MCP 调用请求
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpCallRequest {
    pub plugin_id: String,
    /// 插件提供的工具名
    pub tool: String,
    pub arguments: serde_json::Value,
    pub session_id: Option<String>,
}

/// MCP 调用结果
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpCallResult {
    pub success: bool,
    pub data: serde_json::Value,
    pub error: Option<String>,
    pub duration_ms: u64,
    /// 轻量化摘要（注入上下文用，原始数据不长期占用）
    pub summary: String,
}

/// MCP 插件注册表
pub struct McpStore {
    configs: Arc<RwLock<HashMap<String, McpConfig>>>,
    statuses: Arc<RwLock<HashMap<String, McpStatus>>>,
    /// stdio 子进程句柄（生命周期标记）
    processes: Arc<RwLock<HashMap<String, Child>>>,
}

impl Default for McpStore {
    fn default() -> Self {
        Self {
            configs: Arc::new(RwLock::new(HashMap::new())),
            statuses: Arc::new(RwLock::new(HashMap::new())),
            processes: Arc::new(RwLock::new(HashMap::new())),
        }
    }
}

impl Clone for McpStore {
    fn clone(&self) -> Self {
        Self {
            configs: self.configs.clone(),
            statuses: self.statuses.clone(),
            processes: self.processes.clone(),
        }
    }
}

impl McpStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// 初始化内置 MCP 插件配置（参考真实开源 MCP 服务，enabled=false 等待用户启用）。
    ///
    /// 幂等：重复调用安全，已存在的 id 会被覆盖。
    pub async fn init_builtin(&self) {
        for config in builtin_mcp_plugins() {
            let _ = self.register(config).await;
        }
    }

    /// 注册插件（重复 ID 覆盖旧配置）
    pub async fn register(&self, config: McpConfig) -> Result<(), AppError> {
        let id = config.meta.id.clone();
        self.configs.write().await.insert(id.clone(), config);
        self.statuses.write().await.insert(
            id.clone(),
            McpStatus {
                id,
                connected: false,
                last_error: None,
                last_call_at: None,
                call_count: 0,
            },
        );
        Ok(())
    }

    /// 卸载插件
    pub async fn unregister(&self, id: &str) {
        self.configs.write().await.remove(id);
        if let Some(mut child) = self.processes.write().await.remove(id) {
            let _ = child.kill().await;
            let _ = child.wait().await;
        }
        self.statuses.write().await.remove(id);
    }

    /// 启用/禁用插件
    pub async fn set_enabled(&self, id: &str, enabled: bool) -> Result<(), AppError> {
        let mut configs = self.configs.write().await;
        let config = configs
            .get_mut(id)
            .ok_or_else(|| AppError::BadRequest(format!("插件不存在: {id}")))?;
        config.meta.enabled = enabled;
        Ok(())
    }

    /// 列出所有插件元信息
    pub async fn list_metas(&self) -> Vec<McpMeta> {
        self.configs
            .read()
            .await
            .values()
            .map(|c| c.meta.clone())
            .collect()
    }

    /// 列出所有插件状态
    pub async fn list_statuses(&self) -> Vec<McpStatus> {
        self.statuses.read().await.values().cloned().collect()
    }

    /// 获取插件配置
    pub async fn get_config(&self, id: &str) -> Option<McpConfig> {
        self.configs.read().await.get(id).cloned()
    }

    /// 连接插件（stdio 启动子进程 / SSE 建立连接）
    ///
    /// 最小化实现：仅校验传输配置完整性并标记 connected=true，
    /// 实际子进程启动 / HTTP 请求在 call() 中按需进行。
    pub async fn connect(&self, id: &str) -> Result<(), AppError> {
        let config = self
            .get_config(id)
            .await
            .ok_or_else(|| AppError::BadRequest(format!("插件不存在: {id}")))?;

        // 校验传输协议配置
        match config.meta.transport.as_str() {
            "stdio" => {
                if config.command.is_none() {
                    return Err(AppError::BadRequest("stdio 插件缺少 command".into()));
                }
            }
            "sse" => {
                if config.url.is_none() {
                    return Err(AppError::BadRequest("sse 插件缺少 url".into()));
                }
            }
            other => return Err(AppError::BadRequest(format!("未知传输协议: {other}"))),
        }

        // 更新状态
        let mut statuses = self.statuses.write().await;
        statuses
            .entry(id.to_string())
            .and_modify(|s| {
                s.connected = true;
                s.last_error = None;
            })
            .or_insert_with(|| McpStatus {
                id: id.to_string(),
                connected: true,
                last_error: None,
                last_call_at: None,
                call_count: 0,
            });
        Ok(())
    }

    /// 断开插件
    pub async fn disconnect(&self, id: &str) -> Result<(), AppError> {
        if let Some(mut child) = self.processes.write().await.remove(id) {
            let _ = child.kill().await;
            let _ = child.wait().await;
        }
        let mut statuses = self.statuses.write().await;
        if let Some(status) = statuses.get_mut(id) {
            status.connected = false;
        }
        Ok(())
    }

    /// 调用插件工具
    pub async fn call(
        &self,
        req: McpCallRequest,
        level: PermissionLevel,
    ) -> Result<McpCallResult, AppError> {
        let started = std::time::Instant::now();
        let config = self
            .get_config(&req.plugin_id)
            .await
            .ok_or_else(|| AppError::BadRequest(format!("插件不存在: {}", req.plugin_id)))?;

        if !config.meta.enabled {
            return Err(AppError::Forbidden(format!(
                "插件 {} 已禁用",
                req.plugin_id
            )));
        }

        // 权限隔离检查
        Self::check_permission(&config.permission_scope, &req.tool, level)?;

        // 超时控制
        let timeout = Duration::from_secs(config.timeout_secs.max(1));
        let plugin_id = req.plugin_id.clone();
        let timeout_secs = config.timeout_secs;
        let call_future = async {
            match config.meta.transport.as_str() {
                "stdio" => Self::call_stdio(&config, &req).await,
                "sse" => Self::call_sse(&config, &req).await,
                other => Err(AppError::BadRequest(format!("未知传输协议: {other}"))),
            }
        };

        let result = tokio::time::timeout(timeout, call_future).await;
        let duration_ms = started.elapsed().as_millis() as u64;

        // 更新状态
        {
            let mut statuses = self.statuses.write().await;
            if let Some(status) = statuses.get_mut(&plugin_id) {
                status.call_count += 1;
                status.last_call_at = Some(chrono::Utc::now().to_rfc3339());
                match &result {
                    Ok(Ok(_)) => {}
                    Ok(Err(e)) => status.last_error = Some(e.to_string()),
                    Err(_) => status.last_error = Some("调用超时".into()),
                }
            }
        }

        match result {
            Ok(Ok(data)) => {
                let summary = summarize(&data);
                Ok(McpCallResult {
                    success: true,
                    data,
                    error: None,
                    duration_ms,
                    summary,
                })
            }
            Ok(Err(e)) => Ok(McpCallResult {
                success: false,
                data: serde_json::Value::Null,
                error: Some(e.to_string()),
                duration_ms,
                summary: String::new(),
            }),
            Err(_) => Ok(McpCallResult {
                success: false,
                data: serde_json::Value::Null,
                error: Some(format!("调用超时 ({timeout_secs}s)")),
                duration_ms,
                summary: String::new(),
            }),
        }
    }

    /// 生成第一层缓存的 MCP 精简清单
    pub async fn build_cache_summary(&self) -> String {
        let configs = self.configs.read().await;
        let mut lines = Vec::new();
        lines.push("# 可用 MCP 插件".to_string());
        for (id, cfg) in configs.iter() {
            if cfg.meta.enabled {
                let cap = if cfg.meta.capabilities.is_empty() {
                    "-"
                } else {
                    &cfg.meta.capabilities
                };
                lines.push(format!(
                    "- {} [{}]: {} ({})",
                    id, cfg.meta.category, cfg.meta.name, cap
                ));
            }
        }
        lines.join("\n")
    }

    /* ============================================================
     * 内部方法
     * ============================================================ */

    /// 权限隔离检查
    fn check_permission(
        scope: &str,
        tool: &str,
        level: PermissionLevel,
    ) -> Result<(), AppError> {
        match scope {
            "file" => {
                // 文件类：继承三级权限，写操作需 can_write
                if is_file_write_tool(tool) && !level.can_write() {
                    return Err(AppError::Forbidden(
                        "当前权限等级禁止文件写操作".into(),
                    ));
                }
            }
            "network" => {
                // 网络类（知识库/云服务）：禁止访问本地文件系统
                if is_file_tool(tool) {
                    return Err(AppError::Forbidden(
                        "网络类插件禁止访问本地文件系统".into(),
                    ));
                }
            }
            "shell" => {
                // Shell 类：需 can_shell（FullAccess）
                if !level.can_shell() {
                    return Err(AppError::Forbidden(
                        "当前权限等级禁止 Shell 操作".into(),
                    ));
                }
            }
            "database" | "security" => {
                // 高危类：权限检查在外部（high_risk 总开关 + 审批）处理
            }
            _ => {}
        }
        Ok(())
    }

    /// stdio 协议调用：启动子进程，stdin/stdout 传递 JSON-RPC
    async fn call_stdio(
        config: &McpConfig,
        req: &McpCallRequest,
    ) -> Result<serde_json::Value, AppError> {
        let command = config
            .command
            .as_ref()
            .ok_or_else(|| AppError::BadRequest("stdio 插件缺少 command".into()))?;
        let mut cmd = Command::new(command);
        // 超时或异常退出时自动 kill 子进程，避免孤儿进程
        cmd.kill_on_drop(true);
        if let Some(args) = &config.args {
            cmd.args(args);
        }
        if let Some(env) = &config.env {
            for (k, v) in env {
                cmd.env(k, v);
            }
        }
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut child = cmd
            .spawn()
            .map_err(|e| AppError::Tool(format!("启动子进程失败: {e}")))?;
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| AppError::Tool("无法获取 stdin".into()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| AppError::Tool("无法获取 stdout".into()))?;

        // 构造 JSON-RPC 2.0 请求
        let rpc_req = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {
                "name": req.tool,
                "arguments": req.arguments,
            }
        });
        let line = serde_json::to_string(&rpc_req)
            .map_err(|e| AppError::Tool(format!("JSON 序列化失败: {e}")))?;
        stdin
            .write_all(format!("{line}\n").as_bytes())
            .await?;
        stdin.flush().await?;
        drop(stdin); // 关闭 stdin 通知子进程

        // 读取响应（每行一个 JSON，跳过非 JSON 的启动日志）
        let mut reader = BufReader::new(stdout).lines();
        let mut attempts = 0;
        while attempts < 10 {
            attempts += 1;
            let line = match reader.next_line().await? {
                Some(l) => l,
                None => break,
            };
            if line.trim().is_empty() {
                continue;
            }
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) {
                let _ = child.kill().await;
                let _ = child.wait().await;
                return Ok(value);
            }
        }
        let _ = child.kill().await;
        let _ = child.wait().await;
        Err(AppError::Tool("子进程未返回有效 JSON 响应".into()))
    }

    /// SSE 协议调用：POST 到插件 URL
    async fn call_sse(
        config: &McpConfig,
        req: &McpCallRequest,
    ) -> Result<serde_json::Value, AppError> {
        let url = config
            .url
            .as_ref()
            .ok_or_else(|| AppError::BadRequest("sse 插件缺少 url".into()))?;
        let client = reqwest::Client::new();
        let body = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {
                "name": req.tool,
                "arguments": req.arguments,
            }
        });
        let resp = client
            .post(url)
            .json(&body)
            .send()
            .await
            .map_err(|e| AppError::Tool(format!("SSE 请求失败: {e}")))?
            .error_for_status()
            .map_err(|e| AppError::Tool(format!("SSE 响应错误: {e}")))?;
        let value: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| AppError::Tool(format!("SSE 响应解析失败: {e}")))?;
        Ok(value)
    }
}

/* ============================================================
 * 辅助函数
 * ============================================================ */

/// 判断工具是否涉及文件访问
fn is_file_tool(tool: &str) -> bool {
    let t = tool.to_lowercase();
    t.contains("file") || t.contains("read") || t.contains("write") || t.contains("fs")
}

/// 判断工具是否涉及文件写操作
fn is_file_write_tool(tool: &str) -> bool {
    let t = tool.to_lowercase();
    t.contains("write")
        || t.contains("delete")
        || t.contains("remove")
        || t.contains("create")
        || t.contains("mkdir")
        || t.contains("rmdir")
}

/// 轻量化摘要：截断至 2000 字符
fn summarize(data: &serde_json::Value) -> String {
    let s = data.to_string();
    let count = s.chars().count();
    if count <= 2000 {
        s
    } else {
        let truncated: String = s.chars().take(2000).collect();
        format!("{truncated}...[truncated]")
    }
}

/* ============================================================
 * 内置 12 项真实开源 MCP 插件配置
 * ============================================================
 *
 * 全部 enabled=false，等用户主动启用。来源参考：
 * - modelcontextprotocol/servers 官方仓库
 * - rust-lang/rust-analyzer
 * - typescript-language-server/typescript-language-server
 * - upstash/context7
 *
 * 所有插件 timeout_secs=30，version="1.0.0"。
 */

/// 构造内置 MCP 插件配置清单（12 项）。
fn builtin_mcp_plugins() -> Vec<McpConfig> {
    vec![
        builtin_one(
            "github",
            "GitHub",
            "GitHub 官方 MCP（仓库/Issue/PR 操作）",
            "other",
            "network",
            false,
            "仓库/Issue/PR 读写",
            Some("npx".into()),
            Some(vec!["-y".into(), "@modelcontextprotocol/server-github".into()]),
            Some({
                let mut m = HashMap::new();
                m.insert("GITHUB_PERSONAL_ACCESS_TOKEN".into(), String::new());
                m
            }),
            None,
        ),
        builtin_one(
            "filesystem",
            "Filesystem",
            "文件系统 MCP（受限读写）",
            "other",
            "file",
            false,
            "文件读写/目录遍历",
            Some("npx".into()),
            Some(vec!["-y".into(), "@modelcontextprotocol/server-filesystem".into()]),
            None,
            None,
        ),
        builtin_one(
            "memory",
            "Memory",
            "持久化记忆 MCP（知识图谱）",
            "knowledge",
            "network",
            false,
            "知识图谱记忆存储",
            Some("npx".into()),
            Some(vec!["-y".into(), "@modelcontextprotocol/server-memory".into()]),
            None,
            None,
        ),
        builtin_one(
            "puppeteer",
            "Puppeteer",
            "浏览器自动化 MCP",
            "other",
            "network",
            false,
            "浏览器自动化/截图/PDF",
            Some("npx".into()),
            Some(vec!["-y".into(), "@modelcontextprotocol/server-puppeteer".into()]),
            None,
            None,
        ),
        builtin_one(
            "brave-search",
            "Brave Search",
            "Brave 搜索 MCP",
            "knowledge",
            "network",
            false,
            "网络搜索",
            Some("npx".into()),
            Some(vec!["-y".into(), "@modelcontextprotocol/server-brave-search".into()]),
            Some({
                let mut m = HashMap::new();
                m.insert("BRAVE_API_KEY".into(), String::new());
                m
            }),
            None,
        ),
        builtin_one(
            "fetch",
            "Fetch",
            "HTTP 请求 MCP",
            "other",
            "network",
            false,
            "HTTP 请求/网页抓取",
            Some("npx".into()),
            Some(vec!["-y".into(), "@modelcontextprotocol/server-fetch".into()]),
            None,
            None,
        ),
        builtin_one(
            "sequential-thinking",
            "Sequential Thinking",
            "思维链 MCP",
            "other",
            "network",
            false,
            "结构化思维链",
            Some("npx".into()),
            Some(vec!["-y".into(), "@modelcontextprotocol/server-sequential-thinking".into()]),
            None,
            None,
        ),
        builtin_one(
            "sqlite",
            "SQLite",
            "SQLite 数据库 MCP（高危）",
            "database",
            "database",
            true,
            "SQLite 数据库读写",
            Some("npx".into()),
            Some(vec!["-y".into(), "@modelcontextprotocol/server-sqlite".into()]),
            None,
            None,
        ),
        builtin_one(
            "time",
            "Time",
            "时间查询 MCP",
            "other",
            "network",
            false,
            "时间/时区查询",
            Some("npx".into()),
            Some(vec!["-y".into(), "@modelcontextprotocol/server-time".into()]),
            None,
            None,
        ),
        builtin_one(
            "rust-lsp",
            "Rust LSP",
            "Rust LSP MCP（类型/定义/引用）",
            "lsp",
            "network",
            false,
            "Rust 类型/定义/引用跳转",
            Some("rust-analyzer".into()),
            None,
            None,
            None,
        ),
        builtin_one(
            "typescript-lsp",
            "TypeScript LSP",
            "TypeScript LSP MCP",
            "lsp",
            "network",
            false,
            "TS/JS 类型/定义/引用",
            Some("npx".into()),
            Some(vec![
                "-y".into(),
                "typescript-language-server".into(),
                "--stdio".into(),
            ]),
            None,
            None,
        ),
        builtin_one(
            "context7",
            "Context7",
            "Context7 最新文档 MCP",
            "knowledge",
            "network",
            false,
            "最新库文档查询",
            Some("npx".into()),
            Some(vec!["-y".into(), "@upstash/context7-mcp".into()]),
            None,
            None,
        ),
    ]
}

/// 构造单个内置 MCP 配置的辅助函数（默认 enabled=false, timeout_secs=30, version="1.0.0"）。
#[allow(clippy::too_many_arguments)]
fn builtin_one(
    id: &str,
    name: &str,
    description: &str,
    category: &str,
    permission_scope: &str,
    high_risk: bool,
    capabilities: &str,
    command: Option<String>,
    args: Option<Vec<String>>,
    env: Option<HashMap<String, String>>,
    url: Option<String>,
) -> McpConfig {
    McpConfig {
        meta: McpMeta {
            id: id.to_string(),
            name: name.to_string(),
            description: description.to_string(),
            version: "1.0.0".to_string(),
            transport: "stdio".to_string(),
            enabled: false,
            high_risk,
            category: category.to_string(),
            capabilities: capabilities.to_string(),
        },
        command,
        args,
        env,
        url,
        permission_scope: permission_scope.to_string(),
        timeout_secs: 30,
    }
}
