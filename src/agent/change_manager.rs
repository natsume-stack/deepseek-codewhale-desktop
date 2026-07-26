//! ChangeManager: 变更管控模块,管理文件变更快照、Diff 注册、一键回滚。
//!
//! 借鉴 Aider 的 Diff 变更管理:
//! - 每次文件写操作前,自动创建原始文件快照
//! - Diff 注册到注册表,关联 task_id + step_index
//! - 支持单文件回滚、整任务回滚、按时间点回滚
//! - 防止破坏性修改(误删、覆盖)
//!
//! 简化实现:仅内存存储,不持久化,任务结束清理。

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// 文件快照 (变更前的原始内容)。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileSnapshot {
    /// 相对项目根的路径。
    pub path: String,
    /// 原始文件内容;None 表示文件原本不存在。
    pub content: Option<String>,
    pub taken_at: DateTime<Utc>,
}

/// 单次变更记录。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChangeRecord {
    pub id: Uuid,
    pub task_id: Uuid,
    pub step_index: u32,
    pub path: String,
    pub snapshot_before: FileSnapshot,
    pub change_type: ChangeType,
    pub applied_at: DateTime<Utc>,
}

/// 变更类型。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChangeType {
    Created,
    Modified,
    Deleted,
}

impl std::fmt::Display for ChangeType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Created => write!(f, "created"),
            Self::Modified => write!(f, "modified"),
            Self::Deleted => write!(f, "deleted"),
        }
    }
}

pub struct ChangeManager {
    /// task_id -> 按时间顺序的变更记录列表。
    changes: RwLock<HashMap<Uuid, Vec<ChangeRecord>>>,
    /// 工作区根目录 (用于解析相对路径)。
    workspace_root: RwLock<Option<PathBuf>>,
}

impl ChangeManager {
    pub fn new() -> Self {
        Self {
            changes: RwLock::new(HashMap::new()),
            workspace_root: RwLock::new(None),
        }
    }

    /// 设置工作区根目录 (任务启动时调用)。
    pub fn set_workspace(&self, root: PathBuf) {
        *self.workspace_root.write() = Some(root);
    }

    /// 在文件修改前创建快照。
    ///
    /// 读取当前文件内容 (若存在) 存为 FileSnapshot,并注册到 changes 表。
    /// 若文件原本不存在,记录为 Created;否则记录为 Modified。
    pub async fn snapshot_before(
        &self,
        task_id: Uuid,
        step_index: u32,
        path: &str,
    ) -> anyhow::Result<()> {
        let root = self
            .workspace_root
            .read()
            .clone()
            .ok_or_else(|| anyhow::anyhow!("workspace_root 未设置"))?;
        let abs = root.join(path);
        let content = if abs.exists() {
            Some(tokio::fs::read_to_string(&abs).await?)
        } else {
            None
        };
        let change_type = if content.is_none() {
            ChangeType::Created
        } else {
            ChangeType::Modified
        };
        let record = ChangeRecord {
            id: Uuid::new_v4(),
            task_id,
            step_index,
            path: path.to_string(),
            snapshot_before: FileSnapshot {
                path: path.to_string(),
                content,
                taken_at: Utc::now(),
            },
            change_type,
            applied_at: Utc::now(),
        };
        let mut changes = self.changes.write();
        changes.entry(task_id).or_insert_with(Vec::new).push(record);
        Ok(())
    }

