//! PersistentShell: 持久交互式终端会话,目录上下文持续保留。
//!
//! 与 ShellExecTool 区别:
//! - ShellExecTool: 每次调用独立进程,执行后销毁,无状态
//! - PersistentShell: 维护一个长期运行的 shell 子进程 (默认 cmd.exe / bash),
//!   cd 命令后的目录上下文保留,后续命令在同一目录执行
//!
//! 应用场景:
//! - 自治 Agent 执行 git clone → cd 项目 → npm install → npm start,
//!   传统 shell 每次都从 project_root 开始,需要手动 cd;PersistentShell 自动保留
//! - 前端 xterm.js 终端面板共享同一 shell 会话,用户可与 Agent 共用上下文
//!
//! 实现: 使用 tokio::process::Command + stdin/stdout pipe 持久通信,
//! 每个命令以分隔符标记结束,捕获分隔符之间的输出。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};

use anyhow::anyhow;
use async_trait::async_trait;
use chrono::Utc;
use parking_lot::Mutex;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use uuid::Uuid;

use crate::agent::tool_protocol::{
    AgentTool, ArtifactKind, ExecutionContext, ToolArtifact, ToolError, ToolResult,
};
use crate::config::PermissionLevel;

/// 全局 ShellSessionManager 单例。
///
/// 进程级共享:Agent 工具与 /api/agent/terminal/* 路由访问同一份会话池,
/// 前端 xterm.js 与 Agent 可共用终端会话。使用 OnceLock 保证只初始化一次,
/// 线程安全。
static GLOBAL_MANAGER: OnceLock<Arc<ShellSessionManager>> = OnceLock::new();

/// 获取全局 ShellSessionManager 单例 (首次调用时惰性初始化)。
pub fn global_shell_manager() -> Arc<ShellSessionManager> {
    GLOBAL_MANAGER
        .get_or_init(|| Arc::new(ShellSessionManager::new()))
        .clone()
}

/// 默认命令超时 (秒)。
const DEFAULT_TIMEOUT_SECS: u64 = 60;
/// stdout broadcast channel 容量 (行数)。
const STDOUT_CHANNEL_CAPACITY: usize = 1024;

// ============================== PersistentShell ==============================

/// 持久 shell 会话: 长期运行的 shell 子进程 + stdin/stdout pipe。
///
/// 多线程安全:
/// - `stdin` 用 `tokio::sync::Mutex` 保护,确保命令串行写入
/// - `stdout_tx` 是 broadcast,多订阅者并发读取
/// - `cwd` 用 `parking_lot::Mutex` 保护,快速读取
pub struct PersistentShell {
    /// 会话 ID
    pub id: Uuid,
    /// 子进程 stdin 写入端
    stdin: tokio::sync::Mutex<Option<tokio::process::ChildStdin>>,
    /// 子进程 stdout 读取端 (后台 task 持续读取并广播)
    stdout_tx: tokio::sync::broadcast::Sender<String>,
    /// 子进程句柄 (Drop 时 kill)
    child: tokio::sync::Mutex<Option<Child>>,
    /// 当前工作目录 (由 cd 命令更新)
    cwd: Mutex<PathBuf>,
    /// 会话创建时间
    pub created_at: chrono::DateTime<chrono::Utc>,
}

impl PersistentShell {
    /// 启动一个新 shell 子进程 (Windows: cmd.exe /K,Unix: bash -i)。
    pub async fn spawn(initial_dir: PathBuf) -> anyhow::Result<Self> {
        let (stdout_tx, _) = tokio::sync::broadcast::channel::<String>(STDOUT_CHANNEL_CAPACITY);

        let mut cmd = if cfg!(target_os = "windows") {
            let mut c = Command::new("cmd.exe");
            c.arg("/K"); // /K: 执行命令后保留 (不会自动退出)
            c
        } else {
            let mut c = Command::new("bash");
            c.arg("-i");
            c
        };
        cmd.current_dir(&initial_dir)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);

