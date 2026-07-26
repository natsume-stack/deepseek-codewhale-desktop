//! 路由聚合: 注册所有 REST 端点 + CORS + 日志中间件。

pub mod agent;
pub mod approvals;
pub mod chat;
pub mod config_api;
pub mod diffs;
pub mod files;
pub mod git;
pub mod health;
pub mod mcp;
pub mod params;
pub mod project;
pub mod session;
pub mod skills;
pub mod todos;
pub mod tools;
// RAG 项目检索（P1）：rag.rs 位于 src/rag.rs（顶层），用 #[path] 显式指定
#[path = "../rag.rs"]
pub mod rag;
// 代码沙箱执行（P1）
pub mod sandbox;

use axum::http::{header, HeaderName, HeaderValue, Method};
use axum::routing::{delete, get, post, put};
use axum::Router;
use tower_http::cors::{AllowOrigin, CorsLayer};
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
        .route(
            "/diffs/:id/hunks/:hunk_index/apply",
            post(diffs::apply_hunk_handler),
        )
        .route(
            "/diffs/:id/hunks/:hunk_index/reject",
            post(diffs::reject_hunk_handler),
        )
        .route("/diffs/:session_id", get(diffs::list_diffs))
        // 代办任务（P0-7）
        .route("/todos", get(todos::list_todos).post(todos::create_todo))
        .route(
            "/todos/:id",
            get(todos::get_todo).delete(todos::delete_todo),
        )
        .route("/todos/:id/status", post(todos::update_todo_status))
        .route("/todos/session/:session_id", get(todos::list_session_todos))
        // Agent 操作审批（P0-8）
        .route(
            "/approvals",
            get(approvals::list_approvals).post(approvals::create_approval),
        )
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
        // === P2 完整设置页面后端 API ===
        // 模型 & API 卡片
        .route(
            "/config/model-profiles",
            get(config_api::get_model_profiles).put(config_api::set_model_profiles),
        )
        .route("/config/profiles", post(config_api::add_profile))
        .route(
            "/config/profiles/:id",
            axum::routing::put(config_api::update_profile).delete(config_api::delete_profile),
        )
        .route(
            "/config/profiles/:id/active",
            post(config_api::set_active_profile),
        )
        // RAG 卡片
        .route(
            "/config/rag",
            get(config_api::get_rag_config).put(config_api::set_rag_config),
        )
        // 格式化卡片
        .route(
            "/config/formatter",
            get(config_api::get_formatter_config).put(config_api::set_formatter_config),
        )
        // 缓存卡片
        .route(
            "/config/cache",
            get(config_api::get_cache_config).put(config_api::set_cache_config),
        )
        .route(
            "/config/cache/clear-session",
            post(config_api::clear_session_cache),
        )
        .route(
            "/config/cache/clear-memory",
            post(config_api::clear_project_memory),
        )
        .route("/config/cache/stats", get(config_api::get_cache_stats))
        // 外观卡片
        .route(
            "/config/appearance",
            get(config_api::get_appearance).put(config_api::set_appearance),
        )
        // 快捷键卡片
        .route(
            "/config/shortcuts",
            get(config_api::get_shortcuts)
                .put(config_api::set_shortcuts)
                .post(config_api::reset_shortcuts),
        )
        // 安全卡片
        .route(
            "/config/security",
            get(config_api::get_security).put(config_api::set_security),
        )
        .route(
            "/config/security/export-audit",
            get(config_api::export_audit_log),
        )
        // RAG 项目检索（P1）
        .route(
            "/rag/index",
            get(rag::get_index).post(rag::build_index_handler),
        )
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
        .route("/git/log", get(git::git_log))
        // Skill 技能生态（P0）
        // 注意：/skills/config、/skills/find、/skills/import、/skills/default-permission、/skills/agents-md
        // 均为静态路径，必须在 /skills/:id 之前注册（axum 静态优先匹配）。
        .route("/skills/config", get(skills::get_skills_config))
        .route("/skills/find", post(skills::find_skill))
        .route("/skills/import", post(skills::import_skill_pack))
        .route(
            "/skills/default-permission",
            post(skills::set_default_permission),
        )
        .route(
            "/skills/agents-md",
            get(skills::get_agents_md).put(skills::update_agents_md),
        )
        .route(
            "/skills",
            get(skills::list_skills).post(skills::create_skill),
        )
        .route(
            "/skills/:id",
            get(skills::get_skill).delete(skills::delete_skill),
        )
        .route("/skills/:id/toggle", put(skills::toggle_skill))
        .route("/skills/:id/enabled", put(skills::set_skill_enabled))
        .route("/skills/:id/export", post(skills::export_skill))
        // MCP 插件生态（P1）
        // 静态路径优先：/mcp/services、/mcp/global-enabled、/mcp/high-risk/switch、/mcp/call 均在 /mcp/:id 之前。
        .route(
            "/mcp/services",
            get(mcp::list_mcp_services).post(mcp::add_mcp_service),
        )
        .route("/mcp/global-enabled", post(mcp::set_mcp_global_enabled))
        .route(
            "/mcp/high-risk/switch",
            get(mcp::get_high_risk_switch).put(mcp::set_high_risk_switch),
        )
        .route("/mcp/call", post(mcp::call_mcp))
        .route("/mcp", get(mcp::list_mcp).post(mcp::register_mcp))
        .route("/mcp/:id", delete(mcp::delete_mcp))
        .route("/mcp/:id/toggle", put(mcp::toggle_mcp))
        .route("/mcp/:id/enabled", post(mcp::set_mcp_enabled))
        .route("/mcp/:id/connect", post(mcp::connect_mcp))
        .route("/mcp/:id/disconnect", post(mcp::disconnect_mcp))
        // 顶层独立路由：模型档案列表（前端 modelProfilesApi.list）
        .route("/model-profiles", get(config_api::list_model_profiles))
        // Agent 自治运行时 (P0): 任务管理 + SSE 事件流 + 工具列表 + 模式路由
        .nest("/agent", agent::router());

    Router::new()
        .route("/ping", get(health::ping))
        .route("/health", get(health::ping))
        .nest("/api", api)
        .layer(TraceLayer::new_for_http())
        .layer(
            CorsLayer::new()
                // 精确白名单 origin：开发服务器 + Tauri 桌面壳（Windows tauri://localhost / https://tauri.localhost）
                .allow_origin(AllowOrigin::list([
                    "http://localhost:5173".parse::<HeaderValue>().unwrap(),
                    "tauri://localhost".parse::<HeaderValue>().unwrap(),
                    "https://tauri.localhost".parse::<HeaderValue>().unwrap(),
                ]))
                // 仅放行业务实际使用的 HTTP 方法
                .allow_methods([
                    Method::GET,
                    Method::POST,
                    Method::PUT,
                    Method::DELETE,
                    Method::PATCH,
                    Method::OPTIONS,
                ])
                // 仅放行业务实际使用的请求头
                .allow_headers([
                    header::CONTENT_TYPE,
                    header::AUTHORIZATION,
                    HeaderName::from_static("x-session-id"),
                ]),
        )
        .with_state(state)
}
