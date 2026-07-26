//! BrowserTools 阶段1: 静态网页抓取、文本/源码提取。
//!
//! 不依赖浏览器引擎,使用 reqwest 抓取 HTML,简单解析提取:
//! - 纯文本内容 (去标签)
//! - 页面标题
//! - 所有链接
//! - 代码块 (`<pre><code>`)
//!
//! 阶段2 (后续迭代): 接入 headless Chrome / Playwright 实现动态交互。
//!
//! 实现说明: HTML 解析使用简单字符串扫描 + regex (依赖已在 Cargo.toml: `regex = "1"`)
//! 剥离标签,不引入 scraper 等额外依赖。

use async_trait::async_trait;
use regex::Regex;
use serde_json::{json, Value};
use std::time::Duration;

use crate::agent::tool_protocol::{
    AgentTool, ArtifactKind, ExecutionContext, ToolArtifact, ToolError, ToolResult,
};
use crate::config::PermissionLevel;

/// 默认 HTTP 请求超时 (秒)。
const DEFAULT_HTTP_TIMEOUT_SECS: u64 = 5;
/// 输出截断阈值 (16 KiB)。
const MAX_OUTPUT_BYTES: usize = 16 * 1024;

// ============================== WebFetchTool ==============================

pub struct WebFetchTool;

#[async_trait]
impl AgentTool for WebFetchTool {
    fn name(&self) -> &'static str {
        "web.fetch"
    }

    fn description(&self) -> &'static str {
        "抓取静态网页,提取纯文本/HTML/链接/代码块。不支持 SPA 动态页面 (阶段2 接入浏览器引擎)"
    }

    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "url": {
                    "type": "string",
                    "description": "完整 URL (含 http:// 或 https://)"
                },
                "extract": {
                    "type": "string",
                    "enum": ["text", "html", "links", "code_blocks"],
                    "default": "text",
                    "description": "提取模式: text=纯文本, html=原始 HTML, links=所有链接, code_blocks=代码块"
                }
            },
            "required": ["url"]
        })
    }

    fn required_permission(&self) -> PermissionLevel {
        PermissionLevel::ReadOnly
    }

    async fn execute(&self, args: Value, _ctx: &ExecutionContext) -> Result<ToolResult, ToolError> {
        let url = args
            .get("url")
            .and_then(|v| v.as_str())
            .ok_or_else(|| ToolError::InvalidArgs("缺少 url 参数".into()))?;
        let extract = args
            .get("extract")
            .and_then(|v| v.as_str())
            .unwrap_or("text");

        // 构建 HTTP 客户端 (5 秒超时)
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(DEFAULT_HTTP_TIMEOUT_SECS))
            .user_agent("CodeWhale-Desktop/0.1 (+https://github.com/codewhale)")
            .build()
            .map_err(|e| ToolError::Execution(format!("构建 HTTP 客户端失败: {e}")))?;

        let resp = client
            .get(url)
            .send()
            .await
            .map_err(|e| ToolError::Execution(format!("请求 {url} 失败: {e}")))?;
        let status = resp.status();
        if !status.is_success() {
            return Err(ToolError::Execution(format!(
                "HTTP {status} 抓取 {url} 失败"
            )));
        }
        let html = resp
            .text()
            .await
            .map_err(|e| ToolError::Execution(format!("读取响应体失败: {e}")))?;

        let output = match extract {
            "html" => html,
            "text" => extract_text(&html),
            "links" => {
                let links = extract_links(&html);
                serde_json::to_string_pretty(&links).unwrap_or_else(|_| "[]".into())
            }
            "code_blocks" => {
                let blocks = extract_code_blocks(&html);
                serde_json::to_string_pretty(&blocks).unwrap_or_else(|_| "[]".into())
            }
            other => {
                return Err(ToolError::InvalidArgs(format!(
                    "未知 extract 模式: {other} (可选 text/html/links/code_blocks)"
                )));
            }
        };

        let mut tr = ToolResult::success(format!("[url {url}]\n[extract {extract}]\n{output}"));
        tr.artifacts.push(ToolArtifact {
            kind: ArtifactKind::ShellOutput, // 复用 ShellOutput 作为通用文本产物
            path: None,
            diff_id: None,
            summary: format!("url={}, extract={}, bytes={}", url, extract, output.len()),
        });
        // 截断到 16 KiB
        tr.truncate_output(MAX_OUTPUT_BYTES);
        Ok(tr)
    }
}

