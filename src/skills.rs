//! Skill 技能生态（P0）：注册表 + SKILL.md 解析 + 模糊匹配 + 内置 17 项标准 Skill。
//!
//! 设计原则：
//!   - 元信息（SkillMeta）精简、可批量序列化，常驻第一层缓存清单（总字符 ≤ 8000）。
//!   - 完整定义（SkillDefinition）仅在 `skill_find` 命中时临时加载至第五层，
//!     以 `# 临时技能上下文` 标签拼接到 system_prefix 末尾，**不修改第一层固定缓存**。
//!   - 模糊匹配基于关键词命中加权（triggers 0.5 / name 0.3 / description 0.2），
//!     归一化到 [0.0, 1.0]，阈值 0.3 以下不返回。
//!
//! 与 Reasonix 缓存层的边界：
//!   - SkillStore 是上层业务扩展，绝不修改 cache.rs / session.rs 的字节稳定前缀逻辑。
//!   - 临时技能上下文注入由 chat.rs 在 message_snapshot 后追加到 system 消息尾部，
//!     属本轮临时拼接，下一轮自动失效。

use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

/* ============================================================
 * 数据结构
 * ============================================================ */

/// Skill 元信息（存入第一层缓存精简清单，总字符上限 8000）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillMeta {
    /// 唯一标识：code-review, tdd-gen, ...
    pub id: String,
    /// 展示名称：代码评审
    pub name: String,
    /// 简短触发描述（≤100 字符）
    pub description: String,
    /// 触发关键词：["评审","review","code review"]
    pub triggers: Vec<String>,
    /// 分类：review/test/git/refactor/bug/init/lint
    pub category: String,
    /// 语义版本：1.0.0
    pub version: String,
    /// 是否启用
    pub enabled: bool,
    /// 内置 vs 自定义
    pub builtin: bool,
}

/// 单步执行流程。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillStep {
    /// 步骤序号（从 1 开始）。
    pub order: usize,
    /// 步骤说明（自然语言）。
    pub description: String,
    /// 动作类型：analyze/generate/hunk/test/git/commit/lint/init。
    pub action: String,
    /// 关联代办文本（可选，命中时由 chat.rs 推送到 todos）。
    pub todo_text: Option<String>,
}

/// Skill 完整定义（SKILL.md 解析结果，仅在匹配时临时加载至第五层）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillDefinition {
    pub meta: SkillMeta,
    /// 执行流程（Markdown 步骤）。
    pub steps: Vec<SkillStep>,
    /// 所需工具/插件：["read_file","write_file","shell","git"]。
    pub required_tools: Vec<String>,
    /// 默认权限等级：ReadOnly / WorkspaceWrite / FullAccess。
    pub default_permission: String,
    /// 完整 SKILL.md 原文（用于临时注入第五层）。
    pub raw_markdown: String,
}

/// 模糊匹配结果。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillMatch {
    pub skill_id: String,
    pub skill_name: String,
    /// 命中分数 [0.0, 1.0]。
    pub score: f64,
    /// 命中的关键词集合。
    pub matched_keywords: Vec<String>,
}

/* ============================================================
 * Skill 注册表
 * ============================================================ */

/// Skill 注册表：metas 常驻、definitions 懒加载。
#[derive(Clone, Default)]
pub struct SkillStore {
    metas: Arc<RwLock<HashMap<String, SkillMeta>>>,
    definitions: Arc<RwLock<HashMap<String, SkillDefinition>>>,
}

