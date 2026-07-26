/**
 * 单条消息渲染（Codex Desktop 风格 - 去卡片化紧凑流式）
 *
 * 设计原则（对齐 Codex）：
 *   - 不使用气泡卡片，所有消息直接堆叠在流中
 *   - 角色标签：左侧小字 "user" / "codex" + 时间戳 + 流式指示
 *   - user 消息：与 assistant 同左对齐，仅角色标签区分
 *   - assistant 消息：含推理过程折叠 + Markdown 正文 + 内联代码块
 *   - 流式光标：assistant.streaming 时在内容末尾闪烁竖线
 *   - 错误状态：内联红色提示
 *
 * P1 增强：
 *   - assistant 消息右侧操作工具栏：重试 / 删除 / 折叠
 *   - 折叠状态：仅显示前 3 行 + "展开"按钮
 *   - 流式接收时不显示删除按钮（避免误删未完成消息）
 */
import { useMemo } from 'react'
import type { ChatStreamMessage } from '../types'
import { MarkdownLite } from './MarkdownLite'
import { ReasoningBlock } from './ReasoningBlock'
import { ToolCallCard } from './ToolCallCard'

interface MessageItemProps {
  message: ChatStreamMessage
  /** 代码块"应用修改"回调：注册 Diff */
  onApplyCode?: (code: string, filename?: string, lang?: string) => void | Promise<void>
  onRejectCode?: (filename?: string) => void
  /** 重试该消息（删除它及其后所有消息，重新发送上一条 user 消息） */
  onRetry?: (localId: string) => void
  /** 删除该消息 */
  onDelete?: (localId: string) => void
  /** 折叠状态（由 store 持久化） */
  folded?: boolean
  /** 切换折叠状态 */
  onToggleFold?: (localId: string) => void
}

/** 折叠时显示的最大行数 */
const FOLD_PREVIEW_LINES = 3

