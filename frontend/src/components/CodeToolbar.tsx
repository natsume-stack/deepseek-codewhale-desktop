/**
 * 代码块悬浮工具栏（P1 - 参考 Continue.dev）
 *
 *  - 触发：鼠标 hover 到代码块时，工具栏浮在右上角
 *  - 按钮：复制 / 运行（沙箱执行）/ 单独提问 / 应用修改 / 拒绝
 *  - "运行"：调用 sandboxApi.exec，弹窗显示 stdout/stderr/修复建议
 *  - "单独提问"：把代码作为附件挂载到输入框，并预填提问模板（onAsk 回调）
 *  - 视觉：圆角 6px，半透明深色背景，hover 高亮，按钮间距 4px
 *  - 动画：fadeIn 200ms，cubic-bezier(0.16,1,0.3,1)
 *
 * 使用约定：父容器需为 position:relative（CodeBlock 卡片或同等定位祖先）。
 * 工具栏以 absolute top-right 形式浮于父容器之上；通过监听 parentElement
 * 的 mouseenter/mouseleave 切换可见性，避免阻塞代码文本选择。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { sandboxApi } from '../lib/api'
import { useDialogStore } from '../stores/dialog'
import type { SandboxLanguage, SandboxResult } from '../types'

interface CodeToolbarProps {
  code: string
  filename?: string
  lang?: string
  onApply?: () => void
  onReject?: () => void
  onAsk?: (code: string) => void
}

/** 将 lang 或 filename 扩展名映射到 SandboxLanguage；不可识别返回 null */
function detectLanguage(lang?: string, filename?: string): SandboxLanguage | null {
  const l = (lang || '').toLowerCase()
  if (l === 'rust' || l === 'rs') return 'rust'
  if (l === 'go') return 'go'
  if (l === 'python' || l === 'py') return 'python'
  if (l === 'typescript' || l === 'ts' || l === 'tsx' || l === 'js' || l === 'jsx' || l === 'javascript') return 'typescript'
  if (l === 'shell' || l === 'sh' || l === 'bash') return 'shell'
  const ext = filename?.split('.').pop()?.toLowerCase()
  if (ext === 'rs') return 'rust'
  if (ext === 'go') return 'go'
  if (ext === 'py') return 'python'
  if (ext === 'ts' || ext === 'tsx' || ext === 'js' || ext === 'jsx') return 'typescript'
  if (ext === 'sh' || ext === 'bash') return 'shell'
  return null
}

export function CodeToolbar({ code, filename, lang, onApply, onReject, onAsk }: CodeToolbarProps) {
  const [hovered, setHovered] = useState(false)
  const [copied, setCopied] = useState(false)
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<SandboxResult | null>(null)
  const ref = useRef<HTMLDivElement>(null)

  // 通过 parentElement 监听 hover（父容器需为 relative 定位）
  useEffect(() => {
    const parent = ref.current?.parentElement
    if (!parent) return
    const onEnter = () => setHovered(true)
    const onLeave = () => setHovered(false)
    parent.addEventListener('mouseenter', onEnter)
    parent.addEventListener('mouseleave', onLeave)
    return () => {
      parent.removeEventListener('mouseenter', onEnter)
      parent.removeEventListener('mouseleave', onLeave)
    }
  }, [])

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* ignore */
    }
  }

  const detected = detectLanguage(lang, filename)

  const handleRun = async () => {
    if (!detected) {
      await useDialogStore.getState().alert({
        title: '无法运行',
        message: `未识别代码语言：${lang || filename || '未知'}。支持 rust / go / python / typescript / shell。`,
      })
      return
    }
    setRunning(true)
    try {
      const r = await sandboxApi.exec({ language: detected, code, autoFix: true })
      setResult(r)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      await useDialogStore.getState().alert({
        title: '沙箱执行失败',
        message: msg,
      })
    } finally {
      setRunning(false)
    }
  }

  const handleAsk = () => {
    onAsk?.(code)
  }

  return (
    <>
      <div
        ref={ref}
        className="absolute top-2 right-2 z-10 flex items-center gap-1 px-1.5 py-1 rounded-md bg-black/55 border border-white/10 shadow-soft animate-fade-in"
        style={{
          opacity: hovered ? 1 : 0,
          transition: 'opacity 200ms cubic-bezier(0.16,1,0.3,1)',
          pointerEvents: hovered ? 'auto' : 'none',
        }}
      >
        <ToolbarButton title="复制代码" onClick={handleCopy}>
          {copied ? <CheckIcon /> : <CopyIcon />}
        </ToolbarButton>
        <ToolbarButton
          title={detected ? `在沙箱运行（${detected}）` : '不支持运行该语言'}
          onClick={handleRun}
          disabled={running || !detected}
        >
          {running ? <SpinnerIcon /> : <PlayIcon />}
        </ToolbarButton>
        <ToolbarButton title="单独提问" onClick={handleAsk}>
          <AskIcon />
        </ToolbarButton>
        {onApply && (
          <ToolbarButton title="应用修改" onClick={onApply}>
            <ApplyIcon />
          </ToolbarButton>
        )}
        {onReject && (
          <ToolbarButton title="拒绝修改" onClick={onReject}>
            <RejectIcon />
          </ToolbarButton>
        )}
      </div>

      {result && (
        <SandboxResultModal result={result} onClose={() => setResult(null)} />
      )}
    </>
  )
}

