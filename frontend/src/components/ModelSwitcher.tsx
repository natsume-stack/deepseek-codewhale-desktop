/**
 * 多模型切换组件（P1 - 参考 ArcDesk 多模型卡片管理）
 *
 *  - 下拉菜单显示所有可用模型档案
 *  - 当前选中模型高亮
 *  - 切换模型时调用 onSwitch(modelId)
 *  - 显示模型描述和特性（supportsReasoning / maxTokens）
 *  - 视觉：与 Codex 风格一致，圆角下拉，cubic-bezier(0.16,1,0.3,1)
 *
 * 用法：
 *   <ModelSwitcher current="deepseek-chat" profiles={...} onSwitch={(id) => ...} />
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ModelProfile } from '../types'

interface ModelSwitcherProps {
  current: string
  profiles: ModelProfile[]
  onSwitch: (id: string) => void
  /** 紧凑模式：仅显示模型名 + 箭头（用于状态条小尺寸场景） */
  compact?: boolean
}

export function ModelSwitcher({ current, profiles, onSwitch, compact }: ModelSwitcherProps) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  // 点击外部关闭
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (!wrapRef.current) return
      if (!wrapRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    window.addEventListener('mousedown', handler)
    return () => window.removeEventListener('mousedown', handler)
  }, [open])

  // Esc 关闭
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        setOpen(false)
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [open])

  const currentProfile = useMemo(
    () => profiles.find((p) => p.id === current || p.name === current) ?? null,
    [profiles, current],
  )

  const displayName = currentProfile?.displayName ?? currentProfile?.name ?? current

  return (
    <div ref={wrapRef} className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`inline-flex items-center gap-1.5 rounded transition-all duration-200 ease-out
          ${compact
            ? 'px-1.5 py-0.5 text-2xs font-mono text-text-tertiary hover:text-text-primary hover:bg-white/6'
            : 'px-2.5 py-1 text-xs text-text-primary bg-white/6 hover:bg-white/8 border border-white/8'
          }`}
        title={currentProfile?.description ?? '切换模型'}
      >
        <span className={`inline-block w-1.5 h-1.5 rounded-full ${currentProfile?.supportsReasoning ? 'bg-accent' : 'bg-text-tertiary'}`} />
        <span className="truncate max-w-[140px]">{displayName}</span>
        <ChevronIcon open={open} />
      </button>

      {open && (
        <div
          className="absolute bottom-full left-0 mb-1 w-72 rounded-lg border border-white/8 bg-surface-elevated/95 shadow-raised animate-scale-in overflow-hidden z-30"
          style={{ transformOrigin: 'bottom left' }}
        >
          <div className="px-2.5 pt-2 pb-1 text-2xs font-mono text-text-tertiary uppercase tracking-wider">
            模型档案
          </div>
          <div className="max-h-72 overflow-y-auto pb-1">
            {profiles.length === 0 ? (
              <div className="px-2.5 py-2 text-2xs text-text-tertiary">无可用模型</div>
            ) : (
              profiles.map((p) => {
                const active = p.id === current || p.name === current
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => {
                      onSwitch(p.id)
                      setOpen(false)
                    }}
                    className={`w-full flex items-start gap-2.5 px-2.5 py-1.5 text-left rounded transition-all duration-200 ease-out
                      ${active
                        ? 'bg-accent/15 text-text-primary'
                        : 'text-text-secondary hover:bg-white/6 hover:text-text-primary'
                      }`}
                  >
                    <span
                      className={`mt-1 w-3.5 h-3.5 rounded-full border-2 flex items-center justify-center flex-shrink-0
                        ${active ? 'border-accent' : 'border-white/25'}`}
                    >
                      {active && <span className="w-1.5 h-1.5 rounded-full bg-accent" />}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="text-xs font-medium text-text-primary truncate">{p.displayName}</span>
                        {p.supportsReasoning && (
                          <span className="px-1 py-0.5 rounded text-2xs font-mono bg-accent/15 text-accent">
                            Reasoning
                          </span>
                        )}
                      </div>
                      <div className="text-2xs text-text-tertiary mt-0.5 truncate">{p.description}</div>
                      <div className="text-2xs text-text-tertiary mt-0.5 font-mono">
                        {p.name} · {formatTokens(p.maxTokens)}
                      </div>
                    </div>
                  </button>
                )
              })
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(0)}K tokens`
  return `${n} tokens`
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="9"
      height="9"
      viewBox="0 0 16 16"
      fill="none"
      className={`text-text-tertiary transition-transform duration-150 ${open ? 'rotate-180' : ''}`}
    >
      <path d="M3 6l5 5 5-5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