impl SkillStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// 初始化内置 17 项标准 Skill（幂等，重复调用安全）。
    pub async fn init_builtin(&self) {
        let builtin = builtin_skills();
        let mut metas = self.metas.write().await;
        let mut defs = self.definitions.write().await;
        for def in builtin {
            metas.insert(def.meta.id.clone(), def.meta.clone());
            defs.insert(def.meta.id.clone(), def);
        }
    }

    /// 注册自定义 Skill（从 SKILL.md 解析）。id 冲突时返回错误。
    pub async fn register(&self, def: SkillDefinition) -> AppResult<()> {
        let id = def.meta.id.clone();
        let mut metas = self.metas.write().await;
        if metas.contains_key(&id) {
            return Err(AppError::BadRequest(format!("Skill 已存在: {id}")));
        }
        metas.insert(id.clone(), def.meta.clone());
        self.definitions.write().await.insert(id, def);
        Ok(())
    }

    /// 卸载 Skill（内置 Skill 不可卸载）。
    pub async fn unregister(&self, id: &str) -> AppResult<()> {
        let mut metas = self.metas.write().await;
        let is_builtin = metas.get(id).map(|m| m.builtin).unwrap_or(false);
        if is_builtin {
            return Err(AppError::BadRequest(format!("内置 Skill 不可删除: {id}")));
        }
        metas.remove(id);
        self.definitions.write().await.remove(id);
        Ok(())
    }

    /// 启用/禁用 Skill。
    pub async fn set_enabled(&self, id: &str, enabled: bool) -> AppResult<()> {
        let mut metas = self.metas.write().await;
        let m = metas
            .get_mut(id)
            .ok_or_else(|| AppError::BadRequest(format!("Skill 不存在: {id}")))?;
        m.enabled = enabled;
        // 同步 definitions 中的 meta
        if let Some(def) = self.definitions.write().await.get_mut(id) {
            def.meta.enabled = enabled;
        }
        Ok(())
    }

    /// 列出所有元信息（精简清单，用于第一层缓存）。
    pub async fn list_metas(&self) -> Vec<SkillMeta> {
        let mut v: Vec<SkillMeta> = self.metas.read().await.values().cloned().collect();
        v.sort_by(|a, b| a.category.cmp(&b.category).then_with(|| a.id.cmp(&b.id)));
        v
    }

    /// 获取完整定义（临时加载至第五层）。
    pub async fn get_definition(&self, id: &str) -> Option<SkillDefinition> {
        self.definitions.read().await.get(id).cloned()
    }

    /// skill_find 模糊匹配：根据用户消息返回匹配的 Skill 列表（按分数降序）。
    ///
    /// 算法：
    ///   - triggers 关键词命中：+0.5/词
    ///   - name 命中：+0.3
    ///   - description 命中：+0.2
    ///   - 总分归一化到 [0.0, 1.0]（cap 1.0）
    ///   - 阈值 < 0.3 不返回
    ///   - 仅匹配 enabled = true 的 Skill
    pub async fn find(&self, message: &str) -> Vec<SkillMatch> {
        let msg_lower = message.to_lowercase();
        let metas = self.metas.read().await;
        let mut out: Vec<SkillMatch> = metas
            .values()
            .filter(|m| m.enabled)
            .filter_map(|m| {
                let mut score: f64 = 0.0;
                let mut matched: Vec<String> = Vec::new();
                for t in &m.triggers {
                    if !t.is_empty() && msg_lower.contains(&t.to_lowercase()) {
                        score += 0.5;
                        matched.push(t.clone());
                    }
                }
                if !m.name.is_empty() && msg_lower.contains(&m.name.to_lowercase()) {
                    score += 0.3;
                    matched.push(m.name.clone());
                }
                if !m.description.is_empty() && msg_lower.contains(&m.description.to_lowercase()) {
                    score += 0.2;
                    matched.push(m.description.clone());
                }
                if score < 0.3 || matched.is_empty() {
                    return None;
                }
                let score = score.min(1.0);
                Some(SkillMatch {
                    skill_id: m.id.clone(),
                    skill_name: m.name.clone(),
                    score,
                    matched_keywords: matched,
                })
            })
            .collect();
        out.sort_by(|a, b| {
            b.score
                .partial_cmp(&a.score)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        out
    }

    /// 生成第一层缓存的 Skill 精简清单（名称+描述，总字符 ≤ 8000）。
    pub async fn build_cache_summary(&self) -> String {
        let metas = self.metas.read().await;
        let mut sorted: Vec<&SkillMeta> = metas.values().collect();
        sorted.sort_by(|a, b| a.id.cmp(&b.id));
        let mut out = String::from("# Available Skills\n");
        const MAX: usize = 8000;
        for m in sorted {
            if !m.enabled {
                continue;
            }
            let line = format!("- {}: {}\n", m.id, m.description);
            if out.len() + line.len() > MAX {
                break;
            }
            out.push_str(&line);
        }
        out
    }
}

/* ============================================================
 * SKILL.md 解析器
 * ============================================================ */

/// 解析 SKILL.md 内容为 SkillDefinition。
///
/// 简化格式：
/// ```text
/// ---
/// id: code-review
/// name: 代码评审
/// description: 全项目规范、性能、安全漏洞评审
/// triggers: review,评审,code review
/// category: review
/// version: 1.0.0
/// default_permission: WorkspaceWrite
/// required_tools: read_file,git
/// ---
/// # Steps
/// 1. [analyze] 扫描项目结构
/// 2. [analyze] 检查规范
/// 3. [generate] 输出评审报告
/// ```
///
/// - frontmatter 使用简易 `key: value` 解析（不引入新依赖）。
/// - triggers / required_tools 以英文逗号分隔。
/// - 步骤行格式：`<数字>. [action] description`，todo 文本可用 `=> todo 文本` 追加。
pub fn parse_skill_md(content: &str) -> AppResult<SkillDefinition> {
    let raw = content.to_string();
    let (frontmatter, body) = split_frontmatter(content);

    let mut id = String::new();
    let mut name = String::new();
    let mut description = String::new();
    let mut triggers: Vec<String> = Vec::new();
    let mut category = String::from("custom");
    let mut version = String::from("1.0.0");
    let mut default_permission = String::from("WorkspaceWrite");
    let mut required_tools: Vec<String> = Vec::new();

    for line in frontmatter.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let (k, v) = match line.split_once(':') {
            Some((k, v)) => (k.trim(), v.trim()),
            None => continue,
        };
        match k {
            "id" => id = v.to_string(),
            "name" => name = v.to_string(),
            "description" => description = v.to_string(),
            "triggers" => {
                triggers = v
                    .split(',')
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect();
            }
            "category" => category = v.to_string(),
            "version" => version = v.to_string(),
            "default_permission" => default_permission = v.to_string(),
            "required_tools" => {
                required_tools = v
                    .split(',')
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect();
            }
            _ => {}
        }
    }

    if id.is_empty() {
        return Err(AppError::BadRequest("SKILL.md 缺少 id 字段".into()));
    }
    if name.is_empty() {
        name = id.clone();
    }

    let steps = parse_steps(&body);

    Ok(SkillDefinition {
        meta: SkillMeta {
            id,
            name,
            description,
            triggers,
            category,
            version,
            enabled: true,
            builtin: false,
        },
        steps,
        required_tools,
        default_permission,
        raw_markdown: raw,
    })
}

