/**
 * 斜杠指令菜单（P0-5）
 *
 *  - 输入框检测到行首或空格后的 `/` 时，由父组件显示本菜单
 *  - 键盘：上/下选择，回车确认，Esc 关闭
 *  - 视觉：8px 圆角，半透明白底浮层，hover 高亮，对齐 Codex 风格
 *  - 动画：cubic-bezier(0.16,1,0.3,1)，200ms
 *
 * 父组件负责：
 *  - 计算 position（基于光标位置或输入框上方左下角）
 *  - 在文本变化时控制 visible
 *  - 在 onSelect 后把输入框中 `/xxx` 替换为指令文本
 */
import { useEffect, useMemo, useRef, useState } from 'react'

export interface SlashCommand {
  cmd: string
  label: string
  desc: string
}

interface SlashMenuProps {
  commands: SlashCommand[]
  visible: boolean
  onSelect: (cmd: string) => void
  onClose: () => void
  position: { top: number; left: number }
  /** 当前已输入的查询文本（不含 `/`），用于过滤 */
  query?: string
}

export function SlashMenu({
  commands,
  visible,
  onSelect,
  onClose,
  position,
  query = '',
}: SlashMenuProps) {
  const [activeIndex, setActiveIndex] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return commands
    return commands.filter(
      (c) =>
        c.cmd.toLowerCase().includes(q) || c.label.toLowerCase().includes(q),
    )
  }, [commands, query])

  // 重置选中索引
  useEffect(() => {
    setActiveIndex(0)
  }, [query, visible])

  // 滚动到激活项
  useEffect(() => {
    if (!visible || !listRef.current) return
    const el = listRef.current.querySelector<HTMLElement>(
      `[data-slash-idx="${activeIndex}"]`,
    )
    el?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, visible])

  // 键盘事件：挂全局监听，避免受 textarea focus 影响
  useEffect(() => {
    if (!visible) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActiveIndex((i) => (i + 1) % Math.max(filtered.length, 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActiveIndex((i) =>
          (i - 1 + Math.max(filtered.length, 1)) % Math.max(filtered.length, 1),
        )
      } else if (e.key === 'Enter') {
        // 仅当菜单可见且用户未按 Shift（Shift+Enter 用于换行）
        if (!e.shiftKey && filtered[activeIndex]) {
          e.preventDefault()
          e.stopPropagation()
          onSelect(filtered[activeIndex].cmd)
        }
      } else if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [visible, filtered, activeIndex, onSelect, onClose])

  if (!visible || filtered.length === 0) return null

  return (
    <div
      className="fixed z-50 w-72 max-h-64 overflow-hidden rounded-lg border border-white/8 bg-surface-elevated/95 shadow-raised animate-scale-in"
      style={{ top: position.top, left: position.left, transformOrigin: 'bottom left' }}
      data-selectable="true"
    >
      <div className="px-2.5 pt-2 pb-1 text-2xs font-mono text-text-tertiary uppercase tracking-wider">
        斜杠指令
      </div>
      <div ref={listRef} className="max-h-52 overflow-y-auto pb-1">
        {filtered.map((c, idx) => (
          <button
            key={c.cmd}
            data-slash-idx={idx}
            onMouseEnter={() => setActiveIndex(idx)}
            onClick={() => onSelect(c.cmd)}
            className={`w-full flex items-start gap-2.5 px-2.5 py-1.5 text-left rounded transition-all duration-200 ease-out ${
              idx === activeIndex
                ? 'bg-accent/15 text-text-primary'
                : 'text-text-secondary hover:bg-white/6 hover:text-text-primary'
            }`}
          >
            <span className="font-mono text-xs text-accent min-w-[56px]">
              {c.cmd}
            </span>
            <span className="flex-1 min-w-0">
              <span className="block text-xs text-text-primary truncate">
                {c.label}
              </span>
              <span className="block text-2xs text-text-tertiary truncate">
                {c.desc}
              </span>
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}

/** 内置斜杠指令集（由 ChatPanel 使用） */
export const BUILTIN_SLASH_COMMANDS: SlashCommand[] = [
  { cmd: '/refactor', label: '重构', desc: '对选中代码或文件进行重构优化' },
  { cmd: '/test', label: '测试', desc: '为指定文件生成单元测试' },
  { cmd: '/explain', label: '解释', desc: '解释代码逻辑、思路或实现细节' },
  { cmd: '/fix', label: '修复', desc: '分析并修复 bug 或编译错误' },
  { cmd: '/clear', label: '清空会话', desc: '清空当前会话上下文（不可撤销）' },
]
