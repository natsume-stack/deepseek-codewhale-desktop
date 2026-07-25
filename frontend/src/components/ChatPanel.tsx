/**
 * 中央对话面板（Codex 风格 - 阶段 2 重构）
 *
 *  - 顶栏：会话标题 + token 估算 + 右栏切换按钮（极简，无 token/sessionId 高亮）
 *  - 消息流：user / assistant 消息，含推理过程与代码块
 *  - 底部输入栏：Codex 风格圆角大框 + 内嵌发送 + 底部状态条（模型 / 上下文 / 权限）
 *
 * DiffPanel 已迁移到 WorkArea 右栏，本组件不再嵌入 DiffPanel。
 * 当用户点击代码块"应用修改"时，若右栏折叠，自动调用 onToggleRight 展开。
 *
 * 数据流：useChatStore.send() -> POST /api/chat (SSE) -> 增量更新 messages
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useChatStore } from '../stores/chat'
import { useDiffStore } from '../stores/diffs'
import { useDialogStore } from '../stores/dialog'
import { useAutoScroll } from '../hooks/useAutoScroll'
import { MessageItem } from './MessageItem'
import { SlashMenu, BUILTIN_SLASH_COMMANDS } from './SlashMenu'
import type { SlashCommand } from './SlashMenu'
import { FilePicker } from './FilePicker'
import { ModelSwitcher } from './ModelSwitcher'
import { SkillListPanel } from './SkillListPanel'
import { MCPManagerPanel } from './MCPManagerPanel'
import { configApi, paramsApi } from '../lib/api'
import type { ModelProfile } from '../types'

interface ChatPanelProps {
  onToggleLeft?: () => void
  onToggleRight?: () => void
  leftCollapsed?: boolean
  rightCollapsed?: boolean
}

/** 内置模型档案（后端 /model-profiles 路由可能不存在，作为占位使用） */
const BUILTIN_MODEL_PROFILES: ModelProfile[] = [
  {
    id: 'deepseek-chat',
    name: 'deepseek-chat',
    displayName: 'DeepSeek Chat',
    description: '通用对话模型，响应快速，适合大多数编程任务',
    maxTokens: 64000,
    supportsReasoning: false,
  },
  {
    id: 'deepseek-reasoner',
    name: 'deepseek-reasoner',
    displayName: 'DeepSeek Reasoner',
    description: '推理模型，含显式思考过程，适合复杂逻辑与算法题',
    maxTokens: 64000,
    supportsReasoning: true,
  },
  {
    id: 'deepseek-coder',
    name: 'deepseek-coder',
    displayName: 'DeepSeek Coder',
    description: '代码专精模型，对代码补全与重构有更高准确率',
    maxTokens: 128000,
    supportsReasoning: false,
  },
]

/**
 * 扩展斜杠指令集：在内置指令基础上追加技能/插件相关指令。
 *  - /skill       触发技能匹配（作为 slashCommand 传给后端）
 *  - /skill-list  打开技能管理面板（视图类，不进入 slashCommand）
 *  - /mcp         调用 MCP 插件工具（作为 slashCommand 传给后端）
 *  - /mcp-list    打开 MCP 插件管理面板（视图类）
 *  - /plugin      /mcp-list 别名（视图类）
 */
const EXTENDED_SLASH_COMMANDS: SlashCommand[] = [
  ...BUILTIN_SLASH_COMMANDS,
  { cmd: '/skill', label: '触发技能', desc: '对当前消息触发技能匹配' },
  { cmd: '/skill-list', label: '技能列表', desc: '打开技能管理面板' },
  { cmd: '/mcp', label: '调用插件', desc: '调用 MCP 插件工具' },
  { cmd: '/mcp-list', label: '插件列表', desc: '打开 MCP 插件管理面板' },
  { cmd: '/plugin', label: '插件管理', desc: '打开 MCP 插件管理面板（同 /mcp-list）' },
]

/** 视图类指令集合：选中后打开对应面板，不进入 slashCommand 流程 */
const VIEW_COMMANDS: Record<string, 'skill' | 'mcp'> = {
  '/skill-list': 'skill',
  '/mcp-list': 'mcp',
  '/plugin': 'mcp',
}

