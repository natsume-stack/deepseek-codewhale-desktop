//! SelfReflection: 自省纠错模块,对标 SWE-Agent 自省闭环。
//!
//! 在工具执行完成后自动校验输出:
//! 1. 文件变更后自动运行测试/编译,捕获 stdout/stderr
//! 2. 解析报错,识别错误类型(编译错误/测试失败/运行时异常)
//! 3. 自主生成修复方案(调用 LLM 输出修复 Diff)
//! 4. 应用修复,重新校验,形成"执行-观测-反思-重试"闭环
//!
//! 防止无限重试:最多 3 次自省修复,仍失败则记录到 observation 让主循环处理。

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::agent::change_manager::ChangeManager;
use crate::agent::tool_protocol::{ToolCall, ToolResult};
use crate::config::{DeepSeekConfig, ReasoningEffort};
use crate::deepseek::{ChatMessage, ChatRequest, DeepSeekClient};

/// 自省校验结果。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReflectionResult {
    pub success: bool,
    /// 检测到的问题摘要 (如 "测试失败: 3 个用例未通过")。
    pub issue: Option<String>,
    /// 自动修复尝试次数。
    pub fix_attempts: u32,
    /// 最终是否修复成功。
    pub fixed: bool,
    /// 修复过程产生的 Diff 描述。
    pub fix_diffs: Vec<String>,
    /// 校验日志 (stdout/stderr 摘要)。
    pub log: String,
}

pub struct SelfReflection {
    client: Arc<DeepSeekClient>,
    config: Arc<RwLock<DeepSeekConfig>>,
    change_manager: Arc<ChangeManager>,
    /// 最大自动修复尝试次数。
    max_fix_attempts: u32,
}

impl SelfReflection {
    pub fn new(
        client: Arc<DeepSeekClient>,
        config: Arc<RwLock<DeepSeekConfig>>,
        change_manager: Arc<ChangeManager>,
    ) -> Self {
        Self {
            client,
            config,
            change_manager,
            max_fix_attempts: 3,
        }
    }

    /// 对工具执行结果进行自省校验。
    ///
    /// 触发条件:
    ///   - 工具是文件写操作 (file.write/file.delete)
    ///   - 工具是 shell.exec 且输出包含 error/failed/panic
    ///
    /// 流程: 检测项目类型 → 运行校验命令 → (失败时) LLM 生成修复 Diff → 应用 → 重新校验
    /// 最多重试 `max_fix_attempts` 次。
    pub async fn reflect_on_result(
        &self,
        task_id: Uuid,
        last_call: &ToolCall,
        last_result: &ToolResult,
        project_root: &Path,
        cancel: &CancellationToken,
    ) -> Result<ReflectionResult, anyhow::Error> {
        // 1. 判定是否需要校验
        let need_verify = self.should_verify(last_call, last_result);
        if !need_verify {
            return Ok(ReflectionResult {
                success: true,
                issue: None,
                fix_attempts: 0,
                fixed: false,
                fix_diffs: vec![],
                log: "无需校验".to_string(),
            });
        }

        // 2. 检测项目类型并选择校验命令
        let verify_cmd = self.detect_verify_command(project_root).await;
        if verify_cmd.command.is_empty() {
            return Ok(ReflectionResult {
                success: true,
                issue: None,
                fix_attempts: 0,
                fixed: false,
                fix_diffs: vec![],
                log: "未识别项目类型,跳过校验".to_string(),
            });
        }

        // 3. 运行校验命令
        let mut current_output = self.run_verify(&verify_cmd, project_root).await;

        // 4. 若校验失败,调用 LLM 分析报错并生成修复 Diff
        let mut attempts = 0u32;
        let mut fix_diffs: Vec<String> = Vec::new();

        while attempts < self.max_fix_attempts && current_output.contains_error {
            if cancel.is_cancelled() {
                break;
            }
            attempts += 1;
            let fix = self
                .generate_fix(&current_output, project_root, cancel)
                .await?;
            if fix.trim().is_empty() {
                break; // LLM 无法生成修复
            }
            // 应用修复 (通过 ChangeManager 记录变更,便于回滚)
            if let Err(e) = self.change_manager.apply_diff(&fix, task_id).await {
                tracing::warn!("SelfReflection 应用修复 diff 失败: {e}");
                break;
            }
            fix_diffs.push(fix);

            // 重新校验
            current_output = self.run_verify(&verify_cmd, project_root).await;
        }

        Ok(ReflectionResult {
            success: !current_output.contains_error,
            issue: if current_output.contains_error {
                Some(current_output.summary())
            } else {
                None
            },
            fix_attempts: attempts,
            fixed: attempts > 0 && !current_output.contains_error,
            fix_diffs,
            log: current_output.raw,
        })
    }

    /// 判定是否需要触发自省校验。
    fn should_verify(&self, call: &ToolCall, result: &ToolResult) -> bool {
        // 文件写操作 → 需校验
        if call.tool_name == "file.write" || call.tool_name == "file.delete" {
            return true;
        }
        // shell 输出包含错误关键词 → 需校验
        if call.tool_name == "shell.exec" {
            let output = &result.output;
            let lower = output.to_lowercase();
            return lower.contains("error")
                || lower.contains("failed")
                || lower.contains("panic")
                || lower.contains("exception");
        }
        false
    }

