//! 配置模块: 加载、运行时修改、DeepSeek API Key 持久化。
//!
//! 优先级: config.toml 文件 > 环境变量 > 内置默认值。
//! DeepSeek Key 通过 `PUT /api/config/deepseek` 写入后会落盘到 config.toml。

use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

/// 应用配置根。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    pub server: ServerConfig,
    pub deepseek: DeepSeekConfig,
    pub inference: InferenceDefaults,
    /// Agent 权限等级（P0-8 三级权限沙盒）。
    #[serde(default)]
    pub permission: PermissionConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerConfig {
    pub host: String,
    pub port: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeepSeekConfig {
    pub api_key: String,
    pub base_url: String,
    pub model: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InferenceDefaults {
    pub reasoning_effort: ReasoningEffort,
    pub cache_enabled: bool,
    /// 上下文窗口: 保留最近 N 条历史消息 (含 user/assistant)。
    pub context_length: usize,
}

/// 推理强度。DeepSeek 实际通过模型选择 (deepseek-chat / deepseek-reasoner) 体现,
/// 该字段会作为 `reasoning_effort` 透传给 API, 由后端模型决定是否消费。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ReasoningEffort {
    Minimal,
    Low,
    Medium,
    High,
}

/// Agent 权限等级（P0-8 三级权限沙盒）。
///
/// - `ReadOnly`：仅读取工作区，拒绝所有写操作与 Shell 执行
/// - `WorkspaceWrite`：允许读写工作区文件，拒绝 Shell 执行（默认）
/// - `FullAccess`：允许读写文件 + Shell 执行（高危，需二次确认）
///
/// 优先级规则：deny > write > read。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PermissionLevel {
    ReadOnly,
    WorkspaceWrite,
    FullAccess,
}

impl Default for PermissionLevel {
    fn default() -> Self {
        Self::WorkspaceWrite
    }
}

impl PermissionLevel {
    /// 是否允许写文件。
    pub fn can_write(self) -> bool {
        matches!(self, Self::WorkspaceWrite | Self::FullAccess)
    }

    /// 是否允许执行 Shell 命令。
    pub fn can_shell(self) -> bool {
        matches!(self, Self::FullAccess)
    }
}

/// 权限配置（P0-8）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionConfig {
    /// 当前权限等级。
    #[serde(default)]
    pub level: PermissionLevel,
    /// 是否在 Agent 发起写操作时弹出审批弹窗（true=需手动批准，false=自动批准）。
    #[serde(default = "default_approval_on_write")]
    pub approval_on_write: bool,
    /// 是否在 Agent 发起 Shell 命令时弹出审批弹窗。
    #[serde(default = "default_approval_on_shell")]
    pub approval_on_shell: bool,
}

fn default_approval_on_write() -> bool {
    true
}
fn default_approval_on_shell() -> bool {
    true
}

impl Default for PermissionConfig {
    fn default() -> Self {
        Self {
            level: PermissionLevel::default(),
            approval_on_write: true,
            approval_on_shell: true,
        }
    }
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            server: ServerConfig {
                host: "127.0.0.1".to_string(),
                port: 8787,
            },
            deepseek: DeepSeekConfig {
                api_key: String::new(),
                base_url: "https://api.deepseek.com/v1".to_string(),
                model: "deepseek-chat".to_string(),
            },
            inference: InferenceDefaults {
                reasoning_effort: ReasoningEffort::Medium,
                cache_enabled: true,
                context_length: 20,
            },
            permission: PermissionConfig::default(),
        }
    }
}

impl AppConfig {
    /// 配置文件路径: `~/.codewhale-server/config.toml`
    pub fn config_path() -> AppResult<PathBuf> {
        let dir = dirs::config_dir()
            .or_else(dirs::home_dir)
            .ok_or_else(|| AppError::Config("无法定位用户配置目录".into()))?;
        Ok(dir.join("codewhale-server").join("config.toml"))
    }

    /// 加载配置: 文件覆盖默认值, 环境变量覆盖文件。
    pub fn load_or_init() -> AppResult<Self> {
        let mut cfg = Self::default();

        let path = Self::config_path()?;
        if path.exists() {
            let text = fs::read_to_string(&path)
                .map_err(|e| AppError::Config(format!("读取 {} 失败: {e}", path.display())))?;
            if !text.trim().is_empty() {
                let file_cfg: AppConfig = toml::from_str(&text).map_err(|e| {
                    AppError::Config(format!("解析 {} 失败: {e}", path.display()))
                })?;
                cfg = file_cfg;
            }
        }

        cfg.apply_env()?;
        Ok(cfg)
    }