export function ChatPanel({ onToggleLeft, onToggleRight, leftCollapsed, rightCollapsed }: ChatPanelProps = {}) {
  const messages = useChatStore((s) => s.messages)
  const streaming = useChatStore((s) => s.streaming)
  const lastError = useChatStore((s) => s.lastError)
  const sessionId = useChatStore((s) => s.sessionId)
  const send = useChatStore((s) => s.send)
  const stop = useChatStore((s) => s.stop)
  const resetSession = useChatStore((s) => s.resetSession)
  const retryMessage = useChatStore((s) => s.retry)
  const deleteMessage = useChatStore((s) => s.deleteMessage)
  const toggleFold = useChatStore((s) => s.toggleFold)
  const overrideReasoningEffort = useChatStore((s) => s.overrideReasoningEffort)
  const overrideContextLength = useChatStore((s) => s.overrideContextLength)

  const diffCount = useDiffStore((s) => s.diffs.length)
  const pendingCount = useDiffStore((s) => s.diffs.filter((d) => d.status === 'pending').length)
  const registerDiff = useDiffStore((s) => s.register)
  const refreshDiff = useDiffStore((s) => s.refresh)

  const [draft, setDraft] = useState('')
  // 已挂载附件（@文件）与斜杠指令（/refactor 等）
  const [attachments, setAttachments] = useState<string[]>([])
  const [slashCommand, setSlashCommand] = useState<string | null>(null)
  // 状态条用：模型名 + 默认参数（首次拉取后端配置）
  const [model, setModel] = useState('deepseek-chat')
  const [defaultCtxLen, setDefaultCtxLen] = useState(20)
  const [defaultEffort, setDefaultEffort] = useState('medium')
  // 视图类斜杠指令打开的浮层：/skill-list /mcp-list /plugin
  const [skillListOpen, setSkillListOpen] = useState(false)
  const [mcpListOpen, setMcpListOpen] = useState(false)
  const scrollRef = useAutoScroll(messages)

  // 拉取模型名 + 默认参数（仅一次）
  useEffect(() => {
    void configApi.get().then((c) => setModel(c.model)).catch(() => {})
    void paramsApi.get().then((p) => {
      setDefaultCtxLen(p.contextLength)
      setDefaultEffort(p.reasoningEffort)
    }).catch(() => {})
  }, [])

  const tokenEst = useMemo(() => {
    // 粗略估算：4 字符 ≈ 1 token
    const chars = messages.reduce((sum, m) => sum + (m.content?.length ?? 0) + (m.reasoning?.length ?? 0), 0)
    return Math.ceil(chars / 4)
  }, [messages])

  const handleSend = useCallback(() => {
    const text = draft
    if (!text.trim() || streaming) return
    setDraft('')
    // 发送后清空附件与斜杠指令（已随消息发送给后端）
    setAttachments([])
    setSlashCommand(null)
    void send(text, { attachments, slashCommand: slashCommand ?? undefined })
  }, [draft, streaming, send, attachments, slashCommand])

  const handleStop = useCallback(() => {
    void stop()
  }, [stop])

  const handleReset = useCallback(async () => {
    if (streaming) return
    const ok = await useDialogStore.getState().confirm({
      title: '重置会话上下文',
      message: '确认清空当前会话上下文？此操作不可撤销。',
      confirmText: '重置',
      danger: true,
    })
    if (!ok) return
    void resetSession()
  }, [resetSession, streaming])

  /** 代码块"应用修改"：注册到后端 Diff 注册表，并展开右栏 Diff 面板 */
  const handleApplyCode = useCallback(
    async (code: string, filename?: string, lang?: string) => {
      const dialog = useDialogStore.getState()
      if (!filename) {
        await dialog.alert({
          title: '无法应用修改',
          message: '代码块未声明文件名，无法注册 Diff。请在代码块头部使用 ```lang:path/to/file.ts 语法。',
        })
        return
      }
      const id = await registerDiff({
        filePath: filename,
        modifiedContent: code,
        sessionId: sessionId ?? undefined,
      })
      if (id) {
        // 若右栏折叠，则展开以显示 Diff
        if (rightCollapsed && onToggleRight) {
          onToggleRight()
        }
        void refreshDiff()
      } else {
        const err = useDiffStore.getState().error
        await dialog.alert({
          title: '注册 Diff 失败',
          message: err ?? '未知错误',
        })
      }
      void lang
    },
    [registerDiff, sessionId, rightCollapsed, onToggleRight, refreshDiff],
  )

  const handleRejectCode = useCallback((_filename?: string) => {
    void _filename
  }, [])

  /** 切换模型：持久化到后端配置 + 更新本地状态 */
  const handleModelSwitch = useCallback(async (id: string) => {
    setModel(id)
    try {
      await configApi.set({ model: id })
    } catch {
      /* 后端不可用时静默回退（仅本地切换） */
    }
  }, [])

  return (
    <div className="flex flex-col h-full">
      {/* === 顶栏（极简） === */}
      <div className="panel-header">
        <div className="flex items-center gap-2 min-w-0">
          {onToggleLeft && (
            <button
              onClick={onToggleLeft}
              className="icon-btn"
              title={leftCollapsed ? '展开文件树' : '折叠文件树'}
            >
              <SidebarIcon side="left" collapsed={!!leftCollapsed} />
            </button>
          )}
          <span className="panel-title truncate">对话</span>
          <span className="text-2xs font-mono text-text-tertiary">
            {tokenEst > 0 ? `${tokenEst} tokens` : ''}
          </span>
        </div>
        <div className="flex items-center gap-1">
          {/* Diff 切换按钮：显示待应用数 */}
          {onToggleRight && (
            <button
              onClick={onToggleRight}
              className={`icon-btn relative ${!rightCollapsed ? 'text-accent' : ''}`}
              title={rightCollapsed ? '展开变更面板' : '折叠变更面板'}
            >
              <DiffIcon />
              {pendingCount > 0 && rightCollapsed && (
                <span className="absolute -top-0.5 -right-0.5 min-w-[14px] h-[14px] px-1 rounded-full bg-accent text-white text-2xs font-mono flex items-center justify-center">
                  {pendingCount}
                </span>
              )}
            </button>
          )}
          <button
            onClick={handleReset}
            disabled={streaming || messages.length === 0}
            className="icon-btn"
            title="重置当前会话上下文"
          >
            <TrashIcon />
          </button>
        </div>
      </div>

      {/* === 消息流 === */}
      <div ref={scrollRef} className="flex-1 overflow-auto">
        {messages.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="py-2">
            {messages.map((m) => (
              <MessageItem
                key={m.localId}
                message={m}
                onApplyCode={handleApplyCode}
                onRejectCode={handleRejectCode}
                onRetry={(localId) => void retryMessage(localId)}
                onDelete={(localId) => deleteMessage(localId)}
                folded={m.folded}
                onToggleFold={(localId) => toggleFold(localId)}
              />
            ))}
          </div>
        )}
      </div>

      {/* === 错误条 === */}
      {lastError && !streaming && (
        <div className="px-4 py-1.5 border-t border-rose-500/30 bg-rose-500/10 text-2xs text-rose-300">
          最近错误：{lastError}
        </div>
      )}

      {/* === 底部输入栏（Codex 风格圆角大框 + 内嵌发送 + 底部状态条） === */}
      <div className="px-4 pb-3 pt-2">
        <ChatInputBar
          value={draft}
          onChange={setDraft}
          onSend={handleSend}
          onStop={handleStop}
          streaming={streaming}
          model={model}
          modelProfiles={BUILTIN_MODEL_PROFILES}
          onModelSwitch={handleModelSwitch}
          contextLength={overrideContextLength ?? defaultCtxLen}
          effort={overrideReasoningEffort ?? defaultEffort}
          diffCount={diffCount}
          attachments={attachments}
          onAttachmentsChange={setAttachments}
          slashCommand={slashCommand}
          onSlashCommandChange={setSlashCommand}
          commands={EXTENDED_SLASH_COMMANDS}
          onOpenSkillList={() => setSkillListOpen(true)}
          onOpenMcpList={() => setMcpListOpen(true)}
        />
      </div>

      {/* === 视图类斜杠指令触发的浮层 === */}
      {skillListOpen && (
        <SkillListPanel floating onClose={() => setSkillListOpen(false)} />
      )}
      {mcpListOpen && (
        <MCPManagerPanel floating onClose={() => setMcpListOpen(false)} />
      )}
    </div>
  )
}