    /// 应用 unified diff 格式的修复 (供 SelfReflection 使用)。
    ///
    /// 解析 unified diff,对每个文件: snapshot_before → 应用变更 → 记录 ChangeRecord。
    pub async fn apply_diff(&self, diff: &str, task_id: Uuid) -> anyhow::Result<()> {
        let root = self
            .workspace_root
            .read()
            .clone()
            .ok_or_else(|| anyhow::anyhow!("workspace_root 未设置"))?;
        let file_changes = parse_unified_diff(diff)?;
        if file_changes.is_empty() {
            return Err(anyhow::anyhow!("diff 中未解析到任何文件变更"));
        }
        for fc in &file_changes {
            let abs = root.join(&fc.path);
            // 修改前快照
            self.snapshot_before(task_id, 0, &fc.path).await?;
            // 读取原内容 (若存在)
            let original = if abs.exists() {
                tokio::fs::read_to_string(&abs).await?
            } else {
                String::new()
            };
            let new_content = apply_diff_to_file(&original, fc)?;
            // 确保父目录存在
            if let Some(parent) = abs.parent() {
                if !parent.exists() {
                    tokio::fs::create_dir_all(parent).await?;
                }
            }
            tokio::fs::write(&abs, new_content).await?;
            tracing::debug!("ChangeManager 已应用 diff 到 {}", fc.path);
        }
        Ok(())
    }

    /// 回滚单个文件到指定快照。
    pub async fn rollback_file(&self, change_id: Uuid) -> anyhow::Result<()> {
        let root = self
            .workspace_root
            .read()
            .clone()
            .ok_or_else(|| anyhow::anyhow!("workspace_root 未设置"))?;
        let snapshot = {
            let changes = self.changes.read();
            changes
                .values()
                .flatten()
                .find(|r| r.id == change_id)
                .map(|r| r.snapshot_before.clone())
        };
        let snapshot = snapshot
            .ok_or_else(|| anyhow::anyhow!("变更记录不存在: {}", change_id))?;
        let abs = root.join(&snapshot.path);
        match snapshot.content {
            Some(content) => tokio::fs::write(&abs, content).await?,
            None => {
                if abs.exists() {
                    tokio::fs::remove_file(&abs).await?;
                }
            }
        }
        Ok(())
    }

    /// 回滚整个任务的所有变更 (按时间倒序)。
    pub async fn rollback_task(&self, task_id: Uuid) -> anyhow::Result<()> {
        let root = self
            .workspace_root
            .read()
            .clone()
            .ok_or_else(|| anyhow::anyhow!("workspace_root 未设置"))?;
        let records: Vec<ChangeRecord> = {
            let changes = self.changes.read();
            changes.get(&task_id).cloned().unwrap_or_default()
        };
        // 按时间倒序回滚 (后改的先恢复)
        for record in records.iter().rev() {
            let abs = root.join(&record.snapshot_before.path);
            match &record.snapshot_before.content {
                Some(content) => tokio::fs::write(&abs, content).await?,
                None => {
                    if abs.exists() {
                        tokio::fs::remove_file(&abs).await?;
                    }
                }
            }
        }
        // 清理该任务的记录
        self.changes.write().remove(&task_id);
        tracing::info!("已回滚任务 {} 的 {} 项变更", task_id, records.len());
        Ok(())
    }

    /// 列出任务的所有变更。
    pub fn list_changes(&self, task_id: Uuid) -> Vec<ChangeRecord> {
        self.changes
            .read()
            .get(&task_id)
            .cloned()
            .unwrap_or_default()
    }

    /// 生成任务变更的 Diff 摘要 (供前端展示)。
    pub fn generate_diff_summary(&self, task_id: Uuid) -> String {
        let changes = self.list_changes(task_id);
        if changes.is_empty() {
            return "(无变更记录)".to_string();
        }
        let mut summary = format!("任务 {} 共 {} 项变更:\n", task_id, changes.len());
        for (i, record) in changes.iter().enumerate() {
            summary.push_str(&format!(
                "  {}. [{}] {} ({})\n",
                i + 1,
                record.change_type,
                record.path,
                record.applied_at.format("%H:%M:%S")
            ));
        }
        summary
    }

    /// 清理指定任务的变更记录 (任务结束时调用)。
    pub fn clear_task(&self, task_id: Uuid) {
        self.changes.write().remove(&task_id);
    }
}

impl Default for ChangeManager {
    fn default() -> Self {
        Self::new()
    }
}

// ============================================================
// Unified Diff 解析与应用
// ============================================================

