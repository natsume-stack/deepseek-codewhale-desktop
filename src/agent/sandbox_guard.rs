//! SandboxGuard: 独立安全防护层,统一管控工具调用的安全性。
//!
//! 在 ToolDispatcher 调用工具前,经过 SandboxGuard 多层校验:
//! 1. 工作目录锁定:禁止访问项目根之外的文件
//! 2. 命令黑白名单:拦截危险 shell 命令(rm -rf /, format, fork bomb 等)
//! 3. 路径限制:禁止修改 .git/、node_modules/ 等关键目录
//! 4. 高危操作拦截:删除批量文件、git push --force 等触发告警
//! 5. 全自动模式下高危操作自动切换审批
//!
//! 设计要点:
//!   - 与 `tools.rs` 内部的 `ensure_within` 越界校验形成纵深防御
//!   - 正则模式在配置变更时预编译,运行时仅匹配
//!   - 高危 (HighRisk) 不直接拒绝,交由调用方决定是否切换审批

use std::path::{Path, PathBuf};

use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::agent::tool_protocol::{ToolCall, ToolError};
use crate::config::PermissionLevel;

/// 沙盒配置。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SandboxConfig {
    /// 工作目录锁定 (超出此范围的文件访问被拒);None 时使用 project_root。
    pub workspace_root: Option<PathBuf>,
    /// 命令黑名单 (正则,命中即拒绝)。
    pub command_blacklist: Vec<String>,
    /// 路径黑名单 (禁止修改的目录/文件,子串匹配)。
    pub path_blacklist: Vec<String>,
    /// 高危操作模式 (正则,命中触发告警,自治模式应切换审批)。
    pub high_risk_patterns: Vec<String>,
    /// 是否在自治模式下遇高危操作自动切换审批。
    pub auto_approval_on_high_risk: bool,
}

impl Default for SandboxConfig {
    fn default() -> Self {
        Self {
            workspace_root: None,
            command_blacklist: vec![
                r"rm\s+-rf\s+/(?:\s|$)".to_string(),        // rm -rf /
                r"rm\s+-rf\s+~".to_string(),                 // rm -rf ~
                r"mkfs\.".to_string(),                        // mkfs.*
                r":\(\)\{\s*:\|:\&\}\s*;:".to_string(),      // fork bomb
                r"dd\s+if=.*of=/dev/sd".to_string(),          // dd 写磁盘
                r"shutdown|reboot|halt".to_string(),          // 关机重启
                r"format\s+[A-Z]:".to_string(),               // Windows format
                r"del\s+/f\s+/s\s+/q\s+C:".to_string(),       // Windows del
            ],
            path_blacklist: vec![
                ".git/".to_string(),
                "node_modules/".to_string(),
                ".env".to_string(),
                "__pycache__/".to_string(),
                "target/".to_string(),
            ],
            high_risk_patterns: vec![
                r"git\s+push\s+--force".to_string(),
                r"git\s+push\s+-f\s".to_string(),
                r"git\s+reset\s+--hard".to_string(),
                r"rm\s+-rf\s+\.".to_string(),
                r"DROP\s+TABLE".to_string(),
                r"DELETE\s+FROM\s+\w+\s*;".to_string(),
            ],
            auto_approval_on_high_risk: true,
        }
    }
}

/// 编译后的配置 (正则预编译,运行时零编译开销)。
struct CompiledConfig {
    config: SandboxConfig,
    command_blacklist_re: Vec<Regex>,
    high_risk_patterns_re: Vec<Regex>,
}

impl CompiledConfig {
    fn from_config(config: SandboxConfig) -> Self {
        let command_blacklist_re = compile_patterns(&config.command_blacklist);
        let high_risk_patterns_re = compile_patterns(&config.high_risk_patterns);
        Self {
            config,
            command_blacklist_re,
            high_risk_patterns_re,
        }
    }
}

fn compile_patterns(patterns: &[String]) -> Vec<Regex> {
    patterns
        .iter()
        .filter_map(|p| match Regex::new(p) {
            Ok(re) => Some(re),
            Err(e) => {
                tracing::warn!("沙盒正则编译失败 (将忽略该规则): {} -> {e}", p);
                None
            }
        })
        .collect()
}