interface ChatInputBarProps {
  value: string
  onChange: (v: string) => void
  onSend: () => void
  onStop: () => void
  streaming: boolean
  model: string
  /** 可用模型档案列表（用于 ModelSwitcher） */
  modelProfiles: ModelProfile[]
  /** 切换模型回调 */
  onModelSwitch: (id: string) => void
  contextLength: number
  effort: string
  diffCount: number
  attachments: string[]
  onAttachmentsChange: (paths: string[]) => void
  slashCommand: string | null
  onSlashCommandChange: (cmd: string | null) => void
  /** 斜杠指令列表（含技能/插件扩展指令） */
  commands: SlashCommand[]
  /** 视图类指令：打开技能管理面板 */
  onOpenSkillList: () => void
  /** 视图类指令：打开 MCP 插件管理面板 */
  onOpenMcpList: () => void
}

/** 计算光标所在 token 的边界（基于上一个空格切分） */
function getCurrentToken(text: string, cursor: number): { start: number; end: number; token: string } {
  // 向前找最近的空白字符
  let start = cursor
  while (start > 0 && !/\s/.test(text[start - 1])) {
    start--
  }
  return { start, end: cursor, token: text.slice(start, cursor) }
}

/** 计算菜单定位（在 textarea 上方左下角） */
function computeMenuPosition(
  textarea: HTMLTextAreaElement,
  estimatedHeight: number,
): { top: number; left: number } {
  const rect = textarea.getBoundingClientRect()
  const top = Math.max(8, rect.top - estimatedHeight - 8)
  const left = rect.left + 8
  return { top, left }
}

