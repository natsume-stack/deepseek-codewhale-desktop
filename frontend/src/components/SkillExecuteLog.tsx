/**
 * 技能执行日志（P0 - 终端风格）
 *
 *  - 展示当前会话的 Skill 执行日志
 *  - 每条：时间戳、skill_id、步骤序号、动作、结果
 *  - 自动滚动到底部
 *  - 清空日志按钮
 *  - 视觉：终端风格，等宽字体，深色背景
 *
 * 数据来自 useSkillsStore.logs（由 SSE skill_match 事件或 /skill 指令触发写入）。
 */
import { useEffect, useRef } from 'react'
import { useSkillsStore } from '../stores/skills'
import type { SkillLogEntry } from '../types'

export function SkillExecuteLog() {
  const logs = useSkillsStore((s) => s.logs)
  const clearLogs = useSkillsStore((s) => s.clearLogs)
  const containerRef = useRef<HTMLDivElement>(null)

  // 自动滚动到底部
  useEffect(() => {
    const el = containerRef.current
    if (el) {
      el.scrollTop = el.scrollHeight
    }
  }, [logs])

  return (
    <div className="h-full flex flex-col">
      {/* === 操作条 === */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-white/5">
        <div className="flex items-center gap-2 text-2xs font-mono">
          <TerminalIcon />
          <span className="text-text-secondary">技能执行日志</span>
          {logs.length > 0 && (
            <span className="px-1.5 py-0.5 rounded bg-white/6 text-text-tertiary">
              {logs.length} 条
            </span>
          )}
        </div>
        <button
          onClick={clearLogs}
          disabled={logs.length === 0}
          className="btn-secondary !py-1 !px-2 !text-2xs"
          title="清空日志"
        >
          <TrashIcon />
          清空
        </button>
      </div>

      {/* === 日志列表（终端风格） === */}
      <div
        ref={containerRef}
        className="flex-1 overflow-auto bg-black/40 border-t border-white/5 font-mono text-2xs leading-relaxed"
        data-selectable="true"
      >
        {logs.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-2 text-center px-4">
            <TerminalIcon />
            <div className="text-2xs text-text-tertiary">
              暂无执行日志。在输入框使用 <span className="text-accent">/skill</span> 指令触发技能后将在此显示。
            </div>
          </div>
        ) : (
          <div className="p-2 space-y-0.5">
            {logs.map((l) => (
              <LogRow key={l.id} entry={l} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

/* ============== 单条日志行 ============== */

function LogRow({ entry }: { entry: SkillLogEntry }) {
  const time = formatTs(entry.ts)
  const resultColor =
    entry.result === 'success'
      ? 'text-emerald-400'
      : entry.result === 'failed'
        ? 'text-rose-300'
        : entry.result === 'running'
          ? 'text-accent'
          : 'text-text-tertiary'
  const resultLabel =
    entry.result === 'success'
      ? 'OK'
      : entry.result === 'failed'
        ? 'FAIL'
        : entry.result === 'running'
          ? 'RUN'
          : 'SKIP'
  return (
    <div className="px-1 py-0.5 hover:bg-white/4 rounded flex items-start gap-2">
      <span className="text-text-tertiary flex-shrink-0">{time}</span>
      <span className="text-accent flex-shrink-0 min-w-[80px] truncate" title={entry.skillName}>
        [{entry.skillName}]
      </span>
      <span className="text-text-tertiary flex-shrink-0">
        #{entry.stepOrder}/{entry.stepTotal}
      </span>
      <span className="text-text-secondary flex-shrink-0 min-w-[60px] truncate" title={entry.action}>
        {entry.action}
      </span>
      <span className="text-text-primary flex-1 min-w-0 truncate" title={entry.description}>
        {entry.description}
      </span>
      {entry.message && (
        <span className="text-text-tertiary truncate max-w-[200px]" title={entry.message}>
          → {entry.message}
        </span>
      )}
      <span className={`flex-shrink-0 ${resultColor}`}>{resultLabel}</span>
    </div>
  )
}

/** 时间戳格式化：HH:MM:SS.mmm */
function formatTs(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number, len = 2) => String(n).padStart(len, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
}

/* ============== 图标 ============== */

function TerminalIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" className="text-text-secondary">
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.1" />
      <path d="M4 6l2 2-2 2M7.5 10.5h4" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function TrashIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
      <path d="M3 4h10M6 4V2h4v2M5 4l1 9h4l1-9" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