/// 解析后的单个文件变更。
#[derive(Debug, Clone)]
pub struct FileChange {
    /// 相对路径 (已剥离 a/ b/ 前缀)。
    pub path: String,
    /// 该文件的 hunks。
    pub hunks: Vec<HunkChange>,
}

/// 解析后的单个 hunk。
#[derive(Debug, Clone)]
pub struct HunkChange {
    /// 原文件起始行 (1-based)。
    pub old_start: usize,
    /// hunk 内容行 (含 ' '/'+'/'-' 前缀)。
    pub lines: Vec<String>,
}

/// 解析 unified diff 为文件变更列表。
///
/// 支持:
///   - `--- a/path` / `+++ b/path` 文件头
///   - `@@ -start,count +start,count @@` hunk 头
///   - ` `/`+`/`-` 前缀行
///   - 多文件 diff
pub fn parse_unified_diff(diff: &str) -> anyhow::Result<Vec<FileChange>> {
    let diff = strip_markdown_fence(diff);
    let mut files: Vec<FileChange> = Vec::new();
    let mut current_file: Option<FileChange> = None;
    let mut current_hunk: Option<HunkChange> = None;
    // 标记是否已遇到 --- 行,等待配对的 +++ 行
    let mut pending_old_path: Option<String> = None;

    for line in diff.lines() {
        if line.starts_with("--- ") {
            // 关闭当前 hunk
            if let Some(h) = current_hunk.take() {
                if let Some(f) = &mut current_file {
                    f.hunks.push(h);
                }
            }
            // 解析 old path (仅记录,等 +++ 行确定实际路径)
            let raw = line
                .strip_prefix("--- ")
                .unwrap_or(line)
                .trim();
            pending_old_path = Some(raw.to_string());
        } else if line.starts_with("+++ ") {
            // 关闭当前文件
            if let Some(h) = current_hunk.take() {
                if let Some(f) = &mut current_file {
                    f.hunks.push(h);
                }
            }
            if let Some(f) = current_file.take() {
                files.push(f);
            }
            let raw = line
                .strip_prefix("+++ ")
                .unwrap_or(line)
                .trim();
            let path = strip_path_prefix(raw);
            current_file = Some(FileChange {
                path,
                hunks: Vec::new(),
            });
            pending_old_path = None;
        } else if line.starts_with("@@") {
            // 关闭上一个 hunk
            if let Some(h) = current_hunk.take() {
                if let Some(f) = &mut current_file {
                    f.hunks.push(h);
                }
            }
            let old_start = parse_hunk_header(line)?;
            current_hunk = Some(HunkChange {
                old_start,
                lines: Vec::new(),
            });
        } else if let Some(h) = &mut current_hunk {
            // hunk body 行
            if line.starts_with(' ')
                || line.starts_with('+')
                || line.starts_with('-')
                || line.starts_with('\\')
            {
                h.lines.push(line.to_string());
            }
        }
        // 忽略其他行 (如 "diff --git", "index ..." 等)
    }
    // 收尾
    if let Some(h) = current_hunk.take() {
        if let Some(f) = &mut current_file {
            f.hunks.push(h);
        }
    }
    if let Some(f) = current_file.take() {
        files.push(f);
    }
    let _ = pending_old_path; // 仅用于状态跟踪,不强制使用
    Ok(files)
}

/// 剥离 `a/` 或 `b/` 前缀。
fn strip_path_prefix(raw: &str) -> String {
    if let Some(p) = raw.strip_prefix("a/").or_else(|| raw.strip_prefix("b/")) {
        return p.to_string();
    }
    // 去除可能的时间戳后缀 (如 "path\t2024-01-01")
    raw.split_whitespace()
        .next()
        .unwrap_or(raw)
        .to_string()
}