function ChatInputBar({
  value,
  onChange,
  onSend,
  onStop,
  streaming,
  model,
  modelProfiles,
  onModelSwitch,
  contextLength,
  effort,
  diffCount,
  attachments,
  onAttachmentsChange,
  slashCommand,
  onSlashCommandChange,
  commands,
  onOpenSkillList,
  onOpenMcpList,
}: ChatInputBarProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  // SlashMenu 状态
  const [slashVisible, setSlashVisible] = useState(false)
  const [slashPosition, setSlashPosition] = useState({ top: 0, left: 0 })
  const [slashQuery, setSlashQuery] = useState('')
  // FilePicker 状态
  const [pickerVisible, setPickerVisible] = useState(false)
  const [pickerPosition, setPickerPosition] = useState({ top: 0, left: 0 })
  // 当前 @ token 在文本中的边界，用于选中文件后替换
  const atTokenRef = useRef<{ start: number; end: number } | null>(null)
  // 当前 / token 在文本中的边界，用于选中指令后替换
  const slashTokenRef = useRef<{ start: number; end: number } | null>(null)

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      // 当 SlashMenu 可见时，由其全局监听拦截回车，这里跳过
      if (slashVisible) {
        e.preventDefault()
        return
      }
      e.preventDefault()
      onSend()
    }
  }

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const ta = e.target
    onChange(ta.value)
    // 自适应高度
    ta.style.height = 'auto'
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`

    // 检测光标处的 token，决定是否显示 SlashMenu / FilePicker
    const cursor = ta.selectionStart ?? ta.value.length
    const { start, token } = getCurrentToken(ta.value, cursor)

    // SlashMenu 触发：以 `/` 开头且无空格（token 本身不含空格）
    if (token.startsWith('/') && token.length >= 1 && !token.includes(' ')) {
      slashTokenRef.current = { start, end: cursor }
      setSlashQuery(token.slice(1)) // 去掉 `/`
      setSlashPosition(computeMenuPosition(ta, 260))
      setSlashVisible(true)
      // 关闭 FilePicker
      if (pickerVisible) setPickerVisible(false)
      return
    }

    // FilePicker 触发：以 `@` 开头
    if (token.startsWith('@')) {
      atTokenRef.current = { start, end: cursor }
      setPickerPosition(computeMenuPosition(ta, 360))
      setPickerVisible(true)
      // 关闭 SlashMenu
      if (slashVisible) setSlashVisible(false)
      return
    }

    // 都不匹配，关闭两个菜单
    if (slashVisible) setSlashVisible(false)
    if (pickerVisible) setPickerVisible(false)
  }

  /** 选中斜杠指令后：把输入框中的 `/xxx` token 替换为完整指令 + 空格
   *  视图类指令（/skill-list /mcp-list /plugin）例外：清除 token 后直接打开对应面板 */
  const handleSlashSelect = (cmd: string) => {
    const ta = textareaRef.current
    const range = slashTokenRef.current

    // 视图类指令：清除输入框中的 /xxx token，打开对应面板，不进入 slashCommand 流程
    const viewTarget = VIEW_COMMANDS[cmd]
    if (viewTarget) {
      if (ta && range) {
        const before = value.slice(0, range.start)
        const after = value.slice(range.end)
        let newVal = `${before}${after}`
        newVal = newVal.replace(/\s+\s/g, ' ').trimStart()
        onChange(newVal)
        requestAnimationFrame(() => ta.focus())
      }
      if (viewTarget === 'skill') {
        onOpenSkillList()
      } else {
        onOpenMcpList()
      }
      setSlashVisible(false)
      return
    }

    // 普通指令：替换 token 为完整指令 + 空格，并设置 slashCommand
    if (ta && range) {
      const before = value.slice(0, range.start)
      const after = value.slice(range.end)
      const newVal = `${before}${cmd} ${after}`
      onChange(newVal)
      // 把光标放到指令后空格之后
      const newCursor = range.start + cmd.length + 1
      requestAnimationFrame(() => {
        ta.focus()
        ta.setSelectionRange(newCursor, newCursor)
      })
    }
    onSlashCommandChange(cmd)
    setSlashVisible(false)
  }

  /** 选中文件后：把输入框中的 `@xxx` token 替换为空，将选中文件加入 attachments */
  const handleFilePick = (paths: string[]) => {
    const ta = textareaRef.current
    const range = atTokenRef.current
    if (ta && range) {
      const before = value.slice(0, range.start)
      const after = value.slice(range.end)
      // 去掉 @token，若 before 末尾是空格且 after 仍是空格则保留一个
      let newVal = `${before}${after}`
      // 折叠前后多余空格
      newVal = newVal.replace(/\s+\s/g, ' ').trimStart()
      onChange(newVal)
      requestAnimationFrame(() => {
        ta.focus()
      })
    }
    // 合并去重
    const set = new Set(attachments)
    for (const p of paths) set.add(p)
    onAttachmentsChange(Array.from(set))
    setPickerVisible(false)
  }

  /** 删除附件 */
  const handleRemoveAttachment = (path: string) => {
    onAttachmentsChange(attachments.filter((p) => p !== path))
  }

  /** 删除斜杠指令 */
  const handleRemoveSlash = () => {
    onSlashCommandChange(null)
  }

  // 菜单关闭处理（非选中导致）
  const handleSlashClose = () => setSlashVisible(false)
  const handlePickerClose = () => setPickerVisible(false)

  return (
    <div className="rounded-xl border border-white/8 bg-white/4 focus-within:border-accent/40 focus-within:bg-white/6 transition-all duration-200 ease-out">
      {/* 文本输入区 + 内嵌发送按钮 */}
      <div className="flex items-end gap-2 px-3 pt-3 pb-2">
        <textarea
          ref={textareaRef}
          className="flex-1 resize-none min-h-[28px] max-h-[200px] leading-6 bg-transparent text-sm text-text-primary placeholder-text-tertiary focus:outline-none"
          placeholder="输入开发需求… (/ 斜杠指令, @ 挂载文件, Enter 发送, Shift+Enter 换行)"
          rows={1}
          value={value}
          onChange={handleInput}
          onKeyDown={handleKeyDown}
          data-selectable="true"
          spellCheck={false}
        />
        {streaming ? (
          <button
            className="inline-flex items-center justify-center w-7 h-7 rounded-lg bg-white/8 text-text-primary hover:bg-white/12 transition-all duration-200"
            onClick={onStop}
            title="停止生成"
          >
            <StopIcon />
          </button>
        ) : (
          <button
            className="inline-flex items-center justify-center w-7 h-7 rounded-lg bg-accent text-white hover:bg-accent-hover disabled:opacity-30 disabled:cursor-not-allowed transition-all duration-200"
            onClick={onSend}
            disabled={!value.trim()}
            title="发送消息"
          >
            <SendIcon />
          </button>
        )}
      </div>

      {/* 已挂载附件 + 斜杠指令 chips */}
      {(attachments.length > 0 || slashCommand) && (
        <div className="flex flex-wrap items-center gap-1.5 px-3 pb-1.5">
          {slashCommand && (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-accent/15 border border-accent/30 text-2xs font-mono text-accent">
              {slashCommand}
              <button
                className="text-accent hover:text-accent-hover"
                onClick={handleRemoveSlash}
                title="移除指令"
              >
                <CloseMiniIcon />
              </button>
            </span>
          )}
          {attachments.map((p) => (
            <span
              key={p}
              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-white/6 border border-white/8 text-2xs font-mono text-text-secondary max-w-[180px]"
              title={p}
            >
              <AttachIcon />
              <span className="truncate">{p}</span>
              <button
                className="text-text-tertiary hover:text-text-primary"
                onClick={() => handleRemoveAttachment(p)}
                title="移除附件"
              >
                <CloseMiniIcon />
              </button>
            </span>
          ))}
        </div>
      )}

      {/* 底部状态条：模型 / 上下文 / 推理强度 / 变更数 */}
      <div className="flex items-center gap-3 px-3 py-1.5 border-t border-white/5 text-2xs font-mono text-text-tertiary">
        <ModelSwitcher
          current={model}
          profiles={modelProfiles}
          onSwitch={(id) => void onModelSwitch(id)}
          compact
        />
        <span className="text-white/10">·</span>
        <span>ctx {contextLength}</span>
        <span className="text-white/10">·</span>
        <span>effort {effort}</span>
        {diffCount > 0 && (
          <>
            <span className="text-white/10">·</span>
            <span className="text-accent">{diffCount} 变更</span>
          </>
        )}
        <span className="ml-auto text-text-tertiary/70">读写权限：工作区</span>
      </div>

      {/* 浮层菜单：斜杠指令 / 文件挂载 */}
      <SlashMenu
        commands={commands}
        visible={slashVisible}
        onSelect={handleSlashSelect}
        onClose={handleSlashClose}
        position={slashPosition}
        query={slashQuery}
      />
      <FilePicker
        visible={pickerVisible}
        onPick={handleFilePick}
        onClose={handlePickerClose}
        position={pickerPosition}
      />
    </div>
  )
}

function CloseMiniIcon() {
  return (
    <svg width="9" height="9" viewBox="0 0 16 16" fill="none">
      <line x1="4" y1="4" x2="12" y2="12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <line x1="12" y1="4" x2="4" y2="12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

function AttachIcon() {
  return (
    <svg width="9" height="9" viewBox="0 0 16 16" fill="none" className="text-text-tertiary">
      <path
        d="M11 5l-5 5a2 2 0 102.8 2.8L13 8.5a3.5 3.5 0 10-5-5L4 7.8"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  )
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-3.5 text-center px-6">
      <WhaleIcon />
      <div className="text-lg text-text-secondary">开始与 CodeWhale 对话</div>
      <div className="text-xs text-text-tertiary max-w-md">
        输入开发需求，AI 将基于 DeepSeek V4 流式输出推理与代码；代码块顶部声明文件名后可一键应用为 Diff 变更。
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2 text-left max-w-lg">
        <ExampleCard
          title="实现新功能"
          hint="在 src/utils.rs 添加 sha256 工具函数并附单测"
        />
        <ExampleCard
          title="修复 Bug"
          hint="分析 panic 堆栈，定位到 unwrap 调用并替换为 ?"
        />
        <ExampleCard
          title="重构代码"
          hint="将 chat_handler 拆分为 parse / dispatch / stream 三阶段"
        />
        <ExampleCard
          title="解释代码"
          hint="说明 src/diff.rs 中 Myers 算法的实现思路"
        />
      </div>
    </div>
  )
}

function ExampleCard({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="p-2.5 rounded border border-white/8 bg-white/4 hover:bg-white/8 transition-colors">
      <div className="text-xs font-semibold text-text-primary mb-0.5">{title}</div>
      <div className="text-2xs text-text-tertiary leading-relaxed">{hint}</div>
    </div>
  )
}

function DiffIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
      <path d="M4 1v4M4 11v4M1 4h6M1 12h6M10 1l3 14M9 8h6" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
    </svg>
  )
}

function TrashIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
      <path d="M3 4h10M6 4V2h4v2M5 4l1 9h4l1-9" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function SendIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
      <path d="M2 8l12-5-5 12-2-5-5-2z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" fill="currentColor" />
    </svg>
  )
}

function StopIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
      <rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor" />
    </svg>
  )
}

function WhaleIcon() {
  return (
    <svg width="48" height="48" viewBox="0 0 48 48" fill="none" className="text-accent/60">
      <path
        d="M8 24c0-8 6-14 16-14s16 6 16 14v4c0 2-2 4-4 4-1.5 0-2.5-1-3-2-1 1.5-3 2-5 2-2.5 0-4-1.5-4-4v-2"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="14" cy="22" r="1.2" fill="currentColor" />
      <path d="M40 24c2-1 4-3 4-6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

function SidebarIcon({ side, collapsed }: { side: 'left' | 'right'; collapsed: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" className="text-text-secondary">
      <rect x="2" y="3" width="12" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.1" />
      {side === 'left' ? (
        <>
          <rect x="2" y="3" width="4" height="10" fill="currentColor" className={collapsed ? 'opacity-30' : 'opacity-60'} />
          {collapsed && <path d="M7 8h5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />}
        </>
      ) : (
        <>
          <rect x="10" y="3" width="4" height="10" fill="currentColor" className={collapsed ? 'opacity-30' : 'opacity-60'} />
          {collapsed && <path d="M4 8h5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />}
        </>
      )}
    </svg>
  )
}
