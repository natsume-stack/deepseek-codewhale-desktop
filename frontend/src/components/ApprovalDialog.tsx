/**
 * 全局审批监听弹窗组件（P0-8）
 *
 *  - 监听 useApprovalsStore.pendingCount
 *  - 当有 pending 审批时，在屏幕右下角弹出通知卡片（不阻塞，可多个堆叠）
 *  - 每张卡片显示：操作类型 icon + 描述 + 详情（可折叠）+ 批准/拒绝按钮
 *  - 点击批准/拒绝：调用 useApprovalsStore.decide(id, true/false)
 *  - 卡片样式：圆角 8px，半透明白底，阴影，宽度 360px
 *  - 入场动画：从右滑入，cubic-bezier(0.16,1,0.3,1)，200ms
 *  - 顶部有 "审批队列 (N)" 标题栏，可一键全部批准/拒绝
 *  - 组件挂载时启动轮询 useApprovalsStore.startPolling()，卸载时 stopPolling()
 *
 * 非阻塞浮层：z-40，低于 DialogHost（z-50），无全屏遮罩。
 */
import { useEffect, useState } from 'react'
import { useApprovalsStore, selectPendingCount } from '../stores/approvals'
import type { ApprovalKind, ApprovalRequest } from '../types'

export function ApprovalDialog() {
  const approvals = useApprovalsStore((s) => s.approvals)
  const decide = useApprovalsStore((s) => s.decide)
  const startPolling = useApprovalsStore((s) => s.startPolling)
  const stopPolling = useApprovalsStore((s) => s.stopPolling)

  // 挂载启动轮询，卸载停止
  useEffect(() => {
    startPolling()
    return () => stopPolling()
  }, [startPolling, stopPolling])

  // 仅展示 pending 审批；pendingCount 由派生选择器计算
  const pending = approvals.filter((a) => a.status === 'pending')
  const pendingCount = selectPendingCount(approvals)

  if (pending.length === 0) return null

  /** 一键全部批准 */
  const handleApproveAll = () => {
    void Promise.all(pending.map((a) => decide(a.id, true)))
  }

  /** 一键全部拒绝 */
  const handleRejectAll = () => {
    void Promise.all(pending.map((a) => decide(a.id, false)))
  }

  return (
    <div className="fixed bottom-4 right-4 z-40 flex flex-col gap-2 w-[360px] pointer-events-none">
      {/* 标题栏 */}
      <div className="pointer-events-auto flex items-center justify-between px-3 py-2 rounded-lg bg-surface-elevated/95 border border-surface-border shadow-raised animate-slide-in">
        <div className="flex items-center gap-2 min-w-0">
          <BellIcon />
          <span className="text-xs font-semibold text-text-primary truncate">
            审批队列 ({pendingCount})
          </span>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          <button
            onClick={handleApproveAll}
            className="btn-primary !py-0.5 !px-2 !text-2xs"
            title="全部批准"
          >
            全部批准
          </button>
          <button
            onClick={handleRejectAll}
            className="btn-secondary !py-0.5 !px-2 !text-2xs"
            title="全部拒绝"
          >
            全部拒绝
          </button>
        </div>
      </div>

      {/* 审批卡片堆叠（从下往上追加，最新在顶部） */}
      {pending.map((a) => (
        <ApprovalCard key={a.id} approval={a} />
      ))}
    </div>
  )
}

/* ============== 单张审批卡片 ============== */

function ApprovalCard({ approval }: { approval: ApprovalRequest }) {
  const decide = useApprovalsStore((s) => s.decide)
  const [expanded, setExpanded] = useState(false)
  const [busy, setBusy] = useState<null | boolean>(null)

  const handleDecide = async (approved: boolean) => {
    setBusy(approved)
    try {
      await decide(approval.id, approved)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="pointer-events-auto rounded-lg bg-surface-elevated/95 border border-surface-border shadow-raised overflow-hidden animate-slide-in">
      {/* 卡片头：icon + 标题 + 描述 */}
      <div className="flex items-start gap-2.5 px-3 py-2.5">
        <span className="mt-0.5 flex-shrink-0">
          <KindIcon kind={approval.kind} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-text-primary leading-relaxed">
            {approval.description}
          </div>
        </div>
      </div>

      {/* 详情可折叠 */}
      {approval.detail && (
        <div className="px-3 pb-1">
          <button
            onClick={() => setExpanded((v) => !v)}
            className="text-2xs text-accent hover:underline"
          >
            {expanded ? '收起详情' : '查看详情'}
          </button>
          {expanded && (
            <pre className="mt-1 px-2 py-1.5 rounded bg-black/30 border border-white/5 text-2xs font-mono text-text-secondary whitespace-pre-wrap break-all max-h-40 overflow-auto" data-selectable="true">
              {approval.detail}
            </pre>
          )}
        </div>
      )}

      {/* 按钮栏 */}
      <div className="flex gap-1.5 px-3 py-2 border-t border-white/5 bg-white/3">
        <button
          onClick={() => void handleDecide(true)}
          disabled={busy !== null}
          className="btn-primary flex-1 !py-1 !text-2xs"
        >
          {busy === true ? '处理中…' : '批准'}
        </button>
        <button
          onClick={() => void handleDecide(false)}
          disabled={busy !== null}
          className="btn-secondary flex-1 !py-1 !text-2xs"
        >
          {busy === false ? '处理中…' : '拒绝'}
        </button>
      </div>
    </div>
  )
}

/* ============== 图标 ============== */

function KindIcon({ kind }: { kind: ApprovalKind }) {
  if (kind === 'shell') return <ShellIcon />
  if (kind === 'filedelete') return <DeleteIcon />
  if (kind === 'git') return <GitIcon />
  return <FileWriteIcon />
}

function BellIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" className="text-accent">
      <path d="M8 1.5a4 4 0 014 4v3l1.5 2.5h-11L4 8.5v-3a4 4 0 014-4z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M6 12.5a2 2 0 004 0" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  )
}

function FileWriteIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" className="text-accent">
      <path d="M3 2h6l3 3v9H3V2z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
      <path d="M9 2v3h3" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
      <path d="M5.5 9.5L8 7l2.5 2.5M8 7v4" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function ShellIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" className="text-amber-400">
      <rect x="1.5" y="3" width="13" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.1" />
      <path d="M4 6.5L6 8.5L4 10.5" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M8 10.5h3.5" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
    </svg>
  )
}

function DeleteIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" className="text-rose-400">
      <path d="M3 4.5h10M6 4.5V3h4v1.5M5 4.5l.5 8h5l.5-8" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function GitIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" className="text-orange-400">
      <circle cx="4" cy="4" r="1.5" stroke="currentColor" strokeWidth="1.1" />
      <circle cx="4" cy="12" r="1.5" stroke="currentColor" strokeWidth="1.1" />
      <circle cx="12" cy="8" r="1.5" stroke="currentColor" strokeWidth="1.1" />
      <path d="M4 5.5v5M4.8 4.5L11 7.2" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
    </svg>
  )
}
