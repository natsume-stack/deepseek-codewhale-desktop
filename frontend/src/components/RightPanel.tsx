/**
 * 右侧多功能面板（Codex 风格多 Tab）
 *
 *  ┌──────────────────────────────┐
 *  │  变更 · 代办 · RAG             │ ← Tab 切换栏
 *  ├──────────────────────────────┤
 *  │                              │
 *  │  当前 Tab 内容（滚动）          │
 *  │  - 变更：复用 DiffPanel 列表   │
 *  │  - 代办：任务清单              │
 *  │  - RAG：召回面板               │
 *  │                              │
 *  └──────────────────────────────┘
 *
 * 取代原 DiffPanel 直接占据右栏的单一形态，对标 Codex 右侧多功能区。
 */
import { useEffect, useState } from 'react'
import { useDiffStore, selectByStatus } from '../stores/diffs'
import { useChatStore } from '../stores/chat'
import { useTodosStore } from '../stores/todos'
import { useDialogStore } from '../stores/dialog'
import { DiffViewer } from './DiffViewer'
import { RagPanel } from './RagPanel'
import { SkillExecuteLog } from './SkillExecuteLog'
import type { TodoItem } from '../types'

type RightTab = 'changes' | 'todos' | 'rag' | 'skill-log'

interface RightPanelProps {
  /** 关闭按钮回调（折叠右栏） */
  onClose: () => void
}

export function RightPanel({ onClose }: RightPanelProps) {
  const [tab, setTab] = useState<RightTab>('changes')

  const tabs: { key: RightTab; label: string; icon: React.ReactNode }[] = [
    { key: 'changes', label: '变更', icon: <ChangesIcon /> },
    { key: 'todos', label: '代办', icon: <TodoIcon /> },
    { key: 'rag', label: 'RAG', icon: <RagIcon /> },
    { key: 'skill-log', label: '技能日志', icon: <SkillLogIcon /> },
  ]

  return (
    <div className="h-full flex flex-col border-l border-white/8 bg-[#1b1b1b]">
      {/* === Tab 切换栏 === */}
      <div className="flex items-center justify-between px-2 py-2 border-b border-white/8 gap-2">
        <div className="flex items-center gap-0.5">
          {tabs.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`flex h-7 w-7 items-center justify-center text-xs rounded-md transition-colors duration-150 ease-out
                ${tab === t.key
                  ? 'text-text-primary bg-white/10'
                  : 'text-text-tertiary hover:text-text-secondary hover:bg-white/8'
                }`}
              title={t.label}
              aria-label={t.label}
            >
              <span className="opacity-80">{t.icon}</span>
              <span className="sr-only">{t.label}</span>
            </button>
          ))}
        </div>
        <button onClick={onClose} className="icon-btn" title="关闭面板">
          <CloseIcon />
        </button>
      </div>

      {/* === Tab 内容 === */}
      <div className="flex-1 min-h-0 overflow-hidden">
        <div key={tab} className="h-full animate-fade-in">
          {tab === 'changes' && <ChangesTab />}
          {tab === 'todos' && <TodosTab />}
          {tab === 'rag' && <RagTab />}
          {tab === 'skill-log' && <SkillLogTab />}
        </div>
      </div>
    </div>
  )
}

/* ============== 变更 Tab ============== */

