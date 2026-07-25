/**
 * 双栏 Diff 视图
 *
 *  - 左：原始内容；右：修改后内容
 *  - 同步滚动
 *  - 删除行红底 / 新增行绿底（颜色规范对齐 Palot: #3b2828 / #273827）
 *  - 行号列
 *  - 文件名头部
 *  - 单个应用 / 拒绝 / 撤销 按钮
 *
 * 当 entry.hunks 存在且非空时，切换为 hunk 列表视图，支持 hunk 粒度 apply/reject。
 * hunks 不存在时，回退到原双栏视图 + 整 Diff 应用按钮。
 */
import { forwardRef, useMemo, useRef, useState } from 'react'
import { computeDiff, toDualPane, type DiffRow } from '../lib/diff'
import { BASE, ApiError } from '../lib/api'
import type { DiffEntry } from '../types'

/* ============== Hunk 本地类型（避免依赖 types.ts 扩展） ============== */
interface HunkLine {
  kind: 'context' | 'added' | 'removed'
  content: string
  oldNo?: number
  newNo?: number
}
interface Hunk {
  index: number
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: HunkLine[]
  status: string
}

/* ============== Hunk 粒度 API 辅助函数（避免依赖 api.ts 扩展） ============== */
async function applyHunk(diffId: string, hunkIndex: number): Promise<unknown> {
  const resp = await fetch(
    `${BASE}/diffs/${encodeURIComponent(diffId)}/hunks/${hunkIndex}/apply`,
    { method: 'POST' },
  )
  if (!resp.ok) throw new ApiError(resp.status, `HTTP ${resp.status}`)
  return resp.json()
}

async function rejectHunk(diffId: string, hunkIndex: number): Promise<unknown> {
  const resp = await fetch(
    `${BASE}/diffs/${encodeURIComponent(diffId)}/hunks/${hunkIndex}/reject`,
    { method: 'POST' },
  )
  if (!resp.ok) throw new ApiError(resp.status, `HTTP ${resp.status}`)
  return resp.json()
}

interface DiffViewerProps {
  entry: DiffEntry
  onApply?: (id: string) => void | Promise<unknown>
  onReject?: (id: string) => void | Promise<unknown>
  onRevert?: (id: string) => void | Promise<unknown>
}

export function DiffViewer({ entry, onApply, onReject, onRevert }: DiffViewerProps) {
  // 若 entry 携带 hunks 字段且非空，切换为 hunk 列表视图；否则回退到双栏视图
  const entryWithHunks = entry as DiffEntry & { hunks?: Hunk[] }
  if (entryWithHunks.hunks && entryWithHunks.hunks.length > 0) {
    return (
      <HunkDiffView
        entry={entry}
        hunks={entryWithHunks.hunks}
        onApply={onApply}
        onReject={onReject}
        onRevert={onRevert}
      />
    )
  }
  return (
    <DualPaneDiffView
      entry={entry}
      onApply={onApply}
      onReject={onReject}
      onRevert={onRevert}
    />
  )
}

/* ============== 双栏 Diff 视图（原实现，hunks 不存在时兜底） ============== */