// ============================== WebSearchTool ==============================

pub struct WebSearchTool;

#[async_trait]
impl AgentTool for WebSearchTool {
    fn name(&self) -> &'static str {
        "web.search"
    }

    fn description(&self) -> &'static str {
        "网络搜索 (阶段1: 占位,阶段2 接入搜索 API)。当前返回提示信息,请改用 web.fetch 抓取已知 URL"
    }

    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "搜索关键词 (阶段1 未实现)"
                },
                "max_results": {
                    "type": "integer",
                    "description": "最大返回结果数 (阶段1 未实现)",
                    "default": 5
                }
            },
            "required": ["query"]
        })
    }

    fn required_permission(&self) -> PermissionLevel {
        PermissionLevel::ReadOnly
    }

    async fn execute(&self, _args: Value, _ctx: &ExecutionContext) -> Result<ToolResult, ToolError> {
        // 阶段1 占位: 不接入搜索 API,引导用户使用 web.fetch
        Ok(ToolResult::success(
            "web.search 阶段1 暂未实现,请使用 web.fetch 直接抓取已知 URL。阶段2 将接入 Brave/Bing 搜索 API。",
        ))
    }
}

// ============================== HTML 解析辅助函数 ==============================

/// 从 HTML 中提取纯文本 (去标签,压缩空白)。
fn extract_text(html: &str) -> String {
    // 1. 移除 <script> / <style> 整段内容
    let without_scripts = remove_tags_with_content(html, "script");
    let without_styles = remove_tags_with_content(&without_scripts, "style");
    // 2. 将 <br> / </p> / </div> 等转为换行
    let with_newlines = replace_block_tags_with_newlines(&without_styles);
    // 3. 剥离所有 HTML 标签
    let tag_re = Regex::new(r"<[^>]+>").expect("invalid regex");
    let text = tag_re.replace_all(&with_newlines, "");
    // 4. 解码常见 HTML 实体
    let decoded = decode_html_entities(&text);
    // 5. 压缩连续空白 (保留换行)
    let collapsed = collapse_whitespace(&decoded);
    collapsed.trim().to_string()
}

