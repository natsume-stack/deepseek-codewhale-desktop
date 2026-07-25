//! 智能任务路由：Reasonix Plan 模式 + DeepSeekAgents 多模型快速切换。
//!
//! 根据需求复杂度自动路由到 V4-Flash（轻量）或 V4-Pro（重度）。
//! Mega 复杂度启用子任务并发，使用 [`tokio::sync::Semaphore`] 限流防 DeepSeek 429。
//!
//! 决策策略：
//! - 命中"解释/说明/是什么/查询/查看"等关键词 → `Light`（V4-Flash）
//! - 命中"重构/实现/添加/修复"等且涉及多文件/多步骤 → `Heavy`（V4-Pro）
//! - 命中"架构设计/完整实现/全部/端到端"等或同时多文件+多步骤 → `Mega`
//!   （V4-Pro + 子任务并发，并发数 3 限流防 429）
//! - 兜底走 `Light`，让 V4-Flash 处理最经济

use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::{Semaphore, SemaphorePermit};

/// 任务复杂度等级。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Complexity {
    /// 轻量查询/代码解释（V4-Flash）。
    Light,
    /// 多文件重构/架构设计（V4-Pro）。
    Heavy,
    /// 大型需求（V4-Pro + 子任务并发）。
    Mega,
}

/// 模型配置档案。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelProfile {
    pub id: String,
    pub name: String,
    pub display_name: String,
    pub description: String,
    pub max_tokens: u32,
    pub supports_reasoning: bool,
}

/// 路由决策结果。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteDecision {
    pub complexity: Complexity,
    /// 推荐模型 id（对应 `ModelProfile::id`）。
    pub recommended_model: String,
    /// 决策原因（人类可读）。
    pub reason: String,
    /// 是否需要拆解 todo。
    pub needs_todo_split: bool,
    /// 子任务并发数（Mega 复杂度时 > 1）。
    pub concurrency: u32,
}

/// 分析用户需求，返回路由决策。
///
/// 关键词命中规则参见模块级文档。`_context` 预留供后续接入会话上下文增强决策。
pub fn route(message: &str, _context: &str) -> RouteDecision {
    let lower = message.to_lowercase();

    // 关键词分组
    let light_kw = ["解释", "说明", "是什么", "什么是", "查询", "查看", "列出", "简介", "看下", "看一下"];
    let heavy_kw = ["重构", "实现", "添加", "修复", "新建", "迁移", "改造", "优化", "调整"];
    let mega_kw = ["架构设计", "完整实现", "全部", "完整", "所有", "端到端", "整体", "全套"];
    let multi_file_kw = ["多文件", "多个文件", "跨文件", "批量"];
    let multi_step_kw = ["分步", "步骤", "多步", "先", "再", "然后", "最后"];

    let has_light = light_kw.iter().any(|k| lower.contains(k));
    let has_heavy = heavy_kw.iter().any(|k| lower.contains(k));
    let has_mega = mega_kw.iter().any(|k| lower.contains(k));
    let has_multi_file = multi_file_kw.iter().any(|k| lower.contains(k));
    let has_multi_step = multi_step_kw.iter().any(|k| lower.contains(k));

    // 是否需要 todo 拆解
    let needs_todo_split = has_mega
        || (has_heavy && (has_multi_file || has_multi_step))
        || lower.contains("全部")
        || lower.contains("所有")
        || lower.contains("完整");

    // 复杂度决策：Mega 优先，其次 Heavy，最后 Light
    let (complexity, concurrency) = if has_mega || (needs_todo_split && has_multi_step && has_multi_file) {
        (Complexity::Mega, 3u32)
    } else if has_heavy && (has_multi_file || has_multi_step || needs_todo_split) {
        (Complexity::Heavy, 1u32)
    } else if has_heavy {
        // 单文件改造类需求
        (Complexity::Heavy, 1u32)
    } else if has_light {
        (Complexity::Light, 1u32)
    } else {
        // 兜底：默认 Light（V4-Flash 处理简单需求最经济）
        (Complexity::Light, 1u32)
    };

    let recommended_model = match complexity {
        Complexity::Light => "flash".to_string(),
        Complexity::Heavy | Complexity::Mega => "pro".to_string(),
    };

    let reason = match complexity {
        Complexity::Light => "轻量查询/代码解释 → V4-Flash".to_string(),
        Complexity::Heavy => "多文件重构/单文件改造 → V4-Pro".to_string(),
        Complexity::Mega => "大型需求 → V4-Pro + 子任务并发（限流 3）".to_string(),
    };

    RouteDecision {
        complexity,
        recommended_model,
        reason,
        needs_todo_split,
        concurrency,
    }
}