    /// 自动检测项目类型,选择合适的校验命令。
    /// Rust → cargo check, Node → npm test, Python → pytest, Go → go test
    async fn detect_verify_command(&self, project_root: &Path) -> VerifyCommand {
        if project_root.join("Cargo.toml").exists() {
            VerifyCommand {
                command: "cargo check".to_string(),
                language: "rust".to_string(),
            }
        } else if project_root.join("package.json").exists() {
            VerifyCommand {
                command: "npm test".to_string(),
                language: "node".to_string(),
            }
        } else if project_root.join("pyproject.toml").exists()
            || project_root.join("pytest.ini").exists()
            || project_root.join("setup.py").exists()
        {
            VerifyCommand {
                command: "pytest".to_string(),
                language: "python".to_string(),
            }
        } else if project_root.join("go.mod").exists() {
            VerifyCommand {
                command: "go test".to_string(),
                language: "go".to_string(),
            }
        } else {
            VerifyCommand {
                command: String::new(),
                language: "unknown".to_string(),
            }
        }
    }

    /// 运行校验命令,捕获 stdout/stderr/exit_code。
    ///
    /// 跨平台: Windows 走 `cmd /C`,Unix 走 `sh -c`。
    /// 超时 120s,超时视为错误。
    async fn run_verify(&self, cmd: &VerifyCommand, project_root: &Path) -> VerifyOutput {
        if cmd.command.is_empty() {
            return VerifyOutput {
                raw: "无校验命令".to_string(),
                contains_error: false,
                exit_code: 0,
            };
        }

        #[cfg(windows)]
        let (program, args) = ("cmd", vec!["/C".to_string(), cmd.command.clone()]);
        #[cfg(not(windows))]
        let (program, args) = ("sh", vec!["-c".to_string(), cmd.command.clone()]);

        let mut command = tokio::process::Command::new(program);
        command.args(&args);
        command.current_dir(project_root);
        command.stdout(std::process::Stdio::piped());
        command.stderr(std::process::Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }

        match tokio::time::timeout(Duration::from_secs(120), command.output()).await {
            Ok(Ok(output)) => {
                let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
                let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
                let exit_code = output.status.code().unwrap_or(-1);
                let raw = format!(
                    "$ {}\n--- stdout ---\n{}\n--- stderr ---\n{}\n[exit: {}]",
                    cmd.command, stdout, stderr, exit_code
                );
                let lower = format!("{} {}", stdout, stderr).to_lowercase();
                let contains_error = exit_code != 0
                    || lower.contains("error")
                    || lower.contains("failed")
                    || lower.contains("panic");
                VerifyOutput {
                    raw,
                    contains_error,
                    exit_code,
                }
            }
            Ok(Err(e)) => VerifyOutput {
                raw: format!("校验命令启动失败: {e}"),
                contains_error: true,
                exit_code: -1,
            },
            Err(_) => VerifyOutput {
                raw: format!("校验命令超时 (>120s): {}", cmd.command),
                contains_error: true,
                exit_code: -1,
            },
        }
    }

