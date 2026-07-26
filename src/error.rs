use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;
use thiserror::Error;

/// 统一错误类型，可转换为 axum JSON 响应。
#[derive(Debug, Error)]
pub enum AppError {
    #[error("配置错误: {0}")]
    Config(String),

    #[error("DeepSeek API 错误: {status} {body}")]
    DeepSeek { status: u16, body: String },

    #[error("DeepSeek 调用失败: {0}")]
    DeepSeekTransport(#[from] reqwest::Error),

    #[error("会话不存在: {0}")]
    SessionNotFound(String),

    #[error("参数错误: {0}")]
    BadRequest(String),

    #[error("工具执行失败: {0}")]
    Tool(String),

    #[error("权限不足: {0}")]
    Forbidden(String),

    #[error("IO 错误: {0}")]
    Io(#[from] std::io::Error),

    #[error("内部错误: {0}")]
    Internal(#[from] anyhow::Error),
}

impl AppError {
    fn status_code(&self) -> StatusCode {
        match self {
            AppError::BadRequest(_) | AppError::SessionNotFound(_) => StatusCode::BAD_REQUEST,
            AppError::Config(_) => StatusCode::FAILED_DEPENDENCY,
            // Keep actionable upstream failures actionable. In particular, a bad
            // credential must remain a 401 instead of being misreported as 502.
            AppError::DeepSeek { status, .. } => {
                StatusCode::from_u16(*status).unwrap_or(StatusCode::BAD_GATEWAY)
            }
            AppError::Tool(_) => StatusCode::UNPROCESSABLE_ENTITY,
            AppError::Forbidden(_) => StatusCode::FORBIDDEN,
            _ => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let code = self.status_code();
        let body = Json(json!({
            "error": code.as_u16(),
            "message": self.to_string(),
        }));
        (code, body).into_response()
    }
}

pub type AppResult<T> = Result<T, AppError>;
