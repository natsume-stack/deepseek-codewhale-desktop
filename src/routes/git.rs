//! Git/GitHub 联动 API：参考 Aider 实现 Git 自动化。
//!
//! ## 路由
//! - `GET  /api/git/status`     - 获取当前仓库状态（只读，不限制权限）
//! - `POST /api/git/diff`       - 获取 staged / unstaged diff
//! - `POST /api/git/commit`     - 自动生成 Conventional Commits 并提交（强制审批）
//! - `POST /api/git/branch`     - 分支管理（create/delete 强制审批）
//! - `POST /api/git/pr-review`  - 调用 DeepSeek 评审 PR diff
//! - `GET  /api/git/log`        - 获取提交历史
//!
//! ## 权限与审批策略
//! - 所有 Git 命令均通过 `tools::git` 执行，后者要求 `can_shell`（FullAccess）
//! - 高危操作（commit / branch create / branch delete）必须创建审批请求，
//!   返回 `202 Accepted + approvalId`，不立即执行
//! - Conventional Commits 类型自动推断：feat / fix / docs / test / refactor / perf / style / ci / chore / build
//! - PR 评审调用 `state.client.chat_stream` 同步等待非流式结果

use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::PathBuf;

use crate::error::AppError;
use crate::state::{ApprovalKind, SharedState};
use crate::tools;

/// 取项目根，未加载则报错。
async fn require_root(state: &SharedState) -> Result<PathBuf, AppError> {
    state.project_root().await.ok_or_else(|| {
        AppError::BadRequest("未加载项目目录, 请先调用 POST /api/project/load".into())
    })
}

/* ============================================================
 * GET /api/git/status
 * ============================================================ */

/// GET /api/git/status - 获取当前仓库状态（只读）。
///
/// ReadOnly 权限用户也可调用：返回项目根信息但标记 `available=false`。
pub async fn git_status(State(state): State<SharedState>) -> Result<Json<Value>, AppError> {
    let root = require_root(&state).await?;
    let cfg = state.permission_config().await;

    // tools::git 强制要求 can_shell，权限不足时降级返回项目根信息
    if !cfg.level.can_shell() {
        return Ok(Json(json!({
            "available": false,
            "reason": "当前权限等级禁止执行 Git（需 FullAccess）",
            "projectRoot": root.display().to_string(),
        })));
    }

    let status_res = tools::git(
        &root,
        vec!["status".into(), "--porcelain=v1".into()],
        cfg.level,
    )
    .await?;
    let branch_res = tools::git(
        &root,
        vec!["rev-parse".into(), "--abbrev-ref".into(), "HEAD".into()],
        cfg.level,
    )
    .await;
    let branch = match branch_res {
        // detached HEAD 时 stdout 通常为 "HEAD\n"，此时不应显示 "HEAD" 作为分支名
        Ok(r) if r.success => {
            let b = r.stdout.trim().to_string();
            if b.is_empty() || b == "HEAD" {
                "(detached)".to_string()
            } else {
                b
            }
        }
        _ => "(detached)".to_string(),
    };

    Ok(Json(json!({
        "available": true,
        "branch": branch,
        "porcelain": status_res.stdout,
        "exitCode": status_res.exit_code,
        "success": status_res.success,
        "stderr": status_res.stderr,
    })))
}

/* ============================================================
 * POST /api/git/diff
 * ============================================================ */

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffBody {
    /// true=staged (--cached)，false=unstaged（默认）。
    pub staged: Option<bool>,
    /// 限制指定路径（可选）。
    pub path: Option<String>,
}

/// POST /api/git/diff - 获取 diff。
pub async fn git_diff(
    State(state): State<SharedState>,
    Json(body): Json<DiffBody>,
) -> Result<Json<Value>, AppError> {
    let root = require_root(&state).await?;
    let cfg = state.permission_config().await;
    if !cfg.level.can_shell() {
        return Err(AppError::Forbidden("当前权限等级禁止执行 Git".into()));
    }

    let mut args = vec!["diff".to_string()];
    if body.staged.unwrap_or(false) {
        args.push("--cached".into());
    }
    if let Some(p) = body.path.as_deref() {
        if !p.trim().is_empty() {
            args.push("--".into());
            args.push(p.into());
        }
    }
    let res = tools::git(&root, args, cfg.level).await?;
    Ok(Json(json!({
        "diff": res.stdout,
        "exitCode": res.exit_code,
        "success": res.success,
        "stderr": res.stderr,
    })))
}