function ChangesTab() {
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

  useEffect(() => {
    void bindSession(sessionId)
  }, [sessionId, bindSession])

  const groups = selectByStatus(diffs)
  const pendingCount = groups.pending.length
  const appliedCount = groups.applied.length
  const hasDiffs = diffs.length > 0

  return (
    <div className="h-full flex flex-col">
      {/* 操作条 */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-white/5">
        <div className="flex items-center gap-1.5 text-2xs font-mono">
          {pendingCount > 0 && (
            <span className="px-2 py-0.5 rounded-xl bg-warn/15 text-warn">
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
        <div className="flex items-center gap-1">
          <button
            onClick={() => void refresh()}
            disabled={!sessionId || loading}
            className="icon-btn !p-1"
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
        </div>
      </div>

      {/* 错误条 */}
      {error && (
        <div className="px-3 py-1.5 text-2xs text-diff-removed-text bg-diff-removed/20 border-b border-diff-removed/40">
          {error}
        </div>
      )}

      {/* 列表 */}
      <div className="flex-1 overflow-auto p-2 space-y-1">
        {!hasDiffs ? (
          <EmptyHint
            icon={<ChangesIcon />}
            text="暂无代码变更。在对话中点击代码块的「应用修改」即可在此预览。"
          />
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

/* ============== 代办 Tab（接入真实 todos store） ============== */

function TodosTab() {
  const todos = useTodosStore((s) => s.todos)
  const loading = useTodosStore((s) => s.loading)
  const error = useTodosStore((s) => s.error)
  const fetchAll = useTodosStore((s) => s.fetchAll)
  const fetchBySession = useTodosStore((s) => s.fetchBySession)
  const create = useTodosStore((s) => s.create)
  const updateStatus = useTodosStore((s) => s.updateStatus)
  // P0 修复跨会话污染：按当前会话拉取代办，无会话时回退到全部
  const sessionId = useChatStore((s) => s.sessionId)

  useEffect(() => {
    if (sessionId) {
      void fetchBySession(sessionId)
    } else {
      void fetchAll()
    }
  }, [sessionId, fetchAll, fetchBySession])

  const doneCount = todos.filter((t) => t.status === 'done').length
  const runningCount = todos.filter((t) => t.status === 'running').length
  const pendingCount = todos.filter((t) => t.status === 'pending').length

  /** 新增代办：弹出 prompt 对话框输入文本 */
  const handleAdd = async () => {
    const text = await useDialogStore.getState().prompt({
      title: '新增代办',
      placeholder: '输入代办内容…',
      confirmText: '新增',
    })
    if (text && text.trim()) {
      await create(text.trim())
    }
  }

  /** 点击 todo 切换状态：pending ↔ done */
  const toggle = (t: TodoItem) => {
    void updateStatus(t.id, t.status === 'done' ? 'pending' : 'done')
  }

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between px-3 py-2 border-b border-white/5">
        <div className="flex items-center gap-1.5 text-2xs font-mono">
          <span className="text-text-tertiary">
            {doneCount}/{todos.length} 已完成
          </span>
          {runningCount > 0 && (
            <span className="px-2 py-0.5 rounded-xl bg-white/10 text-text-primary flex items-center gap-1">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-white animate-pulse-soft" />
              进行中 {runningCount}
            </span>
          )}
          {pendingCount > 0 && runningCount === 0 && (
            <span className="text-text-tertiary">待处理 {pendingCount}</span>
          )}
        </div>
        <button
          onClick={() => void handleAdd()}
          disabled={loading}
          className="btn-secondary !py-1 !px-2 !text-2xs"
          title="新增代办"
        >
          + 新增
        </button>
      </div>

      {error && (
        <div className="px-3 py-1.5 text-2xs text-diff-removed-text bg-diff-removed/20 border-b border-diff-removed/40">
          {error}
        </div>
      )}

      <div className="flex-1 overflow-auto p-2 space-y-1">
        {todos.length === 0 ? (
          <EmptyHint icon={<TodoIcon />} text="暂无代办事项。AI 拆解任务后会自动列出。" />
        ) : (
          todos.map((t, index) => (
            <button
              key={t.id}
              onClick={() => toggle(t)}
              className="w-full flex items-start gap-3 px-3 py-2.5 rounded-xl text-left hover:bg-white/8 hover:scale-[1.01] transition-all duration-200 ease-bounce animate-slide-up-spring"
              style={{ animationDelay: `${index * 30}ms`, animationFillMode: 'both' }}
            >
              <span
                className={`mt-0.5 w-5 h-5 rounded-xl border flex items-center justify-center flex-shrink-0 transition-all duration-200
                  ${t.status === 'done'
                    ? 'bg-white/20 border-white/40 text-white'
                    : t.status === 'running'
                      ? 'border-white/30 text-transparent bg-white/5'
                      : 'border-white/15 text-transparent hover:border-white/30'
                  }`}
              >
                {t.status === 'running' ? (
                  <svg width="10" height="10" viewBox="0 0 16 16" fill="none" className="animate-spin text-text-primary">
                    <circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeWidth="1.4" strokeOpacity="0.25" />
                    <path d="M13.5 8a5.5 5.5 0 00-5.5-5.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                  </svg>
                ) : (
                  <CheckIcon />
                )}
              </span>
              <div className="min-w-0 flex-1">
                <div
                  className={`text-xs font-medium
                    ${t.status === 'done'
                      ? 'text-text-tertiary line-through'
                      : t.status === 'running'
                        ? 'text-text-primary'
                        : 'text-text-primary'
                    }`}
                >
                  {t.text}
                </div>
                {t.source && (
                  <div className="text-2xs text-text-tertiary mt-0.5">来自会话 {t.source}</div>
                )}
              </div>
            </button>
          ))
        )}
      </div>
    </div>
  )
}

/* ============== RAG Tab（接入 RagPanel） ============== */

function RagTab() {
  return <RagPanel />
}

/* ============== 技能日志 Tab（接入 SkillExecuteLog） ============== */

function SkillLogTab() {
  return <SkillExecuteLog />
}

/* ============== 共用子组件 ============== */

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-2xs uppercase tracking-wider text-text-tertiary font-mono px-2 pt-1 pb-0.5">
      {children}
    </div>
  )
}

function EmptyHint({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-2 text-center px-4">
      <span className="opacity-40">{icon}</span>
      <div className="text-xs text-text-tertiary leading-relaxed">{text}</div>
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
    <div className="animate-slide-up-spring" style={{ animationFillMode: 'both' }}>
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left hover:bg-white/8 hover:scale-[1.01] transition-all duration-200 ease-bounce"
      >
        <ChevronIcon open={expanded} />
        <span className="text-xs font-mono text-text-primary truncate flex-1">{fileName}</span>
        <span className="text-2xs text-text-tertiary">{entry.filePath}</span>
      </button>
      {expanded && (
        <div className="mt-1.5">
          <DiffViewer entry={entry} onApply={onApply} onReject={onReject} onRevert={onRevert} />
        </div>
      )}
    </div>
  )
}

/* ============== 图标 ============== */

function ChangesIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" className="text-text-secondary">
      <path d="M4 1v4M4 11v4M1 4h6M1 12h6M10 1l3 14M9 8h6" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
    </svg>
  )
}

function TodoIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" className="text-text-secondary">
      <rect x="2.5" y="3" width="2.5" height="2.5" rx="0.5" stroke="currentColor" strokeWidth="1.3" />
      <path d="M7 4.25h7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <rect x="2.5" y="7.5" width="2.5" height="2.5" rx="0.5" stroke="currentColor" strokeWidth="1.3" />
      <path d="M7 8.75h7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <rect x="2.5" y="12" width="2.5" height="2.5" rx="0.5" stroke="currentColor" strokeWidth="1.3" />
      <path d="M7 13.25h7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}

/** RAG 数据库 + 搜索图标 */
function RagIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" className="text-text-secondary">
      <ellipse cx="6.5" cy="3.5" rx="4.5" ry="2" stroke="currentColor" strokeWidth="1.1" />
      <path d="M2 3.5v7c0 1.1 2 2 4.5 2s4.5-.9 4.5-2v-7" stroke="currentColor" strokeWidth="1.1" fill="none" />
      <path d="M2 7c0 1.1 2 2 4.5 2s4.5-.9 4.5-2" stroke="currentColor" strokeWidth="1.1" fill="none" />
      <path d="M10.5 9.5L14 13" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <circle cx="12.5" cy="11.5" r="2.5" stroke="currentColor" strokeWidth="1.1" fill="none" />
    </svg>
  )
}

/** 技能日志：终端 + 闪电 */
function SkillLogIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" className="text-text-secondary">
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.1" />
      <path d="M4 6l2 2-2 2M7.5 10.5h4" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" />
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

function CheckIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 16 16" fill="none">
      <path d="M3 8.5l3 3 7-7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
