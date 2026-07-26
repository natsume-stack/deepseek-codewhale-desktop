//! 配置模块: 加载、运行时修改、DeepSeek API Key 持久化。
//!
//! 优先级: config.toml 文件 > 环境变量 > 内置默认值。
//! DeepSeek Key 通过 `PUT /api/config/deepseek` 写入后会落盘到 config.toml。

use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
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
    // === P2 新增配置 ===
    /// 多模型多凭证配置（P2 模型&API 卡片）。
    #[serde(default)]
    pub model_profiles: ModelProfilesConfig,
    /// RAG 检索配置（P2 RAG 卡片）。
    #[serde(default)]
    pub rag: RagConfig,
    /// 格式化配置（P2 格式化卡片）。
    #[serde(default)]
    pub formatter: FormatterConfig,
    /// 缓存调试配置（P2 缓存卡片）。
    #[serde(default)]
    pub cache_debug: CacheDebugConfig,
    /// 外观主题配置（P2 外观卡片）。
    #[serde(default)]
    pub appearance: AppearanceConfig,
    /// 快捷键配置（P2 快捷键卡片）。
    #[serde(default)]
    pub shortcuts: ShortcutsConfig,
    /// 通用安全配置（P2 安全卡片）。
    #[serde(default)]
    pub security: SecurityConfig,
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
    /// 上下文 Token 预算。0 表示仅发送当前消息，最大 1,000,000。
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
                context_length: 32_768,
            },
            permission: PermissionConfig::default(),
            model_profiles: ModelProfilesConfig::default(),
            rag: RagConfig::default(),
            formatter: FormatterConfig::default(),
            cache_debug: CacheDebugConfig::default(),
            appearance: AppearanceConfig::default(),
            shortcuts: ShortcutsConfig::default(),
            security: SecurityConfig::default(),
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
        // 自动规范化 base_url（修复用户遗漏 /v1 后缀导致 502 的问题）
        let fixed = cfg.normalize_deepseek_urls();
        if fixed {
            tracing::info!("DeepSeek base_url 已自动规范化，将落盘更新");
            let _ = cfg.save();
        }
        Ok(cfg)
    }

    /// 规范化 DeepSeek base_url：确保以 /v1 结尾（仅对 DeepSeek 官方域名生效）。
    /// 同时修正 model_profiles 中相同问题的 profile。
    /// 返回 true 表示有字段被修正（需落盘）。
    pub fn normalize_deepseek_urls(&mut self) -> bool {
        let mut changed = false;
        // 修正主配置
        let fixed_main = normalize_base_url(&self.deepseek.base_url);
        if fixed_main != self.deepseek.base_url {
            tracing::warn!(
                "base_url 自动修正: {} -> {}",
                self.deepseek.base_url,
                fixed_main
            );
            self.deepseek.base_url = fixed_main;
            changed = true;
        }
        // 修正 model_profiles
        for p in &mut self.model_profiles.profiles {
            let fixed = normalize_base_url(&p.base_url);
            if fixed != p.base_url {
                tracing::warn!(
                    "profile {} base_url 自动修正: {} -> {}",
                    p.id,
                    p.base_url,
                    fixed
                );
                p.base_url = fixed;
                changed = true;
            }
        }
        changed
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
        self.normalize_deepseek_urls();
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

pub(crate) fn mask_key(k: &str) -> String {
    let len = k.chars().count();
    if len <= 8 {
        return "*".repeat(len.max(1));
    }
    let head: String = k.chars().take(3).collect();
    let tail: String = k.chars().skip(len.saturating_sub(4)).collect();
    let masked = "*".repeat(len - 7);
    format!("{head}{masked}{tail}")
}

/// 规范化 DeepSeek 兼容 API 的 base_url：
/// - 去除尾部斜杠
/// - 若指向 DeepSeek 官方域名但缺少 `/v1` 后缀，自动追加
/// - 对 OpenRouter / Volcengine / 自建网关等其他域名不强制追加
pub fn normalize_base_url(url: &str) -> String {
    let trimmed = url.trim_end_matches('/');
    if trimmed.is_empty() {
        return String::new();
    }
    // 已含 /v1（或 /v2 等版本段）则跳过
    if trimmed.ends_with("/v1") || trimmed.ends_with("/v2") {
        return trimmed.to_string();
    }
    // 仅对 DeepSeek 官方域名自动补 /v1
    if trimmed.contains("api.deepseek.com") {
        format!("{trimmed}/v1")
    } else {
        trimmed.to_string()
    }
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

/* ============================================================
 * P2 完整设置页面后端配置结构体
 * ============================================================ */

/// 多模型多凭证配置（P2 模型&API 卡片）。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ModelProfilesConfig {
    /// 多套 API 凭证。
    pub profiles: Vec<ApiProfile>,
    /// 当前激活的 profile id。
    pub active_profile_id: Option<String>,
}

/// 单套 API 凭证。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiProfile {
    pub id: String,
    /// 显示名称，如 "DeepSeek 主账号"。
    pub name: String,
    /// 服务商: "deepseek" | "openrouter" | "mimo" | "volcengine"。
    pub provider: String,
    /// 脱敏后的 key（sk-****xxxx）。
    pub api_key_masked: String,
    /// 加密后的 key（简化: base64）。
    pub api_key_encrypted: Option<String>,
    pub base_url: String,
    pub model: String,
    /// 展示名: "V4-Flash" / "V4-Pro"。
    pub display_name: String,
    /// 是否支持 reasoning。
    pub supports_reasoning: bool,
    pub max_tokens: u32,
}

