/**
 * 内置终端面板（xterm.js 集成）
 *
 * 布局:
 *   ┌─────────────────────────────────────────────────┐
 *   │ 内置终端                       [+新建] [×关闭]    │  顶部标题栏
 *   ├─────────────────────────────────────────────────┤
 *   │ session: abc123  cwd: /path/to/project          │  会话元信息
 *   ├─────────────────────────────────────────────────┤
 *   │                                                 │
 *   │  $ git clone ...                                │  xterm 渲染区
 *   │  Cloning into '...'...                          │
 *   │  $ _                                            │
 *   └─────────────────────────────────────────────────┘
 *
 * - 集成 @xterm/xterm + @xterm/addon-fit + @xterm/addon-web-links
 * - 订阅 useTerminalStore.outputs[activeSessionId]，新行调用 term.writeln
 * - xterm onData 回调累积用户输入，回车触发 execCommand
 * - 切换 activeSessionId 时清空 xterm 并重放该会话历史输出
 * - FitAddon + ResizeObserver 自适应容器尺寸
 * - 空状态：无 session 时显示「创建终端会话」按钮
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import { useTerminalStore } from '../stores/terminal'
import { projectApi } from '../lib/api'

export function TerminalPanel() {
  const sessions = useTerminalStore((s) => s.sessions)
  const activeSessionId = useTerminalStore((s) => s.activeSessionId)
  const createSession = useTerminalStore((s) => s.createSession)
  const closeSession = useTerminalStore((s) => s.closeSession)
  const fetchSessions = useTerminalStore((s) => s.fetchSessions)

  const [busy, setBusy] = useState(false)

  // 挂载时拉取已有会话列表
  useEffect(() => {
    void fetchSessions()
  }, [fetchSessions])

  const handleCreate = async () => {
    try {
      setBusy(true)
      const p = await projectApi.get()
      await createSession(p.path ?? '')
    } catch (err) {
      console.error('[TerminalPanel] createSession failed:', err)
    } finally {
      setBusy(false)
    }
  }

  const handleClose = async () => {
    if (!activeSessionId) return
    try {
      setBusy(true)
      await closeSession(activeSessionId)
    } finally {
      setBusy(false)
    }
  }

  const activeSession = useMemo(
    () => sessions.find((s) => s.session_id === activeSessionId) ?? null,
    [sessions, activeSessionId],
  )

  return (
    <div className="h-full w-full flex flex-col overflow-hidden rounded-2xl border border-white/6 bg-surface-work/80 backdrop-blur-sm">
      {/* === 顶部标题栏 === */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-white/5 bg-surface-elevated">
        <div className="flex items-center gap-2">
          <TerminalIcon />
          <span className="text-sm font-semibold text-text-primary">内置终端</span>
          {sessions.length > 0 && (
            <span className="text-2xs text-text-tertiary font-mono">
              {sessions.length} 个会话
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => void handleCreate()}
            disabled={busy}
            className="btn-primary !py-1 !px-2.5 !text-2xs disabled:opacity-40"
            title="新建终端会话"
          >
            + 新建
          </button>
          <button
            onClick={() => void handleClose()}
            disabled={busy || !activeSessionId}
            className="btn-secondary !py-1 !px-2.5 !text-2xs disabled:opacity-40"
            title="关闭当前会话"
          >
            × 关闭
          </button>
        </div>
      </div>

      {/* === 会话元信息栏 === */}
      {activeSession && (
        <div className="flex items-center gap-3 px-4 py-1.5 border-b border-white/5 bg-white/3 text-2xs font-mono">
          <span className="text-text-tertiary">
            session:{' '}
            <span className="text-text-secondary">
              {activeSession.session_id.slice(0, 12)}
            </span>
          </span>
          <span className="text-text-tertiary">
            cwd:{' '}
            <span className="text-text-secondary truncate">{activeSession.cwd}</span>
          </span>
        </div>
      )}

      {/* === 主体：xterm 渲染区 / 空状态 === */}
      <div className="flex-1 min-h-0 relative">
        {activeSession ? (
          <XtermView sessionId={activeSession.session_id} />
        ) : (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-center px-6">
            <span className="text-3xl opacity-40">⌨️</span>
            <div className="text-sm text-text-secondary">还没有终端会话</div>
            <div className="text-2xs text-text-tertiary leading-relaxed max-w-xs">
              创建一个内置终端会话，可直接在面板内执行 shell 命令并实时查看输出。
            </div>
            <button
              onClick={() => void handleCreate()}
              disabled={busy}
              className="btn-primary !py-1.5 !px-4 !text-xs mt-1 disabled:opacity-40"
            >
              {busy ? '创建中…' : '创建终端会话'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

/* ============== xterm.js 集成子组件 ============== */

interface XtermViewProps {
  sessionId: string
}

function XtermView({ sessionId }: XtermViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  /** 已写入 xterm 的行数，用于增量追加 */
  const writtenCountRef = useRef<number>(0)
  /** 用户输入缓冲（回车触发执行） */
  const inputBufRef = useRef<string>('')

  const outputs = useTerminalStore((s) => s.outputs[sessionId] ?? [])
  const isExecuting = useTerminalStore((s) => s.isExecuting[sessionId] ?? false)
  const execCommand = useTerminalStore((s) => s.execCommand)

  // 初始化 xterm（仅在 sessionId 首次挂载时）
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const term = new Terminal({
      fontFamily: 'Consolas, "JetBrains Mono", monospace',
      fontSize: 14,
      lineHeight: 1.2,
      cursorBlink: true,
      theme: {
        background: '#161617',
        foreground: 'rgba(255,255,255,0.95)',
        cursor: 'rgba(255,255,255,0.95)',
        selectionBackground: 'rgba(255,255,255,0.20)',
        black: '#161617',
        white: 'rgba(255,255,255,0.95)',
      },
      allowProposedApi: true,
    })
    const fit = new FitAddon()
    const webLinks = new WebLinksAddon()
    term.loadAddon(fit)
    term.loadAddon(webLinks)
    term.open(container)
    try {
      fit.fit()
    } catch {
      /* 容器尚未布局完成，忽略 */
    }

    termRef.current = term
    fitRef.current = fit

    // 用户输入：累积到缓冲，回车触发执行
    term.onData((data) => {
      for (const ch of data) {
        if (ch === '\r' || ch === '\n') {
          const cmd = inputBufRef.current
          inputBufRef.current = ''
          term.write('\r\n')
          if (cmd.trim().length > 0) {
            void execCommand(sessionId, cmd).catch(() => {
              // 错误已在 store 内追加到 outputs，这里静默
            })
          }
        } else if (ch === '\u007f') {
          // Backspace
          if (inputBufRef.current.length > 0) {
            inputBufRef.current = inputBufRef.current.slice(0, -1)
            term.write('\b \b')
          }
        } else if (ch === '\u0003') {
          // Ctrl+C
          inputBufRef.current = ''
          term.write('^C\r\n')
        } else {
          inputBufRef.current += ch
          term.write(ch)
        }
      }
    })

    return () => {
      term.dispose()
      termRef.current = null
      fitRef.current = null
      writtenCountRef.current = 0
    }
  }, [sessionId, execCommand])

  // 容器尺寸自适应
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const ro = new ResizeObserver(() => {
      try {
        fitRef.current?.fit()
      } catch {
        /* ignore */
      }
    })
    ro.observe(container)
    return () => ro.disconnect()
  }, [])

  // 增量写入新输出行
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    const total = outputs.length
    const written = writtenCountRef.current
    if (total <= written) return
    for (let i = written; i < total; i++) {
      const line = outputs[i]
      // 空行用 writeln 直接换行；否则按行写入
      term.writeln(line)
    }
    writtenCountRef.current = total
    // 自动滚动到底部
    term.scrollToBottom()
  }, [outputs])

  // 执行中状态：光标样式提示
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.options.cursorStyle = isExecuting ? 'bar' : 'block'
  }, [isExecuting])

  return (
    <div className="absolute inset-0 px-3 py-3 overflow-hidden">
      <div ref={containerRef} className="w-full h-full" />
    </div>
  )
}

/* ============== 图标 ============== */

function TerminalIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      className="text-text-secondary flex-shrink-0"
    >
      <rect
        x="1.5"
        y="2.5"
        width="13"
        height="11"
        rx="1.5"
        stroke="currentColor"
        strokeWidth="1.1"
      />
      <path
        d="M4 6.5L6 8.5L4 10.5"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M8 10.5h3.5"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinecap="round"
      />
    </svg>
  )
}
