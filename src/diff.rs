//! Myers 风格 Diff 算法实现（P0-3 增量 Diff 逐块接受/拒绝）。
//!
//! 用于将「原始内容」与「修改后内容」对比，生成 hunk 列表。
//! 每个 hunk 可独立 apply/reject，支持逐块变更选择性接受。
//!
//! 实现策略：采用 LCS（最长公共子序列）动态规划生成行级 diff，
//! 再将连续变更压缩为独立 hunk，每个 hunk 前后保留 3 行 context，
//! 相邻 hunk 上下文重叠时合并为一个 hunk。O(n*m) 复杂度对小文件足够。
//!
//! 算法正确性说明（单元测试式注释）：
//!   - diff_hunks("a\nb\nc", "a\nb\nc") 应返回空 hunks
//!   - diff_hunks("a", "b") 应返回 1 个 hunk（removed a, added b）
//!   - diff_hunks("", "a\nb") 应返回 1 个 hunk（纯新增）
//!   - diff_hunks("a\nb", "") 应返回 1 个 hunk（纯删除）
//!   - apply_hunk 应用后，再 diff_hunks 应得到空 hunks（幂等）

use serde::Serialize;

/// 单个 Diff hunk（变更块）。
///
/// 一个 hunk 表示原始文件中连续若干行被替换为新增的连续若干行。
/// 客户端可按 hunk 粒度独立 apply/reject。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hunk {
    /// hunk 在 DiffEntry 内的索引（0-based）。
    pub index: usize,
    /// 原始文件起始行号（1-based）。
    pub old_start: usize,
    /// 原始文件行数（0=纯新增）。
    pub old_lines: usize,
    /// 修改后起始行号（1-based）。
    pub new_start: usize,
    /// 修改后行数（0=纯删除）。
    pub new_lines: usize,
    /// hunk 内容（带 +/- 前缀的行）。
    pub lines: Vec<HunkLine>,
    /// hunk 状态（pending/applied/rejected）。
    pub status: String,
}

/// hunk 单行（带增删标记）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HunkLine {
    /// 行类型：context（上下文）/ added（新增）/ removed（删除）。
    pub kind: String,
    /// 行内容（不含换行符）。
    pub content: String,
    /// 原始行号（added 行为 None）。
    pub old_no: Option<usize>,
    /// 新行号（removed 行为 None）。
    pub new_no: Option<usize>,
}

/// 编辑操作（LCS 回溯产物，内部使用）。
#[derive(Debug, Clone)]
enum Edit {
    /// 相等行（context）：(old_line_no, new_line_no, content)
    Equal(usize, usize, String),
    /// 删除行：(old_line_no, content)
    Removed(usize, String),
    /// 新增行：(new_line_no, content)
    Added(usize, String),
}

/// 上下文行数（统一 diff 风格，每个 hunk 前后保留 N 行）。
const CONTEXT_LINES: usize = 3;