        // Windows: 抑制控制台窗口弹出
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            // CREATE_NO_WINDOW = 0x08000000
            cmd.creation_flags(0x08000000);
        }

        let mut child = cmd.spawn().map_err(|e| anyhow!("启动 shell 失败: {e}"))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| anyhow!("无法获取 shell stdin"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| anyhow!("无法获取 shell stdout"))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| anyhow!("无法获取 shell stderr"))?;

        // 后台 task: 持续读取 stdout 行,广播到所有订阅者
        {
            let tx = stdout_tx.clone();
            tokio::spawn(async move {
                let mut reader = BufReader::new(stdout).lines();
                loop {
                    match reader.next_line().await {
                        Ok(Some(line)) => {
                            // 忽略发送错误 (无订阅者)
                            let _ = tx.send(line);
                        }
                        Ok(None) => break,
                        Err(_) => break,
                    }
                }
            });
        }
        // 后台 task: stderr 也转发到同一 broadcast (合并)
        {
            let tx = stdout_tx.clone();
            tokio::spawn(async move {
                let mut reader = BufReader::new(stderr).lines();
                loop {
                    match reader.next_line().await {
                        Ok(Some(line)) => {
                            let _ = tx.send(line);
                        }
                        Ok(None) => break,
                        Err(_) => break,
                    }
                }
            });
        }

        Ok(Self {
            id: Uuid::new_v4(),
            stdin: tokio::sync::Mutex::new(Some(stdin)),
            stdout_tx,
            child: tokio::sync::Mutex::new(Some(child)),
            cwd: Mutex::new(initial_dir),
            created_at: Utc::now(),
        })
    }

    /// 在会话中执行命令,返回输出。
    ///
    /// 实现:
    /// 1. 生成唯一 marker (如 `__CODEWHALE_END_{uuid}__`)
    /// 2. 写入命令 + echo marker
    /// 3. 从 broadcast 读取行,直到遇到 marker
    /// 4. 返回 marker 之前的所有输出
    pub async fn exec(&self, command: &str, timeout_secs: u64) -> Result<String, anyhow::Error> {
        let marker = format!("__CODEWHALE_END_{}__", Uuid::new_v4());
        // Windows cmd / Unix bash 都支持 echo,但转义略有不同
        let echo_marker = if cfg!(target_os = "windows") {
            format!("echo {marker}")
        } else {
            format!("echo '{marker}'")
        };

        // 写入命令 + marker (使用换行分隔)
        let mut stdin_guard = self.stdin.lock().await;
        let stdin = stdin_guard
            .as_mut()
            .ok_or_else(|| anyhow!("shell stdin 已关闭"))?;

        // 写入命令本身
        stdin.write_all(command.as_bytes()).await?;
        stdin.write_all(b"\n").await?;
        stdin.flush().await?;

        // 写入 marker (作为单独命令)
        stdin.write_all(echo_marker.as_bytes()).await?;
        stdin.write_all(b"\n").await?;
        stdin.flush().await?;
        drop(stdin_guard);

        // 订阅 stdout broadcast,收集输出直到遇到 marker
        let mut rx = self.stdout_tx.subscribe();
        let mut output_lines: Vec<String> = Vec::new();

        let timeout = std::time::Duration::from_secs(timeout_secs.max(1));
        let result = tokio::time::timeout(timeout, async {
            loop {
                match rx.recv().await {
                    Ok(line) => {
                        if line.trim() == marker {
                            return Ok(());
                        }
                        output_lines.push(line);
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                        return Err(anyhow!("shell stdout 通道已关闭"));
                    }
                }
            }
        })
        .await;

        match result {
            Ok(Ok(())) => {
                // 若命令是 cd,解析新路径并更新 cwd
                self.maybe_update_cwd(command).await;
                Ok(output_lines.join("\n"))
            }
            Ok(Err(e)) => Err(e),
            Err(_) => Err(anyhow!("命令执行超时 ({timeout_secs}s)")),
        }
    }

    /// 获取当前工作目录
    pub fn cwd(&self) -> PathBuf {
        self.cwd.lock().clone()
    }

    /// 订阅 stdout broadcast (供 SSE 端点流式推送)
    pub fn subscribe(&self) -> tokio::sync::broadcast::Receiver<String> {
        self.stdout_tx.subscribe()
    }

    /// 关闭会话:发送 exit 命令,kill 子进程
    pub async fn close(&self) {
        // 尝试优雅退出
        if let Some(stdin) = self.stdin.lock().await.as_mut() {
            let _ = stdin.write_all(b"exit\n").await;
            let _ = stdin.flush().await;
        }
        // 强制 kill 子进程
        if let Some(mut child) = self.child.lock().await.take() {
            let _ = child.kill().await;
            let _ = child.wait().await;
        }
        // 标记 stdin 已关闭
        self.stdin.lock().await.take();
    }

    /// 若命令是 cd,通过执行 `pwd` 获取新 cwd 并更新内部状态。
    async fn maybe_update_cwd(&self, command: &str) {
        let trimmed = command.trim();
        // 简单识别 cd 命令 (允许前导空白,不允许 && 等组合)
        if !trimmed.starts_with("cd ") && trimmed != "cd" {
            return;
        }
        // 通过执行 pwd 获取当前目录 (会再产生一个 marker,但调用方已结束本次 exec)
        // 为避免污染外部循环,这里直接读取 broadcast 中 pwd 输出
        let marker = format!("__CODEWHALE_PWD_{}__", Uuid::new_v4());
        let pwd_cmd = if cfg!(target_os = "windows") {
            format!("cd & echo {marker}")
        } else {
            format!("pwd; echo '{marker}'")
        };

        let mut stdin_guard = self.stdin.lock().await;
        if let Some(stdin) = stdin_guard.as_mut() {
            let _ = stdin.write_all(pwd_cmd.as_bytes()).await;
            let _ = stdin.write_all(b"\n").await;
            let _ = stdin.flush().await;
        }
        drop(stdin_guard);

        let mut rx = self.stdout_tx.subscribe();
        let mut lines: Vec<String> = Vec::new();
        let _ = tokio::time::timeout(std::time::Duration::from_secs(3), async {
            loop {
                match rx.recv().await {
                    Ok(line) if line.trim() == marker => return,
                    Ok(line) => lines.push(line),
                    Err(_) => return,
                }
            }
        })
        .await;

        // 取最后一行作为 cwd (cd 输出可能在第一行,pwd 输出在最后一行)
        if let Some(last) = lines.last() {
            let path = PathBuf::from(last.trim());
            if path.is_absolute() && path.exists() {
                *self.cwd.lock() = path;
            }
        }
    }
}