function DualPaneDiffView({ entry, onApply, onReject, onRevert }: DiffViewerProps) {
  const leftRef = useRef<HTMLDivElement | null>(null)
  const rightRef = useRef<HTMLDivElement | null>(null)

  const { rows, added, removed } = useMemo(() => {
    const diff = computeDiff(entry.originalContent ?? '', entry.modifiedContent)
    return {
      rows: toDualPane(diff),
      added: diff.added,
      removed: diff.removed,
    }
  }, [entry.originalContent, entry.modifiedContent])

  /** 双栏同步滚动（避免回环） */
  let syncing = false
  const onScroll = (side: 'left' | 'right') => (e: React.UIEvent<HTMLDivElement>) => {
    if (syncing) return
    syncing = true
    const src = e.currentTarget
    const tgt = side === 'left' ? rightRef.current : leftRef.current
    if (tgt) {
      tgt.scrollTop = src.scrollTop
      tgt.scrollLeft = src.scrollLeft
    }
    requestAnimationFrame(() => { syncing = false })
  }

  const fileName = entry.filePath.replace(/\\/g, '/').split('/').pop() ?? entry.filePath
  const fileExt = fileName.split('.').pop()?.toLowerCase() ?? ''
  const isPending = entry.status === 'pending'
  const isApplied = entry.status === 'applied'
  const isRejected = entry.status === 'rejected'
  const isReverted = entry.status === 'reverted'

  return (
    <div className="border border-white/8 rounded-md bg-white/4 overflow-hidden animate-fade-in">
      {/* 头部：文件名 + 统计 + 状态 + 操作 */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-white/6 border-b border-white/8">
        <div className="flex items-center gap-2 min-w-0">
          <FileBadge ext={fileExt} />
          <span className="text-xs font-mono text-text-primary truncate" title={entry.filePath}>
            {fileName}
          </span>
          <span className="text-2xs text-text-tertiary truncate hidden md:inline">{entry.filePath}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-2xs font-mono">
            <span className="text-diff-added-text">+{added}</span>
            <span className="mx-1 text-text-tertiary">·</span>
            <span className="text-diff-removed-text">-{removed}</span>
          </span>
          <StatusChip status={entry.status} />
          <div className="flex items-center gap-0.5">
            {isPending && onApply && (
              <button
                onClick={() => void onApply(entry.id)}
                className="btn-secondary !py-0.5 !px-2 !text-2xs"
                title="写入磁盘"
              >
                应用
              </button>
            )}
            {isPending && onReject && (
              <button
                onClick={() => void onReject(entry.id)}
                className="icon-btn"
                title="拒绝"
              >
                <RejectIcon />
              </button>
            )}
            {(isApplied || isRejected || isReverted) && onRevert && (
              <button
                onClick={() => void onRevert(entry.id)}
                className="icon-btn"
                title="撤销"
              >
                <UndoIcon />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* 双栏 Diff 主体 */}
      <div className="grid grid-cols-2 max-h-[420px]">
        <Pane
          title="原始"
          ref={leftRef}
          onScroll={onScroll('left')}
          rows={rows}
          side="left"
        />
        <Pane
          title="修改后"
          ref={rightRef}
          onScroll={onScroll('right')}
          rows={rows}
          side="right"
        />
      </div>
    </div>
  )
}

interface PaneProps {
  title: string
  rows: DiffRow[]
  side: 'left' | 'right'
  onScroll: (e: React.UIEvent<HTMLDivElement>) => void
}

const Pane = forwardRef<HTMLDivElement, PaneProps>(function Pane(props, ref) {
  const { title, rows, side, onScroll } = props
  return (
    <div className="flex flex-col border-r last:border-r-0 border-white/8 min-w-0">
      <div className="px-3 py-1 text-2xs uppercase tracking-wide text-text-tertiary border-b border-white/8 bg-white/4">
        {title}
      </div>
      <div
        ref={ref}
        onScroll={onScroll}
        className="flex-1 overflow-auto font-mono text-xs leading-5"
        data-selectable="true"
      >
        <table className="w-full border-collapse">
          <tbody>
            {rows.map((row, idx) => {
              const line = side === 'left' ? row.left : row.right
              const isEmpty = !line
              const isAdded = line?.type === 'added'
              const isRemoved = line?.type === 'removed'
              return (
                <tr
                  key={idx}
                  className={isAdded ? 'bg-diff-added' : isRemoved ? 'bg-diff-removed' : ''}
                >
                  <td className="select-none w-10 text-right pr-2 text-text-tertiary align-top">
                    {line?.[side === 'left' ? 'oldLine' : 'newLine'] ?? ''}
                  </td>
                  <td className="whitespace-pre px-2 align-top">
                    <span className={isAdded ? 'text-diff-added-text' : isRemoved ? 'text-diff-removed-text' : 'text-text-primary'}>
                      {isEmpty ? '\u00A0' : line!.text || '\u00A0'}
                    </span>
                  </td>
                </tr>
              )
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={2} className="px-3 py-2 text-text-tertiary italic">
                  （空）
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
})

function StatusChip({ status }: { status: DiffEntry['status'] }) {
  const map: Record<DiffEntry['status'], { label: string; cls: string }> = {
    pending: { label: '待应用', cls: 'bg-accent/15 text-accent' },
    applied: { label: '已应用', cls: 'bg-diff-added/40 text-diff-added-text' },
    rejected: { label: '已拒绝', cls: 'bg-white/8 text-text-tertiary' },
    reverted: { label: '已撤销', cls: 'bg-diff-removed/30 text-diff-removed-text' },
  }
  const v = map[status]
  return <span className={`px-1.5 py-0.5 rounded text-2xs font-mono ${v.cls}`}>{v.label}</span>
}

function FileBadge({ ext }: { ext: string }) {
  const color =
    ext === 'rs' ? '#dea584' :
    ext === 'ts' || ext === 'tsx' ? '#3178c6' :
    ext === 'js' || ext === 'jsx' ? '#f7df1e' :
    ext === 'py' ? '#3572a5' :
    '#9d9d9d'
  return (
    <span
      className="px-1.5 py-0.5 rounded text-2xs font-mono font-bold"
      style={{ color, backgroundColor: `${color}22` }}
    >
      {ext.toUpperCase().slice(0, 4)}
    </span>
  )
}

function RejectIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
      <line x1="4" y1="4" x2="12" y2="12" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <line x1="12" y1="4" x2="4" y2="12" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

function UndoIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
      <path d="M3 8h7a3 3 0 010 6H6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <path d="M5 5L2 8l3 3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  )
}

/* ============== Hunk 列表视图（entry.hunks 存在时启用） ============== */

interface HunkDiffViewProps {
  entry: DiffEntry
  hunks: Hunk[]
  onApply?: (id: string) => void | Promise<unknown>
  onReject?: (id: string) => void | Promise<unknown>
  onRevert?: (id: string) => void | Promise<unknown>
}

function HunkDiffView({ entry, hunks, onApply, onReject }: HunkDiffViewProps) {
  const [busyIdx, setBusyIdx] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  const fileName = entry.filePath.replace(/\\/g, '/').split('/').pop() ?? entry.filePath
  const fileExt = fileName.split('.').pop()?.toLowerCase() ?? ''

  /** 应用单个 hunk：调用本地 applyHunk，再触发父级 onApply 让 store 刷新 */
  const handleApply = async (hunkIndex: number) => {
    setBusyIdx(hunkIndex)
    setError(null)
    try {
      await applyHunk(entry.id, hunkIndex)
      if (onApply) await onApply(entry.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyIdx(null)
    }
  }

  /** 拒绝单个 hunk */
  const handleReject = async (hunkIndex: number) => {
    setBusyIdx(hunkIndex)
    setError(null)
    try {
      await rejectHunk(entry.id, hunkIndex)
      if (onReject) await onReject(entry.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyIdx(null)
    }
  }

  return (
    <div className="border border-white/8 rounded-md bg-white/4 overflow-hidden animate-fade-in">
      {/* 头部：文件名 + hunk 计数 + 整体状态 */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-white/6 border-b border-white/8">
        <div className="flex items-center gap-2 min-w-0">
          <FileBadge ext={fileExt} />
          <span className="text-xs font-mono text-text-primary truncate" title={entry.filePath}>
            {fileName}
          </span>
          <span className="text-2xs text-text-tertiary">{hunks.length} 个 hunk</span>
        </div>
        <StatusChip status={entry.status} />
      </div>

      {error && (
        <div className="px-3 py-1.5 text-2xs text-diff-removed-text bg-diff-removed/20 border-b border-diff-removed/40">
          {error}
        </div>
      )}

      {/* hunk 列表 */}
      <div className="max-h-[420px] overflow-auto divide-y divide-white/5">
        {hunks.map((hunk) => (
          <HunkRow
            key={hunk.index}
            hunk={hunk}
            busy={busyIdx === hunk.index}
            onApply={() => void handleApply(hunk.index)}
            onReject={() => void handleReject(hunk.index)}
          />
        ))}
      </div>
    </div>
  )
}

interface HunkRowProps {
  hunk: Hunk
  busy: boolean
  onApply: () => void
  onReject: () => void
}

function HunkRow({ hunk, busy, onApply, onReject }: HunkRowProps) {
  const isPending = hunk.status === 'pending'
  const isApplied = hunk.status === 'applied'
  const isRejected = hunk.status === 'rejected'

  return (
    <div className="font-mono text-xs">
      {/* hunk 头部：统一 diff 头 + 状态/操作 */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-white/4 border-b border-white/5 sticky top-0 z-10">
        <span className="text-2xs text-text-tertiary truncate">
          @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
        </span>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {isPending && (
            <>
              <button
                onClick={onApply}
                disabled={busy}
                className="btn-secondary !py-0.5 !px-2 !text-2xs"
                title="应用此 hunk"
              >
                {busy ? '…' : '应用'}
              </button>
              <button
                onClick={onReject}
                disabled={busy}
                className="icon-btn !p-1"
                title="拒绝此 hunk"
              >
                <RejectIcon />
              </button>
            </>
          )}
          {isApplied && (
            <span className="px-1.5 py-0.5 rounded text-2xs font-mono bg-diff-added/40 text-diff-added-text">
              ✓ 已应用
            </span>
          )}
          {isRejected && (
            <span className="px-1.5 py-0.5 rounded text-2xs font-mono bg-white/8 text-text-tertiary">
              ✗ 已拒绝
            </span>
          )}
        </div>
      </div>

      {/* hunk 行内容：左侧 old_no / 右侧 new_no / 行内容 */}
      <div className="overflow-x-auto" data-selectable="true">
        <table className="w-full border-collapse">
          <tbody>
            {hunk.lines.map((line, idx) => (
              <tr
                key={idx}
                className={
                  line.kind === 'added'
                    ? 'bg-diff-added'
                    : line.kind === 'removed'
                    ? 'bg-diff-removed'
                    : ''
                }
              >
                <td className="select-none w-10 text-right pr-2 text-text-tertiary align-top">
                  {line.oldNo ?? ''}
                </td>
                <td className="select-none w-10 text-right pr-2 text-text-tertiary align-top border-l border-white/5">
                  {line.newNo ?? ''}
                </td>
                <td className="select-none w-4 text-center align-top">
                  <span
                    className={
                      line.kind === 'added'
                        ? 'text-diff-added-text'
                        : line.kind === 'removed'
                        ? 'text-diff-removed-text'
                        : 'text-text-tertiary'
                    }
                  >
                    {line.kind === 'added' ? '+' : line.kind === 'removed' ? '-' : ' '}
                  </span>
                </td>
                <td className="whitespace-pre px-2 align-top">
                  <span
                    className={
                      line.kind === 'added'
                        ? 'text-diff-added-text'
                        : line.kind === 'removed'
                        ? 'text-diff-removed-text'
                        : 'text-text-primary'
                    }
                  >
                    {line.content || '\u00A0'}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