/// 对比原始内容与修改后内容，生成 hunk 列表。
///
/// 算法步骤：
/// 1. 按行切分 old/new
/// 2. 计算 LCS DP 表（dp[i][j] = old[0..i] 与 new[0..j] 的 LCS 长度）
/// 3. 回溯得到 Edit 序列：相等走对角线，否则比较 dp[i-1][j] 与 dp[i][j-1] 决定 Removed/Added
/// 4. 将连续的非 Equal 操作打包为变更块，并附加上下文
/// 5. 合并上下文重叠的相邻变更块
pub fn diff_hunks(old: &str, new: &str) -> Vec<Hunk> {
    let old_lines: Vec<&str> = old.lines().collect();
    let new_lines: Vec<&str> = new.lines().collect();

    // 完全相同直接返回空 hunks
    if old == new {
        return Vec::new();
    }

    let m = old_lines.len();
    let n = new_lines.len();

    // Step 1: 计算 LCS DP 表
    // dp[i][j] = old[0..i] 与 new[0..j] 的最长公共子序列长度
    let mut dp = vec![vec![0usize; n + 1]; m + 1];
    for i in 1..=m {
        for j in 1..=n {
            if old_lines[i - 1] == new_lines[j - 1] {
                dp[i][j] = dp[i - 1][j - 1] + 1;
            } else {
                dp[i][j] = dp[i - 1][j].max(dp[i][j - 1]);
            }
        }
    }

    // Step 2: 回溯得到 Edit 序列（从 dp[m][n] 出发，从后往前，最后反转）
    let mut edits: Vec<Edit> = Vec::with_capacity(m + n);
    let mut i = m;
    let mut j = n;
    while i > 0 || j > 0 {
        if i > 0 && j > 0 && old_lines[i - 1] == new_lines[j - 1] {
            edits.push(Edit::Equal(i, j, old_lines[i - 1].to_string()));
            i -= 1;
            j -= 1;
        } else if j > 0 && (i == 0 || dp[i][j - 1] >= dp[i - 1][j]) {
            edits.push(Edit::Added(j, new_lines[j - 1].to_string()));
            j -= 1;
        } else {
            edits.push(Edit::Removed(i, old_lines[i - 1].to_string()));
            i -= 1;
        }
    }
    edits.reverse();

    // Step 3: 找出所有变更块（连续的非 Equal 区间 [start, end)）
    let mut change_blocks: Vec<(usize, usize)> = Vec::new();
    let mut k = 0;
    while k < edits.len() {
        if matches!(edits[k], Edit::Equal(..)) {
            k += 1;
            continue;
        }
        let start = k;
        while k < edits.len() && !matches!(edits[k], Edit::Equal(..)) {
            k += 1;
        }
        change_blocks.push((start, k));
    }

    if change_blocks.is_empty() {
        return Vec::new();
    }

    // Step 4: 合并上下文重叠的相邻变更块
    // 每个 block 扩展为 [start - CONTEXT_LINES, end + CONTEXT_LINES]
    // 若扩展后区间与上一个 block 重叠，则合并
    let mut merged: Vec<(usize, usize)> = Vec::new();
    for &(s, e) in &change_blocks {
        let cs = s.saturating_sub(CONTEXT_LINES);
        let ce = (e + CONTEXT_LINES).min(edits.len());
        if let Some(last) = merged.last_mut() {
            if cs <= last.1 {
                last.1 = last.1.max(ce);
                continue;
            }
        }
        merged.push((cs, ce));
    }

    // Step 5: 为每个合并后的区间生成 Hunk
    let mut hunks = Vec::with_capacity(merged.len());
    for (idx, (s, e)) in merged.iter().enumerate() {
        let mut lines: Vec<HunkLine> = Vec::with_capacity(*e - *s);
        let mut old_start: Option<usize> = None;
        let mut new_start: Option<usize> = None;
        let mut old_lines_count = 0usize;
        let mut new_lines_count = 0usize;

        for ed in &edits[*s..*e] {
            match ed {
                Edit::Equal(o, n_, content) => {
                    if old_start.is_none() {
                        old_start = Some(*o);
                    }
                    if new_start.is_none() {
                        new_start = Some(*n_);
                    }
                    lines.push(HunkLine {
                        kind: "context".into(),
                        content: content.clone(),
                        old_no: Some(*o),
                        new_no: Some(*n_),
                    });
                    old_lines_count += 1;
                    new_lines_count += 1;
                }
                Edit::Removed(o, content) => {
                    if old_start.is_none() {
                        old_start = Some(*o);
                    }
                    lines.push(HunkLine {
                        kind: "removed".into(),
                        content: content.clone(),
                        old_no: Some(*o),
                        new_no: None,
                    });
                    old_lines_count += 1;
                }
                Edit::Added(n_, content) => {
                    if new_start.is_none() {
                        new_start = Some(*n_);
                    }
                    lines.push(HunkLine {
                        kind: "added".into(),
                        content: content.clone(),
                        old_no: None,
                        new_no: Some(*n_),
                    });
                    new_lines_count += 1;
                }
            }
        }

        // 纯新增/纯删除场景下 start 可能为 None，兜底取 1
        let old_start = old_start.unwrap_or(1);
        let new_start = new_start.unwrap_or(1);

        hunks.push(Hunk {
            index: idx,
            old_start,
            old_lines: old_lines_count,
            new_start,
            new_lines: new_lines_count,
            lines,
            status: "pending".into(),
        });
    }

    hunks
}