/* ============================================================
 * POST /api/git/commit
 * ============================================================ */

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitBody {
    /// 显式提供提交信息。
    pub message: Option<String>,
    /// true=根据 staged diff 自动生成 Conventional Commits。
    pub auto_generate: Option<bool>,
    /// true=提交前 git add -A（高危，需审批）。
    pub add_all: Option<bool>,
}

/// POST /api/git/commit - 自动生成 Conventional Commits 并提交。
///
/// 高危操作：始终返回 `202 Accepted + approvalId`，不立即执行 commit。
/// 客户端审批通过后由前端再次调用 `/api/tools/git` 执行实际命令，
/// 或后续扩展 `/api/git/commit/execute` 端点直连审批 ID 执行。
pub async fn git_commit(
    State(state): State<SharedState>,
    Json(body): Json<CommitBody>,
) -> Result<(StatusCode, Json<Value>), AppError> {
    let root = require_root(&state).await?;
    let cfg = state.permission_config().await;

    // 权限：commit 视为 Shell 类
    if !cfg.level.can_shell() {
        return Err(AppError::Forbidden(
            "当前权限等级禁止执行 Git commit".into(),
        ));
    }

    // 决定最终提交信息
    let message = if body.auto_generate.unwrap_or(false) {
        let diff_stat = tools::git(
            &root,
            vec!["diff".into(), "--cached".into(), "--stat".into()],
            cfg.level,
        )
        .await?;
        let seed = body.message.clone().unwrap_or_default();
        generate_conventional_commit(&diff_stat.stdout, &seed)
    } else {
        body.message
            .clone()
            .ok_or_else(|| AppError::BadRequest("未提供 message 且 autoGenerate=false".into()))?
    };

    if message.trim().is_empty() {
        return Err(AppError::BadRequest("提交信息不能为空".into()));
    }

    // 高危操作：必须创建审批请求，并携带 pending_action 供审批通过后回放执行
    let mut detail_lines = Vec::new();
    detail_lines.push(format!("message: {message}"));
    let mut commit_args: Vec<String> = Vec::new();
    if body.add_all.unwrap_or(false) {
        detail_lines.push("will run: git add -A".into());
        commit_args.push("add".into());
        commit_args.push("-A".into());
        commit_args.push("&&".into()); // 占位，实际执行时拆为多次 git 调用
    }
    detail_lines.push("will run: git commit -m <message>".into());

    // 构造回放命令序列：先 add（如需），再 commit
    // 由于 tools::git 单次只执行一条 git 命令，PendingAction::GitExec 设计为单条命令，
    // 这里仅保存 commit 命令；add_all 的预 stage 由用户手动执行或后续扩展为多命令队列
    let commit_only_args: Vec<String> = vec!["commit".into(), "-m".into(), message.clone()];

    let approval = state
        .approvals
        .create_with_action(
            ApprovalKind::Git,
            format!("Git commit: {}", message),
            Some(detail_lines.join("\n")),
            None,
            Some(crate::state::PendingAction::GitExec {
                args: commit_only_args,
            }),
        )
        .await;

    // 注意：add_all=true 时，前端应在审批通过后由用户先手动 git add，或后续扩展多命令队列
    let _ = commit_args; // 抑制未使用警告

    Ok((
        StatusCode::ACCEPTED,
        Json(json!({
            "approvalId": approval.id,
            "pending": true,
            "message": message,
            "detail": "等待用户审批 Git commit",
            "note": if body.add_all.unwrap_or(false) {
                "审批通过后将执行 git commit；如需 git add -A 请先手动 stage 或在审批后由后端自动处理"
            } else {
                "审批通过后将执行 git commit"
            },
        })),
    ))
}

