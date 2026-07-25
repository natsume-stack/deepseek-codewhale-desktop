/**
 * 行级 Diff 算法（LCS 动态规划）
 *
 * 不引入 diff-match-patch 等依赖，保持轻量。
 * 输入：原始文本 / 修改后文本
 * 输出：行级 token 序列（equal / added / removed）
 *
 * 用于 DiffViewer 双栏渲染。
 */

export type DiffOp = 'equal' | 'added' | 'removed'

export interface DiffLine {
  type: DiffOp
  oldLine?: number  // 1-based，原始行号
  newLine?: number  // 1-based，修改后行号
  text: string
}

export interface DiffResult {
  lines: DiffLine[]
  /** 统计 */
  added: number
  removed: number
  unchanged: number
}

/** 将文本拆为行数组（保留末尾空行信息） */
function toLines(text: string): string[] {
  if (!text) return []
  return text.split('\n')
}

/**
 * 计算 LCS 表，回溯生成 DiffLine 序列。
 * 复杂度 O(n*m)，适合中等规模代码 Diff。
 */
export function computeDiff(oldText: string, newText: string): DiffResult {
  const a = toLines(oldText)
  const b = toLines(newText)
  const n = a.length
  const m = b.length

  // dp[i][j]: a 前 i 行与 b 前 j 行的 LCS 长度
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1])
      }
    }
  }

  // 回溯
  const lines: DiffLine[] = []
  let i = n
  let j = m
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      lines.unshift({ type: 'equal', oldLine: i, newLine: j, text: a[i - 1] })
      i--
      j--
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      lines.unshift({ type: 'removed', oldLine: i, text: a[i - 1] })
      i--
    } else {
      lines.unshift({ type: 'added', newLine: j, text: b[j - 1] })
      j--
    }
  }
  while (i > 0) {
    lines.unshift({ type: 'removed', oldLine: i, text: a[i - 1] })
    i--
  }
  while (j > 0) {
    lines.unshift({ type: 'added', newLine: j, text: b[j - 1] })
    j--
  }

  const added = lines.filter((l) => l.type === 'added').length
  const removed = lines.filter((l) => l.type === 'removed').length
  const unchanged = lines.filter((l) => l.type === 'equal').length

  return { lines, added, removed, unchanged }
}

/**
 * 将 DiffResult 拆分为左右两栏对齐行（用于双栏渲染）。
 * - equal: 左右都有
 * - removed: 左有右空
 * - added:  右有左空
 *
 * 对齐策略：连续的 removed + added 块两两配对，不足则填空行。
 */
export interface DiffRow {
  left: DiffLine | null
  right: DiffLine | null
}

export function toDualPane(diff: DiffResult): DiffRow[] {
  const rows: DiffRow[] = []
  const lines = diff.lines
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (line.type === 'equal') {
      rows.push({ left: line, right: line })
      i++
      continue
    }
    // 收集连续的 removed + added 块
    const removedBlock: DiffLine[] = []
    const addedBlock: DiffLine[] = []
    while (i < lines.length && lines[i].type === 'removed') {
      removedBlock.push(lines[i])
      i++
    }
    while (i < lines.length && lines[i].type === 'added') {
      addedBlock.push(lines[i])
      i++
    }
    // 配对
    const maxLen = Math.max(removedBlock.length, addedBlock.length)
    for (let k = 0; k < maxLen; k++) {
      rows.push({
        left: removedBlock[k] ?? null,
        right: addedBlock[k] ?? null,
      })
    }
  }
  return rows
}