/// 拆分 frontmatter（--- ... ---）与正文，未带 frontmatter 时整体视作正文。
fn split_frontmatter(content: &str) -> (String, String) {
    let trimmed = content.trim_start();
    if !trimmed.starts_with("---") {
        return (String::new(), content.to_string());
    }
    // 跳过首行 `---`
    let after_open = trimmed.trim_start_matches("---");
    let end = match after_open.find("\n---") {
        Some(i) => i,
        None => return (String::new(), content.to_string()),
    };
    let frontmatter = after_open[..end].trim().to_string();
    // 跳过结束 `---` 及其后的换行
    let rest = &after_open[end + "\n---".len()..];
    let body = rest.trim_start_matches(['\n', '\r']).to_string();
    (frontmatter, body)
}

/// 解析正文中的步骤行：`<数字>. [action] description [=> todo]`。
fn parse_steps(body: &str) -> Vec<SkillStep> {
    let mut steps = Vec::new();
    for line in body.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        // 必须以 `数字.` 开头
        let after_num = match line.find('.') {
            Some(i) if i > 0 => &line[i + 1..],
            _ => continue,
        };
        let prefix = &line[..line.find('.').unwrap()];
        let order: usize = match prefix.trim().parse() {
            Ok(n) => n,
            Err(_) => continue,
        };
        let rest = after_num.trim();
        // 解析 [action]
        let (action, desc_part) = if let Some(open) = rest.find('[') {
            if let Some(close) = rest[open..].find(']') {
                let action = rest[open + 1..open + close].trim().to_string();
                let desc = rest[open + close + 1..].trim().to_string();
                (action, desc)
            } else {
                ("analyze".to_string(), rest.to_string())
            }
        } else {
            ("analyze".to_string(), rest.to_string())
        };
        // 解析 `=> todo 文本`
        let (description, todo_text) = if let Some(i) = desc_part.find("=>") {
            let desc = desc_part[..i].trim().to_string();
            let todo = desc_part[i + 2..].trim().to_string();
            (desc, if todo.is_empty() { None } else { Some(todo) })
        } else {
            (desc_part, None)
        };
        steps.push(SkillStep {
            order,
            description,
            action,
            todo_text,
        });
    }
    steps
}

/* ============================================================
 * 内置 17 项标准 Skill
 * ============================================================ */