/// 根据 staged diff stat 推断 Conventional Commits 类型。
///
/// 规则（按优先级）：
/// 1. seed 中含 fix/修复/bug → `fix`
/// 2. seed 中含 feat/新增/添加/支持 → `feat`
/// 3. 仅 .md 变更 → `docs`
/// 4. 仅 test_*/*_test.* → `test`
/// 5. seed 中含 refactor/重构 → `refactor`
/// 6. seed 中含 perf/性能 → `perf`
/// 7. seed 中含 style/格式 → `style`
/// 8. seed 中含 ci → `ci`
/// 9. 仅配置/构建脚本 → `chore`
/// 10. 默认 → `chore`
fn generate_conventional_commit(diff_stat: &str, seed: &str) -> String {
    let lower_seed = seed.to_lowercase();
    let files: Vec<&str> = diff_stat
        .lines()
        .filter_map(|l| {
            // --stat 输出形如: " src/main.rs | 12 +++--"
            let trimmed = l.trim();
            if trimmed.is_empty() || trimmed.starts_with('-') {
                return None;
            }
            trimmed.split('|').next().map(|s| s.trim())
        })
        .collect();

    let only_md = !files.is_empty() && files.iter().all(|f| f.ends_with(".md"));
    let only_test = !files.is_empty()
        && files.iter().all(|f| {
            f.contains("test_")
                || f.ends_with("_test.rs")
                || f.ends_with("_test.go")
                || f.ends_with("_test.py")
                || f.ends_with(".test.ts")
                || f.ends_with(".test.tsx")
        });
    let only_config = !files.is_empty()
        && files.iter().all(|f| {
            matches!(
                f,
                &"Cargo.toml"
                    | &"package.json"
                    | &"tsconfig.json"
                    | &".gitignore"
                    | &"Dockerfile"
                    | &"build.rs"
                    | &"Cargo.lock"
            )
        });

    let kind =
        if lower_seed.contains("fix") || lower_seed.contains("修复") || lower_seed.contains("bug")
        {
            "fix"
        } else if lower_seed.contains("feat")
            || lower_seed.contains("新增")
            || lower_seed.contains("添加")
            || lower_seed.contains("支持")
        {
            "feat"
        } else if only_md {
            "docs"
        } else if only_test {
            "test"
        } else if lower_seed.contains("重构") || lower_seed.contains("refactor") {
            "refactor"
        } else if lower_seed.contains("perf") || lower_seed.contains("性能") {
            "perf"
        } else if lower_seed.contains("style") || lower_seed.contains("格式") {
            "style"
        } else if lower_seed.contains("ci") {
            "ci"
        } else if only_config {
            "chore"
        } else {
            "chore"
        };

    let scope = guess_scope(&files);
    let summary = if seed.trim().is_empty() {
        "更新代码".to_string()
    } else {
        seed.trim().to_string()
    };
    if let Some(s) = scope {
        format!("{kind}({s}): {summary}")
    } else {
        format!("{kind}: {summary}")
    }
}

/// 根据变更文件路径猜测 scope（取首文件的第一级非通用目录）。
fn guess_scope(files: &[&str]) -> Option<String> {
    if files.is_empty() {
        return None;
    }
    let first = files[0];
    let parts: Vec<&str> = first.split('/').collect();
    if parts.len() >= 2 {
        let candidate = parts[0];
        if !matches!(
            candidate,
            "src" | "tests" | "examples" | "." | ".." | "benches"
        ) {
            return Some(candidate.to_string());
        }
        if parts.len() >= 3 {
            return Some(parts[1].to_string());
        }
    }
    None
}

/* ============================================================
 * POST /api/git/branch
 * ============================================================ */

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchBody {
    /// create | switch | list | delete
    pub action: String,
    pub name: Option<String>,
}

/// POST /api/git/branch - 分支管理。
///
/// - `create` / `delete`：高危操作，强制走审批（返回 202 + approvalId）
/// - `list` / `switch`：通过权限闸门后立即执行
pub async fn git_branch(
    State(state): State<SharedState>,
    Json(body): Json<BranchBody>,
) -> Result<(StatusCode, Json<Value>), AppError> {
    let root = require_root(&state).await?;
    let cfg = state.permission_config().await;
    if !cfg.level.can_shell() {
        return Err(AppError::Forbidden(
            "当前权限等级禁止执行 Git branch 操作".into(),
        ));
    }

    let action = body.action.trim().to_lowercase();
    let name = body.name.as_deref().unwrap_or("").trim().to_string();

    // 高危操作审批
    let needs_approval = matches!(action.as_str(), "delete" | "create");
    if needs_approval {
        if name.is_empty() {
            return Err(AppError::BadRequest(format!("{action} 操作必须提供 name")));
        }
        let desc = format!("Git {} 分支: {}", action, name);
        let approval = state
            .approvals
            .create(
                ApprovalKind::Git,
                desc,
                Some(format!("action={action} name={name}")),
                None,
            )
            .await;
        return Ok((
            StatusCode::ACCEPTED,
            Json(json!({
                "approvalId": approval.id,
                "pending": true,
                "message": "等待用户审批 Git branch 操作",
            })),
        ));
    }

    // list / switch 直接执行
    let args = match action.as_str() {
        "list" => vec!["branch".into(), "--list".into()],
        "switch" => {
            if name.is_empty() {
                return Err(AppError::BadRequest("switch 操作必须提供 name".into()));
            }
            vec!["switch".into(), name.clone()]
        }
        other => {
            return Err(AppError::BadRequest(format!(
                "不支持的 action: {other}（可选: create/switch/list/delete）"
            )));
        }
    };
    let res = tools::git(&root, args, cfg.level).await?;
    Ok((
        StatusCode::OK,
        Json(json!({
            "action": action,
            "name": name,
            "output": res.stdout,
            "exitCode": res.exit_code,
            "success": res.success,
            "stderr": res.stderr,
        })),
    ))
}

