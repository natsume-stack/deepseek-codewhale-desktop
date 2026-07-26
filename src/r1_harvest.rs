//! Reasonix R1 Thought Harvest（P0+）。
//!
//! DeepSeek-R1（reasoner）有时会将工具调用隐藏在推理块（reasoning_content）中，
//! 而非走标准 content 通道。本模块从推理内容中识别隐藏的工具调用并规整为标准 DSML 标签，
//! 让上层路由可以像处理普通工具调用一样调度。
//!
//! 识别规则（优先级从高到低）：
//! 1. 严格 JSON 围栏：```tool\n{"name":"read_file","arguments":{...}}\n```
//! 2. XML 风格：<tool name="read_file"><arg path="..."/></tool>
//! 3. 自然语言（confidence < 0.7）："我需要读取文件 src/main.rs"

use serde::Serialize;
use serde_json::{json, Value};

/// 从推理内容中提取出的单个工具调用。
#[derive(Debug, Clone, Serialize)]
pub struct HarvestedTool {
    /// 工具名："read_file" / "write_file" / "shell" 等。
    pub name: String,
    /// 工具参数（JSON 对象）。
    pub arguments: Value,
    /// 原始匹配文本（用于在推理流中定位/替换）。
    pub raw_text: String,
    /// 置信度 0.0-1.0。
    pub confidence: f64,
}

/// 从推理内容中提取隐藏的工具调用。
///
/// 匹配模式：
/// - 严格 JSON 围栏：```tool\n{json}\n```（confidence 1.0）
/// - XML 风格：<tool name="..."><arg k="v"/></tool>（confidence 0.9）
/// - 自然语言："调用工具 X" / "我需要读取文件 Y"（confidence < 0.7）
pub fn harvest_tools(reasoning: &str) -> Vec<HarvestedTool> {
    let mut out = Vec::new();
    out.extend(harvest_json_fenced(reasoning));
    out.extend(harvest_xml_style(reasoning));
    out.extend(harvest_natural_language(reasoning));
    out
}

/// 规整为标准 DSML 工具标签。
///
/// 输出形如：
/// ```text
/// <tool name="read_file">
/// <arg path="src/main.rs"/>
/// </tool>
/// ```
pub fn to_dsml(tool: &HarvestedTool) -> String {
    let mut s = String::new();
    s.push_str(&format!("<tool name=\"{}\">\n", escape_xml(&tool.name)));
    if let Some(obj) = tool.arguments.as_object() {
        for (k, v) in obj {
            let vstr = match v {
                Value::String(s) => s.clone(),
                other => other.to_string(),
            };
            s.push_str(&format!(
                "<arg {}=\"{}\"/>\n",
                escape_xml(k),
                escape_xml(&vstr)
            ));
        }
    }
    s.push_str("</tool>");
    s
}

/* ============================================================
 * 内部识别函数
 * ============================================================ */

/// 识别 ```tool\n{json}\n``` 围栏。
fn harvest_json_fenced(reasoning: &str) -> Vec<HarvestedTool> {
    let mut out = Vec::new();
    let mut rest = reasoning;
    while let Some(start) = rest.find("```tool") {
        let after = &rest[start + "```tool".len()..];
        // 跳过可能的换行
        let after = after.trim_start_matches(['\n', '\r', ' ', '\t']);
        match after.find("```") {
            None => break,
            Some(end) => {
                let raw_json = &after[..end];
                let raw_text = format!("```tool\n{}\n```", raw_json);
                if let Ok(v) = serde_json::from_str::<Value>(raw_json.trim()) {
                    if let Some(name) = v
                        .get("name")
                        .and_then(|x| x.as_str())
                        .map(|s| s.to_string())
                    {
                        let args = v.get("arguments").cloned().unwrap_or(json!({}));
                        out.push(HarvestedTool {
                            name,
                            arguments: args,
                            raw_text,
                            confidence: 1.0,
                        });
                    }
                }
                rest = &after[end + "```".len()..];
            }
        }
    }
    out
}

/// 识别 <tool name="..."><arg k="v"/></tool>。
fn harvest_xml_style(reasoning: &str) -> Vec<HarvestedTool> {
    let mut out = Vec::new();
    let mut rest = reasoning;
    while let Some(start) = rest.find("<tool") {
        let after = &rest[start..];
        match after.find("</tool>") {
            None => break,
            Some(end) => {
                let block = &after[..end + "</tool>".len()];
                if let Some(tool) = parse_xml_tool(block) {
                    out.push(tool);
                }
                rest = &after[end + "</tool>".len()..];
            }
        }
    }
    out
}