/// RAG 检索配置（P2 RAG 卡片）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RagConfig {
    pub enabled: bool,
    /// 分块大小（默认 500 行）。
    pub chunk_size: usize,
    /// 召回上限。
    pub max_tokens: usize,
    /// 召回权重 0.0-1.0。
    pub recall_weight: f64,
    /// 自定义过滤规则。
    pub file_filter: Vec<String>,
    pub auto_index: bool,
}

impl Default for RagConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            chunk_size: 500,
            max_tokens: 8000,
            recall_weight: 0.7,
            file_filter: vec![],
            auto_index: false,
        }
    }
}

/// 格式化配置（P2 格式化卡片）。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FormatterConfig {
    pub rust_enabled: bool,
    pub go_enabled: bool,
    pub python_enabled: bool,
    pub typescript_enabled: bool,
    pub format_on_save: bool,
    /// language -> command。
    pub custom_commands: HashMap<String, String>,
}

/// 缓存调试配置（P2 缓存卡片）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheDebugConfig {
    pub fingerprint_check: bool,
    /// 单文件挂载上限，默认 51200 (50KB)。
    pub mount_size_threshold: usize,
    /// 历史对话自动压缩阈值。
    pub auto_compress_threshold: usize,
}

impl Default for CacheDebugConfig {
    fn default() -> Self {
        Self {
            fingerprint_check: true,
            mount_size_threshold: 51200,
            auto_compress_threshold: 100,
        }
    }
}

/// 外观主题配置（P2 外观卡片）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppearanceConfig {
    pub mica_enabled: bool,
    /// "dark" | "light"。
    pub theme: String,
    /// 全局圆角。
    pub corner_radius: u32,
    pub animation_duration_ms: u32,
    /// "github-dark" | "dracula" | ...
    pub code_highlight_theme: String,
}

impl Default for AppearanceConfig {
    fn default() -> Self {
        Self {
            mica_enabled: true,
            theme: "dark".into(),
            corner_radius: 8,
            animation_duration_ms: 200,
            code_highlight_theme: "github-dark".into(),
        }
    }
}

/// 快捷键配置（P2 快捷键卡片）。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutsConfig {
    /// action -> shortcut, e.g. "send-message" -> "Enter"。
    pub bindings: HashMap<String, String>,
}

/// 通用安全配置（P2 安全卡片）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecurityConfig {
    /// 默认 300 (5分钟)。
    pub approval_timeout_secs: u64,
    /// 危险命令黑名单。
    pub shell_blacklist: Vec<String>,
    /// 会话过期时长。
    pub session_expire_hours: u64,
    pub audit_log_path: Option<String>,
}

impl Default for SecurityConfig {
    fn default() -> Self {
        Self {
            approval_timeout_secs: 300,
            shell_blacklist: vec!["rm -rf /".into(), "format".into(), "del /f /s /q".into()],
            session_expire_hours: 168, // 7 天
            audit_log_path: None,
        }
    }
}
