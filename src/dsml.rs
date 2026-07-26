//! DSML (DeepSeek Markup Language) 标准化工具调用标签。
//!
//! 参考 Deep Code 规范，所有文件 / Git / Shell 操作仅输出标准化执行意图标签，
//! 由 Agent 输出文本 → 客户端解析 DSML → 权限校验 → 审批 → 实际调用 tools::* 函数。
//!
//! XML 格式：
//! ```xml
//! <tool name="write_file" intent="创建新文件" requiredPermission="workspaceWrite">
//!   <arg name="path">src/utils.rs</arg>
//!   <arg name="content">fn sha256(...) { ... }</arg>
//! </tool>
//! ```

use crate::config::PermissionLevel;
use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};

/// DSML 工具调用标签。
///
/// Agent 输出此结构序列化后的 XML，客户端解析后再走权限/审批/执行流程。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DsmlToolCall {
    /// 工具名：read_file / write_file / shell / git_create_commit / git_pr_review / ...
    pub name: String,
    /// 参数（JSON 对象，按工具 schema 自行约定字段）。
    pub arguments: serde_json::Value,
    /// 意图描述（人类可读）。
    pub intent: String,
    /// 权限等级要求。
    pub required_permission: PermissionLevel,
}

impl DsmlToolCall {
    /// 序列化为 DSML XML 标签。
    pub fn to_xml(&self) -> String {
        let perm = permission_to_str(self.required_permission);
        let mut out = String::new();
        out.push_str(&format!(
            "<tool name=\"{}\" intent=\"{}\" requiredPermission=\"{}\">\n",
            xml_escape(&self.name),
            xml_escape(&self.intent),
            perm
        ));
        if let Some(obj) = self.arguments.as_object() {
            for (k, v) in obj.iter() {
                let val = match v {
                    serde_json::Value::String(s) => s.clone(),
                    other => other.to_string(),
                };
                out.push_str(&format!(
                    "  <arg name=\"{}\">{}</arg>\n",
                    xml_escape(k),
                    xml_escape(&val)
                ));
            }
        }
        out.push_str("</tool>");
        out
    }

    /// 从 XML 解析单个 DSML 标签。
    pub fn from_xml(xml: &str) -> AppResult<Self> {
        let trimmed = xml.trim();
        // 找起始标签结束位置
        let open_end = trimmed
            .find('>')
            .ok_or_else(|| AppError::BadRequest("DSML XML 缺少起始标签结束符 >".into()))?;
        let open_tag = &trimmed[..open_end + 1];
        let rest = &trimmed[open_end + 1..];
        let close_idx = rest
            .rfind("</tool>")
            .ok_or_else(|| AppError::BadRequest("DSML XML 缺少 </tool> 闭合标签".into()))?;
        let inner = &rest[..close_idx];

        // 解析起始标签属性
        let open_inner = open_tag
            .strip_prefix("<tool")
            .and_then(|s| s.strip_suffix('>'))
            .ok_or_else(|| AppError::BadRequest("DSML 起始标签格式错误".into()))?
            .trim();

        let mut name = String::new();
        let mut intent = String::new();
        let mut perm_str = String::new();
        for attr in split_attrs(open_inner)? {
            let (k, v) = attr;
            match k.as_str() {
                "name" => name = v,
                "intent" => intent = v,
                "requiredPermission" => perm_str = v,
                _ => {}
            }
        }
        if name.is_empty() {
            return Err(AppError::BadRequest("DSML 标签缺少 name 属性".into()));
        }

        // 解析 <arg name="...">value</arg>
        let mut args = serde_json::Map::new();
        let mut pos = 0;
        while pos < inner.len() {
            let Some(start_rel) = inner[pos..].find("<arg ") else {
                break;
            };
            let start = pos + start_rel;
            let tag_open_end = inner[start..]
                .find('>')
                .ok_or_else(|| AppError::BadRequest("DSML <arg> 缺少 >".into()))?;
            let arg_tag_full = &inner[start..start + tag_open_end + 1];
            let arg_attr_inner = arg_tag_full
                .strip_prefix("<arg")
                .and_then(|s| s.strip_suffix('>'))
                .ok_or_else(|| AppError::BadRequest("DSML <arg> 起始格式错误".into()))?
                .trim();
            let mut arg_name = String::new();
            for attr in split_attrs(arg_attr_inner)? {
                let (k, v) = attr;
                if k == "name" {
                    arg_name = v;
                }
            }
            if arg_name.is_empty() {
                return Err(AppError::BadRequest("DSML <arg> 缺少 name 属性".into()));
            }
            let value_start = start + tag_open_end + 1;
            let value_end_rel = inner[value_start..]
                .find("</arg>")
                .ok_or_else(|| AppError::BadRequest("DSML <arg> 缺少 </arg> 闭合".into()))?;
            let value = &inner[value_start..value_start + value_end_rel];
            args.insert(
                arg_name.clone(),
                serde_json::Value::String(xml_unescape(value)),
            );
            pos = value_start + value_end_rel + "</arg>".len();
        }

        let required_permission = parse_permission(&perm_str)?;
        Ok(Self {
            name,
            arguments: serde_json::Value::Object(args),
            intent,
            required_permission,
        })
    }

