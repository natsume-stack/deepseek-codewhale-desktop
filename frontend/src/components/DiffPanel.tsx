/**
 * Diff 预览面板（右栏固定面板 - Codex 风格）
 *
 *  - 作为 WorkArea 右侧固定栏，替代原 ParamsPanel 位置
 *  - 列出当前会话所有 Diff 条目（按 createdAt 降序）
 *  - 折叠/展开单个 Diff 详情（双栏 DiffViewer）
 *  - 顶栏：标题 + 数量 + 应用全部 / 刷新 / 关闭按钮
 *  - 空状态提示
 *
 * 自动从 chat store 同步 sessionId。
 */
import { useEffect, useState } from 'react'
import { useChatStore } from '../stores/chat'
import { useDiffStore, selectByStatus } from '../stores/diffs'
import { DiffViewer } from './DiffViewer'

interface DiffPanelProps {
  /** 关闭按钮回调（折叠右栏） */
  onClose: () => void
}

export function DiffPanel({ onClose }: DiffPanelProps) {
  const sessionId = useChatStore((s) => s.sessionId)
  const diffs = useDiffStore((s) => s.diffs)
  const loading = useDiffStore((s) => s.loading)
  const error = useDiffStore((s) => s.error)
  const bindSession = useDiffStore((s) => s.bindSession)
  const refresh = useDiffStore((s) => s.refresh)
  const apply = useDiffStore((s) => s.apply)
  const reject = useDiffStore((s) => s.reject)
  const revert = useDiffStore((s) => s.revert)
  const applyAll = useDiffStore((s) => s.applyAll)

  const [expandedId, setExpandedId] = useState<string | null>(null)

  // 绑定会话：sessionId 变化时拉取 Diff 列表
  useEffect(() => {
    void bindSession(sessionId)
  }, [sessionId, bindSession])

  const groups = selectByStatus(diffs)
  const pendingCount = groups.pending.length
  const appliedCount = groups.applied.length
  const hasDiffs = diffs.length > 0

  return (
    <div className="h-full flex flex-col border-l border-white/5 bg-white/3">
      {/* 顶栏 */}
      <div className="panel-header">
        <div className="flex items-center gap-2 min-w-0">
          <DiffIcon />
          <span className="panel-title">变更</span>
          <div className="flex items-center gap-1.5 text-2xs font-mono">
            {pendingCount > 0 && (
              <span className="px-1.5 py-0.5 rounded bg-accent/15 text-accent">
                待应用 {pendingCount}
              </span>
            )}
            {appliedCount > 0 && (
              <span className="px-1.5 py-0.5 rounded bg-diff-added/30 text-diff-added-text">
                已应用 {appliedCount}
              </span>
            )}
            {diffs.length === 0 && (
              <span className="text-text-tertiary">无变更</span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          <button
            onClick={() => void refresh()}
            disabled={!sessionId || loading}
            className="icon-btn"
            title="刷新"
          >
            <RefreshIcon spinning={loading} />
          </button>
          <button
            onClick={() => void applyAll()}
            disabled={pendingCount === 0}
            className="btn-secondary !py-1 !px-2 !text-2xs"
            title="将所有待应用 Diff 写入磁盘"
          >
            应用全部
          </button>
          <button onClick={onClose} className="icon-btn" title="关闭面板">
            <CloseIcon />
          </button>
        </div>
      </div>

      {/* 错误条 */}
      {error && (
        <div className="px-3 py-1.5 text-2xs text-diff-removed-text bg-diff-removed/20 border-b border-diff-removed/40">
          {error}
        </div>
      )}

      {/* 列表 */}
      <div className="flex-1 overflow-auto p-3 space-y-2">
        {!hasDiffs ? (
          <EmptyHint />
        ) : (
          <>
            {groups.pending.length > 0 && (
              <SectionLabel>待应用 ({groups.pending.length})</SectionLabel>
            )}
            {groups.pending.map((d) => (
              <DiffEntryItem
                key={d.id}
                entry={d}
                expanded={expandedId === d.id}
                onToggle={() => setExpandedId((v) => (v === d.id ? null : d.id))}
                onApply={apply}
                onReject={reject}
                onRevert={revert}
              />
            ))}
            {groups.applied.length > 0 && (
              <SectionLabel>已应用 ({groups.applied.length})</SectionLabel>
            )}
            {groups.applied.map((d) => (
              <DiffEntryItem
                key={d.id}
                entry={d}
                expanded={expandedId === d.id}
                onToggle={() => setExpandedId((v) => (v === d.id ? null : d.id))}
                onApply={apply}
                onReject={reject}
                onRevert={revert}
              />
            ))}
            {(groups.rejected.length > 0 || groups.reverted.length > 0) && (
              <SectionLabel>历史 ({groups.rejected.length + groups.reverted.length})</SectionLabel>
            )}
            {[...groups.rejected, ...groups.reverted].map((d) => (
              <DiffEntryItem
                key={d.id}
                entry={d}
                expanded={expandedId === d.id}
                onToggle={() => setExpandedId((v) => (v === d.id ? null : d.id))}
                onApply={apply}
                onReject={reject}
                onRevert={revert}
              />
            ))}
          </>
        )}
      </div>
    </div>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-2xs uppercase tracking-wider text-text-tertiary font-mono px-1 pt-1">
      {children}
    </div>
  )
}

function EmptyHint() {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-2 text-center">
      <DiffIcon />
      <div className="text-xs text-text-tertiary">
        暂无代码变更。在对话中点击代码块的"应用修改"按钮即可在此预览。
      </div>
    </div>
  )
}

interface DiffEntryItemProps {
  entry: import('../types').DiffEntry
  expanded: boolean
  onToggle: () => void
  onApply: (id: string) => Promise<unknown>
  onReject: (id: string) => Promise<unknown>
  onRevert: (id: string) => Promise<unknown>
}

function DiffEntryItem({ entry, expanded, onToggle, onApply, onReject, onRevert }: DiffEntryItemProps) {
  const fileName = entry.filePath.replace(/\\/g, '/').split('/').pop() ?? entry.filePath
  return (
    <div>
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-left hover:bg-white/6 transition-colors"
      >
        <ChevronIcon open={expanded} />
        <span className="text-xs font-mono text-text-primary truncate flex-1">{fileName}</span>
        <span className="text-2xs text-text-tertiary">{entry.filePath}</span>
      </button>
      {expanded && (
        <div className="mt-1.5">
          <DiffViewer
            entry={entry}
            onApply={onApply}
            onReject={onReject}
            onRevert={onRevert}
          />
        </div>
      )}
    </div>
  )
}

function DiffIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" className="text-text-secondary">
      <path d="M4 1v4M4 11v4M1 4h6M1 12h6M10 1l3 14M9 8h6" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
    </svg>
  )
}

function CloseIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
      <line x1="4" y1="4" x2="12" y2="12" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <line x1="12" y1="4" x2="4" y2="12" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 16 16"
      fill="none"
      className={`text-text-tertiary transition-transform duration-150 ${open ? 'rotate-90' : ''}`}
    >
      <path d="M5 3l6 5-6 5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function RefreshIcon({ spinning }: { spinning?: boolean }) {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" className={spinning ? 'animate-spin' : ''}>
      <path d="M13 8a5 5 0 11-1.5-3.5M13 2v3h-3" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  )
}