/* ============== 工具栏按钮 ============== */
interface ToolbarButtonProps {
  title: string
  onClick: () => void
  disabled?: boolean
  children: ReactNode
}
function ToolbarButton({ title, onClick, disabled, children }: ToolbarButtonProps) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      disabled={disabled}
      className="inline-flex items-center justify-center w-6 h-6 rounded text-text-secondary hover:bg-white/12 hover:text-text-primary disabled:opacity-30 disabled:cursor-not-allowed transition-all duration-200 ease-out"
    >
      {children}
    </button>
  )
}

/* ============== 沙箱结果弹窗 ============== */
function SandboxResultModal({
  result,
  onClose,
}: {
  result: SandboxResult
  onClose: () => void
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 animate-fade-in"
      onClick={onClose}
    >
      <div
        className="w-[560px] max-w-[90vw] max-h-[80vh] rounded-lg border border-white/10 bg-surface-elevated shadow-raised animate-scale-in flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-white/8">
          <div className="flex items-center gap-2 min-w-0">
            <span
              className={`inline-block w-2 h-2 rounded-full flex-shrink-0 ${result.success ? 'bg-emerald-400' : 'bg-rose-400'}`}
            />
            <span className="text-sm font-semibold text-text-primary truncate">
              沙箱执行{result.success ? '成功' : '失败'}
            </span>
            <span className="text-2xs text-text-tertiary font-mono">
              exit={result.exitCode} · {result.durationMs}ms
            </span>
          </div>
          <button onClick={onClose} className="icon-btn !p-1" title="关闭">
            <CloseIcon />
          </button>
        </div>

        <div className="flex-1 overflow-auto p-4 space-y-3 text-xs">
          {result.stdout && (
            <div>
              <div className="text-2xs uppercase tracking-wider text-text-tertiary font-mono mb-1">
                stdout
              </div>
              <pre
                className="px-3 py-2 rounded bg-black/30 border border-white/5 font-mono text-xs text-diff-added-text whitespace-pre-wrap break-all"
                data-selectable="true"
              >
                {result.stdout}
              </pre>
            </div>
          )}
          {result.stderr && (
            <div>
              <div className="text-2xs uppercase tracking-wider text-text-tertiary font-mono mb-1">
                stderr
              </div>
              <pre
                className="px-3 py-2 rounded bg-black/30 border border-white/5 font-mono text-xs text-diff-removed-text whitespace-pre-wrap break-all"
                data-selectable="true"
              >
                {result.stderr}
              </pre>
            </div>
          )}
          {!result.stdout && !result.stderr && (
            <div className="text-text-tertiary italic">（无输出）</div>
          )}
          {result.fixSuggestion && (
            <div className="px-3 py-2 rounded bg-accent/10 border border-accent/30 text-xs text-text-primary">
              <div className="text-2xs uppercase tracking-wider text-accent font-mono mb-1">
                修复建议
              </div>
              <div className="whitespace-pre-wrap">{result.fixSuggestion}</div>
            </div>
          )}
          {result.fixDiff && (
            <div>
              <div className="text-2xs uppercase tracking-wider text-accent font-mono mb-1">
                修复 Diff
              </div>
              <pre
                className="px-3 py-2 rounded bg-black/30 border border-white/5 font-mono text-xs text-text-secondary whitespace-pre-wrap break-all"
                data-selectable="true"
              >
                {result.fixDiff}
              </pre>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 px-4 py-2.5 border-t border-white/8 bg-white/4">
          <button onClick={onClose} className="btn-secondary !py-1 !px-3 !text-xs">
            关闭
          </button>
        </div>
      </div>
    </div>
  )
}

/* ============== 图标 ============== */
function CopyIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
      <rect x="5" y="5" width="8" height="8" rx="1" stroke="currentColor" strokeWidth="1.1" />
      <path d="M3 11V3h8" stroke="currentColor" strokeWidth="1.1" />
    </svg>
  )
}
function CheckIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" className="text-diff-added-text">
      <path d="M3 8l3 3 7-7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
function PlayIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
      <path d="M4 3l9 5-9 5V3z" fill="currentColor" />
    </svg>
  )
}
function SpinnerIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" className="animate-spin">
      <path d="M8 1.5a6.5 6.5 0 106.5 6.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}
function AskIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
      <path d="M2 4a2 2 0 012-2h8a2 2 0 012 2v5a2 2 0 01-2 2H7l-3 3v-3H4a2 2 0 01-2-2V4z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
      <path d="M6 7h4M6 5h6" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
    </svg>
  )
}
function ApplyIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
      <path d="M3 8.5l3 3 7-7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
function RejectIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
      <line x1="4" y1="4" x2="12" y2="12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <line x1="12" y1="4" x2="4" y2="12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
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
