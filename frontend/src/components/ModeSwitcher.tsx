/**
 * 执行模式切换器（自动 / 审批）
 *
 * - 两个 pill 按钮（rounded-full），当前激活为白底黑字，非激活为透明 + 次级文字
 * - 切换时调用 store.setDefaultMode（或外部 onChange），加载态显示 animate-pulse-soft
 * - 受控用法：传入 mode + onChange；非受控用法：仅传入 mode，内部调用 store
 */
import { useState } from 'react'
import { useAgentTasksStore } from '../stores/agentTasks'
import type { ExecutionMode } from '../types'

interface ModeSwitcherProps {
  mode: ExecutionMode
  /** 可选外部回调；不传则调用全局 store.setDefaultMode */
  onChange?: (mode: ExecutionMode) => void
}

const OPTIONS: { key: ExecutionMode; label: string; icon: string }[] = [
  { key: 'autonomous', label: '自动', icon: '🤖' },
  { key: 'approval', label: '审批', icon: '✋' },
]

export function ModeSwitcher({ mode, onChange }: ModeSwitcherProps) {
  const setDefaultMode = useAgentTasksStore((s) => s.setDefaultMode)
  const [pending, setPending] = useState<ExecutionMode | null>(null)

  const handle = (m: ExecutionMode) => {
    if (m === mode || pending) return
    setPending(m)
    const done = onChange ? Promise.resolve(onChange(m)) : setDefaultMode(m)
    Promise.resolve(done).finally(() => setPending(null))
  }

  return (
    <div className="inline-flex items-center gap-1 p-1 rounded-full bg-white/6 border border-white/8">
      {OPTIONS.map((o) => {
        const active = mode === o.key
        const loading = pending === o.key
        return (
          <button
            key={o.key}
            onClick={() => handle(o.key)}
            disabled={!!pending}
            className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium transition-all duration-200 ease-bounce
              ${active
                ? 'bg-white text-black'
                : 'text-text-secondary hover:text-text-primary hover:bg-white/8'
              }
              ${loading ? 'animate-pulse-soft' : ''}
              ${pending && !loading ? 'opacity-60' : ''}`}
          >
            <span>{o.icon}</span>
            <span>{o.label}</span>
          </button>
        )
      })}
    </div>
  )
}
