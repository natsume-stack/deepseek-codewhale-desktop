/**
 * 高危操作拦截弹窗（SandboxAlertDialog）
 *
 * 布局:
 *   ┌─ ⚠ 高危操作拦截 ────────────────────────────────┐
 *   │ 检测到高危操作，需要确认:                        │
 *   │ 工具: shell.exec                                │
 *   │ 命令: git push --force origin main              │
 *   │ 原因: 命中高危模式: git push --force            │
 *   │ [拒绝]              [批准此项]                   │
 *   └─────────────────────────────────────────────────┘
 *
 * - 接收 alert: SandboxAlert | null + onApprove/onReject 回调
 * - 模态居中，背景蒙层 bg-black/60
 * - 卡片 bg-elevated rounded-2xl p-6
 * - 拒绝按钮: bg-white/10 灰色
 * - 批准按钮: bg-orange-500 橙色（警示色）
 * - 出现动画: animate-scale-in
 */
import type { SandboxAlert, ToolCall } from '../types'

interface SandboxAlertDialogProps {
  alert: SandboxAlert | null
  onApprove: () => void
  onReject: () => void
}

export function SandboxAlertDialog({ alert, onApprove, onReject }: SandboxAlertDialogProps) {
  if (!alert) return null

  const toolName = alert.call?.tool_name ?? 'unknown'
  const command = extractCommand(alert.call)

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 animate-fade-in"
      onClick={onReject}
    >
      <div
        className="w-[460px] max-w-[92vw] rounded-2xl border border-warn/30 bg-surface-elevated shadow-raised overflow-hidden animate-scale-in"
        onClick={(e) => e.stopPropagation()}
      >
        {/* === 标题栏 === */}
        <div className="flex items-center gap-2 px-5 py-3.5 border-b border-warn/20 bg-warn/8">
          <WarnIcon />
          <span className="text-sm font-semibold text-warn">高危操作拦截</span>
        </div>

        {/* === 内容 === */}
        <div className="px-5 py-4 space-y-3">
          <div className="text-xs text-text-secondary leading-relaxed">
            检测到高危操作，需要确认：
          </div>

          <div className="space-y-1.5 px-3 py-2.5 rounded-md bg-black/30 border border-white/6">
            <FieldRow label="工具" value={toolName} mono />
            {command && <FieldRow label="命令" value={command} mono highlight />}
            <FieldRow label="原因" value={alert.reason} />
          </div>
        </div>

        {/* === 按钮栏 === */}
        <div className="flex justify-end gap-2 px-5 py-3.5 border-t border-white/5 bg-white/3">
          <button
            onClick={onReject}
            className="btn-secondary !px-4 !py-1.5 !text-xs"
            autoFocus
          >
            拒绝
          </button>
          <button
            onClick={onApprove}
            className="btn-warn !px-4 !py-1.5 !text-xs"
          >
            批准此项
          </button>
        </div>
      </div>
    </div>
  )
}

/* ============== 字段行 ============== */

interface FieldRowProps {
  label: string
  value: string
  mono?: boolean
  highlight?: boolean
}

function FieldRow({ label, value, mono, highlight }: FieldRowProps) {
  return (
    <div className="flex items-start gap-2">
      <span className="text-2xs text-text-tertiary font-mono flex-shrink-0 w-10">
        {label}：
      </span>
      <span
        className={`text-xs leading-relaxed break-all min-w-0 flex-1 ${
          mono ? 'font-mono' : ''
        } ${highlight ? 'text-warn' : 'text-text-primary'}`}
      >
        {value}
      </span>
    </div>
  )
}

/* ============== 工具：从 ToolCall 提取命令文本 ============== */

function extractCommand(call: ToolCall | null | undefined): string {
  if (!call) return ''
  const args = call.arguments ?? {}
  // 常见字段名：command / cmd / command_line / script
  const cmd =
    (args.command as string | undefined) ??
    (args.cmd as string | undefined) ??
    (args.command_line as string | undefined) ??
    (args.script as string | undefined)
  if (typeof cmd === 'string' && cmd) return cmd
  // 退化：序列化整个 arguments
  try {
    return JSON.stringify(args)
  } catch {
    return ''
  }
}

/* ============== 图标 ============== */

function WarnIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 16 16"
      fill="none"
      className="text-warn flex-shrink-0"
    >
      <path
        d="M8 1.5L14.5 13H1.5L8 1.5z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <path
        d="M8 6v3.5"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
      <circle cx="8" cy="11.3" r="0.6" fill="currentColor" />
    </svg>
  )
}