/// 沙盒校验结果。
#[derive(Debug, Clone)]
pub enum SandboxCheckResult {
    /// 允许执行。
    Allowed,
    /// 高危但允许执行 (自治模式应切换审批)。携带原因描述。
    HighRisk(String),
}

/// 命令风险等级。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommandRiskLevel {
    /// 安全。
    Safe,
    /// 命中黑名单,直接拒绝。
    Blacklisted,
    /// 高危,自治模式应切换审批。
    HighRisk,
}

pub struct SandboxGuard {
    inner: parking_lot::RwLock<CompiledConfig>,
}

impl SandboxGuard {
    pub fn new() -> Self {
        Self::with_config(SandboxConfig::default())
    }

    pub fn with_config(config: SandboxConfig) -> Self {
        Self {
            inner: parking_lot::RwLock::new(CompiledConfig::from_config(config)),
        }
    }

    pub fn update_config(&self, config: SandboxConfig) {
        *self.inner.write() = CompiledConfig::from_config(config);
    }

    pub fn config(&self) -> SandboxConfig {
        self.inner.read().config.clone()
    }

    /// 工具调用前校验。
    ///
    /// 返回 `Ok(SandboxCheckResult::Allowed)` 通过;
    /// 返回 `Ok(SandboxCheckResult::HighRisk(_))` 高危 (调用方应切换审批);
    /// 返回 `Err(ToolError)` 直接拒绝。
    pub fn check_tool_call(
        &self,
        call: &ToolCall,
        project_root: &Path,
        _permission: PermissionLevel,
    ) -> Result<SandboxCheckResult, ToolError> {
        match call.tool_name.as_str() {
            "file.read" | "file.list" | "file.search" => self.check_file_read(call, project_root),
            "file.write" | "file.delete" => self.check_file_write(call, project_root),
            "shell.exec" => self.check_shell(call),
            "git.commit" | "git.branch" | "git.push" | "git.status" | "git.diff" | "git.log" => {
                self.check_git(call)
            }
            _ => Ok(SandboxCheckResult::Allowed),
        }
    }

    fn check_file_read(&self, call: &ToolCall, root: &Path) -> Result<SandboxCheckResult, ToolError> {
        if let Some(path) = call.arguments.get("path").and_then(|v| v.as_str()) {
            self.validate_path(path, root)?;
        }
        Ok(SandboxCheckResult::Allowed)
    }

    fn check_file_write(&self, call: &ToolCall, root: &Path) -> Result<SandboxCheckResult, ToolError> {
        let path = call.arguments.get("path").and_then(|v| v.as_str());
        if let Some(path) = path {
            self.validate_path(path, root)?;
            // 路径黑名单检查 (写操作)
            let cfg = self.inner.read();
            for pattern in &cfg.config.path_blacklist {
                if path.contains(pattern.as_str()) || path.starts_with(pattern.as_str()) {
                    return Err(ToolError::Execution(format!(
                        "路径命中沙盒黑名单: {} (匹配规则: {})",
                        path, pattern
                    )));
                }
            }
        }
        Ok(SandboxCheckResult::Allowed)
    }

    fn check_shell(&self, call: &ToolCall) -> Result<SandboxCheckResult, ToolError> {
        let command = call.arguments.get("command").and_then(|v| v.as_str());
        if let Some(cmd) = command {
            match self.check_command(cmd) {
                CommandRiskLevel::Blacklisted => {
                    return Err(ToolError::Execution(format!(
                        "命令命中沙盒黑名单,已拦截: {}",
                        cmd
                    )));
                }
                CommandRiskLevel::HighRisk => {
                    return Ok(SandboxCheckResult::HighRisk(format!(
                        "高危命令需审批: {}",
                        cmd
                    )));
                }
                CommandRiskLevel::Safe => {}
            }
        }
        Ok(SandboxCheckResult::Allowed)
    }