/// 解析 `@@ -start,count +start,count @@` 中的 old_start。
fn parse_hunk_header(line: &str) -> anyhow::Result<usize> {
    let after = line
        .strip_prefix("@@")
        .unwrap_or(line)
        .trim();
    // 找到第二个 "@@" 之前的内容
    let header_body = match after.find("@@") {
        Some(idx) => &after[..idx],
        None => after,
    };
    let parts: Vec<&str> = header_body.split_whitespace().collect();
    if parts.is_empty() {
        return Err(anyhow::anyhow!("无效的 hunk header: {}", line));
    }
    // parts[0] = "-start,count"
    let old_part = parts[0].strip_prefix('-').unwrap_or(parts[0]);
    let old_start: usize = old_part
        .split(',')
        .next()
        .unwrap_or("0")
        .parse()
        .map_err(|e| anyhow::anyhow!("解析 old_start 失败: {e}"))?;
    Ok(old_start)
}

/// 将 diff 应用到原文件内容,返回新内容。
pub fn apply_diff_to_file(original: &str, fc: &FileChange) -> anyhow::Result<String> {
    let original_lines: Vec<&str> = original.lines().collect();
    let mut result: Vec<String> = Vec::new();
    let mut current_line: usize = 0; // 0-based 索引

    for hunk in &fc.hunks {
        let old_start_idx = hunk.old_start.saturating_sub(1); // 转 0-based
        // 拷贝 hunk 之前的未变更行
        while current_line < old_start_idx && current_line < original_lines.len() {
            result.push(original_lines[current_line].to_string());
            current_line += 1;
        }
        // 应用 hunk 行
        for line in &hunk.lines {
            match line.chars().next() {
                Some(' ') => {
                    // context 行: 从原文件拷贝
                    if current_line < original_lines.len() {
                        result.push(original_lines[current_line].to_string());
                        current_line += 1;
                    }
                }
                Some('-') => {
                    // 删除行: 跳过原文件对应行
                    current_line += 1;
                }
                Some('+') => {
                    // 新增行: 写入新内容
                    result.push(line[1..].to_string());
                }
                Some('\\') => {
                    // "\ No newline at end of file" 等元信息行,跳过
                }
                _ => {}
            }
        }
    }
    // 拷贝剩余行
    while current_line < original_lines.len() {
        result.push(original_lines[current_line].to_string());
        current_line += 1;
    }

    let mut output = result.join("\n");
    // 保留原文件末尾换行
    if original.ends_with('\n') && !output.is_empty() {
        output.push('\n');
    }
    Ok(output)
}