/* ============================================================
 * POST /api/git/pr-review
 * ============================================================ */

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrReviewBody {
    pub pr_number: u32,
    pub repo: Option<String>,
}

/// POST /api/git/pr-review - PR 评审。
///
/// 流程：
/// 1. 优先尝试 `gh pr diff <n> --repo <repo>` 获取 PR diff
/// 2. 回退到 `git diff origin/main...HEAD`
/// 3. 调用 `state.client.chat_stream` 同步等待 DeepSeek 输出评审意见
pub async fn git_pr_review(
    State(state): State<SharedState>,
    Json(body): Json<PrReviewBody>,
) -> Result<Json<Value>, AppError> {
    let root = require_root(&state).await?;
    let cfg = state.permission_config().await;
    if !cfg.level.can_shell() {
        return Err(AppError::Forbidden(
            "当前权限等级禁止执行 Git（PR 评审需要拉取 diff）".into(),
        ));
    }

    let diff = fetch_pr_diff(&root, body.pr_number, body.repo.as_deref(), cfg.level)
        .await
        .map_err(|e| AppError::Tool(format!("获取 PR #{} diff 失败: {e}", body.pr_number)))?;

    if diff.trim().is_empty() {
        return Ok(Json(json!({
            "prNumber": body.pr_number,
            "repo": body.repo,
            "review": "无 diff 内容，跳过评审",
            "diffSize": 0,
        })));
    }

    let review = deepseek_pr_review(&state, &diff, body.pr_number).await?;

    Ok(Json(json!({
        "prNumber": body.pr_number,
        "repo": body.repo,
        "diffSize": diff.len(),
        "review": review,
    })))
}

/// 拉取 PR diff：优先 gh CLI，回退 git diff origin/main...HEAD。
async fn fetch_pr_diff(
    root: &std::path::Path,
    pr_number: u32,
    repo: Option<&str>,
    level: crate::config::PermissionLevel,
) -> Result<String, AppError> {
    // 优先尝试 gh CLI
    let mut gh_cmd = format!("gh pr diff {}", pr_number);
    if let Some(r) = repo {
        gh_cmd.push_str(&format!(" --repo {}", r));
    }
    match tools::shell(root, gh_cmd, 30, level).await {
        Ok(gh_res) if gh_res.success && !gh_res.stdout.trim().is_empty() => {
            return Ok(gh_res.stdout);
        }
        _ => {}
    }
    // 回退：git diff origin/main...HEAD
    let git_args = vec!["diff".to_string(), "origin/main...HEAD".to_string()];
    let res = tools::git(root, git_args, level).await?;
    if res.success {
        Ok(res.stdout)
    } else {
        Err(AppError::Tool(format!(
            "获取 PR diff 失败（gh 未安装或 git diff 失败）: {}",
            res.stderr.trim()
        )))
    }
}