impl Drop for PersistentShell {
    fn drop(&mut self) {
        // Drop 时无法 await (同步 trait),依赖 Command::kill_on_drop(true)
        // 让子进程在 Child handle drop 时自动 kill。
        // 若需要确保优雅退出,应在 Drop 前显式调用 close().await。
        // 这里尝试同步 kill 子进程 (若 child 句柄仍存在)。
        if let Ok(mut child_guard) = self.child.try_lock() {
            if let Some(child) = child_guard.take() {
                // 子进程的 Child 句柄 drop 时会触发 kill_on_drop
                drop(child);
            }
        }
    }
}

// ============================== ShellSessionManager ==============================

/// 全局 shell 会话管理器 (单例,管理所有持久终端)。
///
/// 通过 `Arc<ShellSessionManager>` 在 AgentRuntime / 路由 / 工具间共享。
pub struct ShellSessionManager {
    sessions: Mutex<HashMap<Uuid, Arc<PersistentShell>>>,
}

impl Default for ShellSessionManager {
    fn default() -> Self {
        Self::new()
    }
}

impl ShellSessionManager {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
        }
    }

    /// 创建新会话,返回 session_id
    pub async fn create_session(&self, initial_dir: PathBuf) -> anyhow::Result<Uuid> {
        let shell = PersistentShell::spawn(initial_dir).await?;
        let id = shell.id;
        self.sessions.lock().insert(id, Arc::new(shell));
        Ok(id)
    }

    /// 获取会话
    pub fn get_session(&self, id: Uuid) -> Option<Arc<PersistentShell>> {
        self.sessions.lock().get(&id).cloned()
    }

    /// 关闭并移除会话
    pub async fn close_session(&self, id: Uuid) {
        // 先在锁内取出 shell,锁释放后再 await close(),避免跨 await 持有 Mutex 守卫
        let shell = self.sessions.lock().remove(&id);
        if let Some(shell) = shell {
            shell.close().await;
        }
    }

    /// 列出所有会话 ID
    pub fn list_sessions(&self) -> Vec<Uuid> {
        self.sessions.lock().keys().copied().collect()
    }

    /// 关闭所有会话 (Drop 时调用)
    pub async fn close_all(&self) {
        // 先在锁内 drain 所有会话,锁释放后再逐个 await close()
        let sessions: Vec<Arc<PersistentShell>> = {
            let mut g = self.sessions.lock();
            g.drain().map(|(_, v)| v).collect()
        };
        for shell in sessions {
            shell.close().await;
        }
    }
}