/// 剥离 ```diff ... ``` 或 ``` ... ``` 代码块包裹。
fn strip_markdown_fence(s: &str) -> &str {
    let trimmed = s.trim();
    if let Some(rest) = trimmed.strip_prefix("```") {
        let rest = rest.strip_prefix("diff").unwrap_or(rest);
        // 跳过首行换行
        let rest = rest.trim_start();
        if let Some(end) = rest.rfind("```") {
            return rest[..end].trim();
        }
        return rest.trim();
    }
    trimmed
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn parse_simple_unified_diff() {
        let diff = "--- a/src/lib.rs\n+++ b/src/lib.rs\n@@ -1,3 +1,3 @@\n fn main() {\n-    println!(\"hello\");\n+    println!(\"world\");\n }\n";
        let files = parse_unified_diff(diff).unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "src/lib.rs");
        assert_eq!(files[0].hunks.len(), 1);
        assert_eq!(files[0].hunks[0].old_start, 1);
        assert_eq!(files[0].hunks[0].lines.len(), 5);
    }

    #[test]
    fn parse_multi_file_diff() {
        let diff = "--- a/a.txt\n+++ b/a.txt\n@@ -1,1 +1,1 @@\n-old\n+new\n--- a/b.txt\n+++ b/b.txt\n@@ -1,1 +1,1 @@\n-x\n+y\n";
        let files = parse_unified_diff(diff).unwrap();
        assert_eq!(files.len(), 2);
        assert_eq!(files[0].path, "a.txt");
        assert_eq!(files[1].path, "b.txt");
    }

    #[test]
    fn apply_diff_replaces_line() {
        let original = "fn main() {\n    println!(\"hello\");\n}\n";
        let diff = "--- a/src/lib.rs\n+++ b/src/lib.rs\n@@ -1,3 +1,3 @@\n fn main() {\n-    println!(\"hello\");\n+    println!(\"world\");\n }\n";
        let files = parse_unified_diff(diff).unwrap();
        let result = apply_diff_to_file(original, &files[0]).unwrap();
        assert!(result.contains("world"));
        assert!(!result.contains("hello"));
        assert!(result.contains("fn main()"));
    }

    #[test]
    fn apply_diff_adds_line() {
        let original = "line1\nline3\n";
        let diff = "--- a/f.txt\n+++ b/f.txt\n@@ -1,1 +1,2 @@\n line1\n+line2\n line3\n";
        let files = parse_unified_diff(diff).unwrap();
        let result = apply_diff_to_file(original, &files[0]).unwrap();
        assert_eq!(result, "line1\nline2\nline3\n");
    }

    #[tokio::test]
    async fn snapshot_and_rollback_task() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().to_path_buf();
        let file_path = "test_file.txt";
        let abs = root.join(file_path);
        tokio::fs::write(&abs, "original content")
            .await
            .unwrap();

        let cm = ChangeManager::new();
        cm.set_workspace(root.clone());
        let task_id = Uuid::new_v4();

        // 快照
        cm.snapshot_before(task_id, 0, file_path).await.unwrap();
        assert_eq!(cm.list_changes(task_id).len(), 1);

        // 修改文件
        tokio::fs::write(&abs, "modified content")
            .await
            .unwrap();

        // 回滚
        cm.rollback_task(task_id).await.unwrap();
        let restored = tokio::fs::read_to_string(&abs).await.unwrap();
        assert_eq!(restored, "original content");
        // 回滚后记录应被清理
        assert!(cm.list_changes(task_id).is_empty());
    }

    #[tokio::test]
    async fn snapshot_new_file_rollback_removes_it() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().to_path_buf();
        let cm = ChangeManager::new();
        cm.set_workspace(root.clone());
        let task_id = Uuid::new_v4();

        let file_path = "new_file.txt";
        let abs = root.join(file_path);
        // 文件不存在时快照 → Created
        cm.snapshot_before(task_id, 0, file_path).await.unwrap();
        let records = cm.list_changes(task_id);
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].change_type, ChangeType::Created);

        // 创建文件
        let mut f = std::fs::File::create(&abs).unwrap();
        f.write_all(b"new content").unwrap();

        // 回滚应删除文件
        cm.rollback_task(task_id).await.unwrap();
        assert!(!abs.exists());
    }

    #[tokio::test]
    async fn apply_diff_creates_and_modifies() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().to_path_buf();
        let cm = ChangeManager::new();
        cm.set_workspace(root.clone());
        let task_id = Uuid::new_v4();

        // 先创建文件
        let file_path = "src/main.rs";
        let abs = root.join(file_path);
        tokio::fs::create_dir_all(abs.parent().unwrap())
            .await
            .unwrap();
        tokio::fs::write(&abs, "fn main() {\n    println!(\"hi\");\n}\n")
            .await
            .unwrap();

        // 应用 diff 修改
        let diff = "--- a/src/main.rs\n+++ b/src/main.rs\n@@ -1,3 +1,3 @@\n fn main() {\n-    println!(\"hi\");\n+    println!(\"hello\");\n }\n";
        cm.apply_diff(diff, task_id).await.unwrap();
        let content = tokio::fs::read_to_string(&abs).await.unwrap();
        assert!(content.contains("hello"));
        assert!(!content.contains("\"hi\""));

        // 回滚
        cm.rollback_task(task_id).await.unwrap();
        let restored = tokio::fs::read_to_string(&abs).await.unwrap();
        assert!(restored.contains("\"hi\""));
    }

    #[test]
    fn generate_diff_summary_empty() {
        let cm = ChangeManager::new();
        let summary = cm.generate_diff_summary(Uuid::new_v4());
        assert!(summary.contains("无变更记录"));
    }
}