fn builtin_skills() -> Vec<SkillDefinition> {
    vec![
        build_skill(
            "code-review",
            "代码评审",
            "全项目规范、性能、安全漏洞评审",
            vec![
                "review".into(),
                "评审".into(),
                "code review".into(),
                "代码评审".into(),
            ],
            "review",
            "WorkspaceWrite",
            vec!["read_file".into(), "git".into()],
            vec![
                step(
                    1,
                    "analyze",
                    "扫描项目结构，识别模块边界与依赖",
                    Some("扫描项目结构"),
                ),
                step(
                    2,
                    "analyze",
                    "检查代码规范（命名、注释、风格）",
                    Some("检查代码规范"),
                ),
                step(
                    3,
                    "analyze",
                    "检查性能热点与潜在 N+1/重复计算",
                    Some("检查性能问题"),
                ),
                step(
                    4,
                    "analyze",
                    "检查安全漏洞（注入、越权、敏感信息泄漏）",
                    Some("检查安全漏洞"),
                ),
                step(5, "generate", "输出结构化评审报告", None),
            ],
            r#"---
id: code-review
name: 代码评审
description: 全项目规范、性能、安全漏洞评审
triggers: review,评审,code review,代码评审
category: review
version: 1.0.0
default_permission: WorkspaceWrite
required_tools: read_file,git
---
# 代码评审 Skill

## 执行步骤
1. [analyze] 扫描项目结构，识别模块边界与依赖
2. [analyze] 检查代码规范（命名、注释、风格）
3. [analyze] 检查性能热点与潜在 N+1/重复计算
4. [analyze] 检查安全漏洞（注入、越权、敏感信息泄漏）
5. [generate] 输出结构化评审报告（按严重程度分级）

## 输出规范
- 评审报告必须包含：发现项 / 严重程度 / 建议修改 / 修改 Hunk（可选）
- 严重程度：critical / warning / info
"#,
        ),
        build_skill(
            "tdd-gen",
            "测试生成",
            "自动生成单元/集成测试用例",
            vec![
                "test".into(),
                "测试".into(),
                "tdd".into(),
                "unit test".into(),
                "单元测试".into(),
            ],
            "test",
            "WorkspaceWrite",
            vec!["read_file".into(), "write_file".into(), "shell".into()],
            vec![
                step(
                    1,
                    "analyze",
                    "分析目标函数/模块的输入输出与边界",
                    Some("分析目标函数"),
                ),
                step(
                    2,
                    "generate",
                    "生成测试用例（正常/边界/异常）",
                    Some("生成测试用例"),
                ),
                step(
                    3,
                    "test",
                    "沙箱执行校验，捕获失败并迭代",
                    Some("沙箱执行校验"),
                ),
                step(4, "hunk", "输出最终测试文件 Hunk", None),
            ],
            r#"---
id: tdd-gen
name: 测试生成
description: 自动生成单元/集成测试用例
triggers: test,测试,tdd,unit test,单元测试
category: test
version: 1.0.0
default_permission: WorkspaceWrite
required_tools: read_file,write_file,shell
---
# 测试生成 Skill

## 执行步骤
1. [analyze] 分析目标函数/模块的输入输出与边界
2. [generate] 生成测试用例（正常/边界/异常路径）
3. [test] 沙箱执行校验，捕获失败并迭代
4. [hunk] 输出最终测试文件 Hunk

## 输出规范
- 测试文件路径必须以原文件 + _test 后缀
- 覆盖率目标：核心逻辑 ≥ 80%
"#,
        ),
        build_skill(
            "git-workflow",
            "Git 工作流",
            "Conventional Commit、PR 评审、分支管理",
            vec![
                "commit".into(),
                "提交".into(),
                "pr".into(),
                "pull request".into(),
                "分支".into(),
            ],
            "git",
            "FullAccess",
            vec!["git".into(), "shell".into()],
            vec![
                step(
                    1,
                    "analyze",
                    "读取 git status 与 diff 摘要",
                    Some("读取 git 状态"),
                ),
                step(
                    2,
                    "generate",
                    "按 Conventional Commit 生成 message",
                    Some("生成 commit message"),
                ),
                step(3, "commit", "走审批队列，确认后提交", Some("提交审批")),
            ],
            r#"---
id: git-workflow
name: Git 工作流
description: Conventional Commit、PR 评审、分支管理
triggers: commit,提交,pr,pull request,分支
category: git
version: 1.0.0
default_permission: FullAccess
required_tools: git,shell
---
# Git 工作流 Skill

## 执行步骤
1. [analyze] 读取 git status 与 diff 摘要
2. [generate] 按 Conventional Commit 规范生成 message
3. [commit] 走审批队列，确认后提交

## Conventional Commit 规范
- feat: 新功能
- fix: Bug 修复
- refactor: 重构
- test: 测试
- docs: 文档
- chore: 杂项
"#,
        ),
        build_skill(
            "large-refactor",
            "大型重构",
            "模块化分层重构",
            vec![
                "refactor".into(),
                "重构".into(),
                "模块化".into(),
                "拆分".into(),
            ],
            "refactor",
            "WorkspaceWrite",
            vec!["read_file".into(), "write_file".into(), "shell".into()],
            vec![
                step(1, "analyze", "分析依赖图与调用链", Some("分析依赖关系")),
                step(
                    2,
                    "analyze",
                    "拆解为可独立验证的子任务",
                    Some("拆解重构 todo"),
                ),
                step(
                    3,
                    "hunk",
                    "分步生成 Hunk，每步可独立 apply",
                    Some("分步生成 Hunk"),
                ),
                step(4, "test", "沙箱验证（编译/测试）", None),
            ],
            r#"---
id: large-refactor
name: 大型重构
description: 模块化分层重构
triggers: refactor,重构,模块化,拆分
category: refactor
version: 1.0.0
default_permission: WorkspaceWrite
required_tools: read_file,write_file,shell
---
# 大型重构 Skill

## 执行步骤
1. [analyze] 分析依赖图与调用链
2. [analyze] 拆解为可独立验证的子任务
3. [hunk] 分步生成 Hunk，每步可独立 apply
4. [test] 沙箱验证（编译/测试）

## 重构原则
- 单步 Hunk 必须可独立编译通过
- 保持外部 API 兼容
- 优先抽取接口，再迁移实现
"#,
        ),
        build_skill(
            "bug-diagnose",
            "Bug 诊断",
            "沙箱报错堆栈定位修复",
            vec![
                "bug".into(),
                "错误".into(),
                "报错".into(),
                "diagnose".into(),
                "修复 bug".into(),
            ],
            "bug",
            "WorkspaceWrite",
            vec!["read_file".into(), "write_file".into(), "shell".into()],
            vec![
                step(1, "analyze", "捕获报错堆栈与复现路径", Some("捕获报错堆栈")),
                step(2, "analyze", "定位相关文件与函数", Some("定位问题文件")),
                step(
                    3,
                    "analyze",
                    "分析根因（数据/控制流/边界）",
                    Some("分析根因"),
                ),
                step(4, "hunk", "生成修复 Hunk 并说明修改理由", None),
            ],
            r#"---
id: bug-diagnose
name: Bug 诊断
description: 沙箱报错堆栈定位修复
triggers: bug,错误,报错,diagnose,修复 bug
category: bug
version: 1.0.0
default_permission: WorkspaceWrite
required_tools: read_file,write_file,shell
---
# Bug 诊断 Skill

## 执行步骤
1. [analyze] 捕获报错堆栈与复现路径
2. [analyze] 定位相关文件与函数
3. [analyze] 分析根因（数据/控制流/边界）
4. [hunk] 生成修复 Hunk 并说明修改理由

## 输出规范
- 必须给出根因分析
- 修复 Hunk 必须最小化，不引入无关改动
"#,
        ),
        build_skill(
            "lint-fix",
            "格式化修复",
            "格式化与 lint 自动修复",
            vec![
                "lint".into(),
                "格式化".into(),
                "format".into(),
                "prettier".into(),
                "rustfmt".into(),
            ],
            "lint",
            "WorkspaceWrite",
            vec!["read_file".into(), "write_file".into(), "shell".into()],
            vec![
                step(1, "analyze", "扫描目标文件与格式问题", Some("扫描格式问题")),
                step(
                    2,
                    "shell",
                    "调用 formatter（rustfmt/prettier）",
                    Some("调用 formatter"),
                ),
                step(3, "hunk", "生成格式化 Hunk", None),
            ],
            r#"---
id: lint-fix
name: 格式化修复
description: 格式化与 lint 自动修复
triggers: lint,格式化,format,prettier,rustfmt
category: lint
version: 1.0.0
default_permission: WorkspaceWrite
required_tools: read_file,write_file,shell
---
# 格式化修复 Skill

## 执行步骤
1. [analyze] 扫描目标文件与格式问题
2. [shell] 调用 formatter（rustfmt/prettier）
3. [hunk] 生成格式化 Hunk

## 工具选择
- Rust: rustfmt
- TS/JS: prettier
- Python: black
"#,
        ),
        build_skill(
            "project-init",
            "项目初始化",
            "脚手架生成",
            vec![
                "init".into(),
                "新建项目".into(),
                "scaffold".into(),
                "脚手架".into(),
            ],
            "init",
            "WorkspaceWrite",
            vec!["write_file".into(), "shell".into()],
            vec![
                step(
                    1,
                    "analyze",
                    "选择模板（Rust/Node/Python/Tauri）",
                    Some("选择项目模板"),
                ),
                step(2, "generate", "生成目录结构", Some("生成目录结构")),
                step(
                    3,
                    "write",
                    "写入基础文件（Cargo.toml/package.json/README）",
                    None,
                ),
            ],
            r#"---
id: project-init
name: 项目初始化
description: 脚手架生成
triggers: init,新建项目,scaffold,脚手架
category: init
version: 1.0.0
default_permission: WorkspaceWrite
required_tools: write_file,shell
---
# 项目初始化 Skill

## 执行步骤
1. [analyze] 选择模板（Rust/Node/Python/Tauri）
2. [generate] 生成目录结构
3. [write] 写入基础文件（Cargo.toml/package.json/README）

## 模板规范
- Rust: Cargo.toml + src/main.rs + README.md
- Node: package.json + src/index.ts + README.md
- Tauri: tauri.conf.json + src/main.rs + frontend/
"#,
        ),
        // === 新增 10 个内置 Skill（参考真实开源项目能力） ===
        build_skill(
            "perf-optimize",
            "性能优化",
            "hot path 分析、内存泄漏检测、异步任务优化",
            vec![
                "performance".into(),
                "性能".into(),
                "优化".into(),
                "perf".into(),
                "慢".into(),
                "内存泄漏".into(),
            ],
            "refactor",
            "WorkspaceWrite",
            vec!["read_file".into(), "shell".into()],
            vec![
                step(
                    1,
                    "analyze",
                    "采集性能数据（flamegraph/耗时统计）",
                    Some("采集性能数据"),
                ),
                step(
                    2,
                    "analyze",
                    "识别 hot path 与瓶颈（CPU/IO/内存）",
                    Some("识别瓶颈"),
                ),
                step(
                    3,
                    "analyze",
                    "检查内存泄漏与异步任务堆积",
                    Some("检查内存泄漏"),
                ),
                step(4, "hunk", "生成优化 Hunk 并说明预期收益", None),
            ],
            r#"---
id: perf-optimize
name: 性能优化
description: hot path 分析、内存泄漏检测、异步任务优化
triggers: performance,性能,优化,perf,慢,内存泄漏
category: refactor
version: 1.0.0
default_permission: WorkspaceWrite
required_tools: read_file,shell
---
# 性能优化 Skill

## 执行步骤
1. [analyze] 采集性能数据（flamegraph/耗时统计）
2. [analyze] 识别 hot path 与瓶颈（CPU/IO/内存）
3. [analyze] 检查内存泄漏与异步任务堆积
4. [hunk] 生成优化 Hunk 并说明预期收益

## 优化原则
- 单步优化必须可独立测量收益
- 不破坏字节稳定前缀与缓存契约
- 优先算法/数据结构优化，其次并发，最后微调
"#,
        ),
        build_skill(
            "security-audit",
            "安全审计",
            "SQL 注入、XSS、密钥泄露、依赖漏洞扫描",
            vec![
                "security".into(),
                "安全".into(),
                "审计".into(),
                "audit".into(),
                "漏洞".into(),
                "CVE".into(),
            ],
            "review",
            "ReadOnly",
            vec!["read_file".into(), "shell".into()],
            vec![
                step(
                    1,
                    "analyze",
                    "扫描密钥泄露（硬编码 token/密钥/.env）",
                    Some("扫描密钥泄露"),
                ),
                step(
                    2,
                    "analyze",
                    "扫描注入漏洞（SQL/Command/XSS）",
                    Some("扫描注入漏洞"),
                ),
                step(
                    3,
                    "analyze",
                    "检查依赖 CVE 与版本漏洞",
                    Some("检查依赖漏洞"),
                ),
                step(4, "generate", "输出安全审计报告（按风险等级分级）", None),
            ],
            r#"---
id: security-audit
name: 安全审计
description: SQL 注入、XSS、密钥泄露、依赖漏洞扫描
triggers: security,安全,审计,audit,漏洞,CVE
category: review
version: 1.0.0
default_permission: ReadOnly
required_tools: read_file,shell
---
# 安全审计 Skill

## 执行步骤
1. [analyze] 扫描密钥泄露（硬编码 token/密钥/.env）
2. [analyze] 扫描注入漏洞（SQL/Command/XSS）
3. [analyze] 检查依赖 CVE 与版本漏洞
4. [generate] 输出安全审计报告（按风险等级分级）

## 风险等级
- critical: 立即修复（密钥泄露/RCE）
- high: 高危（注入/越权）
- medium: 中危（CSRF/敏感信息）
- low: 低危（信息泄漏/配置）
"#,
        ),
        build_skill(
            "api-design",
            "API 设计",
            "RESTful API 设计、OpenAPI 规范、错误码、版本兼容",
            vec![
                "api".into(),
                "接口".into(),
                "REST".into(),
                "RESTful".into(),
                "OpenAPI".into(),
            ],
            "refactor",
            "WorkspaceWrite",
            vec!["read_file".into(), "write_file".into()],
            vec![
                step(1, "analyze", "梳理业务领域与资源边界", Some("梳理业务领域")),
                step(
                    2,
                    "generate",
                    "设计 RESTful 路由与资源模型",
                    Some("设计路由"),
                ),
                step(
                    3,
                    "generate",
                    "定义错误码与 OpenAPI 规范",
                    Some("定义错误码"),
                ),
                step(4, "generate", "生成 API 文档与 Mock", None),
            ],
            r#"---
id: api-design
name: API 设计
description: RESTful API 设计、OpenAPI 规范、错误码、版本兼容
triggers: api,接口,REST,RESTful,OpenAPI
category: refactor
version: 1.0.0
default_permission: WorkspaceWrite
required_tools: read_file,write_file
---
# API 设计 Skill

## 执行步骤
1. [analyze] 梳理业务领域与资源边界
2. [generate] 设计 RESTful 路由与资源模型
3. [generate] 定义错误码与 OpenAPI 规范
4. [generate] 生成 API 文档与 Mock

## 设计原则
- 资源命名复数（/users, /orders）
- 版本前缀（/v1/）
- 统一错误码：{code, message, detail}
- 幂等性：GET/PUT/DELETE 幂等，POST 非幂等
"#,
        ),
        build_skill(
            "doc-gen",
            "文档生成",
            "README、API 文档、注释、CHANGELOG 自动生成",
            vec![
                "文档".into(),
                "doc".into(),
                "document".into(),
                "README".into(),
                "文档生成".into(),
            ],
            "init",
            "WorkspaceWrite",
            vec!["read_file".into(), "write_file".into()],
            vec![
                step(1, "analyze", "扫描模块入口与公共 API", Some("扫描模块入口")),
                step(
                    2,
                    "generate",
                    "生成 README/CHANGELOG 骨架",
                    Some("生成文档骨架"),
                ),
                step(3, "generate", "为公共函数生成注释与示例", None),
            ],
            r#"---
id: doc-gen
name: 文档生成
description: README、API 文档、注释、CHANGELOG 自动生成
triggers: 文档,doc,document,README,文档生成
category: init
version: 1.0.0
default_permission: WorkspaceWrite
required_tools: read_file,write_file
---
# 文档生成 Skill

## 执行步骤
1. [analyze] 扫描模块入口与公共 API
2. [generate] 生成 README/CHANGELOG 骨架
3. [generate] 为公共函数生成注释与示例

## 文档规范
- README: 项目简介 + 快速开始 + 配置 + 贡献
- CHANGELOG: Keep a Changelog 格式
- 注释: rustdoc / JSDoc / Google Style
"#,
        ),
        build_skill(
            "dep-check",
            "依赖检查",
            "过期依赖、安全漏洞、版本冲突检测与升级",
            vec![
                "依赖".into(),
                "dependency".into(),
                "upgrade".into(),
                "升级".into(),
                "outdated".into(),
            ],
            "lint",
            "WorkspaceWrite",
            vec!["read_file".into(), "shell".into()],
            vec![
                step(
                    1,
                    "shell",
                    "运行 outdated / audit 工具",
                    Some("检查过期依赖"),
                ),
                step(2, "analyze", "识别冲突与不兼容版本", Some("识别版本冲突")),
                step(3, "hunk", "生成升级 Hunk 并验证编译", None),
            ],
            r#"---
id: dep-check
name: 依赖检查
description: 过期依赖、安全漏洞、版本冲突检测与升级
triggers: 依赖,dependency,upgrade,升级,outdated
category: lint
version: 1.0.0
default_permission: WorkspaceWrite
required_tools: read_file,shell
---
# 依赖检查 Skill

## 执行步骤
1. [shell] 运行 outdated / audit 工具
2. [analyze] 识别冲突与不兼容版本
3. [hunk] 生成升级 Hunk 并验证编译

## 工具映射
- Rust: cargo outdated / cargo audit
- Node: npm outdated / npm audit
- Python: pip list --outdated / pip-audit
"#,
        ),
        build_skill(
            "dockerize",
            "Docker 化",
            "Dockerfile、docker-compose、镜像优化",
            vec![
                "docker".into(),
                "容器".into(),
                "Dockerfile".into(),
                "镜像".into(),
                "容器化".into(),
            ],
            "init",
            "WorkspaceWrite",
            vec!["read_file".into(), "write_file".into(), "shell".into()],
            vec![
                step(
                    1,
                    "analyze",
                    "识别运行时与依赖（语言/端口/卷）",
                    Some("识别运行时"),
                ),
                step(
                    2,
                    "generate",
                    "生成多阶段 Dockerfile 与 .dockerignore",
                    Some("生成 Dockerfile"),
                ),
                step(3, "generate", "生成 docker-compose.yml（含健康检查）", None),
            ],
            r#"---
id: dockerize
name: Docker 化
description: Dockerfile、docker-compose、镜像优化
triggers: docker,容器,Dockerfile,镜像,容器化
category: init
version: 1.0.0
default_permission: WorkspaceWrite
required_tools: read_file,write_file,shell
---
# Docker 化 Skill

## 执行步骤
1. [analyze] 识别运行时与依赖（语言/端口/卷）
2. [generate] 生成多阶段 Dockerfile 与 .dockerignore
3. [generate] 生成 docker-compose.yml（含健康检查）

## 镜像优化
- 多阶段构建减小最终镜像
- 使用 distroless / alpine 基础镜像
- 合并 RUN 层减少体积
"#,
        ),
        build_skill(
            "cicd-setup",
            "CI/CD 配置",
            "GitHub Actions、GitLab CI、自动化流水线",
            vec![
                "CI".into(),
                "CD".into(),
                "pipeline".into(),
                "Actions".into(),
                "流水线".into(),
                "自动化".into(),
            ],
            "init",
            "WorkspaceWrite",
            vec!["read_file".into(), "write_file".into()],
            vec![
                step(1, "analyze", "识别构建/测试/部署流程", Some("识别流程")),
                step(
                    2,
                    "generate",
                    "生成 workflow 文件（GitHub Actions/GitLab CI）",
                    Some("生成 workflow"),
                ),
                step(3, "generate", "配置缓存与并发限制", None),
            ],
            r#"---
id: cicd-setup
name: CI/CD 配置
description: GitHub Actions、GitLab CI、自动化流水线
triggers: CI,CD,pipeline,Actions,流水线,自动化
category: init
version: 1.0.0
default_permission: WorkspaceWrite
required_tools: read_file,write_file
---
# CI/CD 配置 Skill

## 执行步骤
1. [analyze] 识别构建/测试/部署流程
2. [generate] 生成 workflow 文件（GitHub Actions/GitLab CI）
3. [generate] 配置缓存与并发限制

## 流水线规范
- stages: lint → test → build → deploy
- 缓存依赖目录（cargo/registry, node_modules）
- 限制并发避免重复部署
"#,
        ),
        build_skill(
            "db-migration",
            "数据库迁移",
            "schema 变更、数据迁移、回滚脚本",
            vec![
                "migration".into(),
                "迁移".into(),
                "schema".into(),
                "数据库迁移".into(),
            ],
            "refactor",
            "WorkspaceWrite",
            vec!["read_file".into(), "write_file".into(), "shell".into()],
            vec![
                step(
                    1,
                    "analyze",
                    "对比新旧 schema 差异",
                    Some("对比 schema 差异"),
                ),
                step(
                    2,
                    "generate",
                    "生成迁移脚本（up/down）",
                    Some("生成迁移脚本"),
                ),
                step(
                    3,
                    "generate",
                    "生成数据迁移与回滚脚本",
                    Some("生成回滚脚本"),
                ),
                step(4, "test", "沙箱执行验证（迁移 + 回滚）", None),
            ],
            r#"---
id: db-migration
name: 数据库迁移
description: schema 变更、数据迁移、回滚脚本
triggers: migration,迁移,schema,数据库迁移
category: refactor
version: 1.0.0
default_permission: WorkspaceWrite
required_tools: read_file,write_file,shell
---
# 数据库迁移 Skill

## 执行步骤
1. [analyze] 对比新旧 schema 差异
2. [generate] 生成迁移脚本（up/down）
3. [generate] 生成数据迁移与回滚脚本
4. [test] 沙箱执行验证（迁移 + 回滚）

## 迁移原则
- 所有变更必须可回滚
- 大表变更采用 pt-online-schema-change
- 数据迁移与 schema 变更分离
"#,
        ),
        build_skill(
            "code-style",
            "代码风格统一",
            "ESLint、rustfmt、prettier、.editorconfig",
            vec![
                "风格".into(),
                "style".into(),
                "lint".into(),
                "eslint".into(),
                "rustfmt".into(),
                "prettier".into(),
            ],
            "lint",
            "WorkspaceWrite",
            vec!["read_file".into(), "write_file".into(), "shell".into()],
            vec![
                step(
                    1,
                    "analyze",
                    "识别语言与既有风格配置",
                    Some("识别语言与风格"),
                ),
                step(
                    2,
                    "generate",
                    "生成 .editorconfig / rustfmt.toml / .eslintrc",
                    Some("生成风格配置"),
                ),
                step(3, "shell", "执行格式化并生成统一 Hunk", None),
            ],
            r#"---
id: code-style
name: 代码风格统一
description: ESLint、rustfmt、prettier、.editorconfig
triggers: 风格,style,lint,eslint,rustfmt,prettier
category: lint
version: 1.0.0
default_permission: WorkspaceWrite
required_tools: read_file,write_file,shell
---
# 代码风格统一 Skill

## 执行步骤
1. [analyze] 识别语言与既有风格配置
2. [generate] 生成 .editorconfig / rustfmt.toml / .eslintrc
3. [shell] 执行格式化并生成统一 Hunk

## 工具映射
- Rust: rustfmt + clippy
- TS/JS: prettier + eslint
- Python: black + ruff
"#,
        ),
        build_skill(
            "release-notes",
            "版本发布说明",
            "CHANGELOG、release notes、版本号管理",
            vec![
                "release".into(),
                "发布".into(),
                "changelog".into(),
                "版本发布".into(),
            ],
            "git",
            "WorkspaceWrite",
            vec!["read_file".into(), "git".into()],
            vec![
                step(
                    1,
                    "analyze",
                    "提取自上次发布以来的 commit 列表",
                    Some("提取 commit 列表"),
                ),
                step(
                    2,
                    "generate",
                    "按 Conventional Commit 分类生成 CHANGELOG",
                    Some("生成 CHANGELOG"),
                ),
                step(
                    3,
                    "generate",
                    "确定版本号（SemVer）并生成 release notes",
                    None,
                ),
            ],
            r#"---
id: release-notes
name: 版本发布说明
description: CHANGELOG、release notes、版本号管理
triggers: release,发布,changelog,版本发布
category: git
version: 1.0.0
default_permission: WorkspaceWrite
required_tools: read_file,git
---
# 版本发布说明 Skill

## 执行步骤
1. [analyze] 提取自上次发布以来的 commit 列表
2. [generate] 按 Conventional Commit 分类生成 CHANGELOG
3. [generate] 确定版本号（SemVer）并生成 release notes

## 版本号规则（SemVer）
- MAJOR: 不兼容变更
- MINOR: 向后兼容的新功能
- PATCH: 向后兼容的修复
"#,
        ),
    ]
}

