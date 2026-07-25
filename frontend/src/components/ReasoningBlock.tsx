/**
 * 推理过程展示（折叠面板）
 *
 * 仅 deepseek-reasoner 模型产生 reasoning 内容。
 * 视觉对齐 Palot：低饱和度灰底、可折叠、流式接收时显示"思考中"指示。
 */
import { useState, type ReactNode } from 'react'

interface ReasoningBlockProps {
  content: string
  streaming?: boolean
  /** 默认折叠状态；流式时默认展开 */
  defaultOpen?: boolean
}

export function ReasoningBlock({ content, streaming, defaultOpen }: ReasoningBlockProps) {
  const [open, setOpen] = useState(defaultOpen ?? !!streaming)
  if (!content && !streaming) return null

  return (
    <div className="my-1.5 rounded border border-white/8 bg-white/4 overflow-hidden animate-fade-in">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-3 py-1.5 hover:bg-white/6 transition-colors"
      >
        <span className="flex items-center gap-2 text-2xs uppercase tracking-wide text-text-tertiary font-mono">
          <ChevronIcon open={open} />
          {streaming ? (
            <span className="flex items-center gap-1.5">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-accent animate-pulse-soft" />
              思考中…
            </span>
          ) : (
            <span>推理过程</span>
          )}
        </span>
        <span className="text-2xs text-text-tertiary">
          {content ? `${content.length} 字符` : ''}
        </span>
      </button>
      {open && (content || streaming) && (
        <div
          className="px-3 py-2 text-xs leading-5 text-text-tertiary font-mono whitespace-pre-wrap border-t border-white/8 max-h-64 overflow-auto"
          data-selectable="true"
        >
          {content || (streaming ? '等待模型输出…' : '')}
        </div>
      )}
    </div>
  )
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 16 16"
      fill="none"
      className={`transition-transform duration-150 ${open ? 'rotate-90' : ''}`}
    >
      <path d="M5 3l6 5-6 5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** 工具函数：包裹子元素时若需要再加边框可使用（保留扩展） */
export function ReasoningWrap({ children }: { children: ReactNode }) {
  return <div className="text-text-tertiary">{children}</div>
}