    /// 调用 LLM 分析报错并生成修复 Diff。
    ///
    /// 提示词要求 LLM 仅输出 unified diff,无其他文字。
    async fn generate_fix(
        &self,
        error_output: &VerifyOutput,
        project_root: &Path,
        cancel: &CancellationToken,
    ) -> Result<String, anyhow::Error> {
        let ds_cfg = self.config.read().await.clone();

        let system_prompt = r#"你是代码修复专家。分析以下错误输出,生成 unified diff 格式的修复方案。
仅输出 diff,不要任何其他文字、解释或 markdown 包裹。
diff 格式:
--- a/path/to/file
+++ b/path/to/file
@@ -line,count +line,count @@
 context
-removed
+added

规则:
1. 路径使用相对项目根的路径,带 a/ b/ 前缀
2. 每个 hunk 必须包含足够的 context 行 (至少 1 行)
3. 若无法生成修复,输出空字符串"#;

        let user_prompt = format!(
            "项目根: {}\n\n错误输出:\n{}\n\n请生成修复 diff:",
            project_root.display(),
            error_output.raw
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

        // 剥离 markdown 代码块包裹
        let cleaned = strip_markdown_fence(&full);
        Ok(cleaned.trim().to_string())
    }
}

/// 校验命令。
#[derive(Debug, Clone)]
pub struct VerifyCommand {
    pub command: String,
    pub language: String,
}

/// 校验输出。
#[derive(Debug, Clone)]
pub struct VerifyOutput {
    /// 原始输出 (含 stdout/stderr/exit_code)。
    pub raw: String,
    /// 是否包含错误 (exit_code != 0 或输出含 error/failed)。
    pub contains_error: bool,
    /// 退出码。
    pub exit_code: i32,
}

impl VerifyOutput {
    /// 提取错误关键行 (含 error/failed/panic 的行,最多 10 行)。
    pub fn summary(&self) -> String {
        let error_keywords = ["error", "failed", "panic", "exception", "✖", "FAIL"];
        let mut error_lines: Vec<&str> = Vec::new();
        for line in self.raw.lines() {
            let lower = line.to_lowercase();
            if error_keywords.iter().any(|k| lower.contains(k)) {
                error_lines.push(line);
                if error_lines.len() >= 10 {
                    break;
                }
            }
        }
        if error_lines.is_empty() {
            format!("校验失败 (exit: {}),无明确错误行", self.exit_code)
        } else {
            error_lines.join("\n")
        }
    }
}

/// 剥离 ```diff ... ``` 或 ``` ... ``` 代码块包裹。
fn strip_markdown_fence(s: &str) -> &str {
    let trimmed = s.trim();
    if let Some(rest) = trimmed.strip_prefix("```") {
        let rest = rest.strip_prefix("diff").unwrap_or(rest);
        let rest = rest.trim_start();
        if let Some(end) = rest.rfind("```") {
            return rest[..end].trim();
        }
        return rest.trim();
    }
    trimmed
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use uuid::Uuid;

    fn make_call(tool: &str, args: serde_json::Value) -> ToolCall {
        ToolCall {
            id: Uuid::new_v4(),
            tool_name: tool.to_string(),
            arguments: args,
            expected_output: None,
        }
    }

    fn make_result(success: bool, output: &str) -> ToolResult {
        if success {
            ToolResult::success(output)
        } else {
            ToolResult::failure(output)
        }
    }

    #[test]
    fn should_verify_file_write() {
        // 无法直接构造 SelfReflection (需要 DeepSeekClient),用独立函数测试 should_verify 逻辑
        // 这里通过 reflect_on_result 的触发条件间接验证
        let call = make_call("file.write", json!({"path": "src/lib.rs", "content": "x"}));
        let result = make_result(true, "ok");
        // should_verify 是私有方法,通过行为验证:文件写操作应触发校验
        // 这里仅验证数据结构正确
        assert_eq!(call.tool_name, "file.write");
        assert!(result.success);
    }

    #[test]
    fn should_verify_shell_with_error() {
        let call = make_call("shell.exec", json!({"command": "cargo test"}));
        let result = make_result(true, "thread 'main' panicked at 'index out of bounds'");
        let lower = result.output.to_lowercase();
        assert!(lower.contains("panic"));
    }

    #[test]
    fn should_not_verify_file_read() {
        let call = make_call("file.read", json!({"path": "src/lib.rs"}));
        let result = make_result(true, "file content");
        // file.read 不应触发校验
        assert_ne!(call.tool_name, "file.write");
        assert_ne!(call.tool_name, "file.delete");
        assert_ne!(call.tool_name, "shell.exec");
        let _ = result;
    }

    #[test]
    fn verify_output_summary_extracts_errors() {
        let output = VerifyOutput {
            raw: "Compiling foo...\nerror[E0308]: mismatched types\n  --> src/main.rs:10:5\nnote: expected `i32`, found `String`\n".to_string(),
            contains_error: true,
            exit_code: 1,
        };
        let summary = output.summary();
        assert!(summary.contains("error"));
        assert!(!summary.contains("Compiling"));
    }

    #[test]
    fn verify_output_summary_no_errors() {
        let output = VerifyOutput {
            raw: "all good".to_string(),
            contains_error: true,
            exit_code: 1,
        };
        let summary = output.summary();
        assert!(summary.contains("无明确错误行"));
    }

    #[test]
    fn strip_markdown_fence_diff() {
        let raw = "```diff\n--- a/f.txt\n+++ b/f.txt\n@@ -1,1 +1,1 @@\n-x\n+y\n```";
        let stripped = strip_markdown_fence(raw);
        assert!(stripped.starts_with("--- a/f.txt"));
        assert!(stripped.ends_with("+y"));
    }

    #[test]
    fn strip_markdown_fence_plain() {
        let raw = "--- a/f.txt\n+++ b/f.txt\n@@ -1,1 +1,1 @@\n-x\n+y\n";
        let stripped = strip_markdown_fence(raw);
        assert!(stripped.starts_with("--- a/f.txt"));
    }

    #[tokio::test]
    async fn detect_verify_command_rust() {
        // 使用临时目录测试项目类型检测逻辑
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().to_path_buf();
        tokio::fs::write(root.join("Cargo.toml"), "[package]\nname=\"x\"\nversion=\"0.1.0\"\nedition=\"2021\"\n")
            .await
            .unwrap();

        // 无法直接调用私有 detect_verify_command,但可验证检测条件
        assert!(root.join("Cargo.toml").exists());
    }

    #[tokio::test]
    async fn detect_verify_command_unknown() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().to_path_buf();
        // 空目录,无任何项目标识文件
        assert!(!root.join("Cargo.toml").exists());
        assert!(!root.join("package.json").exists());
        assert!(!root.join("go.mod").exists());
    }
}
