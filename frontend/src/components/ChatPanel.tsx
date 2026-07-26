import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { useChatStore } from '../stores/chat'
import { useDiffStore } from '../stores/diffs'
import { useDialogStore } from '../stores/dialog'
import { useFileTreeStore } from '../stores/fileTree'
import { useAutoScroll } from '../hooks/useAutoScroll'
import { MessageItem } from './MessageItem'
import { SlashMenu, BUILTIN_SLASH_COMMANDS } from './SlashMenu'
import type { SlashCommand } from './SlashMenu'
import { FilePicker } from './FilePicker'
import { SkillListPanel } from './SkillListPanel'
import { MCPManagerPanel } from './MCPManagerPanel'
import { configApi, paramsApi, projectApi, gitApi, mcpApi, permissionApi } from '../lib/api'
import type { ModelProfile, ProjectInfo, GitStatus, McpConfig, McpStatus, PermissionConfig, PermissionLevel, ReasoningEffort } from '../types'

interface ChatPanelProps {
  onToggleLeft?: () => void
  onToggleRight?: () => void
  leftCollapsed?: boolean
  rightCollapsed?: boolean
}

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

const EXTENDED_SLASH_COMMANDS: SlashCommand[] = [
  ...BUILTIN_SLASH_COMMANDS,
  { cmd: '/skill', label: '触发技能', desc: '对当前消息触发技能匹配' },
  { cmd: '/skill-list', label: '技能列表', desc: '打开技能管理面板' },
  { cmd: '/mcp', label: '调用插件', desc: '调用 MCP 插件工具' },
  { cmd: '/mcp-list', label: '插件列表', desc: '打开 MCP 插件管理面板' },
  { cmd: '/plugin', label: '插件管理', desc: '打开 MCP 插件管理面板（同 /mcp-list）' },
]

const VIEW_COMMANDS: Record<string, 'skill' | 'mcp'> = {
  '/skill-list': 'skill',
  '/mcp-list': 'mcp',
  '/plugin': 'mcp',
}

type PermissionMode = 'ask' | 'auto' | 'fullaccess' | 'custom'
type EffortLevel = ReasoningEffort

const PERMISSION_LABELS: Record<PermissionMode, string> = {
  ask: '请求批准',
  auto: '替我审批',
  fullaccess: '完全访问',
  custom: '自定义',
}

const PERMISSION_LEVEL_MAP: Record<PermissionMode, PermissionLevel> = {
  ask: 'readOnly',
  auto: 'workspaceWrite',
  fullaccess: 'fullAccess',
  custom: 'workspaceWrite',
}

const LEVEL_TO_MODE: Record<PermissionLevel, PermissionMode> = {
  readOnly: 'ask',
  workspaceWrite: 'auto',
  fullAccess: 'fullaccess',
}

