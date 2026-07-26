/**
 * ReAct 步骤流可视化（子组件）
 *
 * - 接收 steps: ReActStep[]，按 iteration 渲染时间线
 * - 每步显示：迭代圆点 + Thought + Action（工具名 + 参数 chip）+ Observation（可折叠代码块）+ Reflection
 * - 工具调用 chip 按工具名前缀显示不同图标：file.*=📄 shell.*=💻 git.*=🌿 search.*=🔍 edit.*=✏️
 * - 失败的工具调用（observation 以 [ERROR] 开头）渲染红色背景
 * - 自动滚动到最新步骤（复用 useAutoScroll hook）
 * - 新步骤使用 animate-slide-up-spring 渐入
 */
import { useState } from 'react'
import { useAutoScroll } from '../hooks/useAutoScroll'
import type { ReActStep, ToolCall } from '../types'

interface ReActTimelineProps {
  steps: ReActStep[]
}

export function ReActTimeline({ steps }: ReActTimelineProps) {
  const ref = useAutoScroll(steps.length)

  if (steps.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2 text-center px-4 py-8">
        <span className="opacity-40 text-2xl">🧠</span>
        <div className="text-xs text-text-tertiary leading-relaxed">
          任务启动后，思考-行动-观察循环将在此实时呈现。
        </div>
      </div>
    )
  }

  return (
    <div ref={ref} className="h-full overflow-auto px-3 py-3 space-y-2.5">
      {steps.map((step, i) => (
        <ReActStepItem key={step.iteration} step={step} index={i} />
      ))}
    </div>
  )
}

function ReActStepItem({ step, index }: { step: ReActStep; index: number }) {
  const [open, setOpen] = useState(false)
  const failed = step.observation.startsWith('[ERROR]')
  // 展开时剥去 [ERROR] 标记前缀，便于阅读真实错误内容
  const observationText = failed ? step.observation.replace(/^\[ERROR\]\s*/, '') : step.observation

  return (
    <div
      className="rounded-xl border border-white/6 bg-white/4 px-3 py-2.5 animate-slide-up-spring"
      style={{ animationDelay: `${index * 40}ms`, animationFillMode: 'both' }}
    >
      {/* 迭代圆点 + 标题 */}
      <div className="flex items-center gap-2 mb-2">
        <span className="inline-block w-2 h-2 rounded-full bg-white/60" />
        <span className="text-xs font-semibold text-text-primary">
          Iteration {step.iteration}
        </span>
        <span className="text-2xs text-text-tertiary ml-auto font-mono">
          {step.timestamp.slice(11, 19)}
        </span>
      </div>

      {/* Thought */}
      {step.thought && (
        <div className="mb-1.5">
          <FieldLabel>Thought</FieldLabel>
          <div className="text-xs text-text-secondary leading-relaxed pl-3 border-l border-white/10">
            {step.thought}
          </div>
        </div>
      )}

      {/* Action */}
      {step.action && (
        <div className="mb-1.5">
          <FieldLabel>Action</FieldLabel>
          <ToolCallChip call={step.action} />
        </div>
      )}

      {/* Observation（可折叠） */}
      {step.observation && (
        <div className="mb-1.5">
          <button
            onClick={() => setOpen((v) => !v)}
            className="flex items-center gap-1 text-2xs text-text-tertiary hover:text-text-secondary transition-colors"
          >
            <ChevronIcon open={open} />
            <span>Observation{failed ? ' · 失败' : ''}</span>
          </button>
          {open ? (
            <pre
              className={`mt-1 px-2.5 py-2 rounded-md text-2xs font-mono whitespace-pre-wrap break-all max-h-48 overflow-auto
                ${failed ? 'bg-diff-removed/20 text-diff-removed-text' : 'bg-black/30 text-text-secondary'}`}
            >
              {observationText}
            </pre>
          ) : (
            <div
              className={`mt-1 px-2.5 py-1.5 rounded-md text-2xs font-mono truncate
                ${failed ? 'bg-diff-removed/15 text-diff-removed-text' : 'bg-black/30 text-text-tertiary'}`}
            >
              {observationText.split('\n')[0]}
            </div>
          )}
        </div>
      )}

      {/* Reflection */}
      {step.reflection && (
        <div>
          <FieldLabel>Reflection</FieldLabel>
          <div className="text-xs text-text-secondary leading-relaxed pl-3 border-l border-white/10">
            {step.reflection}
          </div>
        </div>
      )}
    </div>
  )
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-2xs uppercase tracking-wider text-text-tertiary font-mono mb-0.5">
      {children}
    </div>
  )
}

function ToolCallChip({ call }: { call: ToolCall }) {
  const icon = toolIcon(call.tool_name)
  const argsPreview = formatArgs(call.arguments)
  return (
    <div className="inline-flex items-center gap-1.5 px-2 py-1 rounded-full bg-white/8 border border-white/10 text-2xs font-mono max-w-full">
      <span className="flex-shrink-0">{icon}</span>
      <span className="text-text-primary font-semibold flex-shrink-0">{call.tool_name}</span>
      {argsPreview && (
        <span className="text-text-tertiary truncate min-w-0">{argsPreview}</span>
      )}
    </div>
  )
}

function toolIcon(name: string): string {
  if (name.startsWith('file')) return '📄'
  if (name.startsWith('shell')) return '💻'
  if (name.startsWith('git')) return '🌿'
  if (name.startsWith('search')) return '🔍'
  if (name.startsWith('edit')) return '✏️'
  return '🔧'
}

function formatArgs(args: Record<string, unknown>): string {
  try {
    const entries = Object.entries(args)
    if (entries.length === 0) return ''
    const [k, v] = entries[0]
    const vs = typeof v === 'string' ? v : JSON.stringify(v)
    return `${k}: ${vs.length > 40 ? vs.slice(0, 40) + '…' : vs}`
  } catch {
    return ''
  }
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="9"
      height="9"
      viewBox="0 0 16 16"
      fill="none"
      className={`text-text-tertiary transition-transform duration-150 ${open ? 'rotate-90' : ''}`}
    >
      <path d="M5 3l6 5-6 5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
