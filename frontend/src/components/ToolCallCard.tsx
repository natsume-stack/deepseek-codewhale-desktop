/**
 * 工具调用卡片（Agent Loop 可视化）
 *
 * 设计参考 Codex / Cline / Claude Code 的工具执行展示：
 *   - 紧凑的卡片样式，左侧状态图标 + 工具名 + 意图
 *   - 可展开查看参数和结果
 *   - 运行中显示转圈动画
 *   - 成功显示对勾，失败显示叉号
 *   - 参数和结果支持折叠/展开
 *
 * 配色遵循 Codex 风格：白/灰/黑单色，无蓝色。
 */
import { useState } from 'react'
import type { ToolCallEntry } from '../types'

interface ToolCallCardProps {
  call: ToolCallEntry
}

/** 工具图标（按工具名映射） */
function ToolIcon({ name }: { name: string }) {
  // 通用：文件/搜索/编辑/执行/问号
  if (name === 'read_file' || name === 'list_files') {
    return (
      <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
        <path d="M3 2h6l3 3v9H3V2z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
        <path d="M9 2v3h3M5 8h6M5 11h4" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
      </svg>
    )
  }
  if (name === 'search_files') {
    return (
      <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
        <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.2" />
        <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      </svg>
    )
  }
  if (name === 'write_file' || name === 'edit_file') {
    return (
      <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
        <path d="M11.5 2L14 4.5 6 12.5 3 13l.5-3L11.5 2z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      </svg>
    )
  }
  if (name === 'shell') {
    return (
      <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
        <rect x="1.5" y="2.5" width="13" height="11" rx="1.2" stroke="currentColor" strokeWidth="1.1" />
        <path d="M4 6l2 2-2 2M7.5 10.5h4" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    )
  }
  if (name === 'git') {
    return (
      <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
        <circle cx="4" cy="4" r="1.8" stroke="currentColor" strokeWidth="1.1" />
        <circle cx="4" cy="12" r="1.8" stroke="currentColor" strokeWidth="1.1" />
        <circle cx="12" cy="8" r="1.8" stroke="currentColor" strokeWidth="1.1" />
        <path d="M4 5.8v4.4M5.6 4.4L11 7M5.6 11.6L11 9" stroke="currentColor" strokeWidth="1.1" />
      </svg>
    )
  }
  if (name === 'ask_followup_question') {
    return (
      <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
        <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.1" />
        <path d="M6.5 6.5a1.5 1.5 0 113 0c0 1-.5 1.3-1 1.7-.3.2-.5.4-.5.8M8 11.5v.2" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
      </svg>
    )
  }
  if (name === 'attempt_completion') {
    return (
      <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
        <path d="M3 8.5l3 3 7-7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    )
  }
  // 通用工具图标
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
      <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.1" />
      <path d="M5 8h6M8 5v6" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
    </svg>
  )
}

/** 工具名中文标签 */
function toolLabel(name: string): string {
  const map: Record<string, string> = {
    read_file: '读取文件',
    list_files: '列出目录',
    search_files: '搜索代码',
    write_file: '写入文件',
    edit_file: '编辑文件',
    shell: '执行命令',
    git: 'Git 操作',
    ask_followup_question: '追问用户',
    attempt_completion: '任务完成',
  }
  return map[name] ?? name
}

/** 参数摘要（紧凑展示） */
function argsSummary(name: string, args?: Record<string, unknown>): string {
  if (!args) return ''
  const get = (k: string) => (typeof args[k] === 'string' ? (args[k] as string) : '')
  switch (name) {
    case 'read_file':
      return get('path') || ''
    case 'list_files':
      return get('path') || '.'
    case 'search_files':
      return get('regex') ? `/${get('regex')}/` : ''
    case 'write_file':
    case 'edit_file':
      return get('path') || ''
    case 'shell':
      return get('command') ? `$ ${get('command')}` : ''
    case 'git':
      if (Array.isArray(args.args)) return `git ${(args.args as string[]).join(' ')}`
      if (typeof args.args === 'string') return `git ${args.args}`
      return ''
    case 'ask_followup_question':
      return get('question') || ''
    case 'attempt_completion':
      return ''
    default:
      return ''
  }
}