    /// 从 JSON 解析（与 serde 序列化字段一致）。
    pub fn from_json(json: &str) -> AppResult<Self> {
        serde_json::from_str(json)
            .map_err(|e| AppError::BadRequest(format!("DSML JSON 解析失败: {e}")))
    }
}

/// 解析文本中所有 DSML `<tool>...</tool>` 块。
///
/// 解析失败的块会被跳过并记录 warn，不影响其它块。
pub fn parse_dsml_blocks(text: &str) -> Vec<DsmlToolCall> {
    let mut out = Vec::new();
    let mut cursor = 0;
    while cursor < text.len() {
        let Some(rel) = text[cursor..].find("<tool ") else {
            break;
        };
        let start = cursor + rel;
        let Some(end_rel) = text[start..].find("</tool>") else {
            break;
        };
        let end = start + end_rel + "</tool>".len();
        let block = &text[start..end];
        match DsmlToolCall::from_xml(block) {
            Ok(call) => out.push(call),
            Err(e) => tracing::warn!("DSML 块解析失败: {e}; block={block}"),
        }
        cursor = end;
    }
    out
}

/* ============================================================
 * 标准化工具调用标签构造器（供 Agent 输出模板使用）
 * ============================================================ */

/// 生成 read_file 的 DSML 标签构建器。
pub fn build_read_file(path: &str) -> DsmlToolCall {
    DsmlToolCall {
        name: "read_file".into(),
        arguments: serde_json::json!({ "path": path }),
        intent: format!("读取文件: {path}"),
        required_permission: PermissionLevel::ReadOnly,
    }
}

/// 生成 write_file 的 DSML 标签构建器。
pub fn build_write_file(path: &str, content: &str) -> DsmlToolCall {
    DsmlToolCall {
        name: "write_file".into(),
        arguments: serde_json::json!({ "path": path, "content": content }),
        intent: format!("写入文件: {path}"),
        required_permission: PermissionLevel::WorkspaceWrite,
    }
}

/// 生成 shell 的 DSML 标签构建器。
pub fn build_shell(command: &str) -> DsmlToolCall {
    DsmlToolCall {
        name: "shell".into(),
        arguments: serde_json::json!({ "command": command }),
        intent: format!("执行 Shell 命令: {command}"),
        required_permission: PermissionLevel::FullAccess,
    }
}

/// 生成 git_create_commit 的 DSML 标签构建器。
pub fn build_git_commit(message: &str, conventional: bool) -> DsmlToolCall {
    DsmlToolCall {
        name: "git_create_commit".into(),
        arguments: serde_json::json!({
            "message": message,
            "conventional": conventional,
        }),
        intent: format!("Git 提交: {message}"),
        required_permission: PermissionLevel::FullAccess,
    }
}

/// 生成 git_pr_review 的 DSML 标签构建器。
pub fn build_git_pr_review(pr_number: u32) -> DsmlToolCall {
    DsmlToolCall {
        name: "git_pr_review".into(),
        arguments: serde_json::json!({ "prNumber": pr_number }),
        intent: format!("GitHub PR 评审 #{pr_number}"),
        required_permission: PermissionLevel::ReadOnly,
    }
}