fn build_skill(
    id: &str,
    name: &str,
    description: &str,
    triggers: Vec<String>,
    category: &str,
    default_permission: &str,
    required_tools: Vec<String>,
    steps: Vec<SkillStep>,
    raw_markdown: &str,
) -> SkillDefinition {
    SkillDefinition {
        meta: SkillMeta {
            id: id.to_string(),
            name: name.to_string(),
            description: description.to_string(),
            triggers,
            category: category.to_string(),
            version: "1.0.0".to_string(),
            enabled: true,
            builtin: true,
        },
        steps,
        required_tools,
        default_permission: default_permission.to_string(),
        raw_markdown: raw_markdown.to_string(),
    }
}

fn step(order: usize, action: &str, description: &str, todo_text: Option<&str>) -> SkillStep {
    SkillStep {
        order,
        description: description.to_string(),
        action: action.to_string(),
        todo_text: todo_text.map(|s| s.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_init_builtin() {
        let store = SkillStore::new();
        store.init_builtin().await;
        let metas = store.list_metas().await;
        assert_eq!(metas.len(), 17, "应有 17 项内置 Skill");
        assert!(metas.iter().any(|m| m.id == "code-review"));
        assert!(metas.iter().any(|m| m.id == "perf-optimize"));
        assert!(metas.iter().any(|m| m.id == "release-notes"));
    }

    #[tokio::test]
    async fn test_find() {
        let store = SkillStore::new();
        store.init_builtin().await;
        let hits = store.find("请帮我做一下代码评审").await;
        assert!(!hits.is_empty(), "应匹配到 code-review");
        assert_eq!(hits[0].skill_id, "code-review");
        assert!(hits[0].score >= 0.3);
    }

    #[test]
    fn test_parse_skill_md() {
        let md = r#"---
id: my-skill
name: 我的技能
description: 测试技能
triggers: foo,bar
category: custom
version: 2.0.0
default_permission: ReadOnly
required_tools: read_file
---
# Steps
1. [analyze] 第一步 => todo1
2. [generate] 第二步
"#;
        let def = parse_skill_md(md).unwrap();
        assert_eq!(def.meta.id, "my-skill");
        assert_eq!(def.meta.name, "我的技能");
        assert_eq!(def.meta.triggers, vec!["foo", "bar"]);
        assert_eq!(def.meta.version, "2.0.0");
        assert_eq!(def.steps.len(), 2);
        assert_eq!(def.steps[0].action, "analyze");
        assert_eq!(def.steps[0].todo_text.as_deref(), Some("todo1"));
        assert_eq!(def.steps[1].action, "generate");
        assert!(def.steps[1].todo_text.is_none());
    }
}