/// 将指定 hunk 应用到原始内容，返回应用后的完整文件内容。
///
/// 算法：
/// 1. 按 old_start（1-based）定位 old 文件中需要替换的起点（转 0-based）
/// 2. 提取 hunk 中 context + removed 行作为「期望的 old 区域」
/// 3. 验证 old 对应位置内容与期望匹配，不匹配则返回原 old（保守策略）
/// 4. 替换：将 old 区域替换为 context + added 行
///
/// 内部直接复用 apply_hunks 批量实现，保证单 hunk 与多 hunk 逻辑一致。
pub fn apply_hunk(old: &str, hunk: &Hunk) -> String {
    apply_hunks(old, std::slice::from_ref(hunk))
}

/// 批量应用多个 hunk，按 old_start 升序应用，自动处理行号偏移。
///
/// 注意：每个 hunk 应用后，后续 hunk 的 old_start 需要加上
/// (new_lines - old_lines) 的累计偏移。本函数内部维护 line_offset 跟踪偏移。
///
/// 若某 hunk 的 context 验证失败（说明文件内容与预期不符），则跳过该 hunk。
pub fn apply_hunks(old: &str, hunks: &[Hunk]) -> String {
    if hunks.is_empty() {
        return old.to_string();
    }

    // 按 old_start 升序排序（不修改原切片）
    let mut sorted: Vec<Hunk> = hunks.to_vec();
    sorted.sort_by_key(|h| h.old_start);

    let had_trailing_newline = old.ends_with('\n');
    let mut current: Vec<String> = old.lines().map(|s| s.to_string()).collect();
    let mut line_offset: i64 = 0; // 累计行号偏移

    for hunk in &sorted {
        // 定位 hunk 在 current 中的起点（考虑之前应用导致的偏移）
        let start_idx = hunk.old_start as i64 + line_offset - 1; // 转 0-based
        if start_idx < 0 || start_idx as usize > current.len() {
            continue; // 越界，跳过
        }

        // 提取 hunk 中 context + removed 行作为「期望的 old 区域」
        let mut expected_old: Vec<String> = Vec::new();
        for line in &hunk.lines {
            match line.kind.as_str() {
                "context" | "removed" => expected_old.push(line.content.clone()),
                _ => {}
            }
        }

        let end_idx = (start_idx as usize) + expected_old.len();
        if end_idx > current.len() {
            continue; // 越界，跳过
        }

        // 验证 context + removed 行匹配
        let actual_old: Vec<String> = current[start_idx as usize..end_idx].to_vec();
        if actual_old != expected_old {
            continue; // 不匹配，跳过此 hunk（保守策略）
        }

        // 构造替换内容：context + added 保留，removed 跳过
        let mut replacement: Vec<String> = Vec::new();
        for line in &hunk.lines {
            match line.kind.as_str() {
                "context" => replacement.push(line.content.clone()),
                "added" => replacement.push(line.content.clone()),
                "removed" => {} // 移除
                _ => {}
            }
        }

        // 替换 current[start_idx..end_idx] 为 replacement
        current.splice(start_idx as usize..end_idx, replacement.iter().cloned());

        // 更新行号偏移
        let delta = (hunk.new_lines as i64) - (hunk.old_lines as i64);
        line_offset += delta;
    }

    // 重新拼接，保留原文件末尾换行行为
    let mut result = current.join("\n");
    if had_trailing_newline {
        result.push('\n');
    }
    result
}

/// 拒绝指定 hunk：返回原 old 不变（语义占位）。
///
/// 语义：拒绝一个 hunk 意味着不应用该变更，文件内容保持原样。
pub fn reject_hunk(old: &str, _hunk: &Hunk) -> String {
    old.to_string()
}