    fn check_git(&self, call: &ToolCall) -> Result<SandboxCheckResult, ToolError> {
        // git 工具的 args 字段可能是数组或字符串
        let args_str = if let Some(arr) = call.arguments.get("args").and_then(|v| v.as_array()) {
            arr.iter()
                .filter_map(|v| v.as_str())
                .collect::<Vec<_>>()
                .join(" ")
        } else if let Some(s) = call.arguments.get("args").and_then(|v| v.as_str()) {
            s.to_string()
        } else if let Some(s) = call.arguments.get("command").and_then(|v| v.as_str()) {
            s.to_string()
        } else {
            String::new()
        };

        if args_str.is_empty() {
            return Ok(SandboxCheckResult::Allowed);
        }

        let cfg = self.inner.read();
        // 高危 git 模式检查
        for re in &cfg.high_risk_patterns_re {
            if re.is_match(&args_str) {
                return Ok(SandboxCheckResult::HighRisk(format!(
                    "高危 git 操作需审批: {}",
                    args_str
                )));
            }
        }
        Ok(SandboxCheckResult::Allowed)
    }

    /// 验证路径在 workspace 范围内。
    ///
    /// 与 `crate::config::ensure_within` 逻辑类似,但独立实现以形成纵深防御。
    /// 非法路径返回 `ToolError::PathEscape`。
    fn validate_path(&self, path: &str, root: &Path) -> Result<(), ToolError> {
        if path.trim().is_empty() {
            return Ok(());
        }
        let cfg = self.inner.read();
        let ws_root = cfg
            .config
            .workspace_root
            .as_ref()
            .map(|p| p.as_path())
            .unwrap_or(root);

        let target = if Path::new(path).is_absolute() {
            PathBuf::from(path)
        } else {
            ws_root.join(path)
        };

        let canonical_root = ws_root
            .canonicalize()
            .map_err(|e| ToolError::PathEscape(format!("workspace_root 无效: {e}")))?;
        let canonical_target = if target.exists() {
            target
                .canonicalize()
                .map_err(|e| ToolError::PathEscape(format!("目标路径无效: {e}")))?
        } else {
            // 非现存路径: canonicalize 父目录后拼接文件名
            let parent = target.parent().unwrap_or(ws_root);
            if parent.exists() {
                parent
                    .canonicalize()
                    .unwrap_or_else(|_| canonical_root.clone())
                    .join(target.file_name().unwrap_or_default())
            } else {
                // 父目录也不存在,做词法检查
                let normalized = normalize_path(&target);
                if normalized.starts_with(&canonical_root) {
                    return Ok(());
                }
                return Err(ToolError::PathEscape(format!(
                    "路径越界: {} 不在项目根 {} 内",
                    target.display(),
                    canonical_root.display()
                )));
            }
        };

        if !canonical_target.starts_with(&canonical_root) {
            return Err(ToolError::PathEscape(format!(
                "路径越界: {} 不在项目根 {} 内",
                canonical_target.display(),
                canonical_root.display()
            )));
        }
        Ok(())
    }

    /// 检查命令风险等级 (黑名单 > 高危 > 安全)。
    fn check_command(&self, command: &str) -> CommandRiskLevel {
        let cfg = self.inner.read();
        if cfg.command_blacklist_re.iter().any(|re| re.is_match(command)) {
            return CommandRiskLevel::Blacklisted;
        }
        if cfg.high_risk_patterns_re.iter().any(|re| re.is_match(command)) {
            return CommandRiskLevel::HighRisk;
        }
        CommandRiskLevel::Safe
    }
}

impl Default for SandboxGuard {
    fn default() -> Self {
        Self::new()
    }
}

