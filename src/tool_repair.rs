//! Reasonix Tool-Call Repair（P0+）。
//!
//! 兼容 DeepSeek V4/R1 工具调用缺陷：
//! - 截断 JSON：流式中途断包导致 `}` / `]` / `"` 缺失，按栈匹配补全
//! - 深嵌套参数：模型偶发产出 5+ 层嵌套，拍平到顶层降低解析失败率
//! - 重复风暴调用：同一工具同一参数连续调用 N 次，识别并告警
//!
//! 修复过程仅作用于"工具调用内容"本身，绝不改动缓存前缀字节。

use crate::error::{AppError, AppResult};
use serde_json::{Map, Value};

/// 修复截断的 JSON 字符串。
///
/// 使用简单栈匹配：
/// - 遇到 `{` 压栈 `}`
/// - 遇到 `[` 压栈 `]`
/// - 遇到 `"` 进入字符串态，下一个非转义 `"` 退出
/// - 末尾按栈顺序反向补全缺失的闭合字符
///
/// 同时处理字符串内部未闭合情况（补一个 `"`）。
pub fn repair_truncated_json(s: &str) -> String {
    let trimmed = s.trim();
    if trimmed.is_empty() {
        return "{}".to_string();
    }
    // 先尝试原样解析
    if serde_json::from_str::<Value>(trimmed).is_ok() {
        return trimmed.to_string();
    }

    let bytes: Vec<char> = trimmed.chars().collect();
    let mut stack: Vec<char> = Vec::new();
    let mut in_string = false;
    let mut escape = false;
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i];
        if in_string {
            if escape {
                escape = false;
            } else if c == '\\' {
                escape = true;
            } else if c == '"' {
                in_string = false;
                stack.pop(); // 弹出 '"' 标记
            }
        } else {
            match c {
                '"' => {
                    in_string = true;
                    stack.push('"');
                }
                '{' => stack.push('}'),
                '[' => stack.push(']'),
                '}' | ']' => {
                    // 匹配则弹出栈顶
                    if stack.last() == Some(&c) {
                        stack.pop();
                    }
                }
                _ => {}
            }
        }
        i += 1;
    }

    let mut out = trimmed.to_string();
    // 字符串未闭合：先补 "
    if in_string {
        out.push('"');
    }
    // 按栈逆序补全闭合
    while let Some(c) = stack.pop() {
        if c != '"' {
            out.push(c);
        }
    }
    out
}

/// 修复深嵌套参数：嵌套超过 3 层的拍平到顶层。
///
/// 拍平规则：对 Object 类型递归遍历，将嵌套子键用 "_" 连接提升到顶层。
/// 例如 `{"a": {"b": {"c": {"d": 1}}}}` → `{"a_b_c_d": 1}`。
/// 数组保持原样（避免下标语义被破坏）。
pub fn repair_deep_nested(args: Value) -> Value {
    flatten_value(args, None, 0)
}

fn flatten_value(v: Value, prefix: Option<String>, depth: usize) -> Value {
    const MAX_DEPTH: usize = 3;
    // 提前判断是否超过深度阈值，避免 match 后 v 已 move
    if depth >= MAX_DEPTH {
        if v.is_object() {
            return Value::String(v.to_string());
        }
        return v;
    }
    match v {
        Value::Object(map) => {
            let mut out = Map::new();
            for (k, val) in map {
                let new_key = match &prefix {
                    Some(p) => format!("{}_{}", p, k),
                    None => k,
                };
                let flattened = flatten_value(val, Some(new_key.clone()), depth + 1);
                // 若子项展开后仍是对象且 key 与 new_key 相同则直接合并（避免双重前缀）
                if let Value::Object(sub) = &flattened {
                    if prefix.is_some() && depth > 0 {
                        // 子对象合并到当前层
                        for (sk, sv) in sub {
                            out.insert(sk.clone(), sv.clone());
                        }
                        continue;
                    }
                }
                out.insert(new_key, flattened);
            }
            Value::Object(out)
        }
        other => other,
    }
}