/// 提取所有 <a href="..."> 链接,返回 (text, href) 列表。
fn extract_links(html: &str) -> Vec<(String, String)> {
    let mut links = Vec::new();
    // 简单正则匹配 <a href="...">text</a>
    let re = Regex::new(r#"(?i)<a\s+[^>]*href\s*=\s*["']([^"']+)["'][^>]*>(.*?)</a>"#)
        .expect("invalid regex");
    let text_re = Regex::new(r"<[^>]+>").expect("invalid regex");
    for cap in re.captures_iter(html) {
        let href = cap.get(1).map(|m| m.as_str().to_string()).unwrap_or_default();
        let inner = cap.get(2).map(|m| m.as_str()).unwrap_or("");
        let text = text_re.replace_all(inner, "").trim().to_string();
        if !href.is_empty() {
            links.push((text, href));
        }
    }
    links
}

/// 提取 <pre><code>...</code></pre> 代码块内容。
fn extract_code_blocks(html: &str) -> Vec<String> {
    let mut blocks = Vec::new();
    // 匹配 <pre>...<code>...</code>...</pre> 或 <pre>...</pre>
    let pre_re =
        Regex::new(r"(?is)<pre[^>]*>(.*?)</pre>").expect("invalid regex");
    let tag_re = Regex::new(r"<[^>]+>").expect("invalid regex");
    for cap in pre_re.captures_iter(html) {
        let inner = cap.get(1).map(|m| m.as_str()).unwrap_or("");
        let text = tag_re.replace_all(inner, "");
        let decoded = decode_html_entities(&text);
        let trimmed = decoded.trim();
        if !trimmed.is_empty() {
            blocks.push(trimmed.to_string());
        }
    }
    blocks
}

/// 移除指定标签及其内容 (如 <script>...</script>)。
fn remove_tags_with_content(html: &str, tag: &str) -> String {
    let pattern = format!(r"(?is)<{tag}[^>]*>.*?</{tag}>");
    match Regex::new(&pattern) {
        Ok(re) => re.replace_all(html, "").into_owned(),
        Err(_) => html.to_string(),
    }
}

/// 将块级标签替换为换行符,保留文本结构。
fn replace_block_tags_with_newlines(html: &str) -> String {
    let block_re = Regex::new(r"(?i)</?(p|div|br|h[1-6]|li|tr|table|hr)[^>]*>")
        .expect("invalid regex");
    block_re.replace_all(html, "\n").into_owned()
}

/// 解码常见 HTML 实体。
fn decode_html_entities(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&nbsp;", " ")
}

/// 压缩连续空白 (保留换行符),将多个空格合并为单个。
fn collapse_whitespace(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut prev_ws = false;
    for ch in s.chars() {
        if ch == '\n' {
            out.push(ch);
            prev_ws = false;
        } else if ch.is_whitespace() {
            if !prev_ws {
                out.push(' ');
            }
            prev_ws = true;
        } else {
            out.push(ch);
            prev_ws = false;
        }
    }
    out
}

// ============================== 测试 ==============================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_text_strips_tags() {
        let html = r#"<html><head><style>body{}</style></head><body><h1>Hello</h1><p>World &amp; <b>foo</b></p></body></html>"#;
        let text = extract_text(html);
        assert!(text.contains("Hello"));
        assert!(text.contains("World"));
        assert!(text.contains("foo"));
        assert!(!text.contains("<"));
        assert!(text.contains("&")); // &amp; 解码为 &
    }

    #[test]
    fn extract_links_finds_anchors() {
        let html = r#"<a href="https://example.com">Example</a> <a href="/rel">Rel</a>"#;
        let links = extract_links(html);
        assert_eq!(links.len(), 2);
        assert_eq!(links[0].0, "Example");
        assert_eq!(links[0].1, "https://example.com");
        assert_eq!(links[1].1, "/rel");
    }

    #[test]
    fn extract_code_blocks_returns_content() {
        let html = r#"<pre><code>fn main() {
    println!("hi");
}</code></pre>"#;
        let blocks = extract_code_blocks(html);
        assert_eq!(blocks.len(), 1);
        assert!(blocks[0].contains("fn main"));
        assert!(blocks[0].contains("println"));
    }

    #[test]
    fn extract_text_removes_scripts() {
        let html = r#"<script>alert('x');</script><p>visible</p>"#;
        let text = extract_text(html);
        assert!(text.contains("visible"));
        assert!(!text.contains("alert"));
        assert!(!text.contains("script"));
    }

    #[test]
    fn decode_html_entities_basic() {
        assert_eq!(decode_html_entities("a &amp; b &lt; c"), "a & b < c");
        assert_eq!(decode_html_entities("&quot;hi&quot;"), "\"hi\"");
    }

    #[tokio::test]
    async fn web_search_returns_placeholder() {
        let tool = WebSearchTool;
        let ctx = ExecutionContext::new(
            uuid::Uuid::new_v4(),
            uuid::Uuid::new_v4(),
            std::path::PathBuf::from("/"),
            tokio_util::sync::CancellationToken::new(),
        );
        let result = tool
            .execute(json!({"query": "rust"}), &ctx)
            .await
            .expect("web.search 应成功返回占位");
        assert!(result.success);
        assert!(result.output.contains("web.fetch"));
    }

    #[tokio::test]
    async fn web_fetch_rejects_missing_url() {
        let tool = WebFetchTool;
        let ctx = ExecutionContext::new(
            uuid::Uuid::new_v4(),
            uuid::Uuid::new_v4(),
            std::path::PathBuf::from("/"),
            tokio_util::sync::CancellationToken::new(),
        );
        let result = tool.execute(json!({}), &ctx).await;
        assert!(result.is_err());
    }
}