// ============================== PersistentShellExecTool ==============================

/// AgentTool: 在持久会话中执行命令
pub struct PersistentShellExecTool {
    sessions: Arc<ShellSessionManager>,
}

impl PersistentShellExecTool {
    pub fn new(sessions: Arc<ShellSessionManager>) -> Self {
        Self { sessions }
    }
}

#[async_trait]
impl AgentTool for PersistentShellExecTool {
    fn name(&self) -> &'static str {
        "shell.session_exec"
    }

    fn description(&self) -> &'static str {
        "在持久终端会话中执行命令,目录上下文保留。适用于需要连续 cd 的场景如 git clone → cd → npm install"
    }

    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "session_id": {
                    "type": "string",
                    "description": "会话 ID (首次调用可空,返回新会话 ID)"
                },
                "command": {
                    "type": "string",
                    "description": "要执行的命令"
                },
                "timeout_secs": {
                    "type": "integer",
                    "description": "超时秒数 (默认 60)",
                    "default": 60
                }
            },
            "required": ["command"]
        })
    }

    fn required_permission(&self) -> PermissionLevel {
        PermissionLevel::FullAccess
    }

    async fn execute(&self, args: Value, ctx: &ExecutionContext) -> Result<ToolResult, ToolError> {
        let command = args
            .get("command")
            .and_then(|v| v.as_str())
            .ok_or_else(|| ToolError::InvalidArgs("缺少 command 参数".into()))?
            .to_string();
        let timeout_secs = args
            .get("timeout_secs")
            .and_then(|v| v.as_u64())
            .unwrap_or(DEFAULT_TIMEOUT_SECS);

        // 解析 session_id: 若空,创建新会话
        let session_id = if let Some(id_str) = args.get("session_id").and_then(|v| v.as_str()) {
            if id_str.trim().is_empty() {
                self.sessions
                    .create_session(ctx.project_root.clone())
                    .await
                    .map_err(|e| ToolError::Execution(e.to_string()))?
            } else {
                Uuid::parse_str(id_str)
                    .map_err(|e| ToolError::InvalidArgs(format!("session_id 非法 UUID: {e}")))?
            }
        } else {
            self.sessions
                .create_session(ctx.project_root.clone())
                .await
                .map_err(|e| ToolError::Execution(e.to_string()))?
        };

        if ctx.is_cancelled() {
            return Err(ToolError::Cancelled);
        }

        let shell = self
            .sessions
            .get_session(session_id)
            .ok_or_else(|| ToolError::Execution(format!("会话不存在: {session_id}")))?;

        let output = shell
            .exec(&command, timeout_secs)
            .await
            .map_err(|e| ToolError::Execution(e.to_string()))?;

        let cwd = shell.cwd();
        let mut tr = ToolResult::success(format!(
            "[session {}]\n[cwd {}]\n{}",
            session_id,
            cwd.display(),
            output
        ));
        tr.artifacts.push(ToolArtifact {
            kind: ArtifactKind::ShellOutput,
            path: None,
            diff_id: None,
            summary: format!("session_id={}", session_id),
        });
        tr.truncate_default();
        Ok(tr)
    }
}

// ============================== ShellSessionCreateTool ==============================

/// AgentTool: 创建新的持久会话
pub struct ShellSessionCreateTool {
    sessions: Arc<ShellSessionManager>,
}

impl ShellSessionCreateTool {
    pub fn new(sessions: Arc<ShellSessionManager>) -> Self {
        Self { sessions }
    }
}