export function ToolCallCard({ call }: ToolCallCardProps) {
  const [expanded, setExpanded] = useState(false)
  const isRunning = call.status === 'running'
  const isFailed = call.status === 'failed'
  const isCompletion = call.name === 'attempt_completion'
  const summary = argsSummary(call.name, call.args)

  // 收尾卡片：更醒目的成功样式
  if (isCompletion) {
    return (
      <div className="my-1.5 px-3 py-2.5 rounded-2xl border border-white/12 bg-white/5 animate-slide-up-spring">
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-white/15 text-white">
            <ToolIcon name="attempt_completion" />
          </span>
          <span className="text-xs font-semibold text-text-primary">任务已完成</span>
        </div>
        {call.result && (
          <div className="mt-1.5 text-xs text-text-secondary leading-relaxed whitespace-pre-wrap break-words">
            {call.result}
          </div>
        )}
      </div>
    )
  }

  return (
    <div
      className={`my-1 rounded-xl border transition-all duration-200 ease-out animate-slide-up-spring
        ${isRunning
          ? 'border-white/15 bg-white/4'
          : isFailed
            ? 'border-rose-400/30 bg-rose-500/8'
            : 'border-white/10 bg-white/3'
        }`}
    >
      {/* 头部：图标 + 工具名 + 摘要 + 状态 */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-white/4 transition-colors duration-150"
      >
        {/* 状态图标 */}
        <span
          className={`inline-flex items-center justify-center w-5 h-5 rounded-full flex-shrink-0
            ${isRunning
              ? 'bg-white/10 text-text-primary'
              : isFailed
                ? 'bg-rose-500/20 text-rose-300'
                : 'bg-white/12 text-text-primary'
            }`}
        >
          {isRunning ? (
            <SpinnerIcon />
          ) : isFailed ? (
            <CrossIcon />
          ) : (
            <ToolIcon name={call.name} />
          )}
        </span>

        {/* 工具名 + 意图 */}
        <span className="text-xs font-semibold text-text-primary flex-shrink-0">
          {toolLabel(call.name)}
        </span>
        {summary && (
          <span className="text-2xs font-mono text-text-tertiary truncate flex-1">
            {summary}
          </span>
        )}

        {/* 右侧：状态文字 + 展开箭头 */}
        <span
          className={`text-2xs font-mono flex-shrink-0
            ${isRunning ? 'text-text-secondary' : isFailed ? 'text-rose-300' : 'text-text-tertiary'}
          `}
        >
          {isRunning ? '运行中…' : isFailed ? '失败' : '完成'}
        </span>
        <svg
          width="9" height="9" viewBox="0 0 16 16" fill="none"
          className={`text-text-tertiary transition-transform duration-150 ${expanded ? 'rotate-90' : ''}`}
        >
          <path d="M5 3l6 5-6 5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {/* 展开内容：意图 + 参数 + 结果 */}
      {expanded && (
        <div className="px-3 pb-2.5 space-y-1.5 border-t border-white/5 pt-2">
          {call.intent && (
            <div className="text-2xs text-text-tertiary">
              <span className="opacity-60">意图：</span>
              {call.intent}
            </div>
          )}
          {call.args && Object.keys(call.args).length > 0 && (
            <div>
              <div className="text-2xs text-text-tertiary opacity-60 mb-0.5">参数</div>
              <pre
                className="text-2xs font-mono text-text-secondary bg-black/20 rounded-lg p-2 overflow-auto max-h-40"
                data-selectable="true"
              >
                {JSON.stringify(call.args, null, 2)}
              </pre>
            </div>
          )}
          {call.result && (
            <div>
              <div className="text-2xs text-text-tertiary opacity-60 mb-0.5">
                {isFailed ? '错误' : '结果'}
              </div>
              <pre
                className={`text-2xs font-mono rounded-lg p-2 overflow-auto max-h-60 whitespace-pre-wrap break-words
                  ${isFailed ? 'text-rose-300 bg-rose-500/8' : 'text-text-secondary bg-black/20'}
                `}
                data-selectable="true"
              >
                {call.result}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function SpinnerIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" className="animate-spin">
      <circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeWidth="1.4" strokeOpacity="0.25" />
      <path d="M13.5 8a5.5 5.5 0 00-5.5-5.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

function CrossIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
      <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}
