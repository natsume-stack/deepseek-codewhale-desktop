//! CodeWhale Server 入口。
//!
//! 启动本地 HTTP API 服务, 对外提供 REST + SSE 接口供 WinUI 前端调用。
//! 配置加载优先级: config.toml > 环境变量 > 内置默认值。

mod agent;
mod cache;
mod config;
mod deepseek;
mod diff;
mod dsml;
mod error;
mod mcp;
mod r1_harvest;
mod routes;
mod session;
mod skills;
mod smart_router;
mod state;
mod tool_repair;
mod tools;

use std::net::SocketAddr;
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("info,codewhale_server=debug")),
        )
        .init();

    let cfg = config::AppConfig::load_or_init()?;
    let host = cfg.server.host.clone();
    let port = cfg.server.port;
    let addr: SocketAddr = format!("{host}:{port}").parse()?;

    let state = state::SharedState::new(cfg);
    // 初始化内置 17 项标准 Skill + 12 项真实开源 MCP 插件配置（P0 Skill / P1 MCP 生态）
    state.skills.init_builtin().await;
    state.mcp.init_builtin().await;
    // 注册 Agent 内置工具 (Agent A 提供 register_builtin_tools 真实实现后生效)
    state.agent.register_builtin().await;
    tracing::info!("已加载内置 Skill 与 MCP 插件配置");
    let app = routes::build_router(state);

    tracing::info!("CodeWhale server listening on http://{}", addr);
    tracing::info!("健康检测: GET http://{}/ping", addr);
    tracing::info!("配置文件: {}", config::AppConfig::config_path()?.display());

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}