export function MessageItem({
  message,
  onApplyCode,
  onRejectCode,
  onRetry,
  onDelete,
  folded,
  onToggleFold,
}: MessageItemProps) {
  const isUser = message.role === 'user'
  const isAssistant = message.role === 'assistant'

  const ts = useMemo(() => {
    try {
      return new Date(message.ts).toLocaleTimeString('zh-CN', { hour12: false })
    } catch {
      return ''
    }
  }, [message.ts])

  // 折叠态预览：取前 N 行（hooks 必须在条件 return 之前调用）
  const foldedContent = useMemo(() => {
    if (!isAssistant || !folded || !message.content) return message.content
    const lines = message.content.split('\n')
    if (lines.length <= FOLD_PREVIEW_LINES) return message.content
    return lines.slice(0, FOLD_PREVIEW_LINES).join('\n')
  }, [isAssistant, folded, message.content])

  if (!isUser && !isAssistant) return null

  const isFolded = !!folded && isAssistant && !message.streaming

  return (
    <div className="px-6 py-3 animate-fade-in group/msg">
      {/* === 角色标签行 === */}
      <div className="flex items-center gap-2 mb-1.5">
        <span
          className={`text-2xs font-mono font-semibold uppercase tracking-wide
            ${isUser ? 'text-text-tertiary' : 'text-accent'}`}
        >
          {isUser ? 'user' : 'CodeWhale'}
        </span>
        {ts && <span className="text-2xs text-text-tertiary font-mono">{ts}</span>}
        {isAssistant && message.streaming && (
          <span className="flex items-center gap-1 text-2xs text-accent">
            <span className="inline-block w-1 h-1 rounded-full bg-accent animate-pulse-soft" />
          </span>
        )}

        {/* === assistant 消息操作工具栏（右侧） === */}
        {isAssistant && !message.streaming && !message.error && (
          <div className="ml-auto flex items-center gap-0.5 opacity-0 group-hover/msg:opacity-100 transition-opacity duration-200 ease-out">
            {onToggleFold && (
              <ActionButton
                title={isFolded ? '展开消息' : '折叠消息'}
                onClick={() => onToggleFold(message.localId)}
              >
                {isFolded ? <ExpandIcon /> : <FoldIcon />}
              </ActionButton>
            )}
            {onRetry && (
              <ActionButton
                title="重试该回复"
                onClick={() => onRetry(message.localId)}
              >
                <RetryIcon />
              </ActionButton>
            )}
            {onDelete && (
              <ActionButton
                title="删除该回复"
                onClick={() => onDelete(message.localId)}
                danger
              >
                <DeleteIcon />
              </ActionButton>
            )}
          </div>
        )}
      </div>

      {/* === user 消息正文 === */}
      {isUser && (
        <div
          className="text-sm text-text-primary whitespace-pre-wrap break-words leading-6"
          data-selectable="true"
        >
          {message.content}
        </div>
      )}

      {/* === assistant 消息正文 === */}
      {isAssistant && (
        <div className="space-y-1.5">
          {/* 推理过程（折叠） - 折叠态时不显示，避免冗余 */}
          {!isFolded && (message.reasoning || message.streaming) && (
            <ReasoningBlock
              content={message.reasoning ?? ''}
              streaming={message.streaming}
            />
          )}

          {/* 工具调用列表（Agent Loop 可视化） - 折叠态时也隐藏 */}
          {!isFolded && message.toolCalls && message.toolCalls.length > 0 && (
            <div className="my-1 space-y-0.5">
              {message.toolCalls.map((tc) => (
                <ToolCallCard key={tc.localId} call={tc} />
              ))}
            </div>
          )}

          {/* 错误提示 */}
          {message.error && (
            <div className="px-3 py-2 rounded border border-diff-removed bg-diff-removed/30 text-xs text-diff-removed-text">
              生成失败：{message.error}
            </div>
          )}

          {/* 正文（Markdown + 代码块） */}
          {message.content ? (
            <div className="text-sm leading-6">
              <MarkdownLite
                text={isFolded ? foldedContent ?? '' : message.content}
                onApplyCode={onApplyCode}
                onRejectCode={onRejectCode}
              />
              {message.streaming && (
                <span className="inline-block w-1.5 h-4 ml-0.5 bg-accent animate-pulse-soft align-middle" />
              )}
              {/* 折叠态"展开"提示 */}
              {isFolded && (
                <button
                  type="button"
                  onClick={() => onToggleFold?.(message.localId)}
                  className="mt-1 inline-flex items-center gap-1 px-2 py-0.5 rounded text-2xs text-accent bg-accent/10 hover:bg-accent/15 border border-accent/25 transition-all duration-200 ease-out"
                  title="展开完整内容"
                >
                  <ExpandIcon />
                  展开完整内容
                </button>
              )}
            </div>
          ) : !message.streaming && !message.error && (!message.toolCalls || message.toolCalls.length === 0) ? (
            <div className="text-sm text-text-tertiary italic">（空回复）</div>
          ) : null}
        </div>
      )}
    </div>
  )
}

/* ============== 操作按钮（轻量 icon-btn 变体） ============== */
interface ActionButtonProps {
  title: string
  onClick: () => void
  danger?: boolean
  children: React.ReactNode
}
function ActionButton({ title, onClick, danger, children }: ActionButtonProps) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={`inline-flex items-center justify-center w-6 h-6 rounded text-text-tertiary hover:bg-white/8 hover:text-text-primary transition-all duration-200 ease-out
        ${danger ? 'hover:text-rose-300 hover:bg-rose-500/10' : ''}`}
    >
      {children}
    </button>
  )
}

/* ============== 图标 ============== */
function RetryIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
      <path d="M13 8a5 5 0 11-1.5-3.5M13 2v3h-3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  )
}
function DeleteIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
      <path d="M3 4.5h10M6 4.5V3h4v1.5M5 4.5l.5 8h5l.5-8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
function FoldIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
      <path d="M3 4h10M3 8h10M3 12h6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  )
}
function ExpandIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
      <path d="M3 4h10M3 8h10M3 12h10" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  )
}
