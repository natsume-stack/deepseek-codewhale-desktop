/**
 * 右键上下文菜单
 *
 * 浮于应用之上的菜单面板，支持:
 *  - 自动定位（避开屏幕边界）
 *  - 点击外部关闭
 *  - 分隔符 / 禁用项
 *  - ESC 关闭
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'

export interface MenuItem {
  type?: 'item' | 'separator'
  label?: string
  icon?: ReactNode
  onClick?: () => void
  disabled?: boolean
  danger?: boolean
  shortcut?: string
}

interface ContextMenuProps {
  x: number
  y: number
  items: MenuItem[]
  onClose: () => void
}

export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState({ x, y })

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    let nx = x
    let ny = y
    if (x + rect.width > window.innerWidth - 8) nx = window.innerWidth - rect.width - 8
    if (y + rect.height > window.innerHeight - 8) ny = window.innerHeight - rect.height - 8
    nx = Math.max(8, nx)
    ny = Math.max(8, ny)
    setPos({ x: nx, y: ny })
  }, [x, y])

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  return (
    <div
      ref={ref}
      style={{ left: pos.x, top: pos.y }}
      className="fixed z-50 min-w-[180px] py-1 rounded-md border border-white/10 bg-white/10 shadow-raised animate-fade-in"
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((it, i) => {
        if (it.type === 'separator') {
          return <div key={i} className="h-px my-1 bg-border" />
        }
        return (
          <button
            key={i}
            disabled={it.disabled}
            onClick={() => {
              it.onClick?.()
              onClose()
            }}
            className={`w-full flex items-center gap-2.5 px-3 py-1.5 text-left text-xs transition-colors
              ${it.disabled
                ? 'text-text-tertiary cursor-not-allowed'
                : it.danger
                  ? 'text-diff-removed-text hover:bg-diff-removed/30'
                  : 'text-text-primary hover:bg-white/8'
              }`}
          >
            {it.icon && <span className="flex-shrink-0 w-3.5 h-3.5 inline-flex items-center justify-center">{it.icon}</span>}
            <span className="flex-1">{it.label}</span>
            {it.shortcut && <span className="text-2xs text-text-tertiary">{it.shortcut}</span>}
          </button>
        )
      })}
    </div>
  )
}