/// 简易 XML 解析：<tool name="X"><arg k="v"/></tool>
fn parse_xml_tool(block: &str) -> Option<HarvestedTool> {
    // 提取 name 属性
    let name_start = block.find("name=\"")? + "name=\"".len();
    let name_end = block[name_start..].find('"')?;
    let name = block[name_start..name_start + name_end].to_string();

    // 提取所有 <arg k="v"/>
    let mut args = serde_json::Map::new();
    let mut cursor = 0;
    while let Some(rel) = block[cursor..].find("<arg") {
        let abs = cursor + rel;
        let tag_end = match block[abs..].find("/>") {
            Some(e) => abs + e + 2,
            None => match block[abs..].find("</arg>") {
                Some(e) => abs + e + "</arg>".len(),
                None => break,
            },
        };
        let tag = &block[abs..tag_end];
        // 在 tag 内寻找所有 k="v" 属性对
        let mut i = 0;
        let bytes = tag.as_bytes();
        while i < bytes.len() {
            // 找到下一个 "
            if bytes[i] == b'"' {
                // 回溯找属性名
                let value_start = i + 1;
                if let Some(value_end_rel) = tag[value_start..].find('"') {
                    let value_end = value_start + value_end_rel;
                    let value = &tag[value_start..value_end];
                    // 回溯找 "=" 之前的属性名
                    let mut k_end = i;
                    while k_end > 0
                        && (bytes[k_end - 1] == b' '
                            || bytes[k_end - 1] == b'\t'
                            || bytes[k_end - 1] == b'\n'
                            || bytes[k_end - 1] == b'\r')
                    {
                        k_end -= 1;
                    }
                    let mut k_start = k_end;
                    while k_start > 0 {
                        let c = bytes[k_start - 1];
                        if c.is_ascii_alphanumeric() || c == b'_' || c == b'-' {
                            k_start -= 1;
                        } else {
                            break;
                        }
                    }
                    if k_end > k_start {
                        let key = &tag[k_start..k_end];
                        if !key.is_empty() && key != "name" {
                            args.insert(key.to_string(), Value::String(value.to_string()));
                        }
                    }
                    i = value_end + 1;
                    continue;
                }
            }
            i += 1;
        }
        cursor = tag_end;
    }

    if name.is_empty() {
        return None;
    }
    Some(HarvestedTool {
        name,
        arguments: Value::Object(args),
        raw_text: block.to_string(),
        confidence: 0.9,
    })
}

/// 识别自然语言模式（低置信度）。
///
/// 仅匹配最常见两种：
/// - "调用工具 read_file 参数 path=src/main.rs"
/// - "我需要读取文件 src/main.rs"
fn harvest_natural_language(reasoning: &str) -> Vec<HarvestedTool> {
    let mut out = Vec::new();
    // 模式1：调用工具 X 参数 K=V[, K=V]
    for line in reasoning.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("调用工具") {
            let rest = rest.trim();
            // 取第一个 token 作为工具名
            let mut parts = rest.splitn(2, char::is_whitespace);
            let name = match parts.next() {
                Some(n) if !n.is_empty() => n.trim_end_matches(',').to_string(),
                _ => continue,
            };
            let args_str = parts.next().unwrap_or("").trim();
            let mut args = serde_json::Map::new();
            // 解析 "参数 K=V, K=V"
            if let Some(args_rest) = args_str.strip_prefix("参数") {
                for pair in args_rest.split(',') {
                    let pair = pair.trim();
                    if let Some(eq) = pair.find('=') {
                        let k = pair[..eq].trim();
                        let v = pair[eq + 1..].trim();
                        if !k.is_empty() {
                            args.insert(k.to_string(), Value::String(v.to_string()));
                        }
                    }
                }
            }
            out.push(HarvestedTool {
                name,
                arguments: Value::Object(args),
                raw_text: line.to_string(),
                confidence: 0.6,
            });
            continue;
        }
        // 模式2：我需要读取文件 PATH
        if let Some(rest) = line.strip_prefix("我需要读取文件") {
            let path = rest.trim().trim_end_matches('。').trim_end_matches('.');
            if !path.is_empty() {
                let mut args = serde_json::Map::new();
                args.insert("path".to_string(), Value::String(path.to_string()));
                out.push(HarvestedTool {
                    name: "read_file".to_string(),
                    arguments: Value::Object(args),
                    raw_text: line.to_string(),
                    confidence: 0.5,
                });
                continue;
            }
        }
    }
    out
}

fn escape_xml(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}