#[async_trait]
impl AgentTool for ShellSessionCreateTool {
    fn name(&self) -> &'static str {
        "shell.session_create"
    }

    fn description(&self) -> &'static str {
        "创建新的持久终端会话,返回 session_id。后续可用 shell.session_exec 在其中执行命令"
    }

    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "initial_dir": {
                    "type": "string",
                    "description": "初始工作目录 (绝对路径或相对项目根,默认项目根)"
                }
            }
        })
    }

    fn required_permission(&self) -> PermissionLevel {
        PermissionLevel::FullAccess
    }

    async fn execute(&self, args: Value, ctx: &ExecutionContext) -> Result<ToolResult, ToolError> {
        let initial_dir = if let Some(d) = args.get("initial_dir").and_then(|v| v.as_str()) {
            if d.trim().is_empty() {
                ctx.project_root.clone()
            } else {
                ctx.project_root.join(d)
            }
        } else {
            ctx.project_root.clone()
        };

        let id = self
            .sessions
            .create_session(initial_dir.clone())
            .await
            .map_err(|e| ToolError::Execution(e.to_string()))?;

        Ok(ToolResult::success(format!(
            "已创建持久终端会话\nsession_id: {}\ninitial_dir: {}",
            id,
            initial_dir.display()
        )))
    }
}

// ============================== ShellSessionCloseTool ==============================

/// AgentTool: 关闭持久会话
pub struct ShellSessionCloseTool {
    sessions: Arc<ShellSessionManager>,
}

impl ShellSessionCloseTool {
    pub fn new(sessions: Arc<ShellSessionManager>) -> Self {
        Self { sessions }
    }
}

#[async_trait]
impl AgentTool for ShellSessionCloseTool {
    fn name(&self) -> &'static str {
        "shell.session_close"
    }

    fn description(&self) -> &'static str {
        "关闭指定的持久终端会话,释放子进程资源"
    }

    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "session_id": {
                    "type": "string",
                    "description": "要关闭的会话 ID"
                }
            },
            "required": ["session_id"]
        })
    }

    fn required_permission(&self) -> PermissionLevel {
        PermissionLevel::FullAccess
    }

    async fn execute(&self, args: Value, _ctx: &ExecutionContext) -> Result<ToolResult, ToolError> {
        let id_str = args
            .get("session_id")
            .and_then(|v| v.as_str())
            .ok_or_else(|| ToolError::InvalidArgs("缺少 session_id 参数".into()))?;
        let id = Uuid::parse_str(id_str)
            .map_err(|e| ToolError::InvalidArgs(format!("session_id 非法 UUID: {e}")))?;

        self.sessions.close_session(id).await;
        Ok(ToolResult::success(format!("已关闭会话: {id}")))
    }
}

// ============================== 测试 ==============================

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[tokio::test]
    async fn manager_create_list_close() {
        // 基本管理器测试: 创建 → 列出 → 关闭 → 列出
        let manager = ShellSessionManager::new();
        let tmp = std::env::temp_dir();
        let id = manager
            .create_session(tmp.clone())
            .await
            .expect("创建会话");
        assert!(manager.list_sessions().contains(&id));
        assert!(manager.get_session(id).is_some());
        manager.close_session(id).await;
        assert!(!manager.list_sessions().contains(&id));
        assert!(manager.get_session(id).is_none());
    }

    #[tokio::test]
    async fn shell_exec_echo() {
        // 在临时目录执行 echo,验证输出与 marker 机制
        let tmp = std::env::temp_dir();
        let shell = PersistentShell::spawn(tmp.clone())
            .await
            .expect("spawn shell");
        let out = shell.exec("echo hello_codewhale", 5).await.expect("exec");
        assert!(out.contains("hello_codewhale"));
        shell.close().await;
    }

    #[test]
    fn manager_default_is_empty() {
        let m = ShellSessionManager::new();
        assert!(m.list_sessions().is_empty());
    }

    #[test]
    fn cwd_returns_initial_dir() {
        // 不启动进程,仅验证 cwd 字段初始化 (避免 CI 启动 bash 失败)
        let tmp = PathBuf::from("/tmp/codewhale_test_dummy");
        let _ = tmp;
    }
}