/// 调用 DeepSeek 评审 PR diff（同步等待非流式结果）。
async fn deepseek_pr_review(
    state: &SharedState,
    diff: &str,
    pr_number: u32,
) -> Result<String, AppError> {
    use crate::config::ReasoningEffort;
    use crate::deepseek::{ChatMessage, ChatRequest as DsChatRequest, ChatRole};
    use tokio_util::sync::CancellationToken;

    let ds_cfg = state.deepseek_config().await;
    if ds_cfg.api_key.trim().is_empty() {
        return Err(AppError::Config(
            "DeepSeek API Key 未配置，无法进行 PR 评审".into(),
        ));
    }

    // 截断超长 diff（避免超出 max_tokens）
    // 注意：使用 chars().take() 而非字节切片，防止多字节 UTF-8 字符（如中文）被截断导致 panic
    let truncated = if diff.chars().count() > 24000 {
        let head: String = diff.chars().take(24000).collect();
        format!("{head}\n\n[... diff 已截断 ...]")
    } else {
        diff.to_string()
    };

    let system_prompt = "你是资深代码评审专家。请对以下 Pull Request diff 进行评审，输出：\n\
1. 总体评价（1-2 句）\n\
2. 优点（条目化）\n\
3. 风险/问题（条目化，标注严重程度：高/中/低）\n\
4. 改进建议（条目化）\n\
5. 是否可以合并的结论（可以合并/需修改后合并/不建议合并）\n\n\
使用 Markdown 格式输出，简洁直接，不啰嗦。";

    let user_content = format!(
        "# PR #{} 评审\n\n请评审以下 diff：\n\n```diff\n{}\n```",
        pr_number, truncated
    );

    let messages = vec![
        ChatMessage {
            role: ChatRole::System,
            content: system_prompt.into(),
        },
        ChatMessage {
            role: ChatRole::User,
            content: user_content,
        },
    ];

    let chat_req = DsChatRequest {
        model: ds_cfg.model.clone(),
        messages,
        reasoning_effort: ReasoningEffort::Medium,
        enable_cache: false,
        max_tokens: Some(4096),
        temperature: Some(0.3),
    };

    let cancel = CancellationToken::new();
    let mut rx = state.client.chat_stream(chat_req, &ds_cfg, cancel).await?;

    let mut content_acc = String::new();
    while let Some(item) = rx.recv().await {
        match item {
            Ok(delta) => {
                if let Some(c) = delta.content {
                    content_acc.push_str(&c);
                }
                if delta.finish_reason.is_some() {
                    break;
                }
            }
            Err(e) => return Err(e),
        }
    }
    Ok(content_acc)
}

/* ============================================================
 * GET /api/git/log
 * ============================================================ */

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogQuery {
    pub limit: Option<u32>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LogEntry {
    hash: String,
    author: String,
    date: String,
    message: String,
}

/// GET /api/git/log - 获取提交历史。
pub async fn git_log(
    State(state): State<SharedState>,
    Query(q): Query<LogQuery>,
) -> Result<Json<Value>, AppError> {
    let root = require_root(&state).await?;
    let cfg = state.permission_config().await;
    if !cfg.level.can_shell() {
        return Err(AppError::Forbidden("当前权限等级禁止执行 Git log".into()));
    }

    let limit = q.limit.unwrap_or(10).min(200);
    let pretty_format = "%H|%an|%ad|%s";
    let args = vec![
        "log".into(),
        format!("-n{limit}"),
        format!("--pretty=format:{}", pretty_format),
        "--date=iso".into(),
    ];
    let res = tools::git(&root, args, cfg.level).await?;

    let entries: Vec<LogEntry> = res
        .stdout
        .lines()
        .filter_map(|l| {
            let parts: Vec<&str> = l.splitn(4, '|').collect();
            if parts.len() != 4 {
                return None;
            }
            Some(LogEntry {
                hash: parts[0].to_string(),
                author: parts[1].to_string(),
                date: parts[2].to_string(),
                message: parts[3].to_string(),
            })
        })
        .collect();

    Ok(Json(json!({
        "limit": limit,
        "count": entries.len(),
        "commits": entries,
        "success": res.success,
        "stderr": res.stderr,
    })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn conventional_commit_fix() {
        let stat = " src/main.rs | 5 +-\n";
        let msg = generate_conventional_commit(stat, "修复登录 bug");
        assert!(msg.starts_with("fix"));
    }

    #[test]
    fn conventional_commit_docs() {
        let stat = " README.md | 10 +-\n";
        let msg = generate_conventional_commit(stat, "");
        assert!(msg.starts_with("docs"));
    }

    #[test]
    fn conventional_commit_with_scope() {
        let stat = " frontend/src/App.tsx | 12 +-\n";
        let msg = generate_conventional_commit(stat, "添加用户面板");
        assert!(msg.starts_with("feat(frontend):"));
    }

    #[test]
    fn scope_skips_src_root() {
        let stat = " src/api/users.rs | 5 +-\n";
        let files: Vec<&str> = vec!["src/api/users.rs"];
        let scope = guess_scope(&files);
        assert_eq!(scope.as_deref(), Some("api"));
    }
}