/// 检测重复风暴调用：返回告警字符串列表。
///
/// 告警条件：连续 3+ 次相同工具名 + 相同参数（参数 JSON 字符串化后比较）。
pub fn detect_storm_calls(history: &[Value]) -> Vec<String> {
    let mut alerts = Vec::new();
    if history.len() < 3 {
        return alerts;
    }
    // history 假设为按时间顺序的工具调用 JSON 数组，每项形如 {"name":"X","arguments":{...}}
    let mut i = 0;
    while i + 2 < history.len() {
        let a = &history[i];
        let b = &history[i + 1];
        let c = &history[i + 2];
        let name_a = a.get("name").and_then(|v| v.as_str()).unwrap_or("");
        let name_b = b.get("name").and_then(|v| v.as_str()).unwrap_or("");
        let name_c = c.get("name").and_then(|v| v.as_str()).unwrap_or("");
        if name_a == name_b && name_b == name_c && !name_a.is_empty() {
            let args_a = a
                .get("arguments")
                .map(|v| v.to_string())
                .unwrap_or_default();
            let args_b = b
                .get("arguments")
                .map(|v| v.to_string())
                .unwrap_or_default();
            let args_c = c
                .get("arguments")
                .map(|v| v.to_string())
                .unwrap_or_default();
            if args_a == args_b && args_b == args_c {
                alerts.push(format!(
                    "检测到风暴调用：工具 \"{}\" 参数 {} 连续调用 3 次 (索引 {},{},{})",
                    name_a, args_a, i, i + 1, i + 2
                ));
                i += 3;
                continue;
            }
        }
        i += 1;
    }
    alerts
}

/// 综合修复入口：补全截断 JSON → 解析 → 拍平深嵌套 → 风暴告警。
///
/// 修复后返回标准 JSON Value。风暴告警会以 `tracing::warn!` 记录但不影响返回值。
pub fn repair_tool_call(raw: &str, history: &[Value]) -> AppResult<Value> {
    let repaired = repair_truncated_json(raw);
    let parsed: Value = serde_json::from_str(&repaired).map_err(|e| {
        AppError::Tool(format!("工具调用 JSON 修复后仍解析失败: {e}; raw={raw}"))
    })?;
    let flattened = repair_deep_nested(parsed);

    // 风暴检测仅针对有 name 字段的标准工具调用
    if flattened.is_object() {
        let mut hist_with_current = history.to_vec();
        hist_with_current.push(flattened.clone());
        for alert in detect_storm_calls(&hist_with_current) {
            tracing::warn!("{}", alert);
        }
    }
    Ok(flattened)
}

/* ============================================================
 * 单元测试
 * ============================================================ */

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_repair_truncated_object() {
        let s = "{\"name\":\"read_file\",\"arguments\":{\"path\":\"src/main.rs\"";
        let r = repair_truncated_json(s);
        let v: Value = serde_json::from_str(&r).expect("应可解析");
        assert_eq!(v["name"], "read_file");
    }

    #[test]
    fn test_repair_truncated_array() {
        let s = "[1,2,3";
        let r = repair_truncated_json(s);
        assert!(r.ends_with(']'));
        let v: Value = serde_json::from_str(&r).expect("应可解析");
        assert_eq!(v[2], 3);
    }

    #[test]
    fn test_repair_truncated_string() {
        let s = "{\"path\":\"src/main.rs}";
        let r = repair_truncated_json(s);
        // 应补全 " 与 }
        assert!(r.ends_with("\"}"));
    }

    #[test]
    fn test_repair_deep_nested_flatten() {
        let v = json!({
            "a": {
                "b": {
                    "c": {
                        "d": 1
                    }
                }
            }
        });
        let flat = repair_deep_nested(v);
        // depth 0 -> key "a"; depth 1 -> key "a_b"; depth 2 -> key "a_b_c"; depth 3 = MAX, 序列化为字符串
        let obj = flat.as_object().expect("应为对象");
        assert!(obj.contains_key("a_b_c"));
    }

    #[test]
    fn test_detect_storm_calls() {
        let h = vec![
            json!({"name":"read_file","arguments":{"path":"a.rs"}}),
            json!({"name":"read_file","arguments":{"path":"a.rs"}}),
            json!({"name":"read_file","arguments":{"path":"a.rs"}}),
        ];
        let alerts = detect_storm_calls(&h);
        assert_eq!(alerts.len(), 1);
    }

    #[test]
    fn test_repair_tool_call_ok() {
        let raw = "{\"name\":\"read_file\",\"arguments\":{\"path\":\"a.rs\"}";
        let v = repair_tool_call(raw, &[]).expect("应成功");
        assert_eq!(v["name"], "read_file");
    }
}