const EFFORT_LABELS: Record<EffortLevel, string> = {
  minimal: '极低',
  low: '低',
  medium: '中',
  high: '高',
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
  const setOverrides = useChatStore((s) => s.setOverrides)

  const pendingCount = useDiffStore((s) => s.diffs.filter((d) => d.status === 'pending').length)
  const diffs = useDiffStore((s) => s.diffs)
  const registerDiff = useDiffStore((s) => s.register)
  const refreshDiff = useDiffStore((s) => s.refresh)

  const [draft, setDraft] = useState('')
  const [attachments, setAttachments] = useState<string[]>([])
  const [slashCommand, setSlashCommand] = useState<string | null>(null)
  const [model, setModel] = useState('deepseek-chat')
  const [defaultEffort, setDefaultEffort] = useState('medium')
  const [contextLimit, setContextLimit] = useState(32_768)
  const [skillListOpen, setSkillListOpen] = useState(false)
  const [mcpListOpen, setMcpListOpen] = useState(false)
  const scrollRef = useAutoScroll(messages)

  const [projectName, setProjectName] = useState('CodeWhale')
  const [gitBranch, setGitBranch] = useState('main')
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('fullaccess')
  const [mcpPlugins, setMcpPlugins] = useState<Array<McpConfig & { status?: McpStatus }>>([])

  const handlePickProject = useCallback(async () => {
    const path = await invoke<string | null>('pick_project_folder').catch(() => null)
    if (!path) return
    const loaded = await useFileTreeStore.getState().loadProject(path)
    if (!loaded) {
      await useDialogStore.getState().alert({ title: '项目加载失败', message: useFileTreeStore.getState().error ?? '无法加载所选目录。' })
      return
    }
    const name = path.split(/[\\/]/).filter(Boolean).pop()
    setProjectName(name || 'CodeWhale')
    void gitApi.status().then((g) => setGitBranch(g.branch || 'main')).catch(() => setGitBranch('main'))
  }, [])

  useEffect(() => {
    void configApi.get().then((c) => setModel(c.model)).catch(() => {})
    void paramsApi.get().then((p) => {
      setDefaultEffort(p.reasoningEffort)
      setContextLimit(p.contextLength)
    }).catch(() => {})
    void projectApi.get().then((p: ProjectInfo) => {
      const name = p.path ? p.path.split(/[\\/]/).pop() : 'CodeWhale'
      setProjectName(name || 'CodeWhale')
    }).catch(() => {})
    void gitApi.status().then((g: GitStatus) => {
      setGitBranch(g.branch || 'main')
    }).catch(() => {})
    void permissionApi.get().then((p: PermissionConfig) => {
      setPermissionMode(LEVEL_TO_MODE[p.level] || 'fullaccess')
    }).catch(() => {})
    void mcpApi.list().then((r) => {
      setMcpPlugins(r.plugins || [])
    }).catch(() => {})
  }, [])

  const tokenEst = useMemo(() => {
    const chars = messages.reduce((sum, m) => sum + (m.content?.length ?? 0) + (m.reasoning?.length ?? 0), 0)
    return Math.ceil(chars / 4)
  }, [messages])

  const diffStats = useMemo(() => diffs.reduce((stats, diff) => {
    const before = diff.originalContent?.split('\n').length ?? 0
    const after = diff.modifiedContent.split('\n').length
    stats.files += 1
    if (after >= before) stats.added += after - before
    else stats.removed += before - after
    return stats
  }, { files: 0, added: 0, removed: 0 }), [diffs])

  const taskProgress = useMemo(() => ({
    current: Math.max(1, messages.filter((message) => message.role === 'assistant').length),
    total: Math.max(1, messages.filter((message) => message.role === 'assistant').length + 1),
  }), [messages])

  const handleSend = useCallback((text?: string) => {
    const sendText = text ?? draft
    if (!sendText.trim() || streaming) return
    setDraft('')
    setAttachments([])
    setSlashCommand(null)
    void send(sendText, { attachments, slashCommand: slashCommand ?? undefined })
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

  const handleModelSwitch = useCallback(async (id: string) => {
    setModel(id)
    try {
      await configApi.set({ model: id })
    } catch {
    }
  }, [])

  /** 切换推理强度：覆盖本轮参数 */
  const handleEffortChange = useCallback((e: EffortLevel) => {
    setOverrides({ reasoningEffort: e })
  }, [setOverrides])

  /** 重置为默认设置 */
  const handleResetDefaults = useCallback(async () => {
    setOverrides({ reasoningEffort: undefined, contextLength: undefined })
    try {
      const c = await configApi.get()
      setModel(c.model)
      const p = await paramsApi.get()
      setDefaultEffort(p.reasoningEffort)
    } catch {
    }
  }, [setOverrides])

  const handlePermissionChange = useCallback(async (mode: PermissionMode) => {
    setPermissionMode(mode)
    if (mode !== 'custom') {
      try {
        await permissionApi.set({ level: PERMISSION_LEVEL_MAP[mode] })
      } catch {
      }
    }
  }, [])

  const handleMcpToggle = useCallback(async (id: string) => {
    try {
      const r = await mcpApi.toggle(id)
      setMcpPlugins(prev => prev.map(p => p.meta.id === id ? { ...p, meta: { ...p.meta, enabled: r.enabled } } : p))
    } catch {
    }
  }, [])

  const currentModelProfile = useMemo(() => {
    return BUILTIN_MODEL_PROFILES.find(p => p.id === model) || BUILTIN_MODEL_PROFILES[0]
  }, [model])

  return (
    <div className="flex flex-col h-full">
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
          {onToggleRight && (
            <button
              onClick={onToggleRight}
              className={`icon-btn relative ${!rightCollapsed ? 'text-white' : ''}`}
              title={rightCollapsed ? '展开变更面板' : '折叠变更面板'}
            >
              <DiffIcon />
              {pendingCount > 0 && rightCollapsed && (
                <span className="absolute -top-0.5 -right-0.5 min-w-[14px] h-[14px] px-1 rounded-full bg-white text-black text-2xs font-mono flex items-center justify-center">
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

      <div ref={scrollRef} className="flex-1 overflow-auto">
        {messages.length === 0 ? (
          <EmptyState projectName={projectName} onQuickAction={handleSend} />
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

      {lastError && !streaming && (
        <div className="px-4 py-1.5 border-t border-rose-500/30 bg-rose-500/10 text-2xs text-rose-300">
          最近错误：{lastError}
        </div>
      )}

      <div className="px-4 pb-3 pt-2">
        <ChatInputBar
          value={draft}
          onChange={setDraft}
          onSend={() => handleSend()}
          onStop={handleStop}
          streaming={streaming}
          hasHistory={messages.length > 0}
          taskProgress={taskProgress}
          changedFiles={diffStats.files}
          linesAdded={diffStats.added}
          linesRemoved={diffStats.removed}
          contextUsed={tokenEst}
          contextLimit={contextLimit}
          modelDisplayName={currentModelProfile.displayName}
          effort={(overrideReasoningEffort ?? defaultEffort) as EffortLevel}
          projectName={projectName}
          gitBranch={gitBranch}
          permissionMode={permissionMode}
          onPermissionChange={handlePermissionChange}
          mcpPlugins={mcpPlugins}
          onMcpToggle={handleMcpToggle}
          attachments={attachments}
          onAttachmentsChange={setAttachments}
          slashCommand={slashCommand}
          onSlashCommandChange={setSlashCommand}
          commands={EXTENDED_SLASH_COMMANDS}
          onOpenSkillList={() => setSkillListOpen(true)}
          onOpenMcpList={() => setMcpListOpen(true)}
          onModelSwitch={handleModelSwitch}
          onEffortChange={handleEffortChange}
          onResetDefaults={handleResetDefaults}
          onPickProject={() => void handlePickProject()}
        />
      </div>

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
  hasHistory: boolean
  taskProgress: { current: number; total: number }
  changedFiles: number
  linesAdded: number
  linesRemoved: number
  contextUsed: number
  contextLimit: number
  modelDisplayName: string
  effort: EffortLevel
  projectName: string
  gitBranch: string
  permissionMode: PermissionMode
  onPermissionChange: (mode: PermissionMode) => void
  onPickProject: () => void
  mcpPlugins: Array<McpConfig & { status?: McpStatus }>
  onMcpToggle: (id: string) => void
  attachments: string[]
  onAttachmentsChange: (paths: string[]) => void
  slashCommand: string | null
  onSlashCommandChange: (cmd: string | null) => void
  commands: SlashCommand[]
  onOpenSkillList: () => void
  onOpenMcpList: () => void
  onModelSwitch?: (id: string) => void
  onEffortChange: (e: EffortLevel) => void
  onResetDefaults: () => void
}

function getCurrentToken(text: string, cursor: number): { start: number; end: number; token: string } {
  let start = cursor
  while (start > 0 && !/\s/.test(text[start - 1])) {
    start--
  }
  return { start, end: cursor, token: text.slice(start, cursor) }
}

function computeMenuPosition(
  textarea: HTMLTextAreaElement,
  estimatedHeight: number,
): { top: number; left: number } {
  const rect = textarea.getBoundingClientRect()
  const top = Math.max(8, rect.top - estimatedHeight - 8)
  const left = rect.left + 8
  return { top, left }
}

function useClickOutside(ref: React.RefObject<HTMLElement | null>, handler: () => void) {
  useEffect(() => {
    const listener = (e: MouseEvent) => {
      if (!ref.current || ref.current.contains(e.target as Node)) return
      handler()
    }
    document.addEventListener('mousedown', listener)
    return () => document.removeEventListener('mousedown', listener)
  }, [ref, handler])
}

function ChatInputBar({
  value,
  onChange,
  onSend,
  onStop,
  streaming,
  hasHistory,
  taskProgress,
  changedFiles,
  linesAdded,
  linesRemoved,
  contextUsed,
  contextLimit,
  modelDisplayName,
  effort,
  projectName,
  gitBranch,
  permissionMode,
  onPermissionChange,
  onPickProject,
  mcpPlugins,
  onMcpToggle,
  attachments,
  onAttachmentsChange,
  slashCommand,
  onSlashCommandChange,
  commands,
  onOpenSkillList,
  onOpenMcpList,
  onEffortChange,
  onResetDefaults,
}: ChatInputBarProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [slashVisible, setSlashVisible] = useState(false)
  const [slashPosition, setSlashPosition] = useState({ top: 0, left: 0 })
  const [slashQuery, setSlashQuery] = useState('')
  const [pickerVisible, setPickerVisible] = useState(false)
  const [pickerPosition, setPickerPosition] = useState({ top: 0, left: 0 })
  const atTokenRef = useRef<{ start: number; end: number } | null>(null)
  const slashTokenRef = useRef<{ start: number; end: number } | null>(null)

  const [addMenuOpen, setAddMenuOpen] = useState(false)
  const [permOpen, setPermOpen] = useState(false)
  const [modelEffortOpen, setModelEffortOpen] = useState(false)
  const [effortPickerOpen, setEffortPickerOpen] = useState(false)
  const [cacheHitRate, setCacheHitRate] = useState<number | null>(null)

  useEffect(() => {
    let cancelled = false
    const refresh = () => {
      void configApi.getCacheStats().then((stats) => {
        if (!cancelled) setCacheHitRate(stats.hitRate)
      }).catch(() => {})
    }
    refresh()
    const timer = window.setInterval(refresh, 10_000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [])

  const addBtnRef = useRef<HTMLButtonElement>(null)
  const permBtnRef = useRef<HTMLButtonElement>(null)
  const modelBtnRef = useRef<HTMLButtonElement>(null)
  const addMenuRef = useRef<HTMLDivElement>(null)
  const permMenuRef = useRef<HTMLDivElement>(null)
  const modelMenuRef = useRef<HTMLDivElement>(null)

  useClickOutside(addMenuRef, () => setAddMenuOpen(false))
  useClickOutside(permMenuRef, () => setPermOpen(false))
  useClickOutside(modelMenuRef, () => { setModelEffortOpen(false); setEffortPickerOpen(false) })

  const getPopoverPos = (btnRef: React.RefObject<HTMLButtonElement | null>) => {
    if (!btnRef.current) return { bottom: 60, left: 0 }
    const rect = btnRef.current.getBoundingClientRect()
    const containerRect = containerRef.current?.getBoundingClientRect()
    if (!containerRect) return { bottom: 60, left: rect.left }
    return {
      bottom: containerRect.bottom - rect.top + 8,
      left: rect.left - containerRect.left,
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
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
    ta.style.height = 'auto'
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`

    const cursor = ta.selectionStart ?? ta.value.length
    const { start, token } = getCurrentToken(ta.value, cursor)

    if (token.startsWith('/') && token.length >= 1 && !token.includes(' ')) {
      slashTokenRef.current = { start, end: cursor }
      setSlashQuery(token.slice(1))
      setSlashPosition(computeMenuPosition(ta, 260))
      setSlashVisible(true)
      if (pickerVisible) setPickerVisible(false)
      return
    }

    if (token.startsWith('@')) {
      atTokenRef.current = { start, end: cursor }
      setPickerPosition(computeMenuPosition(ta, 360))
      setPickerVisible(true)
      if (slashVisible) setSlashVisible(false)
      return
    }

    if (slashVisible) setSlashVisible(false)
    if (pickerVisible) setPickerVisible(false)
  }

  const handleSlashSelect = (cmd: string) => {
    const ta = textareaRef.current
    const range = slashTokenRef.current

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

    if (ta && range) {
      const before = value.slice(0, range.start)
      const after = value.slice(range.end)
      const newVal = `${before}${cmd} ${after}`
      onChange(newVal)
      const newCursor = range.start + cmd.length + 1
      requestAnimationFrame(() => {
        ta.focus()
        ta.setSelectionRange(newCursor, newCursor)
      })
    }
    onSlashCommandChange(cmd)
    setSlashVisible(false)
  }

  const handleFilePick = (paths: string[]) => {
    const ta = textareaRef.current
    const range = atTokenRef.current
    if (ta && range) {
      const before = value.slice(0, range.start)
      const after = value.slice(range.end)
      let newVal = `${before}${after}`
      newVal = newVal.replace(/\s+\s/g, ' ').trimStart()
      onChange(newVal)
      requestAnimationFrame(() => {
        ta.focus()
      })
    }
    const set = new Set(attachments)
    for (const p of paths) set.add(p)
    onAttachmentsChange(Array.from(set))
    setPickerVisible(false)
  }

  const handleRemoveAttachment = (path: string) => {
    onAttachmentsChange(attachments.filter((p) => p !== path))
  }

  const handleRemoveSlash = () => {
    onSlashCommandChange(null)
  }

  const handleSlashClose = () => setSlashVisible(false)
  const handlePickerClose = () => setPickerVisible(false)

  const addMenuPos = getPopoverPos(addBtnRef)
  const permPos = getPopoverPos(permBtnRef)
  const modelPos = getPopoverPos(modelBtnRef)

  return (
    <div className={`relative ${(streaming || !hasHistory) ? 'pt-10' : ''}`}>
      {streaming ? (
        <div className="absolute top-0 left-1/2 z-20 flex h-12 w-fit max-w-[88%] -translate-x-1/2 items-center gap-3 rounded-[23px] border border-white/10 bg-[#232325] px-5 text-sm shadow-raised">
          <span className="h-3 w-3 flex-shrink-0 rounded-full border-2 border-accent border-t-transparent animate-spin" />
          <span className="text-text-secondary whitespace-nowrap">第 {taskProgress.current} / {taskProgress.total} 步</span>
          <span className="max-w-[180px] truncate text-text-tertiary">{changedFiles > 0 ? `${changedFiles} 个文件已变更` : '正在执行任务'}</span>
          <span className="text-emerald-400">+{linesAdded}</span>
          <span className="text-rose-400">-{linesRemoved}</span>
        </div>
      ) : !hasHistory ? (
      <div className="absolute top-0 left-1/2 z-0 flex h-12 w-[88%] max-w-[720px] -translate-x-1/2 items-center justify-start gap-5 rounded-t-[23px] border border-white/8 border-b-0 bg-[#151516] px-6 pb-1 text-xs text-text-tertiary">
        <span className="inline-flex min-w-0 items-center gap-1.5 truncate"><FolderIcon /><span className="max-w-[180px] truncate">{projectName}</span></span>
        <span className="inline-flex flex-shrink-0 items-center gap-1.5"><MonitorIcon /><span>本地</span></span>
        <span className="inline-flex min-w-0 items-center gap-1.5 truncate"><GitBranchIcon /><span className="max-w-[150px] truncate">{gitBranch}</span></span>
      </div>
      ) : null}

      <div ref={containerRef} className="relative z-10 rounded-3xl border border-white/8 bg-surface-elevated focus-within:border-white/15 transition-all duration-200 ease-out overflow-visible">

      {(attachments.length > 0 || slashCommand) && (
        <div className="flex flex-wrap items-center gap-1.5 px-4 pt-2 pb-1 border-b border-white/5">
          {slashCommand && (
            <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-white/8 border border-white/10 text-xs font-mono text-text-primary">
              {slashCommand}
              <button
                className="text-text-secondary hover:text-text-primary ml-0.5"
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
              className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-white/6 border border-white/8 text-xs font-mono text-text-secondary max-w-[200px]"
              title={p}
            >
              <PaperclipIcon />
              <span className="truncate">{p}</span>
              <button
                className="text-text-tertiary hover:text-text-primary ml-0.5"
                onClick={() => handleRemoveAttachment(p)}
                title="移除附件"
              >
                <CloseMiniIcon />
              </button>
            </span>
          ))}
        </div>
      )}

      <div>
        <textarea
          ref={textareaRef}
          className="w-full resize-none bg-transparent text-sm text-text-primary placeholder-text-tertiary focus:outline-none px-4 pt-3 pb-2 leading-7"
          style={{ minHeight: 44, maxHeight: 200 }}
          placeholder="随心输入"
          rows={1}
          value={value}
          onChange={handleInput}
          onKeyDown={handleKeyDown}
          data-selectable="true"
          spellCheck={false}
        />
      </div>

      <div className="flex items-center justify-between px-3 border-t border-white/5 h-[52px]">
        <div className="flex items-center gap-2">
          <button
            ref={addBtnRef}
            onClick={() => setAddMenuOpen(!addMenuOpen)}
            className="w-9 h-9 rounded-full bg-transparent hover:bg-white/8 text-2xl flex items-center justify-center text-text-secondary transition-colors"
            title="添加内容"
          >
            <PlusIcon />
          </button>
          <span className="text-2xs text-text-tertiary tabular-nums" title="缓存命中率">
            缓存 {cacheHitRate === null ? '—' : `${(cacheHitRate * 100).toFixed(1)}%`}
          </span>
          <ContextMeter used={contextUsed} limit={contextLimit} />
          <button
            ref={permBtnRef}
            onClick={() => setPermOpen(!permOpen)}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm transition-colors ${
              permissionMode === 'fullaccess'
                ? 'bg-warn/20 text-warn hover:bg-warn/30'
                : 'bg-white/6 text-text-secondary hover:bg-white/10'
            }`}
          >
            <ShieldIcon />
            <span>{PERMISSION_LABELS[permissionMode]}</span>
          </button>
        </div>

        <div className="flex items-center gap-2">
          <button
            ref={modelBtnRef}
            onClick={() => setModelEffortOpen(!modelEffortOpen)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-white/6 text-text-secondary hover:bg-white/10 text-sm transition-colors"
          >
            <span>{modelDisplayName}</span>
            <span className="text-text-tertiary">{EFFORT_LABELS[effort]}</span>
          </button>
          {streaming ? (
            <button
              className="w-9 h-9 rounded-full bg-white/10 text-text-tertiary hover:bg-white/15 flex items-center justify-center transition-colors"
              onClick={onStop}
              title="停止生成"
            >
              <StopIcon />
            </button>
          ) : (
            <button
              className="w-9 h-9 rounded-full bg-white text-black hover:bg-white/90 disabled:bg-white/10 disabled:text-text-tertiary flex items-center justify-center transition-colors disabled:cursor-not-allowed"
              onClick={onSend}
              disabled={!value.trim()}
              title="发送消息"
            >
              <SendIcon />
            </button>
          )}
        </div>
      </div>

      {addMenuOpen && (
        <div
          ref={addMenuRef}
          className="fixed z-50 rounded-2xl bg-surface-elevated border border-surface-border shadow-raised p-1.5 animate-scale-in"
          style={{ bottom: addMenuPos.bottom, left: addMenuPos.left, minWidth: 240, maxHeight: 420, overflowY: 'auto' }}
        >
          <div className="text-xs text-text-tertiary px-3 py-2 font-semibold">添加</div>
          <MenuItem icon={<PaperclipIcon />} label="文件和文件夹" onClick={() => { setAddMenuOpen(false); }} />
          <MenuItem icon={<FolderIcon />} label="项目" desc="选择当前任务的工作目录" onClick={() => { setAddMenuOpen(false); onPickProject() }} />
          <MenuItem icon={<TargetIcon />} label="目标" desc="设置要持续追求的目标" onClick={() => setAddMenuOpen(false)} />
          <MenuItem icon={<BulbIcon />} label="计划模式" desc="开启计划模式" onClick={() => setAddMenuOpen(false)} />
          {mcpPlugins.length > 0 && (
            <>
              <div className="text-xs text-text-tertiary px-3 py-2 font-semibold border-t border-white/5 mt-1">插件</div>
              {mcpPlugins.map((p) => (
                <MenuItem
                  key={p.meta.id}
                  icon={<span className="w-5 h-5 rounded bg-white/10 flex items-center justify-center text-xs">{p.meta.name?.[0]?.toUpperCase() || 'P'}</span>}
                  label={p.meta.name || p.meta.id}
                  desc={p.meta.capabilities || p.meta.description || ''}
                  trailing={p.meta.enabled ? <span className="text-white text-xs">✓</span> : null}
                  onClick={() => onMcpToggle(p.meta.id)}
                />
              ))}
            </>
          )}
        </div>
      )}

      {permOpen && (
        <div
          ref={permMenuRef}
          className="fixed z-50 rounded-2xl bg-surface-elevated border border-surface-border shadow-raised p-1.5 animate-scale-in"
          style={{ bottom: permPos.bottom, left: permPos.left, minWidth: 280 }}
        >
          <div className="text-xs text-text-tertiary px-3 py-2">应如何批准操作？</div>
          <PermissionItem
            icon={<HandIcon />}
            label="请求批准"
            desc="编辑外部文件和使用互联网时始终询问"
            selected={permissionMode === 'ask'}
            onClick={() => { onPermissionChange('ask'); setPermOpen(false); }}
          />
          <PermissionItem
            icon={<MaskIcon />}
            label="替我审批"
            desc="仅对检测到的风险操作请求批准"
            selected={permissionMode === 'auto'}
            onClick={() => { onPermissionChange('auto'); setPermOpen(false); }}
          />
          <PermissionItem
            icon={<ShieldIcon />}
            label="完全访问权限"
            desc="可不受限制地访问互联网和您电脑上的任何文件"
            selected={permissionMode === 'fullaccess'}
            warn
            onClick={() => { onPermissionChange('fullaccess'); setPermOpen(false); }}
          />
          <PermissionItem
            icon={<GearIcon />}
            label="自定义 config.toml"
            desc="使用 config.toml 中定义的权限"
            selected={permissionMode === 'custom'}
            onClick={() => { onPermissionChange('custom'); setPermOpen(false); }}
          />
        </div>
      )}

      {modelEffortOpen && (
        <div
          ref={modelMenuRef}
          className="fixed z-50 rounded-2xl bg-surface-elevated border border-surface-border shadow-raised p-1.5 animate-scale-in"
          style={{ bottom: modelPos.bottom, right: 'auto', left: modelPos.left, minWidth: 240 }}
        >
          {!effortPickerOpen ? (
            <>
              <MenuItem
                label="模型"
                trailing={<span className="flex items-center gap-1 text-text-tertiary text-sm">{modelDisplayName}<ChevronRightIcon /></span>}
                onClick={() => setEffortPickerOpen(false)}
                justifyBetween
              />
              <MenuItem
                label="推理强度"
                trailing={<span className="flex items-center gap-1 text-text-tertiary text-sm">{EFFORT_LABELS[effort]}<ChevronRightIcon /></span>}
                onClick={() => setEffortPickerOpen(true)}
                justifyBetween
              />
              <div className="border-t border-white/5 my-1" />
              <MenuItem
                icon={<RefreshIcon />}
                label="重置为默认设置"
                onClick={() => { setModelEffortOpen(false); setEffortPickerOpen(false); onResetDefaults() }}
              />
            </>
          ) : (
            <>
              <MenuItem
                icon={<ChevronRightIcon className="rotate-180" />}
                label="返回"
                onClick={() => setEffortPickerOpen(false)}
              />
              <div className="border-t border-white/5 my-1" />
              {(['minimal', 'low', 'medium', 'high'] as EffortLevel[]).map((e) => (
                <MenuItem
                  key={e}
                  label={EFFORT_LABELS[e]}
                  trailing={effort === e ? <span className="text-white">✓</span> : null}
                  onClick={() => { onEffortChange(e); setEffortPickerOpen(false); setModelEffortOpen(false) }}
                />
              ))}
            </>
          )}
        </div>
      )}

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
    </div>
  )
}

function MenuItem({
  icon,
  label,
  desc,
  trailing,
  onClick,
  justifyBetween,
}: {
  icon?: React.ReactNode
  label: string
  desc?: string
  trailing?: React.ReactNode
  onClick: () => void
  justifyBetween?: boolean
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-start gap-3 px-3 py-2.5 rounded-xl hover:bg-white/8 cursor-pointer transition-colors text-left ${justifyBetween ? 'justify-between' : ''}`}
    >
      {icon && <span className="text-text-secondary mt-0.5 flex-shrink-0">{icon}</span>}
      <div className="flex-1 min-w-0">
        <div className="text-sm text-text-primary">{label}</div>
        {desc && <div className="text-xs text-text-tertiary mt-0.5">{desc}</div>}
      </div>
      {trailing && <span className="flex-shrink-0">{trailing}</span>}
    </button>
  )
}

function ContextMeter({ used, limit }: { used: number; limit: number }) {
  const ratio = limit === 0 ? 1 : Math.min(1, used / limit)
  const label = limit >= 1_000_000 ? '1M' : limit >= 1_000 ? `${Math.round(limit / 1_000)}K` : String(limit)
  return (
    <span className="hidden min-[880px]:inline-flex items-center gap-1.5 text-2xs text-text-tertiary" title={`上下文 ${used.toLocaleString()} / ${limit.toLocaleString()} tokens`}>
      <span>上下文 {used >= 1_000 ? `${Math.round(used / 1_000)}K` : used}/{label}</span>
      <span className="h-1.5 w-12 overflow-hidden rounded-full bg-white/10">
        <span className="block h-full bg-white/60 transition-all" style={{ width: `${ratio * 100}%` }} />
      </span>
    </span>
  )
}

function PermissionItem({
  icon,
  label,
  desc,
  selected,
  warn,
  onClick,
}: {
  icon: React.ReactNode
  label: string
  desc: string
  selected: boolean
  warn?: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-start gap-3 px-3 py-2.5 rounded-xl hover:bg-white/8 cursor-pointer transition-colors text-left ${selected && warn ? 'text-warn' : ''}`}
    >
      <span className={`mt-0.5 flex-shrink-0 ${selected && warn ? 'text-warn' : 'text-text-secondary'}`}>{icon}</span>
      <div className="flex-1 min-w-0">
        <div className={`text-sm ${selected && warn ? 'text-warn' : 'text-text-primary'}`}>{label}</div>
        <div className="text-xs text-text-tertiary mt-0.5">{desc}</div>
      </div>
      {selected && <span className={`flex-shrink-0 ${warn ? 'text-warn' : 'text-white'}`}>✓</span>}
    </button>
  )
}

function EmptyState({ projectName, onQuickAction }: { projectName: string; onQuickAction: (text: string) => void }) {
  const quickActions = [
    { icon: <SearchIcon />, color: '#60A5FA', label: '探索并理解代码', prompt: '探索并理解当前代码库的结构与逻辑' },
    { icon: <HammerIcon />, color: '#C084FC', label: '构建新功能、应用或工具', prompt: '构建一个新功能/应用/工具' },
    { icon: <CycleIcon />, color: '#34D399', label: '审查代码并提出修改建议', prompt: '审查当前代码并提出修改建议' },
    { icon: <BugIcon />, color: '#FB923C', label: '修复问题和失败', prompt: '定位并修复代码中的问题和失败' },
  ]

  return (
    <div className="flex flex-col items-center justify-center h-full text-center px-6 py-8">
      <TerminalLogoIcon />
      <h1 className="text-[30px] font-semibold text-text-primary mt-5 leading-tight">
        我们在 <span className="border-b border-dashed border-text-tertiary pb-1">{projectName}</span> 中构建什么？
      </h1>
      <div className="grid grid-cols-2 gap-2 mt-6 max-w-2xl w-full">
        {quickActions.map((action, i) => (
          <button
            key={i}
            onClick={() => onQuickAction(action.prompt)}
            className="rounded-lg border border-white/8 bg-white/3 hover:bg-white/8 hover:border-white/15 transition-colors duration-150 ease-out cursor-pointer px-4 py-3 text-left min-h-[96px] flex flex-col group"
          >
            <span className="text-2xl mb-auto" style={{ color: action.color }}>{action.icon}</span>
            <div className="text-sm font-medium text-text-primary mt-2">{action.label}</div>
          </button>
        ))}
      </div>
    </div>
  )
}

function CloseMiniIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 16 16" fill="none">
      <line x1="4" y1="4" x2="12" y2="12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <line x1="12" y1="4" x2="4" y2="12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

function DiffIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path d="M4 1v4M4 11v4M1 4h6M1 12h6M10 1l3 14M9 8h6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}

function TrashIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path d="M3 4h10M6 4V2h4v2M5 4l1 9h4l1-9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function SendIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
      <path d="M12 19V5M12 5L5 12M12 5l7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function StopIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor" />
    </svg>
  )
}

function SidebarIcon({ side, collapsed }: { side: 'left' | 'right'; collapsed: boolean }) {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" className="text-text-secondary">
      <rect x="2" y="3" width="12" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
      {side === 'left' ? (
        <>
          <rect x="2" y="3" width="4" height="10" fill="currentColor" className={collapsed ? 'opacity-30' : 'opacity-60'} />
          {collapsed && <path d="M7 8h5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />}
        </>
      ) : (
        <>
          <rect x="10" y="3" width="4" height="10" fill="currentColor" className={collapsed ? 'opacity-30' : 'opacity-60'} />
          {collapsed && <path d="M4 8h5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />}
        </>
      )}
    </svg>
  )
}

function FolderIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2z" />
    </svg>
  )
}

function MonitorIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
      <line x1="8" y1="21" x2="16" y2="21" />
      <line x1="12" y1="17" x2="12" y2="21" />
    </svg>
  )
}

function GitBranchIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <line x1="6" y1="3" x2="6" y2="15" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </svg>
  )
}

function ChevronRightIcon({ className }: { className?: string }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <polyline points="9 18 15 12 9 6" />
    </svg>
  )
}

function PlusIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  )
}

function ShieldIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  )
}

function HandIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 11V6a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v0" />
      <path d="M14 10V4a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v2" />
      <path d="M10 10.5V6a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v8" />
      <path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15" />
    </svg>
  )
}

function MaskIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2z" />
      <path d="M8 14s1.5 2 4 2 4-2 4-2" />
      <line x1="9" y1="9" x2="9.01" y2="9" />
      <line x1="15" y1="9" x2="15.01" y2="9" />
    </svg>
  )
}

function GearIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  )
}

function RefreshIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="23 4 23 10 17 10" />
      <polyline points="1 20 1 14 7 14" />
      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
    </svg>
  )
}

function PaperclipIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  )
}

function TargetIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <circle cx="12" cy="12" r="6" />
      <circle cx="12" cy="12" r="2" />
    </svg>
  )
}

function BulbIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2z" />
    </svg>
  )
}

function TerminalLogoIcon() {
  return (
    <svg width="80" height="80" viewBox="0 0 80 80" fill="none" className="text-text-tertiary">
      <rect x="8" y="12" width="64" height="48" rx="10" stroke="currentColor" strokeWidth="1.2" />
      <path d="M48 8c-4 8-4 16 0 24 4 8 4 16 0 24" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <polyline points="24,32 32,40 24,48" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
      <line x1="38" y1="48" x2="52" y2="48" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  )
}

function SearchIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  )
}

function HammerIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M15 12l-8.5 8.5c-.83.83-2.17.83-3 0c-.83-.83-.83-2.17 0-3L12 9" />
      <path d="M17.64 15L22 10.64" />
      <path d="M20.91 11.7l-1.25-1.25c-.6-.6-.93-1.4-.93-2.25v-.86L16.01 4.6a5.56 5.56 0 0 0-3.94-1.64H9l.92.82A6.18 6.18 0 0 1 12 8.4v1.56l2 2h2.47l2.26 1.91" />
    </svg>
  )
}

function CycleIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="1 4 1 10 7 10" />
      <polyline points="23 20 23 14 17 14" />
      <path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15" />
    </svg>
  )
}

function BugIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="8" y="6" width="8" height="14" rx="4" />
      <path d="M19 7l-3 2M5 7l3 2M19 14l-3-2M5 14l3-2M12 20v-4M12 10V4M8 4l4 2 4-2" />
    </svg>
  )
}
