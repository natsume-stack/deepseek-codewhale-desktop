//! 路由聚合: 注册所有 REST 端点 + CORS + 日志中间件。

pub mod approvals;
pub mod chat;
pub mod config_api;
pub mod diffs;
pub mod files;
pub mod git;
pub mod health;
pub mod params;
pub mod project;
pub mod session;
pub mod todos;
pub mod tools;
// RAG 项目检索（P1）：rag.rs 位于 src/rag.rs（顶层），用 #[path] 显式指定
#[path = "../rag.rs"]
pub mod rag;
// 代码沙箱执行（P1）
pub mod sandbox;

use axum::routing::{delete, get, post};
use axum::Router;
use tower_http::cors::{Any, CorsLayer};
use tower_http::trace::TraceLayer;

use crate::state::SharedState;

pub fn build_router(state: SharedState) -> Router {
    let api = Router::new()
        // 对话
        .route("/chat", post(chat::start_chat))
        .route("/chat/stop", post(chat::stop_chat))
        // 会话
        .route(
            "/sessions",
            get(session::list_sessions).post(session::create_session),
        )
        .route(
            "/sessions/:id",
            get(session::get_session).delete(session::delete_session),
        )
        .route("/sessions/:id/reset", post(session::reset_session))
        // 推理参数
        .route(
            "/params",
            get(params::get_params).put(params::update_params),
        )
        // 项目目录
        .route("/project/load", post(project::load_project))
        .route("/project", get(project::get_project))
        .route("/project/tree", get(files::get_tree))
        // 文件系统 CRUD（新增路由层，不触碰 Agent 内核）
        .route("/files", post(files::create_file))
        .route("/files/read", post(files::read_file))
        .route("/files/write", post(files::write_file))
        .route("/files/rename", axum::routing::patch(files::rename_file))
        .route("/files/reveal", post(files::reveal_in_explorer))
        .route("/files", delete(files::delete_file))
        // Diff 管理（新增路由层）
        .route("/diffs", post(diffs::register_diff))
        .route("/diffs/apply-all", post(diffs::apply_all_diffs))
        .route("/diffs/:id/apply", post(diffs::apply_diff))
        .route("/diffs/:id/reject", post(diffs::reject_diff))
        .route("/diffs/:id/revert", post(diffs::revert_diff))
        .route("/diffs/:id/hunks/:hunk_index/apply", post(diffs::apply_hunk_handler))
        .route("/diffs/:id/hunks/:hunk_index/reject", post(diffs::reject_hunk_handler))
        .route("/diffs/:session_id", get(diffs::list_diffs))
        // 代办任务（P0-7）
        .route("/todos", get(todos::list_todos).post(todos::create_todo))
        .route("/todos/:id", get(todos::get_todo).delete(todos::delete_todo))
        .route("/todos/:id/status", post(todos::update_todo_status))
        .route("/todos/session/:session_id", get(todos::list_session_todos))
        // Agent 操作审批（P0-8）
        .route("/approvals", get(approvals::list_approvals).post(approvals::create_approval))
        .route("/approvals/pending", get(approvals::list_pending))
        .route("/approvals/:id", get(approvals::get_approval))
        .route("/approvals/:id/decide", post(approvals::decide_approval))
        // 内置工具
        .route("/tools/file/read", post(tools::read_file_handler))
        .route("/tools/file/write", post(tools::write_file_handler))
        .route("/tools/git", post(tools::git_handler))
        .route("/tools/shell", post(tools::shell_handler))
        // DeepSeek 配置
        .route(
            "/config/deepseek",
            get(config_api::get_deepseek).put(config_api::set_deepseek),
        )
        .route("/config/deepseek/test", post(config_api::test_deepseek))
        // 权限配置（P0-8）
        .route(
            "/config/permission",
            get(config_api::get_permission).put(config_api::set_permission),
        )
        // RAG 项目检索（P1）
        .route("/rag/index", get(rag::get_index).post(rag::build_index_handler))
        .route("/rag/recall", post(rag::recall_handler))
        .route("/rag/clear", delete(rag::clear_index))
        // 代码沙箱执行（P1）
        .route("/sandbox/exec", post(sandbox::exec))
        .route("/sandbox/languages", get(sandbox::list_languages))
        .route("/sandbox/format", post(sandbox::format_code))
        // Git/GitHub 联动（P1）
        .route("/git/status", get(git::git_status))
        .route("/git/diff", post(git::git_diff))
        .route("/git/commit", post(git::git_commit))
        .route("/git/branch", post(git::git_branch))
        .route("/git/pr-review", post(git::git_pr_review))
        .route("/git/log", get(git::git_log));

    Router::new()
        .route("/ping", get(health::ping))
        .route("/health", get(health::ping))
        .nest("/api", api)
        .layer(TraceLayer::new_for_http())
        .layer(
            CorsLayer::new()
                .allow_origin(Any)
                .allow_methods(Any)
                .allow_headers(Any),
        )
        .with_state(state)
}