    /// 应用环境变量覆盖。
    fn apply_env(&mut self) -> AppResult<()> {
        if let Ok(v) = std::env::var("CODEWHALE_SERVER__HOST") {
            self.server.host = v;
        }
        if let Ok(v) = std::env::var("CODEWHALE_SERVER__PORT") {
            if let Ok(p) = v.parse() {
                self.server.port = p;
            }
        }
        if let Ok(v) = std::env::var("CODEWHALE_DEEPSEEK__API_KEY") {
            self.deepseek.api_key = v;
        }
        if let Ok(v) = std::env::var("CODEWHALE_DEEPSEEK__BASE_URL") {
            self.deepseek.base_url = v;
        }
        if let Ok(v) = std::env::var("CODEWHALE_DEEPSEEK__MODEL") {
            self.deepseek.model = v;
        }
        if let Ok(v) = std::env::var("CODEWHALE_INFERENCE__REASONING_EFFORT") {
            match v.to_lowercase().as_str() {
                "minimal" => self.inference.reasoning_effort = ReasoningEffort::Minimal,
                "low" => self.inference.reasoning_effort = ReasoningEffort::Low,
                "medium" => self.inference.reasoning_effort = ReasoningEffort::Medium,
                "high" => self.inference.reasoning_effort = ReasoningEffort::High,
                _ => {}
            }
        }
        if let Ok(v) = std::env::var("CODEWHALE_INFERENCE__CACHE_ENABLED") {
            self.inference.cache_enabled = matches!(v.to_lowercase().as_str(), "1" | "true" | "yes");
        }
        if let Ok(v) = std::env::var("CODEWHALE_INFERENCE__CONTEXT_LENGTH") {
            if let Ok(n) = v.parse() {
                self.inference.context_length = n;
            }
        }
        Ok(())
    }

    /// 持久化到 config.toml (用于 API Key 落盘)。
    pub fn save(&self) -> AppResult<()> {
        let path = Self::config_path()?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let text =
            toml::to_string_pretty(self).map_err(|e| AppError::Config(format!("序列化失败: {e}")))?;
        let mut file = fs::File::create(&path)?;
        file.write_all(text.as_bytes())?;
        tracing::info!("配置已写入 {}", path.display());
        Ok(())
    }

    /// 仅更新 DeepSeek 配置并落盘。
    pub fn update_deepseek(&mut self, api_key: Option<String>, base_url: Option<String>, model: Option<String>) -> AppResult<()> {
        if let Some(k) = api_key {
            self.deepseek.api_key = k;
        }
        if let Some(u) = base_url {
            self.deepseek.base_url = u;
        }
        if let Some(m) = model {
            self.deepseek.model = m;
        }
        self.save()
    }

    /// Key 脱敏展示: 保留前3后4。
    pub fn masked_key(&self) -> String {
        mask_key(&self.deepseek.api_key)
    }

    pub fn is_configured(&self) -> bool {
        !self.deepseek.api_key.trim().is_empty()
    }
}

fn mask_key(k: &str) -> String {
    let len = k.chars().count();
    if len <= 8 {
        return "*".repeat(len.max(1));
    }
    let head: String = k.chars().take(3).collect();
    let tail: String = k.chars().skip(len.saturating_sub(4)).collect();
    let masked = "*".repeat(len - 7);
    format!("{head}{masked}{tail}")
}

/// 用于校验路径是否在允许的项目根目录下 (防止越权读写)。
pub fn ensure_within(root: &Path, target: &Path) -> AppResult<PathBuf> {
    let canonical_root = root.canonicalize().map_err(|e| {
        AppError::BadRequest(format!("项目根目录无效: {}: {e}", root.display()))
    })?;
    let canonical_target = target.canonicalize().map_err(|e| {
        AppError::BadRequest(format!("目标路径无效: {}: {e}", target.display()))
    })?;
    if !canonical_target.starts_with(&canonical_root) {
        return Err(AppError::BadRequest(format!(
            "路径越界: {} 不在项目根 {} 内",
            canonical_target.display(),
            canonical_root.display()
        )));
    }
    Ok(canonical_target)
}

/// 工作区上下文自动忽略的目录（P0-4）。
///
/// 文件树遍历、@文件挂载选择器、Agent 工具读取均过滤这些目录。
/// 与 `files.rs` 内的本地常量保持一致，这里作为全局公开常量供其它模块复用。
pub const IGNORED_DIRS: &[&str] = &[
    ".git",
    ".svn",
    ".hg",
    "node_modules",
    "target",
    "bin",
    "obj",
    ".vs",
    ".vscode",
    ".idea",
    "__pycache__",
    ".DS_Store",
    "dist",
    "build",
    ".codewhale",
];

/// 判断给定目录名是否应被忽略（P0-4）。
pub fn is_ignored_dir(name: &str) -> bool {
    IGNORED_DIRS.contains(&name)
}
