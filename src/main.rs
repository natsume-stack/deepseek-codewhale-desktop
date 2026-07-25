//! CodeWhale Server 入口。
//!
//! 启动本地 HTTP API 服务, 对外提供 REST + SSE 接口供 WinUI 前端调用。
//! 配置加载优先级: config.toml > 环境变量 > 内置默认值。

mod cache;
mod config;
mod deepseek;
mod diff;
mod dsml;
mod error;
mod r1_harvest;
mod routes;
mod session;
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
    let app = routes::build_router(state);

    tracing::info!("CodeWhale server listening on http://{}", addr);
    tracing::info!("健康检测: GET http://{}/ping", addr);
    tracing::info!("配置文件: {}", config::AppConfig::config_path()?.display());

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}