/// 校验 DSML 工具调用是否符合当前权限等级。
///
/// 返回 `(allowed, reason)`。`allowed=true` 表示当前等级满足要求。
pub fn check_permission(call: &DsmlToolCall, level: PermissionLevel) -> (bool, String) {
    let required = call.required_permission;
    let ok = permission_granted(level, required);
    let reason = if ok {
        format!("权限满足: 当前 {:?} ≥ 要求 {:?}", level, required)
    } else {
        format!("权限不足: 当前 {:?} < 要求 {:?}", level, required)
    };
    (ok, reason)
}

/* ============================================================
 * 内部辅助函数
 * ============================================================ */

fn permission_to_str(p: PermissionLevel) -> &'static str {
    match p {
        PermissionLevel::ReadOnly => "readOnly",
        PermissionLevel::WorkspaceWrite => "workspaceWrite",
        PermissionLevel::FullAccess => "fullAccess",
    }
}

fn parse_permission(s: &str) -> AppResult<PermissionLevel> {
    match s.trim() {
        "" | "readOnly" | "read-only" | "readonly" => Ok(PermissionLevel::ReadOnly),
        "workspaceWrite" | "workspace-write" => Ok(PermissionLevel::WorkspaceWrite),
        "fullAccess" | "full-access" => Ok(PermissionLevel::FullAccess),
        other => Err(AppError::BadRequest(format!("未知权限等级: {other}"))),
    }
}

/// 权限等级比较：当前等级 >= 要求等级 → true。
fn permission_granted(current: PermissionLevel, required: PermissionLevel) -> bool {
    fn rank(p: PermissionLevel) -> u8 {
        match p {
            PermissionLevel::ReadOnly => 0,
            PermissionLevel::WorkspaceWrite => 1,
            PermissionLevel::FullAccess => 2,
        }
    }
    rank(current) >= rank(required)
}

fn xml_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '&' => out.push_str("&amp;"),
            '"' => out.push_str("&quot;"),
            _ => out.push(c),
        }
    }
    out
}

fn xml_unescape(s: &str) -> String {
    s.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&amp;", "&")
}

/// 简易属性拆分器：从 `name="..." intent="..."` 中拆出 (key, value) 对。
fn split_attrs(s: &str) -> AppResult<Vec<(String, String)>> {
    let mut out = Vec::new();
    let mut rest = s;
    while !rest.trim().is_empty() {
        rest = rest.trim_start();
        let eq = rest
            .find('=')
            .ok_or_else(|| AppError::BadRequest("DSML 属性缺少 =".into()))?;
        let key = rest[..eq].trim().to_string();
        let after = rest[eq + 1..].trim_start();
        if !after.starts_with('"') {
            return Err(AppError::BadRequest("DSML 属性值必须用 \" 包裹".into()));
        }
        let value_end = after[1..]
            .find('"')
            .ok_or_else(|| AppError::BadRequest("DSML 属性值缺少结束 \"".into()))?;
        let value = after[1..1 + value_end].to_string();
        out.push((key, value));
        rest = &after[1 + value_end + 1..];
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_write_file() {
        let call = build_write_file("src/utils.rs", "fn main() {}");
        let xml = call.to_xml();
        assert!(xml.contains("name=\"write_file\""));
        assert!(xml.contains("requiredPermission=\"workspaceWrite\""));
        let parsed = DsmlToolCall::from_xml(&xml).unwrap();
        assert_eq!(parsed.name, "write_file");
        assert_eq!(parsed.required_permission, PermissionLevel::WorkspaceWrite);
        assert_eq!(
            parsed.arguments.get("path").and_then(|v| v.as_str()),
            Some("src/utils.rs")
        );
    }

    #[test]
    fn permission_check_basic() {
        let call = build_shell("rm -rf /");
        let (ok, _) = check_permission(&call, PermissionLevel::ReadOnly);
        assert!(!ok);
        let (ok, _) = check_permission(&call, PermissionLevel::FullAccess);
        assert!(ok);
    }

    #[test]
    fn parse_blocks_handles_mixed_text() {
        let text = "前面一段说明\n<tool name=\"read_file\" intent=\"读\" requiredPermission=\"readOnly\">\n  <arg name=\"path\">a.rs</arg>\n</tool>\n中间\n<tool name=\"bad";
        let blocks = parse_dsml_blocks(text);
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].name, "read_file");
    }
}