/// 内置模型档案列表。
pub fn builtin_profiles() -> Vec<ModelProfile> {
    vec![
        ModelProfile {
            id: "flash".into(),
            name: "deepseek-chat".into(),
            display_name: "V4-Flash".into(),
            description: "轻量快速，适合代码解释和简单查询".into(),
            max_tokens: 8192,
            supports_reasoning: false,
        },
        ModelProfile {
            id: "pro".into(),
            name: "deepseek-reasoner".into(),
            display_name: "V4-Pro".into(),
            description: "深度推理，适合多文件重构和架构设计".into(),
            max_tokens: 65536,
            supports_reasoning: true,
        },
    ]
}

/// 子任务并发限流器（防 DeepSeek 429）。
///
/// 基于 [`tokio::sync::Semaphore`] 实现，`acquire` 返回的 `SemaphorePermit`
/// 释放时自动归还配额。Mega 复杂度场景下默认 `max=3`。
pub struct ConcurrencyLimiter {
    max: u32,
    current: Arc<Semaphore>,
}

impl ConcurrencyLimiter {
    pub fn new(max: u32) -> Self {
        Self {
            max,
            current: Arc::new(Semaphore::new(max.max(1) as usize)),
        }
    }

    /// 获取一个并发许可，持有的 permit 释放时自动归还配额。
    pub async fn acquire(&self) -> AppResult<SemaphorePermit<'_>> {
        self.current
            .acquire()
            .await
            .map_err(|e| AppError::Internal(anyhow::anyhow!("Semaphore acquire 失败: {e}")))
    }

    /// 返回限流上限。
    pub fn max(&self) -> u32 {
        self.max
    }

    /// 返回当前可用配额（仅用于监控，不保证并发安全精确）。
    pub fn available_permits(&self) -> usize {
        self.current.available_permits()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn light_query_routes_to_flash() {
        let d = route("解释一下这段代码做什么", "");
        assert_eq!(d.complexity, Complexity::Light);
        assert_eq!(d.recommended_model, "flash");
        assert!(!d.needs_todo_split);
    }

    #[test]
    fn heavy_refactor_routes_to_pro() {
        let d = route("请重构这个函数，添加错误处理", "");
        assert_eq!(d.complexity, Complexity::Heavy);
        assert_eq!(d.recommended_model, "pro");
    }

    #[test]
    fn mega_full_implementation_routes_to_pro_with_concurrency() {
        let d = route("完整实现用户系统，包含注册登录权限，分步骤先做后端再做前端", "");
        assert_eq!(d.complexity, Complexity::Mega);
        assert_eq!(d.recommended_model, "pro");
        assert_eq!(d.concurrency, 3);
        assert!(d.needs_todo_split);
    }

    #[test]
    fn fallback_is_light() {
        let d = route("hello world", "");
        assert_eq!(d.complexity, Complexity::Light);
    }

    #[tokio::test]
    async fn limiter_blocks_at_max() {
        let limiter = ConcurrencyLimiter::new(2);
        let _p1 = limiter.acquire().await.unwrap();
        let _p2 = limiter.acquire().await.unwrap();
        // 第三个应当等待，超时验证
        let try3 =
            tokio::time::timeout(std::time::Duration::from_millis(50), limiter.acquire()).await;
        assert!(try3.is_err(), "第三个 acquire 应当被阻塞");
    }
}