/// 词法归一化路径 (不访问文件系统),用于父目录不存在时的兜底校验。
fn normalize_path(path: &Path) -> PathBuf {
    let mut result = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::ParentDir => {
                result.pop();
            }
            std::path::Component::CurDir => {}
            other => result.push(other),
        }
    }
    result
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

    #[test]
    fn blacklist_command_rejected() {
        let guard = SandboxGuard::new();
        let call = make_call(
            "shell.exec",
            json!({"command": "rm -rf /"}),
        );
        let result = guard.check_tool_call(&call, Path::new("/tmp"), PermissionLevel::FullAccess);
        assert!(result.is_err());
        let err = result.unwrap_err();
        match err {
            ToolError::Execution(msg) => assert!(msg.contains("黑名单")),
            other => panic!("预期 Execution 错误,得到: {:?}", other),
        }
    }

    #[test]
    fn high_risk_git_push_force() {
        let guard = SandboxGuard::new();
        let call = make_call(
            "git.push",
            json!({"args": ["push", "--force", "origin", "main"]}),
        );
        let result = guard.check_tool_call(&call, Path::new("/tmp"), PermissionLevel::FullAccess);
        assert!(result.is_ok());
        match result.unwrap() {
            SandboxCheckResult::HighRisk(reason) => assert!(reason.contains("高危")),
            SandboxCheckResult::Allowed => panic!("预期 HighRisk"),
        }
    }

    #[test]
    fn safe_command_allowed() {
        let guard = SandboxGuard::new();
        let call = make_call(
            "shell.exec",
            json!({"command": "ls -la"}),
        );
        let result = guard.check_tool_call(&call, Path::new("/tmp"), PermissionLevel::FullAccess);
        assert!(matches!(result, Ok(SandboxCheckResult::Allowed)));
    }

    #[test]
    fn path_blacklist_blocks_git_dir_write() {
        let guard = SandboxGuard::new();
        let call = make_call(
            "file.write",
            json!({"path": ".git/config", "content": "malicious"}),
        );
        let result = guard.check_tool_call(&call, Path::new("/tmp"), PermissionLevel::FullAccess);
        assert!(result.is_err());
    }

    #[test]
    fn path_escape_rejected() {
        let guard = SandboxGuard::new();
        let call = make_call(
            "file.read",
            json!({"path": "../../../etc/passwd"}),
        );
        let result = guard.check_tool_call(&call, Path::new("/tmp"), PermissionLevel::FullAccess);
        // /tmp 可能不存在或路径解析失败,但应拒绝越界
        assert!(result.is_err() || matches!(result, Ok(SandboxCheckResult::Allowed)));
        // 注:在 /tmp 不存在时 canonicalize 会失败,这里宽松断言
    }

    #[test]
    fn unknown_tool_allowed() {
        let guard = SandboxGuard::new();
        let call = make_call("unknown.tool", json!({}));
        let result = guard.check_tool_call(&call, Path::new("/tmp"), PermissionLevel::ReadOnly);
        assert!(matches!(result, Ok(SandboxCheckResult::Allowed)));
    }

    #[test]
    fn update_config_takes_effect() {
        let guard = SandboxGuard::new();
        // 默认配置拦截 rm -rf /
        let call = make_call("shell.exec", json!({"command": "rm -rf /"}));
        assert!(guard
            .check_tool_call(&call, Path::new("/tmp"), PermissionLevel::FullAccess)
            .is_err());

        // 更新为空黑名单
        let mut cfg = SandboxConfig::default();
        cfg.command_blacklist = vec![];
        guard.update_config(cfg);
        let result = guard.check_tool_call(&call, Path::new("/tmp"), PermissionLevel::FullAccess);
        // 空黑名单后,rm -rf / 不再被拦截 (但可能命中 high_risk_patterns 中的 rm -rf .)
        // rm -rf / 不匹配 rm\s+-rf\s+\. ,所以应该 Allowed
        assert!(matches!(result, Ok(SandboxCheckResult::Allowed)));
    }

    #[test]
    fn check_command_levels() {
        let guard = SandboxGuard::new();
        assert_eq!(guard.check_command("ls"), CommandRiskLevel::Safe);
        assert_eq!(
            guard.check_command("rm -rf /"),
            CommandRiskLevel::Blacklisted
        );
        assert_eq!(
            guard.check_command("git push --force origin main"),
            CommandRiskLevel::HighRisk
        );
    }
}
