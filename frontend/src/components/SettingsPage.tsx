/**
 * 设置页面（P2 完整版 - 12 个配置卡片）
 *
 *  ┌──────────────┬──────────────────────────────────────────┐
 *  │  设置分类菜单  │   [←返回] 当前 Section 标题                │
 *  │  - 模型配置    │  ──────────────────────────────────────  │
 *  │  - API 服务商  │   内容面板（滚动）                         │
 *  │  - 权限管控    │   每个 Section 修改即时保存，              │
 *  │  - Skill 技能  │   右上角短暂提示「已保存」。                │
 *  │  - MCP 插件    │                                            │
 *  │  - 项目 RAG    │                                            │
 *  │  - 代码格式化  │                                            │
 *  │  - 缓存调试    │                                            │
 *  │  - 外观主题    │                                            │
 *  │  - 快捷键      │                                            │
 *  │  - 通用安全    │                                            │
 *  │  - 关于        │                                            │
 *  └──────────────┴──────────────────────────────────────────┘
 *
 * 设计约束：
 *   - 圆角：浮层 8px，按钮 4px
 *   - 动画：cubic-bezier(0.16,1,0.3,1)，200ms
 *   - 半透明 rgba
 *   - 修改即时保存（onChange 即调用 API），无需「保存」按钮
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import {
  configApi,
  mcpApi,
  paramsApi,
  permissionApi,
  ragApi,
  skillsApi,
} from '../lib/api'
import { useChatStore } from '../stores/chat'
import { useDialogStore } from '../stores/dialog'
import type {
  ApiProfile,
  AppearanceConfig,
  CacheDebugConfig,
  CacheStats,
  FormatterConfig,
  McpPermissionScope,
  McpService,
  McpServicesConfig,
  McpTransport,
  ModelProfilesConfig,
  PermissionConfig,
  PermissionLevel,
  RagConfig,
  RagIndex,
  ReasoningEffort,
  SecurityConfig,
  ShortcutsConfig,
  SkillItem,
  SkillsConfig,
} from '../types'

/* ============================================================
 * 分类元数据
 * ============================================================ */
export type SettingsSection =
  | 'model' | 'api' | 'permission' | 'skill' | 'mcp'
  | 'rag' | 'formatter' | 'cache' | 'appearance'
  | 'shortcuts' | 'security' | 'about'

interface SectionMeta {
  key: SettingsSection
  label: string
  desc: string
}

export const SETTINGS_SECTIONS: SectionMeta[] = [
  { key: 'model', label: '模型配置', desc: '推理强度、上下文缓存' },
  { key: 'api', label: 'API 服务商', desc: '多模型多凭证管理' },
  { key: 'permission', label: '权限管控', desc: 'Agent 操作沙盒' },
  { key: 'skill', label: 'Skill 技能', desc: '本地技能与外部导入' },
  { key: 'mcp', label: 'MCP 插件', desc: '外部模型上下文协议' },
  { key: 'rag', label: '项目 RAG', desc: '检索增强与索引' },
  { key: 'formatter', label: '代码格式化', desc: 'rustfmt/prettier/black' },
  { key: 'cache', label: '缓存调试', desc: '指纹校验、命中率' },
  { key: 'appearance', label: '外观主题', desc: 'Mica、圆角、动画' },
  { key: 'shortcuts', label: '快捷键', desc: '斜杠指令与界面操作' },
  { key: 'security', label: '通用安全', desc: '审批超时、黑名单' },
  { key: 'about', label: '关于', desc: '版本、构建信息' },
]

/* ============================================================
 * 默认配置（API 不可用时回退）
 * ============================================================ */
const DEFAULT_RAG_CONFIG: RagConfig = {
  enabled: false,
  chunkSize: 500,
  maxTokens: 4000,
  recallWeight: 0.5,
  fileFilter: ['**/*.rs', '**/*.ts', '**/*.tsx', '**/*.py', '**/*.go'],
  autoIndex: true,
}

const DEFAULT_FORMATTER_CONFIG: FormatterConfig = {
  rustEnabled: true,
  goEnabled: true,
  pythonEnabled: true,
  typescriptEnabled: true,
  formatOnSave: false,
  customCommands: {},
}

const DEFAULT_CACHE_CONFIG: CacheDebugConfig = {
  fingerprintCheck: true,
  mountSizeThreshold: 256,
  autoCompressThreshold: 1024,
}

const DEFAULT_APPEARANCE: AppearanceConfig = {
  micaEnabled: true,
  theme: 'dark',
  cornerRadius: 23,
  animationDurationMs: 200,
  codeHighlightTheme: 'github-dark',
}

const DEFAULT_SECURITY: SecurityConfig = {
  approvalTimeoutSecs: 120,
  shellBlacklist: ['rm -rf /', 'sudo ', 'mkfs'],
  sessionExpireHours: 168,
  auditLogPath: '',
}

const DEFAULT_SHORTCUT_BINDINGS: Record<string, string> = {
  'send-message': 'Ctrl+Enter',
  'new-session': 'Ctrl+N',
  'close-session': 'Ctrl+W',
  'toggle-settings': 'Ctrl+,',
  'stop-generation': 'Ctrl+.',
  'reset-session': 'Ctrl+R',
  'open-file': 'Ctrl+O',
  'search': 'Ctrl+F',
  'command-palette': 'Ctrl+K',
  'slash-refactor': '/refactor',
  'slash-explain': '/explain',
  'slash-test': '/test',
  'slash-fix': '/fix',
  'slash-docs': '/docs',
}

const SHORTCUT_LABELS: Record<string, string> = {
  'send-message': '发送消息',
  'new-session': '新建会话',
  'close-session': '关闭会话',
  'toggle-settings': '打开设置',
  'stop-generation': '停止生成',
  'reset-session': '重置会话',
  'open-file': '打开文件',
  'search': '搜索',
  'command-palette': '命令面板',
  'slash-refactor': '斜杠指令：重构',
  'slash-explain': '斜杠指令：解释',
  'slash-test': '斜杠指令：测试',
  'slash-fix': '斜杠指令：修复',
  'slash-docs': '斜杠指令：文档',
}

const API_PROVIDERS: { value: string; label: string }[] = [
  { value: 'deepseek', label: 'DeepSeek' },
  { value: 'openrouter', label: 'OpenRouter' },
  { value: 'mimo', label: 'MiMo' },
  { value: 'volcengine', label: '火山方舟' },
  { value: 'custom', label: '自定义' },
]

const CODE_THEMES = [
  'github-dark', 'dracula', 'monokai', 'one-dark', 'solarized-dark', 'nord',
]

const REASONING_EFFORTS: { value: ReasoningEffort; label: string; hint: string }[] = [
  { value: 'minimal', label: '极速', hint: '最低推理开销' },
  { value: 'low', label: '低', hint: '简短推理' },
  { value: 'medium', label: '中', hint: '均衡模式（默认）' },
  { value: 'high', label: '高', hint: '深度推理' },
]

const PERMISSION_LEVELS: {
  value: PermissionLevel
  label: string
  desc: string
  recommended?: boolean
}[] = [
  { value: 'readOnly', label: 'ReadOnly', desc: '仅读取工作区，禁止写文件和 Shell' },
  { value: 'workspaceWrite', label: 'WorkspaceWrite', desc: '允许读写工作区文件，禁止 Shell', recommended: true },
  { value: 'fullAccess', label: 'FullAccess', desc: '允许读写文件 + Shell 执行（高危）' },
]

const MCP_PERMISSION_SCOPES: { value: McpPermissionScope; label: string }[] = [
  { value: 'file', label: '文件' },
  { value: 'network', label: '网络' },
  { value: 'shell', label: 'Shell' },
  { value: 'database', label: '数据库' },
]

/* ============================================================
 * Toast 上下文（轻量「已保存」提示）
 * ============================================================ */
const ToastContext = createContext<(msg: string) => void>(() => {})
const useToast = () => useContext(ToastContext)

/** Apply persisted appearance settings immediately instead of waiting for restart. */
export function applyAppearanceConfig(config: AppearanceConfig) {
  const root = document.getElementById('root')
  if (!root) return
  root.dataset.codewhaleTheme = config.theme === 'light' ? 'light' : 'dark'
  root.style.setProperty('--codewhale-radius', `${config.cornerRadius}px`)
  root.style.setProperty('--codewhale-transition', `${config.animationDurationMs}ms`)
  root.style.setProperty('--codewhale-code-theme', config.codeHighlightTheme)
}

/* ============================================================
 * 主组件
 * ============================================================ */
export function SettingsPage({ section }: { section: SettingsSection }) {
  const [toast, setToast] = useState<string | null>(null)
  const toastTimerRef = useRef<number | null>(null)

  const showToast = useCallback((msg: string) => {
    setToast(msg)
    if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current)
    toastTimerRef.current = window.setTimeout(() => setToast(null), 1500)
  }, [])

  useEffect(() => () => {
    if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current)
  }, [])

  const meta = SETTINGS_SECTIONS.find((s) => s.key === section) ?? SETTINGS_SECTIONS[0]

  /** 返回按钮：派发自定义事件，App.tsx 可监听切回对话视图 */
  const handleBack = () => {
    window.dispatchEvent(new CustomEvent('codewhale:nav-back'))
  }

  return (
    <ToastContext.Provider value={showToast}>
      <div className="h-full w-full p-4 overflow-hidden animate-page-transition">
        <main className="h-full min-w-0 rounded-[23px] border border-white/6 bg-surface-elevated/60 flex flex-col overflow-hidden">
          {/* 顶部：返回按钮 + 当前 Section 标题 */}
          <div className="flex items-center gap-3 px-5 py-4 border-b border-white/5">
            <button
              onClick={handleBack}
              className="icon-btn"
              title="返回对话"
              aria-label="返回"
            >
              <BackIcon />
            </button>
            <h2 className="text-base font-semibold text-text-primary">{meta.label}</h2>
            <span className="text-sm text-text-tertiary">{meta.desc}</span>

            {/* Toast 提示（右上角短暂闪现） */}
            {toast && (
              <div className="ml-auto px-3 py-1 rounded-xl text-xs text-diff-added-text bg-diff-added/30 border border-diff-added/40 animate-fade-in">
                {toast}
              </div>
            )}
          </div>

          {/* 内容滚动区 */}
          <div className="flex-1 overflow-auto p-6">
            <div key={section} className="animate-fade-in">
              {section === 'model' && <ModelSection />}
              {section === 'api' && <ApiSection />}
              {section === 'permission' && <PermissionSection />}
              {section === 'skill' && <SkillSection />}
              {section === 'mcp' && <McpSection />}
              {section === 'rag' && <RagSection />}
              {section === 'formatter' && <FormatterSection />}
              {section === 'cache' && <CacheSection />}
              {section === 'appearance' && <AppearanceSection />}
              {section === 'shortcuts' && <ShortcutsSection />}
              {section === 'security' && <SecuritySection />}
              {section === 'about' && <AboutSection />}
            </div>
          </div>
        </main>
      </div>
    </ToastContext.Provider>
  )
}

/* ============================================================
 * 通用子组件
 * ============================================================ */

function BackIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path d="M10 4l-4 4 4 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function SectionHeader({ title, desc }: { title: string; desc: string }) {
  return (
    <div className="mb-5">
      <h3 className="text-lg font-semibold text-text-primary mb-1">{title}</h3>
      <p className="text-sm text-text-secondary leading-relaxed">{desc}</p>
    </div>
  )
}

function ErrorBanner({ message }: { message: string | null }) {
  if (!message) return null
  return (
    <div className="mb-5 px-4 py-3 rounded-xl text-sm text-diff-removed-text bg-diff-removed/20 border border-diff-removed/40">
      {message}
    </div>
  )
}

function LoadingHint({ text = '加载中…' }: { text?: string }) {
  return <div className="text-sm text-text-tertiary">{text}</div>
}

/** 通用开关行（半透明浮层内） */
function ToggleRow({
  label,
  desc,
  on,
  disabled,
  onChange,
  warn = false,
}: {
  label: string
  desc: string
  on: boolean
  disabled?: boolean
  onChange: (v: boolean) => void
  warn?: boolean
}) {
  return (
    <div className="flex items-center justify-between px-4 py-3">
      <div className="min-w-0 pr-4">
        <div className="text-sm text-text-primary">{label}</div>
        <div className="text-xs text-text-tertiary mt-0.5">{desc}</div>
      </div>
      <button
        className={`w-11 h-6 rounded-full transition-all duration-300 ease-bounce flex-shrink-0 ${on ? (warn ? 'bg-warn' : 'bg-white') : 'bg-white/12'} ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer hover:scale-105'}`}
        onClick={() => !disabled && onChange(!on)}
        role="switch"
        aria-checked={on}
        disabled={disabled}
      >
        <div
          className={`w-5 h-5 rounded-full bg-black shadow-md transition-transform duration-300 ease-bounce ${on ? 'translate-x-5' : 'translate-x-0.5'}`}
        />
      </button>
    </div>
  )
}

/** 通用滑块（带标签、当前值、单位） */
function Slider({
  label,
  desc,
  value,
  min,
  max,
  step = 1,
  unit = '',
  disabled,
  onChange,
}: {
  label: string
  desc?: string
  value: number
  min: number
  max: number
  step?: number
  unit?: string
  disabled?: boolean
  onChange: (v: number) => void
}) {
  return (
    <div className={`px-4 py-3 ${disabled ? 'opacity-60' : ''}`}>
      <div className="flex items-center justify-between mb-3">
        <div className="min-w-0">
          <div className="text-sm text-text-primary">{label}</div>
          {desc && <div className="text-xs text-text-tertiary mt-0.5">{desc}</div>}
        </div>
        <span className="px-2 py-1 rounded-xl text-xs font-mono bg-white/10 text-text-secondary flex-shrink-0">
          {value}{unit}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full h-1.5 rounded-full appearance-none bg-white/10 cursor-pointer
          disabled:cursor-not-allowed [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:shadow-md [&::-webkit-slider-thumb]:transition-transform [&::-webkit-slider-thumb]:hover:scale-110"
      />
    </div>
  )
}

export function SelectMenu({
  value,
  options,
  disabled = false,
  onChange,
}: {
  value: string
  options: Array<{ value: string; label: string }>
  disabled?: boolean
  onChange: (value: string) => void
}) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const [menuRect, setMenuRect] = useState<{ top: number; left: number; width: number } | null>(null)
  const selected = options.find((option) => option.value === value) ?? options[0]

  const close = useCallback(() => setOpen(false), [])
  const toggle = () => {
    const rect = triggerRef.current?.getBoundingClientRect()
    if (rect) setMenuRect({ top: rect.bottom + 6, left: rect.left, width: rect.width })
    setOpen((visible) => !visible)
  }

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('resize', close)
    window.addEventListener('scroll', close, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('resize', close)
      window.removeEventListener('scroll', close, true)
    }
  }, [open, close])

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        onClick={toggle}
        className="input-base flex items-center justify-between gap-3 text-left disabled:cursor-not-allowed disabled:opacity-50"
      >
        <span className="truncate">{selected?.label ?? '请选择'}</span>
        <ChevronDownIcon />
      </button>
      {open && !disabled && menuRect && createPortal(
        <>
          <button type="button" aria-label="关闭选择菜单" className="fixed inset-0 z-[90] cursor-default" onClick={close} />
          <div
            className="fixed z-[100] overflow-hidden rounded-[12px] border border-white/10 bg-[#202022] p-1 shadow-raised"
            style={{ top: menuRect.top, left: menuRect.left, width: menuRect.width }}
          >
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => { onChange(option.value); close() }}
              className={`flex w-full items-center justify-between rounded-[8px] px-3 py-2 text-left text-xs transition-colors ${
                option.value === value ? 'bg-white/12 text-text-primary' : 'text-text-secondary hover:bg-white/8 hover:text-text-primary'
              }`}
            >
              <span>{option.label}</span>
              {option.value === value && <span>✓</span>}
            </button>
          ))}
          </div>
        </>,
        document.body,
      )}
    </div>
  )
}

function ChevronDownIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="m4 6 4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** 多选标签输入（每按 Enter 添加一条，点击 × 删除） */
function TagInput({
  label,
  desc,
  placeholder,
  tags,
  onChange,
}: {
  label: string
  desc?: string
  placeholder?: string
  tags: string[]
  onChange: (tags: string[]) => void
}) {
  const [input, setInput] = useState('')

  const addTag = () => {
    const v = input.trim()
    if (!v) return
    if (tags.includes(v)) {
      setInput('')
      return
    }
    onChange([...tags, v])
    setInput('')
  }

  const removeTag = (t: string) => {
    onChange(tags.filter((x) => x !== t))
  }

  return (
    <div className="px-3 py-2.5">
      <div className="text-sm text-text-primary mb-0.5">{label}</div>
      {desc && <div className="text-2xs text-text-tertiary mb-2">{desc}</div>}
      <div className="flex flex-wrap gap-2 mb-3">
        {tags.map((t) => (
          <span
            key={t}
            className="inline-flex items-center gap-1 px-2 py-1 rounded-xl text-xs font-mono bg-white/10 text-text-secondary"
          >
            {t}
            <button
              onClick={() => removeTag(t)}
              className="text-text-tertiary hover:text-text-primary transition-colors"
              aria-label={`移除 ${t}`}
            >
              ×
            </button>
          </span>
        ))}
        {tags.length === 0 && (
          <span className="text-2xs text-text-tertiary">（空）</span>
        )}
      </div>
      <input
        type="text"
        className="input-base !py-1 !text-2xs font-mono"
        placeholder={placeholder ?? '输入后回车添加'}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            addTag()
          }
        }}
        spellCheck={false}
        data-selectable="true"
      />
    </div>
  )
}

/** 多行文本输入（每行一条规则） */
function LinesInput({
  label,
  desc,
  placeholder,
  lines,
  onChange,
}: {
  label: string
  desc?: string
  placeholder?: string
  lines: string[]
  onChange: (lines: string[]) => void
}) {
  const [text, setText] = useState(lines.join('\n'))

  // 当外部 lines 变化（如初次加载）时同步
  useEffect(() => {
    setText(lines.join('\n'))
  }, [lines])

  return (
    <div className="px-3 py-2.5">
      <div className="text-sm text-text-primary mb-0.5">{label}</div>
      {desc && <div className="text-2xs text-text-tertiary mb-2">{desc}</div>}
      <textarea
        className="input-base !py-1.5 !text-2xs font-mono resize-y min-h-[80px]"
        placeholder={placeholder ?? '每行一条'}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          const next = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
          onChange(next)
        }}
        spellCheck={false}
        data-selectable="true"
      />
    </div>
  )
}

/** 模态浮层 */
function Modal({
  title,
  onClose,
  children,
  width = 'w-[520px]',
}: {
  title: string
  onClose: () => void
  children: ReactNode
  width?: string
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm animate-fade-in"
      onClick={onClose}
    >
      <div
        className={`rounded-3xl border border-surface-border bg-surface-elevated shadow-raised ${width} max-w-[92vw] max-h-[85vh] overflow-hidden animate-scale-in flex flex-col`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/5">
          <h3 className="text-base font-semibold text-text-primary">{title}</h3>
          <button className="icon-btn" onClick={onClose} aria-label="关闭">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        <div className="flex-1 overflow-auto p-5">
          {children}
        </div>
      </div>
    </div>
  )
}

/** 表单字段标签 + 输入框包装 */
function FormField({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: ReactNode
}) {
  return (
    <div>
      <label className="flex items-center justify-between mb-1">
        <span className="text-2xs text-text-secondary">{label}</span>
        {hint && <span className="text-2xs text-text-tertiary">{hint}</span>}
      </label>
      {children}
    </div>
  )
}

/** 简单防抖：用于滑块等连续变化的场景 */
function useDebouncedCallback<A extends unknown[]>(
  callback: (...args: A) => void,
  delay: number,
): (...args: A) => void {
  const cbRef = useRef(callback)
  cbRef.current = callback
  const timerRef = useRef<number | null>(null)
  return useCallback((...args: A) => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => cbRef.current(...args), delay)
  }, [delay])
}

/** 配置块容器（统一外观） */
function ConfigCard({ children }: { children: ReactNode }) {
  return (
    <div className="max-w-2xl space-y-5">
      {children}
    </div>
  )
}

/** 配置分组（带标题） */
function ConfigGroup({
  title,
  children,
  action,
}: {
  title: string
  children: ReactNode
  action?: ReactNode
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-xs uppercase tracking-wider text-text-tertiary font-semibold">
          {title}
        </div>
        {action}
      </div>
      <div className="rounded-2xl border border-white/6 bg-surface-elevated/60 divide-y divide-white/5 overflow-hidden hover:border-white/10 transition-all duration-200">
        {children}
      </div>
    </div>
  )
}

/* ============================================================
 * 1. 模型配置
 * ============================================================ */
function ModelSection() {
  const toast = useToast()
  const setOverrides = useChatStore((s) => s.setOverrides)

  const [effort, setEffort] = useState<ReasoningEffort>('medium')
  const [cache, setCache] = useState(true)
  const [ctxLen, setCtxLen] = useState(20)
  const [profiles, setProfiles] = useState<ModelProfilesConfig | null>(null)
  const [activeProfileId, setActiveProfileId] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    void load()
  }, [])

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const [p, mp] = await Promise.all([
        paramsApi.get(),
        configApi.getModelProfiles().catch(() => null),
      ])
      setEffort(p.reasoningEffort)
      setCache(p.cacheEnabled)
      setCtxLen(p.contextLength)
      if (mp) {
        setProfiles(mp)
        setActiveProfileId(mp.activeProfileId ?? '')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  /** 即时保存推理参数 */
  async function saveParams(patch: Partial<{ reasoningEffort: ReasoningEffort; cacheEnabled: boolean; contextLength: number }>) {
    setSaving(true)
    setError(null)
    try {
      const p = await paramsApi.update(patch)
      setEffort(p.reasoningEffort)
      setCache(p.cacheEnabled)
      setCtxLen(p.contextLength)
      setOverrides({
        reasoningEffort: p.reasoningEffort,
        cacheEnabled: p.cacheEnabled,
        contextLength: p.contextLength,
      })
      toast('已保存')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  /** 切换当前会话绑定的模型 profile */
  async function saveActiveProfile(id: string) {
    if (!id) return
    setSaving(true)
    setError(null)
    try {
      await configApi.setActiveProfile(id)
      setActiveProfileId(id)
      toast('已切换模型')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <LoadingHint />

  return (
    <ConfigCard>
      <SectionHeader
        title="模型配置"
        desc="配置推理强度、上下文缓存与单会话绑定模型。修改即时保存。"
      />
      <ErrorBanner message={error} />

      <ConfigGroup title="推理强度">
        <div className="px-4 py-4">
          <div className="grid grid-cols-4 gap-2">
            {REASONING_EFFORTS.map((e) => (
              <button
                key={e.value}
                onClick={() => void saveParams({ reasoningEffort: e.value })}
                disabled={saving}
                title={e.hint}
                className={`px-3 py-2 rounded-xl text-xs font-medium transition-all duration-200 ease-bounce disabled:opacity-50 hover:scale-[1.02]
                  ${effort === e.value
                    ? 'bg-white text-black'
                    : 'bg-white/6 text-text-secondary border border-white/8 hover:bg-white/12'
                  }`}
              >
                {e.label}
              </button>
            ))}
          </div>
          <div className="text-xs text-text-tertiary mt-3">
            {REASONING_EFFORTS.find((e) => e.value === effort)?.hint}
          </div>
        </div>
      </ConfigGroup>

      <ConfigGroup title="上下文">
        <Slider
          label="上下文窗口"
          desc="历史对话的 Token 预算，0 表示仅发送当前消息"
          value={ctxLen}
          min={0}
          max={1_000_000}
          step={1_024}
          unit=" tokens"
          onChange={(v) => {
            setCtxLen(v)
            void saveParams({ contextLength: v })
          }}
        />
        <ToggleRow
          label="上下文缓存"
          desc="DeepSeek 前缀缓存，降低重复请求成本"
          on={cache}
          disabled={saving}
          onChange={(v) => void saveParams({ cacheEnabled: v })}
        />
      </ConfigGroup>

      <ConfigGroup title="单会话绑定模型">
        <div className="px-3 py-2.5">
          <SelectMenu
            value={activeProfileId}
            disabled={saving || !profiles || profiles.profiles.length === 0}
            onChange={(id) => void saveActiveProfile(id)}
            options={[
              { value: '', label: '（默认 DeepSeek 配置）' },
              ...(profiles?.profiles.map((profile) => ({ value: profile.id, label: `${profile.displayName} (${profile.provider}/${profile.model})` })) ?? []),
            ]}
          />
          <div className="text-2xs text-text-tertiary mt-1.5">
            从「API 服务商」卡片管理的多套凭证中选择当前会话使用的模型。
          </div>
        </div>
      </ConfigGroup>

      <div className="px-3 py-2 rounded-lg border border-white/8 bg-white/4 text-2xs text-text-tertiary leading-relaxed">
        当前：effort=<span className="text-text-secondary">{effort}</span>
        {' · '}cache=<span className="text-text-secondary">{cache ? 'on' : 'off'}</span>
        {' · '}ctx=<span className="text-text-secondary">{ctxLen}</span>
      </div>
    </ConfigCard>
  )
}

/* ============================================================
 * 2. API 服务商（多凭证管理）
 * ============================================================ */
function ApiSection() {
  const toast = useToast()
  const dialog = useDialogStore()
  const [config, setConfig] = useState<ModelProfilesConfig | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<ApiProfile | null>(null)
  const [showForm, setShowForm] = useState(false)

  useEffect(() => {
    void load()
  }, [])

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const c = await configApi.getModelProfiles()
      setConfig(c)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setConfig({ profiles: [], activeProfileId: undefined })
    } finally {
      setLoading(false)
    }
  }

  async function handleSetActive(id: string) {
    setError(null)
    try {
      await configApi.setActiveProfile(id)
      setConfig((c) => (c ? { ...c, activeProfileId: id } : c))
      toast('已设为当前')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleDelete(p: ApiProfile) {
    const ok = await dialog.confirm({
      title: '删除凭证',
      message: `确认删除凭证「${p.name}」？此操作不可撤销。`,
      confirmText: '删除',
      danger: true,
    })
    if (!ok) return
    try {
      await configApi.deleteProfile(p.id)
      setConfig((c) => c ? {
        ...c,
        profiles: c.profiles.filter((x) => x.id !== p.id),
        activeProfileId: c.activeProfileId === p.id ? undefined : c.activeProfileId,
      } : c)
      toast('已删除')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  function handleEdit(p: ApiProfile) {
    setEditing(p)
    setShowForm(true)
  }

  function handleAdd() {
    setEditing(null)
    setShowForm(true)
  }

  async function handleSubmitForm(form: ProfileFormValue) {
    setError(null)
    try {
      if (editing) {
        const { profile: updated } = await configApi.updateProfile(editing.id, {
          ...editing,
          ...form,
          apiKeyMasked: form.apiKey,
          // 后端返回时再次 mask
        })
        setConfig((c) => c ? {
          ...c,
          profiles: c.profiles.map((x) => (x.id === editing.id ? updated : x)),
        } : c)
        toast('已保存')
      } else {
        const { profile: created } = await configApi.addProfile({
          id: '',
          name: form.name,
          provider: form.provider,
          apiKeyMasked: form.apiKey,
          baseUrl: form.baseUrl,
          model: form.model,
          displayName: form.displayName,
          supportsReasoning: form.supportsReasoning,
          maxTokens: form.maxTokens,
        })
        setConfig((c) => c ? { ...c, profiles: [...c.profiles, created] } : c)
        toast('已新增')
      }
      setShowForm(false)
      setEditing(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  if (loading) return <LoadingHint />

  return (
    <ConfigCard>
      <SectionHeader
        title="API 服务商"
        desc="管理多套 API 凭证（DeepSeek/OpenRouter/MiMo/火山方舟）。支持新增、编辑、删除与切换当前模型。"
      />
      <ErrorBanner message={error} />

      <ConfigGroup
        title={`凭证列表（${config?.profiles.length ?? 0}）`}
        action={
          <button onClick={handleAdd} className="btn-primary !py-1 !px-2 !text-2xs">
            + 新增凭证
          </button>
        }
      >
        {config && config.profiles.length > 0 ? (
          <div className="divide-y divide-white/5">
            {config.profiles.map((p) => {
              const isActive = config.activeProfileId === p.id
              return (
                <div
                  key={p.id}
                  className={`px-3 py-3 flex items-start gap-3 ${isActive ? 'bg-accent/6' : ''}`}
                >
                  <button
                    onClick={() => void handleSetActive(p.id)}
                    className={`mt-1 w-4 h-4 rounded-full border-2 flex items-center justify-center flex-shrink-0
                      ${isActive ? 'border-accent' : 'border-white/25'}`}
                    title={isActive ? '当前模型' : '设为当前'}
                    aria-label="设为当前"
                  >
                    {isActive && <span className="w-2 h-2 rounded-full bg-accent" />}
                  </button>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium text-text-primary">{p.name}</span>
                      <span className="px-1.5 py-0.5 rounded text-2xs font-mono bg-accent/12 text-accent">
                        {p.provider}
                      </span>
                      <span className="px-1.5 py-0.5 rounded text-2xs font-mono bg-white/6 text-text-secondary">
                        {p.model}
                      </span>
                      {p.supportsReasoning && (
                        <span className="px-1.5 py-0.5 rounded text-2xs font-mono bg-amber-500/15 text-amber-300">
                          reasoning
                        </span>
                      )}
                      {isActive && (
                        <span className="px-1.5 py-0.5 rounded text-2xs font-mono bg-diff-added/20 text-diff-added-text">
                          当前
                        </span>
                      )}
                    </div>
                    <div className="text-2xs text-text-tertiary mt-1 font-mono truncate">
                      {p.apiKeyMasked || '（未设置密钥）'} · {p.baseUrl}
                    </div>
                    <div className="text-2xs text-text-tertiary mt-0.5">
                      maxTokens=<span className="text-text-secondary">{p.maxTokens}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    <button
                      onClick={() => handleEdit(p)}
                      className="btn-secondary !py-1 !px-2 !text-2xs"
                    >
                      编辑
                    </button>
                    <button
                      onClick={() => void handleDelete(p)}
                      className="btn-secondary !py-1 !px-2 !text-2xs hover:bg-rose-500/20 hover:text-rose-300"
                    >
                      删除
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        ) : (
          <div className="px-3 py-6 text-center text-sm text-text-tertiary">
            暂无凭证，点击右上角「+ 新增凭证」开始配置。
          </div>
        )}
      </ConfigGroup>

      {showForm && (
        <ProfileFormModal
          editing={editing}
          onClose={() => {
            setShowForm(false)
            setEditing(null)
          }}
          onSubmit={handleSubmitForm}
        />
      )}
    </ConfigCard>
  )
}

interface ProfileFormValue {
  name: string
  provider: string
  apiKey: string
  baseUrl: string
  model: string
  displayName: string
  supportsReasoning: boolean
  maxTokens: number
}

function ProfileFormModal({
  editing,
  onClose,
  onSubmit,
}: {
  editing: ApiProfile | null
  onClose: () => void
  onSubmit: (form: ProfileFormValue) => void
}) {
  const [form, setForm] = useState<ProfileFormValue>({
    name: editing?.name ?? '',
    provider: editing?.provider ?? 'deepseek',
    apiKey: '',
    baseUrl: editing?.baseUrl ?? 'https://api.deepseek.com',
    model: editing?.model ?? 'deepseek-chat',
    displayName: editing?.displayName ?? '',
    supportsReasoning: editing?.supportsReasoning ?? false,
    maxTokens: editing?.maxTokens ?? 8192,
  })

  const handleSubmit = () => {
    if (!form.name.trim() || !form.model.trim()) return
    onSubmit(form)
  }

  return (
    <Modal title={editing ? '编辑凭证' : '新增凭证'} onClose={onClose}>
      <div className="space-y-3">
        <FormField label="名称">
          <input
            className="input-base"
            placeholder="例如：DeepSeek 主账号"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            data-selectable="true"
            spellCheck={false}
          />
        </FormField>
        <div className="grid grid-cols-2 gap-2">
          <FormField label="服务商">
            <SelectMenu value={form.provider} options={API_PROVIDERS} onChange={(provider) => setForm({ ...form, provider })} />
          </FormField>
          <FormField label="显示名">
            <input
              className="input-base"
              placeholder="deepseek-chat"
              value={form.displayName}
              onChange={(e) => setForm({ ...form, displayName: e.target.value })}
              data-selectable="true"
              spellCheck={false}
            />
          </FormField>
        </div>
        <FormField
          label="API 密钥"
          hint={editing?.apiKeyMasked ? `当前：${editing.apiKeyMasked}` : '保存时自动 mask'}
        >
          <input
            type="password"
            className="input-base font-mono"
            placeholder={editing ? '留空则不修改' : 'sk-...'}
            value={form.apiKey}
            onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
            data-selectable="true"
            spellCheck={false}
          />
        </FormField>
        <FormField label="Base URL">
          <input
            className="input-base font-mono"
            placeholder="https://api.deepseek.com"
            value={form.baseUrl}
            onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
            data-selectable="true"
            spellCheck={false}
          />
        </FormField>
        <div className="grid grid-cols-2 gap-2">
          <FormField label="模型">
            <input
              className="input-base font-mono"
              placeholder="deepseek-chat"
              value={form.model}
              onChange={(e) => setForm({ ...form, model: e.target.value })}
              data-selectable="true"
              spellCheck={false}
            />
          </FormField>
          <FormField label="最大 Tokens">
            <input
              type="number"
              className="input-base font-mono"
              min={256}
              max={200000}
              value={form.maxTokens}
              onChange={(e) => setForm({ ...form, maxTokens: Number(e.target.value) || 8192 })}
              data-selectable="true"
            />
          </FormField>
        </div>
        <ToggleRow
          label="支持 Reasoning"
          desc="该模型支持推理过程输出（deepseek-reasoner 等）"
          on={form.supportsReasoning}
          onChange={(v) => setForm({ ...form, supportsReasoning: v })}
        />
        <div className="flex justify-end gap-2 pt-2">
          <button onClick={onClose} className="btn-secondary">取消</button>
          <button
            onClick={handleSubmit}
            disabled={!form.name.trim() || !form.model.trim()}
            className="btn-primary disabled:opacity-50"
          >
            {editing ? '保存' : '新增'}
          </button>
        </div>
      </div>
    </Modal>
  )
}

/* ============================================================
 * 3. 权限管控
 * ============================================================ */
function PermissionSection() {
  const toast = useToast()
  const dialog = useDialogStore()
  const [config, setConfig] = useState<PermissionConfig | null>(null)
  const [security, setSecurity] = useState<SecurityConfig | null>(null)
  const [blacklistDirs, setBlacklistDirs] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [confirmFullAccess, setConfirmFullAccess] = useState(false)

  useEffect(() => {
    void load()
  }, [])

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const [perm, sec] = await Promise.all([
        permissionApi.get(),
        configApi.getSecurity().catch(() => DEFAULT_SECURITY),
      ])
      setConfig(perm)
      setSecurity(sec)
      // 黑名单目录：localStorage 兜底（后端未提供字段）
      try {
        const raw = window.localStorage.getItem('codewhale-blacklist-dirs')
        setBlacklistDirs(raw ? JSON.parse(raw) as string[] : ['node_modules/', '.git/', 'target/'])
      } catch {
        setBlacklistDirs(['node_modules/', '.git/', 'target/'])
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  async function update(patch: Partial<PermissionConfig>) {
    if (!config) return
    // FullAccess 二次确认
    if (patch.level === 'fullAccess' && config.level !== 'fullAccess' && !confirmFullAccess) {
      const ok = await dialog.confirm({
        title: '开启 FullAccess',
        message: 'FullAccess 将允许 Agent 执行任意 Shell 命令与文件读写，存在较高风险。确认开启？',
        confirmText: '确认开启',
        danger: true,
      })
      if (!ok) return
      setConfirmFullAccess(true)
    }
    setSaving(true)
    setError(null)
    try {
      const c = await permissionApi.set(patch)
      setConfig(c)
      toast('已保存')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  async function updateSecurity(patch: Partial<SecurityConfig>) {
    if (!security) return
    setSaving(true)
    setError(null)
    try {
      const s = await configApi.setSecurity({ ...security, ...patch })
      setSecurity(s)
      toast('已保存')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  async function handleExportAudit() {
    setError(null)
    try {
      const r = await configApi.exportAuditLog()
      // 触发下载
      const blob = new Blob([r.log], { type: 'text/plain;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'codewhale-audit.log'
      a.click()
      URL.revokeObjectURL(url)
      toast('已导出')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  function updateBlacklistDirs(dirs: string[]) {
    setBlacklistDirs(dirs)
    try {
      window.localStorage.setItem('codewhale-blacklist-dirs', JSON.stringify(dirs))
      toast('已保存')
    } catch {
      /* ignore */
    }
  }

  if (loading) return <LoadingHint />

  return (
    <ConfigCard>
      <SectionHeader
        title="权限管控"
        desc="配置 Agent 在工作区可执行的操作范围、审批策略与黑名单。修改即时保存。"
      />
      <ErrorBanner message={error} />

      <ConfigGroup title="操作范围">
        {PERMISSION_LEVELS.map((lvl) => {
          const selected = config?.level === lvl.value
          return (
            <button
              key={lvl.value}
              onClick={() => void update({ level: lvl.value })}
              disabled={saving}
              className={`w-full flex items-start gap-3 px-3 py-2.5 text-left transition-all duration-200 ease-out disabled:opacity-50
                ${selected ? 'bg-accent/12' : 'hover:bg-white/6'}`}
            >
              <span
                className={`mt-0.5 w-4 h-4 rounded-full border-2 flex items-center justify-center flex-shrink-0
                  ${selected ? 'border-accent' : 'border-white/25'}`}
              >
                {selected && <span className="w-2 h-2 rounded-full bg-accent" />}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-text-primary">{lvl.label}</span>
                  {lvl.recommended && (
                    <span className="px-1.5 py-0.5 rounded text-2xs font-mono bg-accent/15 text-accent">
                      推荐
                    </span>
                  )}
                  {lvl.value === 'fullAccess' && (
                    <span className="px-1.5 py-0.5 rounded text-2xs font-mono bg-rose-500/15 text-rose-300">
                      高危
                    </span>
                  )}
                </div>
                <div className="text-2xs text-text-tertiary mt-0.5 leading-relaxed">{lvl.desc}</div>
              </div>
            </button>
          )
        })}
      </ConfigGroup>

      <ConfigGroup title="审批策略">
        <ToggleRow
          label="写入审批"
          desc="Agent 写入或修改文件前需人工确认"
          on={config?.approvalOnWrite ?? false}
          disabled={saving}
          onChange={(v) => void update({ approvalOnWrite: v })}
        />
        <ToggleRow
          label="Shell 审批"
          desc="Agent 执行 Shell 命令前需人工确认"
          on={config?.approvalOnShell ?? false}
          disabled={saving}
          onChange={(v) => void update({ approvalOnShell: v })}
        />
      </ConfigGroup>

      <ConfigGroup title="审计日志">
        <div className="px-3 py-2.5">
          <FormField label="审计日志存储路径">
            <input
              type="text"
              className="input-base font-mono !text-2xs"
              placeholder="C:\\Users\\you\\codewhale\\audit.log"
              value={security?.auditLogPath ?? ''}
              onChange={(e) => void updateSecurity({ auditLogPath: e.target.value })}
              data-selectable="true"
              spellCheck={false}
            />
          </FormField>
          <div className="mt-2">
            <button onClick={() => void handleExportAudit()} className="btn-secondary !py-1 !px-2 !text-2xs">
              导出审计日志
            </button>
          </div>
        </div>
      </ConfigGroup>

      <ConfigGroup title="黑名单目录">
        <TagInput
          label="禁止 Agent 访问的目录"
          desc="Agent 读写文件时将跳过匹配的目录（glob 形式）"
          placeholder="例如 node_modules/"
          tags={blacklistDirs}
          onChange={updateBlacklistDirs}
        />
      </ConfigGroup>

      {config && (
        <div className="px-3 py-2 rounded-lg border border-white/8 bg-white/4 text-2xs text-text-tertiary leading-relaxed">
          当前：level=<span className="text-text-secondary">{config.level}</span>
          {' · '}writeApproval=<span className="text-text-secondary">{config.approvalOnWrite ? 'on' : 'off'}</span>
          {' · '}shellApproval=<span className="text-text-secondary">{config.approvalOnShell ? 'on' : 'off'}</span>
        </div>
      )}
    </ConfigCard>
  )
}

/* ============================================================
 * 4. Skill 技能管理
 * ============================================================ */
function SkillSection() {
  const toast = useToast()
  const dialog = useDialogStore()
  const [config, setConfig] = useState<SkillsConfig | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [editingAgents, setEditingAgents] = useState(false)
  const [agentsContent, setAgentsContent] = useState('')

  useEffect(() => {
    void load()
  }, [])

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const c = await skillsApi.listConfig()
      setConfig(c)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setConfig({ skills: [], defaultPermission: 'ask' })
    } finally {
      setLoading(false)
    }
  }

  async function handleToggle(skill: SkillItem, enabled: boolean) {
    setError(null)
    try {
      await skillsApi.setEnabled(skill.id, enabled)
      setConfig((c) => c ? {
        ...c,
        skills: c.skills.map((s) => (s.id === skill.id ? { ...s, enabled } : s)),
      } : c)
      toast('已保存')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleDefaultPerm(perm: SkillsConfig['defaultPermission']) {
    setError(null)
    try {
      const c = await skillsApi.setDefaultPermission(perm)
      setConfig(c)
      toast('已保存')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleImport() {
    const path = await dialog.prompt({
      title: '导入外部技能包',
      message: '请输入技能包路径（本地目录或 .tar.gz 文件）：',
      placeholder: 'C:\\path\\to\\skill-pack',
    })
    if (!path) return
    setError(null)
    try {
      const r = await skillsApi.importPack({ path })
      toast(`已导入 ${r.imported} 个技能`)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleExport(skill: SkillItem) {
    setError(null)
    try {
      const r = await skillsApi.exportSkill(skill.id)
      toast(`已导出到 ${r.path}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function openAgentsEditor() {
    setError(null)
    try {
      const r = await skillsApi.readAgentsMd()
      setAgentsContent(r.content)
      setEditingAgents(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setAgentsContent('')
      setEditingAgents(true)
    }
  }

  async function saveAgents() {
    setError(null)
    try {
      await skillsApi.writeAgentsMd(agentsContent)
      toast('已保存 AGENTS.md')
      setEditingAgents(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  if (loading) return <LoadingHint />

  return (
    <ConfigCard>
      <SectionHeader
        title="Skill 技能管理"
        desc="管理本地 .workspace/.skills 目录下的技能包，支持启用/禁用、导入导出与 AGENTS.md 编辑。"
      />
      <ErrorBanner message={error} />

      <ConfigGroup
        title="操作"
        action={
          <button onClick={openAgentsEditor} className="btn-secondary !py-1 !px-2 !text-2xs">
            编辑 AGENTS.md
          </button>
        }
      >
        <div className="px-3 py-2.5 flex items-center gap-2">
          <button onClick={() => void handleImport()} className="btn-primary !py-1 !px-2 !text-2xs">
            导入外部技能包
          </button>
        </div>
      </ConfigGroup>

      <ConfigGroup title="技能执行默认权限">
        <div className="px-3 py-2.5">
          <SelectMenu
            value={config?.defaultPermission ?? 'ask'}
            onChange={(value) => void handleDefaultPerm(value as SkillsConfig['defaultPermission'])}
            options={[
              { value: 'ask', label: '每次询问' }, { value: 'readOnly', label: '只读' },
              { value: 'workspaceWrite', label: '工作区写入' }, { value: 'fullAccess', label: '完全访问' },
            ]}
          />
          <div className="text-2xs text-text-tertiary mt-1.5">
            技能调用外部工具时的默认权限预设，可在每次调用时覆盖。
          </div>
        </div>
      </ConfigGroup>

      <ConfigGroup title={`技能列表（${config?.skills.length ?? 0}）`}>
        {config && config.skills.length > 0 ? (
          <div className="divide-y divide-white/5">
            {config.skills.map((s) => (
              <div key={s.id} className="px-3 py-2.5 flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-text-primary">{s.name}</span>
                    <span className={`px-1.5 py-0.5 rounded text-2xs font-mono ${
                      s.source === 'local' ? 'bg-accent/12 text-accent' : 'bg-amber-500/15 text-amber-300'
                    }`}>
                      {s.source === 'local' ? '本地' : '外部'}
                    </span>
                  </div>
                  <div className="text-2xs text-text-tertiary mt-0.5 truncate">{s.description}</div>
                </div>
                <button
                  onClick={() => void handleExport(s)}
                  className="btn-secondary !py-1 !px-2 !text-2xs flex-shrink-0"
                >
                  导出
                </button>
                <button
                  className={`w-8 h-4 rounded-full transition-colors flex-shrink-0 ${s.enabled ? 'bg-accent' : 'bg-white/12'}`}
                  onClick={() => void handleToggle(s, !s.enabled)}
                  role="switch"
                  aria-checked={s.enabled}
                >
                  <div
                    className={`w-3 h-3 rounded-full bg-white transition-transform ${s.enabled ? 'translate-x-4' : 'translate-x-0.5'}`}
                  />
                </button>
              </div>
            ))}
          </div>
        ) : (
          <div className="px-3 py-6 text-center text-sm text-text-tertiary">
            暂无技能。可在 .workspace/.skills 目录放置技能包后刷新。
          </div>
        )}
      </ConfigGroup>

      {editingAgents && (
        <Modal title="编辑 AGENTS.md" onClose={() => setEditingAgents(false)} width="w-[640px]">
          <div className="space-y-3">
            <textarea
              className="input-base !py-2 !text-xs font-mono resize-y min-h-[400px]"
              value={agentsContent}
              onChange={(e) => setAgentsContent(e.target.value)}
              spellCheck={false}
              data-selectable="true"
              placeholder="# AGENTS.md&#10;描述本工作区可用的技能、调用约定与权限要求。"
            />
            <div className="flex justify-end gap-2">
              <button onClick={() => setEditingAgents(false)} className="btn-secondary">取消</button>
              <button onClick={() => void saveAgents()} className="btn-primary">保存</button>
            </div>
          </div>
        </Modal>
      )}
    </ConfigCard>
  )
}

/* ============================================================
 * 5. MCP 插件管理
 * ============================================================ */
function McpSection() {
  const toast = useToast()
  const dialog = useDialogStore()
  const [config, setConfig] = useState<McpServicesConfig | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showForm, setShowForm] = useState(false)

  useEffect(() => {
    void load()
  }, [])

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const c = await mcpApi.listServices()
      setConfig(c)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setConfig({ services: [], globalEnabled: true })
    } finally {
      setLoading(false)
    }
  }

  async function handleGlobal(v: boolean) {
    if (!config) return
    setError(null)
    try {
      await mcpApi.setGlobalEnabled(v)
      setConfig({ ...config, globalEnabled: v })
      toast('已保存')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleToggle(svc: McpService, enabled: boolean) {
    setError(null)
    try {
      await mcpApi.setEnabled(svc.id, enabled)
      setConfig((c) => c ? {
        ...c,
        services: c.services.map((x) => (x.id === svc.id ? { ...x, enabled } : x)),
      } : c)
      toast('已保存')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleRemove(svc: McpService) {
    const ok = await dialog.confirm({
      title: '移除插件',
      message: `确认移除 MCP 服务「${svc.name}」？`,
      confirmText: '移除',
      danger: true,
    })
    if (!ok) return
    setError(null)
    try {
      await mcpApi.remove(svc.id)
      setConfig((c) => c ? {
        ...c,
        services: c.services.filter((x) => x.id !== svc.id),
      } : c)
      toast('已移除')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleAdd(form: McpFormValue) {
    setError(null)
    try {
      await mcpApi.add({
        name: form.name,
        transport: form.transport,
        endpoint: form.endpoint,
        permissions: form.permissions,
      })
      setShowForm(false)
      toast('已添加')
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  if (loading) return <LoadingHint />

  return (
    <ConfigCard>
      <SectionHeader
        title="MCP 插件管理"
        desc="管理已连接的 MCP（Model Context Protocol）服务，支持 SSE/stdio 传输与权限限制。"
      />
      <ErrorBanner message={error} />

      <ConfigGroup title="全局">
        <ToggleRow
          label="高危插件全局总开关"
          desc="关闭后所有 MCP 插件将停止响应（即使单独启用）"
          on={config?.globalEnabled ?? true}
          onChange={(v) => void handleGlobal(v)}
        />
      </ConfigGroup>

      <ConfigGroup
        title={`已连接服务（${config?.services.length ?? 0}）`}
        action={
          <button onClick={() => setShowForm(true)} className="btn-primary !py-1 !px-2 !text-2xs">
            + 添加服务
          </button>
        }
      >
        {config && config.services.length > 0 ? (
          <div className="divide-y divide-white/5">
            {config.services.map((s) => {
              const connected = s.status === 'connected'
              return (
                <div key={s.id} className="px-3 py-2.5 flex items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium text-text-primary">{s.name}</span>
                      <span className="px-1.5 py-0.5 rounded text-2xs font-mono bg-white/6 text-text-secondary">
                        {s.transport}
                      </span>
                      <span className={`px-1.5 py-0.5 rounded text-2xs font-mono ${
                        connected ? 'bg-diff-added/20 text-diff-added-text' :
                        s.status === 'error' ? 'bg-diff-removed/20 text-diff-removed-text' :
                        'bg-white/6 text-text-tertiary'
                      }`}>
                        {connected ? '已连接' : s.status === 'error' ? '错误' : '已断开'}
                      </span>
                      {s.permissions.map((p) => (
                        <span key={p} className="px-1.5 py-0.5 rounded text-2xs font-mono bg-accent/12 text-accent">
                          {p}
                        </span>
                      ))}
                    </div>
                    <div className="text-2xs text-text-tertiary mt-1 font-mono truncate">{s.endpoint}</div>
                  </div>
                  <button
                    onClick={() => void handleRemove(s)}
                    className="btn-secondary !py-1 !px-2 !text-2xs hover:bg-rose-500/20 hover:text-rose-300 flex-shrink-0"
                  >
                    移除
                  </button>
                  <button
                    className={`w-8 h-4 rounded-full transition-colors flex-shrink-0 ${s.enabled ? 'bg-accent' : 'bg-white/12'}`}
                    onClick={() => void handleToggle(s, !s.enabled)}
                    role="switch"
                    aria-checked={s.enabled}
                  >
                    <div
                      className={`w-3 h-3 rounded-full bg-white transition-transform ${s.enabled ? 'translate-x-4' : 'translate-x-0.5'}`}
                    />
                  </button>
                </div>
              )
            })}
          </div>
        ) : (
          <div className="px-3 py-6 text-center text-sm text-text-tertiary">
            暂无 MCP 服务。点击右上角「+ 添加服务」开始接入。
          </div>
        )}
      </ConfigGroup>

      {showForm && (
        <McpFormModal
          onClose={() => setShowForm(false)}
          onSubmit={handleAdd}
        />
      )}
    </ConfigCard>
  )
}

interface McpFormValue {
  name: string
  transport: McpTransport
  endpoint: string
  permissions: McpPermissionScope[]
}

function McpFormModal({
  onClose,
  onSubmit,
}: {
  onClose: () => void
  onSubmit: (form: McpFormValue) => void
}) {
  const [form, setForm] = useState<McpFormValue>({
    name: '',
    transport: 'sse',
    endpoint: '',
    permissions: ['file'],
  })

  const togglePerm = (p: McpPermissionScope) => {
    setForm((f) => ({
      ...f,
      permissions: f.permissions.includes(p)
        ? f.permissions.filter((x) => x !== p)
        : [...f.permissions, p],
    }))
  }

  return (
    <Modal title="添加 MCP 服务" onClose={onClose}>
      <div className="space-y-3">
        <FormField label="名称">
          <input
            className="input-base"
            placeholder="例如：filesystem-server"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            data-selectable="true"
            spellCheck={false}
          />
        </FormField>
        <FormField label="传输协议">
          <SelectMenu
            value={form.transport}
            onChange={(transport) => setForm({ ...form, transport: transport as McpTransport })}
            options={[{ value: 'sse', label: 'SSE（HTTP 流）' }, { value: 'stdio', label: 'stdio（子进程）' }]}
          />
        </FormField>
        <FormField
          label="端点"
          hint={form.transport === 'sse' ? 'https://example.com/mcp' : '可执行命令'}
        >
          <input
            className="input-base font-mono"
            placeholder={form.transport === 'sse' ? 'https://host/mcp' : 'npx -y @mcp/server'}
            value={form.endpoint}
            onChange={(e) => setForm({ ...form, endpoint: e.target.value })}
            data-selectable="true"
            spellCheck={false}
          />
        </FormField>
        <FormField label="权限范围">
          <div className="flex flex-wrap gap-1.5">
            {MCP_PERMISSION_SCOPES.map((p) => {
              const on = form.permissions.includes(p.value)
              return (
                <button
                  key={p.value}
                  onClick={() => togglePerm(p.value)}
                  className={`px-2 py-1 rounded text-2xs transition-colors
                    ${on ? 'bg-white text-black' : 'bg-white/6 text-text-secondary border border-white/8'}`}
                >
                  {p.label}
                </button>
              )
            })}
          </div>
        </FormField>
        <div className="flex justify-end gap-2 pt-2">
          <button onClick={onClose} className="btn-secondary">取消</button>
          <button
            onClick={() => onSubmit(form)}
            disabled={!form.name.trim() || !form.endpoint.trim()}
            className="btn-primary disabled:opacity-50"
          >
            添加
          </button>
        </div>
      </div>
    </Modal>
  )
}

/* ============================================================
 * 6. 项目 RAG
 * ============================================================ */
function RagSection() {
  const toast = useToast()
  const dialog = useDialogStore()
  const [config, setConfig] = useState<RagConfig | null>(null)
  const [index, setIndex] = useState<RagIndex | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [building, setBuilding] = useState(false)

  useEffect(() => {
    void load()
  }, [])

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const [c, idx] = await Promise.all([
        configApi.getRagConfig().catch(() => DEFAULT_RAG_CONFIG),
        ragApi.getIndex().catch(() => null),
      ])
      setConfig(c)
      setIndex(idx)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  const debouncedSave = useDebouncedCallback(async (next: RagConfig) => {
    setError(null)
    try {
      const c = await configApi.setRagConfig(next)
      setConfig(c)
      toast('已保存')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, 350)

  function update(patch: Partial<RagConfig>) {
    if (!config) return
    const next = { ...config, ...patch }
    setConfig(next)
    void debouncedSave(next)
  }

  async function handleBuild() {
    setBuilding(true)
    setError(null)
    try {
      const idx = await ragApi.buildIndex()
      setIndex(idx)
      toast('索引重建完成')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBuilding(false)
    }
  }

  async function handleClear() {
    const ok = await dialog.confirm({
      title: '清空 RAG 索引',
      message: '确认清空当前项目的 RAG 索引缓存？',
      confirmText: '清空',
      danger: true,
    })
    if (!ok) return
    setError(null)
    try {
      await ragApi.clear()
      setIndex(null)
      toast('已清空')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  if (loading) return <LoadingHint />

  return (
    <ConfigCard>
      <SectionHeader
        title="项目 RAG"
        desc="检索增强生成（RAG）配置。控制分块、召回权重与文件过滤。修改即时保存。"
      />
      <ErrorBanner message={error} />

      <ConfigGroup title="基础">
        <ToggleRow
          label="RAG 自动索引"
          desc="项目加载或文件变更时自动重建索引"
          on={config?.autoIndex ?? false}
          onChange={(v) => update({ autoIndex: v })}
        />
        <ToggleRow
          label="启用 RAG"
          desc="开启后在对话中自动召回相关代码片段"
          on={config?.enabled ?? false}
          onChange={(v) => update({ enabled: v })}
        />
      </ConfigGroup>

      <ConfigGroup title="分块与召回">
        <Slider
          label="索引分块大小"
          desc="每个代码块的目标 token 数"
          value={config?.chunkSize ?? 500}
          min={100}
          max={1000}
          step={50}
          unit=" tokens"
          onChange={(v) => update({ chunkSize: v })}
        />
        <Slider
          label="召回权重"
          desc="RAG 召回内容在 prompt 中的权重"
          value={Math.round((config?.recallWeight ?? 0.5) * 100)}
          min={0}
          max={100}
          step={5}
          onChange={(v) => update({ recallWeight: v / 100 })}
        />
        <Slider
          label="最大召回 Tokens"
          desc="单次召回的总 token 上限"
          value={config?.maxTokens ?? 4000}
          min={500}
          max={16000}
          step={500}
          unit=" tokens"
          onChange={(v) => update({ maxTokens: v })}
        />
      </ConfigGroup>

      <ConfigGroup title="文件过滤规则">
        <LinesInput
          label="包含的文件 glob"
          desc="每行一条 glob 规则，匹配的文件将被索引"
          placeholder="**/*.rs"
          lines={config?.fileFilter ?? []}
          onChange={(lines) => update({ fileFilter: lines })}
        />
      </ConfigGroup>

      <ConfigGroup title="索引操作">
        <div className="px-3 py-2.5 flex items-center gap-2">
          <button
            onClick={() => void handleBuild()}
            disabled={building}
            className="btn-primary !py-1 !px-2 !text-2xs disabled:opacity-50"
          >
            {building ? '重建中…' : '重建项目索引'}
          </button>
          <button
            onClick={() => void handleClear()}
            className="btn-secondary !py-1 !px-2 !text-2xs"
          >
            清空缓存
          </button>
        </div>
      </ConfigGroup>

      {index && (
        <div className="px-3 py-2 rounded-lg border border-white/8 bg-white/4 text-2xs text-text-tertiary leading-relaxed">
          索引状态：files=<span className="text-text-secondary">{index.totalFiles}</span>
          {' · '}chunks=<span className="text-text-secondary">{index.chunks.length}</span>
          {' · '}tokens=<span className="text-text-secondary">{index.totalTokens}</span>
          {' · '}indexedAt=<span className="text-text-secondary">{index.indexedAt || '—'}</span>
        </div>
      )}
    </ConfigCard>
  )
}

/* ============================================================
 * 7. 代码格式化
 * ============================================================ */
function FormatterSection() {
  const toast = useToast()
  const [config, setConfig] = useState<FormatterConfig | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void load()
  }, [])

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const c = await configApi.getFormatterConfig().catch(() => DEFAULT_FORMATTER_CONFIG)
      setConfig(c)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setConfig(DEFAULT_FORMATTER_CONFIG)
    } finally {
      setLoading(false)
    }
  }

  async function save(next: FormatterConfig) {
    setError(null)
    try {
      const c = await configApi.setFormatterConfig(next)
      setConfig(c)
      toast('已保存')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  function update(patch: Partial<FormatterConfig>) {
    if (!config) return
    void save({ ...config, ...patch })
  }

  if (loading) return <LoadingHint />

  const langs: { key: 'rustEnabled' | 'goEnabled' | 'pythonEnabled' | 'typescriptEnabled'; label: string; tool: string; cmdKey: string }[] = [
    { key: 'rustEnabled', label: 'Rust', tool: 'rustfmt', cmdKey: 'rust' },
    { key: 'goEnabled', label: 'Go', tool: 'gofmt', cmdKey: 'go' },
    { key: 'pythonEnabled', label: 'Python', tool: 'black', cmdKey: 'python' },
    { key: 'typescriptEnabled', label: 'TypeScript', tool: 'prettier', cmdKey: 'typescript' },
  ]

  return (
    <ConfigCard>
      <SectionHeader
        title="代码格式化"
        desc="配置各语言格式化工具与自定义命令。Agent 写入代码后自动调用对应工具。"
      />
      <ErrorBanner message={error} />

      <ConfigGroup title="全局">
        <ToggleRow
          label="保存时格式化"
          desc="写入文件到磁盘前自动调用对应语言格式化工具"
          on={config?.formatOnSave ?? false}
          onChange={(v) => update({ formatOnSave: v })}
        />
      </ConfigGroup>

      <ConfigGroup title="工具开关">
        {langs.map((l) => (
          <div key={l.key}>
            <ToggleRow
              label={l.label}
              desc={`默认工具：${l.tool}`}
              on={config?.[l.key] ?? false}
              onChange={(v) => update({ [l.key]: v })}
            />
            <div className="px-3 pb-2.5">
              <input
                type="text"
                className="input-base !py-1 !text-2xs font-mono"
                placeholder={`自定义命令（默认 ${l.tool}）`}
                value={config?.customCommands?.[l.cmdKey] ?? ''}
                onChange={(e) => update({
                  customCommands: { ...(config?.customCommands ?? {}), [l.cmdKey]: e.target.value },
                })}
                data-selectable="true"
                spellCheck={false}
              />
            </div>
          </div>
        ))}
      </ConfigGroup>

      {config && (
        <div className="px-3 py-2 rounded-lg border border-white/8 bg-white/4 text-2xs text-text-tertiary leading-relaxed">
          formatOnSave=<span className="text-text-secondary">{config.formatOnSave ? 'on' : 'off'}</span>
          {' · '}启用={
            [config.rustEnabled, config.goEnabled, config.pythonEnabled, config.typescriptEnabled].filter(Boolean).length
          }/4
        </div>
      )}
    </ConfigCard>
  )
}

/* ============================================================
 * 8. 缓存调试
 * ============================================================ */
function CacheSection() {
  const toast = useToast()
  const dialog = useDialogStore()
  const sessionId = useChatStore((s) => s.sessionId)
  const [config, setConfig] = useState<CacheDebugConfig | null>(null)
  const [stats, setStats] = useState<CacheStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void load()
    // 轮询缓存统计（5s）
    const timer = window.setInterval(() => {
      void configApi.getCacheStats().then(setStats).catch(() => {})
    }, 5000)
    return () => window.clearInterval(timer)
  }, [])

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const [c, s] = await Promise.all([
        configApi.getCacheConfig().catch(() => DEFAULT_CACHE_CONFIG),
        configApi.getCacheStats().catch(() => null),
      ])
      setConfig(c)
      setStats(s)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setConfig(DEFAULT_CACHE_CONFIG)
    } finally {
      setLoading(false)
    }
  }

  const debouncedSave = useDebouncedCallback(async (next: CacheDebugConfig) => {
    setError(null)
    try {
      const c = await configApi.setCacheConfig(next)
      setConfig(c)
      toast('已保存')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, 350)

  function update(patch: Partial<CacheDebugConfig>) {
    if (!config) return
    const next = { ...config, ...patch }
    setConfig(next)
    void debouncedSave(next)
  }

  async function handleClearSession() {
    if (!sessionId) {
      await dialog.alert({ title: '提示', message: '当前无活动会话。' })
      return
    }
    setError(null)
    try {
      await configApi.clearSessionCache(sessionId)
      toast('已清空会话缓存')
      void configApi.getCacheStats().then(setStats).catch(() => {})
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleClearMemory() {
    if (!sessionId) {
      await dialog.alert({ title: '提示', message: '当前无活动会话。' })
      return
    }
    const ok = await dialog.confirm({
      title: '清空项目记忆',
      message: '将清除当前会话的项目记忆与摘要，确认？',
      confirmText: '清空',
      danger: true,
    })
    if (!ok) return
    setError(null)
    try {
      await configApi.clearProjectMemory(sessionId)
      toast('已清空项目记忆')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  if (loading) return <LoadingHint />

  const hitRatePct = stats ? Math.round(stats.hitRate * 100) : 0
  const circumference = 2 * Math.PI * 36
  const dashOffset = circumference * (1 - hitRatePct / 100)

  return (
    <ConfigCard>
      <SectionHeader
        title="缓存调试"
        desc="配置上下文缓存指纹校验、挂载阈值，并实时查看命中率。"
      />
      <ErrorBanner message={error} />

      <ConfigGroup title="命中率仪表盘">
        <div className="px-3 py-4 flex items-center gap-4">
          {/* 圆形进度条 */}
          <svg width="88" height="88" viewBox="0 0 88 88" className="flex-shrink-0">
            <circle cx="44" cy="44" r="36" fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="6" />
            <circle
              cx="44" cy="44" r="36" fill="none" stroke="#3B82F6" strokeWidth="6"
              strokeLinecap="round"
              strokeDasharray={circumference}
              strokeDashoffset={dashOffset}
              transform="rotate(-90 44 44)"
              style={{ transition: 'stroke-dashoffset 300ms cubic-bezier(0.16,1,0.3,1)' }}
            />
            <text x="44" y="49" textAnchor="middle" fill="rgba(255,255,255,0.85)" fontSize="16" fontWeight="600">
              {hitRatePct}%
            </text>
          </svg>
          <div className="flex-1 min-w-0 space-y-1">
            <div className="text-sm text-text-primary">缓存命中率</div>
            <div className="text-2xs text-text-tertiary font-mono">
              hits=<span className="text-diff-added-text">{stats?.hits ?? 0}</span>
              {' · '}misses=<span className="text-diff-removed-text">{stats?.misses ?? 0}</span>
            </div>
            <div className="text-2xs text-text-tertiary font-mono truncate">
              fingerprint={stats?.fingerprint ? stats.fingerprint.slice(0, 16) + '…' : '—'}
            </div>
            <div className="text-2xs text-text-tertiary">
              每 5 秒刷新一次。
            </div>
          </div>
        </div>
      </ConfigGroup>

      <ConfigGroup title="缓存配置">
        <ToggleRow
          label="缓存指纹校验"
          desc="启用后每次请求校验前缀指纹，避免脏读"
          on={config?.fingerprintCheck ?? true}
          onChange={(v) => update({ fingerprintCheck: v })}
        />
        <Slider
          label="单文件挂载大小阈值"
          desc="超过此大小的文件将分块挂载"
          value={config?.mountSizeThreshold ?? 256}
          min={10}
          max={1024}
          step={10}
          unit=" KB"
          onChange={(v) => update({ mountSizeThreshold: v })}
        />
        <Slider
          label="自动压缩阈值"
          desc="超过此大小自动压缩上下文"
          value={config?.autoCompressThreshold ?? 1024}
          min={256}
          max={8192}
          step={64}
          unit=" KB"
          onChange={(v) => update({ autoCompressThreshold: v })}
        />
      </ConfigGroup>

      <ConfigGroup title="操作">
        <div className="px-3 py-2.5 flex items-center gap-2">
          <button
            onClick={() => void handleClearSession()}
            className="btn-secondary !py-1 !px-2 !text-2xs"
          >
            清空会话缓存
          </button>
          <button
            onClick={() => void handleClearMemory()}
            className="btn-secondary !py-1 !px-2 !text-2xs hover:bg-rose-500/20 hover:text-rose-300"
          >
            清空项目记忆
          </button>
          {!sessionId && (
            <span className="text-2xs text-text-tertiary">（无活动会话）</span>
          )}
        </div>
      </ConfigGroup>
    </ConfigCard>
  )
}

/* ============================================================
 * 9. 外观主题
 * ============================================================ */
function AppearanceSection() {
  const toast = useToast()
  const [config, setConfig] = useState<AppearanceConfig | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void load()
  }, [])

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const c = await configApi.getAppearance().catch(() => DEFAULT_APPEARANCE)
      setConfig(c)
      applyAppearanceConfig(c)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setConfig(DEFAULT_APPEARANCE)
    } finally {
      setLoading(false)
    }
  }

  const debouncedSave = useDebouncedCallback(async (next: AppearanceConfig) => {
    setError(null)
    try {
      const c = await configApi.setAppearance(next)
      setConfig(c)
      applyAppearanceConfig(c)
      toast('已保存')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, 350)

  function update(patch: Partial<AppearanceConfig>) {
    if (!config) return
    const next = { ...config, ...patch }
    setConfig(next)
    void debouncedSave(next)
  }

  if (loading) return <LoadingHint />

  return (
    <ConfigCard>
      <SectionHeader
        title="外观主题"
        desc="配置窗口毛玻璃、主题、圆角与动画时长。部分选项需要重启窗口生效。"
      />
      <ErrorBanner message={error} />

      <ConfigGroup title="窗口与主题">
        <ToggleRow
          label="Windows Mica 毛玻璃"
          desc="启用云母材质背景（需要 Windows 11 + 重启窗口）"
          on={config?.micaEnabled ?? true}
          onChange={(v) => update({ micaEnabled: v })}
        />
        <div className="px-3 py-2.5">
          <div className="text-sm text-text-primary mb-2">主题</div>
          <div className="grid grid-cols-2 gap-1">
            {['dark', 'light'].map((t) => (
              <button
                key={t}
                onClick={() => update({ theme: t })}
                className={`px-2 py-1.5 rounded text-2xs transition-colors
                  ${config?.theme === t
                    ? 'bg-white text-black'
                    : 'bg-white/6 text-text-secondary border border-white/8 hover:bg-white/12'
                  }`}
              >
                {t === 'dark' ? '深色' : '浅色'}
              </button>
            ))}
          </div>
        </div>
      </ConfigGroup>

      <ConfigGroup title="视觉细节">
        <Slider
          label="全局圆角"
          desc="浮层与卡片的圆角半径"
          value={config?.cornerRadius ?? 23}
          min={12}
          max={32}
          step={1}
          unit=" px"
          onChange={(v) => update({ cornerRadius: v })}
        />
        <Slider
          label="动画时长"
          desc="过渡动画的默认时长"
          value={config?.animationDurationMs ?? 200}
          min={0}
          max={500}
          step={20}
          unit=" ms"
          onChange={(v) => update({ animationDurationMs: v })}
        />
      </ConfigGroup>

      <ConfigGroup title="代码高亮">
        <div className="px-3 py-2.5">
          <div className="text-sm text-text-primary mb-2">配色方案</div>
          <SelectMenu
            value={config?.codeHighlightTheme ?? 'github-dark'}
            onChange={(codeHighlightTheme) => update({ codeHighlightTheme })}
            options={CODE_THEMES.map((theme) => ({ value: theme, label: theme }))}
          />
        </div>
      </ConfigGroup>
    </ConfigCard>
  )
}

/* ============================================================
 * 10. 快捷键
 * ============================================================ */
function ShortcutsSection() {
  const toast = useToast()
  const [config, setConfig] = useState<ShortcutsConfig | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [savingKey, setSavingKey] = useState(false)

  useEffect(() => {
    void load()
  }, [])

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const c = await configApi.getShortcuts().catch(() => ({ bindings: DEFAULT_SHORTCUT_BINDINGS }))
      setConfig(c)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setConfig({ bindings: DEFAULT_SHORTCUT_BINDINGS })
    } finally {
      setLoading(false)
    }
  }

  async function updateBinding(key: string, value: string) {
    if (!config) return
    setSavingKey(true)
    setError(null)
    const next = { bindings: { ...config.bindings, [key]: value } }
    setConfig(next)
    try {
      const c = await configApi.setShortcuts(next)
      setConfig(c)
      toast('已保存')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSavingKey(false)
    }
  }

  async function handleReset() {
    setError(null)
    try {
      const { shortcuts } = await configApi.resetShortcuts()
      setConfig(shortcuts)
      toast('已重置为默认')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  if (loading) return <LoadingHint />

  const bindings = config?.bindings ?? DEFAULT_SHORTCUT_BINDINGS
  const keys = Object.keys(DEFAULT_SHORTCUT_BINDINGS)

  return (
    <ConfigCard>
      <SectionHeader
        title="快捷键"
        desc="自定义斜杠指令与界面操作的快捷键。点击输入框后按下组合键即可捕获。"
      />
      <ErrorBanner message={error} />

      <ConfigGroup
        title="快捷键列表"
        action={
          <button
            onClick={() => void handleReset()}
            disabled={savingKey}
            className="btn-secondary !py-1 !px-2 !text-2xs disabled:opacity-50"
          >
            重置默认
          </button>
        }
      >
        <div className="divide-y divide-white/5">
          {keys.map((k) => (
            <div key={k} className="px-3 py-2.5 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm text-text-primary">{SHORTCUT_LABELS[k] ?? k}</div>
                <div className="text-2xs text-text-tertiary font-mono mt-0.5">{k}</div>
              </div>
              <KeyCaptureInput
                value={bindings[k] ?? ''}
                onChange={(v) => void updateBinding(k, v)}
              />
            </div>
          ))}
        </div>
      </ConfigGroup>
    </ConfigCard>
  )
}

/** 按键捕获输入：点击后进入捕获态，按下组合键即写入 */
function KeyCaptureInput({
  value,
  onChange,
}: {
  value: string
  onChange: (v: string) => void
}) {
  const [capturing, setCapturing] = useState(false)

  useEffect(() => {
    if (!capturing) return
    const handler = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return
      if (e.key === 'Escape') {
        setCapturing(false)
        return
      }
      const parts: string[] = []
      if (e.ctrlKey) parts.push('Ctrl')
      if (e.altKey) parts.push('Alt')
      if (e.shiftKey) parts.push('Shift')
      if (e.metaKey) parts.push('Meta')
      let key = e.key
      if (key === ' ') key = 'Space'
      parts.push(key.length === 1 ? key.toUpperCase() : key)
      onChange(parts.join('+'))
      setCapturing(false)
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [capturing, onChange])

  return (
    <button
      onClick={() => setCapturing((c) => !c)}
      className={`input-base !py-1 !px-2 !text-2xs font-mono text-left min-w-[140px] ${capturing ? 'border-accent/50 bg-white/8' : ''}`}
    >
      {capturing ? '按下组合键…（Esc 取消）' : (value || '未设置')}
    </button>
  )
}

/* ============================================================
 * 11. 通用安全
 * ============================================================ */
function SecuritySection() {
  const toast = useToast()
  const [config, setConfig] = useState<SecurityConfig | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void load()
  }, [])

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const c = await configApi.getSecurity().catch(() => DEFAULT_SECURITY)
      setConfig(c)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setConfig(DEFAULT_SECURITY)
    } finally {
      setLoading(false)
    }
  }

  const debouncedSave = useDebouncedCallback(async (next: SecurityConfig) => {
    setError(null)
    try {
      const c = await configApi.setSecurity(next)
      setConfig(c)
      toast('已保存')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, 350)

  function update(patch: Partial<SecurityConfig>) {
    if (!config) return
    const next = { ...config, ...patch }
    setConfig(next)
    void debouncedSave(next)
  }

  if (loading) return <LoadingHint />

  return (
    <ConfigCard>
      <SectionHeader
        title="通用安全"
        desc="配置审批超时、Shell 黑名单与会话过期策略。修改即时保存。"
      />
      <ErrorBanner message={error} />

      <ConfigGroup title="审批与会话">
        <Slider
          label="自动审批超时"
          desc="审批请求超过此时间未响应将自动拒绝"
          value={config?.approvalTimeoutSecs ?? 120}
          min={60}
          max={600}
          step={10}
          unit=" s"
          onChange={(v) => update({ approvalTimeoutSecs: v })}
        />
        <Slider
          label="会话自动过期"
          desc="会话闲置超过此时间将被清理"
          value={config?.sessionExpireHours ?? 168}
          min={1}
          max={720}
          step={1}
          unit=" h"
          onChange={(v) => update({ sessionExpireHours: v })}
        />
      </ConfigGroup>

      <ConfigGroup title="Shell 拦截">
        <LinesInput
          label="危险命令黑名单"
          desc="每行一条命令前缀，Agent 执行前匹配将强制审批"
          placeholder="rm -rf /"
          lines={config?.shellBlacklist ?? []}
          onChange={(lines) => update({ shellBlacklist: lines })}
        />
      </ConfigGroup>

      <ConfigGroup title="审计日志">
        <div className="px-3 py-2.5">
          <FormField label="审计日志存储路径">
            <input
              type="text"
              className="input-base font-mono !text-2xs"
              placeholder="C:\\Users\\you\\codewhale\\audit.log"
              value={config?.auditLogPath ?? ''}
              onChange={(e) => update({ auditLogPath: e.target.value })}
              data-selectable="true"
              spellCheck={false}
            />
          </FormField>
        </div>
      </ConfigGroup>

      {config && (
        <div className="px-3 py-2 rounded-lg border border-white/8 bg-white/4 text-2xs text-text-tertiary leading-relaxed">
          timeout=<span className="text-text-secondary">{config.approvalTimeoutSecs}s</span>
          {' · '}expire=<span className="text-text-secondary">{config.sessionExpireHours}h</span>
          {' · '}blacklist=<span className="text-text-secondary">{config.shellBlacklist.length}</span>
        </div>
      )}
    </ConfigCard>
  )
}

/* ============================================================
 * 12. 关于
 * ============================================================ */
function AboutSection() {
  const techStack = [
    'Tauri 2', 'Rust', 'React 18', 'TypeScript 5',
    'Tailwind CSS 3', 'Zustand 4', 'DeepSeek V3/V4',
  ]
  const credits = [
    { name: 'OpenAI Codex', desc: 'UI 风格参考' },
    { name: 'Aider', desc: '代码格式化思路' },
    { name: 'DeepSeek', desc: '推理模型支持' },
    { name: 'Tauri', desc: '桌面应用框架' },
  ]

  return (
    <ConfigCard>
      <SectionHeader
        title="关于 CodeWhale"
        desc="复刻 Codex 风格的桌面 AI 编程 Agent。"
      />

      <ConfigGroup title="应用信息">
        <div className="px-3 py-3 space-y-1.5">
          <div className="flex items-center gap-2">
            <span className="text-base font-semibold text-text-primary">CodeWhale Desktop</span>
            <span className="px-1.5 py-0.5 rounded text-2xs font-mono bg-accent/12 text-accent">v0.1.0</span>
          </div>
          <div className="text-2xs text-text-tertiary">构建时间：2026-07-26</div>
          <div className="text-2xs text-text-tertiary font-mono">
            仓库：github.com/codewhale/desktop
          </div>
        </div>
      </ConfigGroup>

      <ConfigGroup title="技术栈">
        <div className="px-3 py-3 flex flex-wrap gap-1.5">
          {techStack.map((t) => (
            <span
              key={t}
              className="px-1.5 py-0.5 rounded text-2xs font-mono bg-white/6 text-text-secondary"
            >
              {t}
            </span>
          ))}
        </div>
      </ConfigGroup>

      <ConfigGroup title="致谢">
        <div className="divide-y divide-white/5">
          {credits.map((c) => (
            <div key={c.name} className="px-3 py-2 flex items-center justify-between">
              <span className="text-sm text-text-primary">{c.name}</span>
              <span className="text-2xs text-text-tertiary">{c.desc}</span>
            </div>
          ))}
        </div>
      </ConfigGroup>

      <ConfigGroup title="许可证">
        <div className="px-3 py-3">
          <div className="text-sm text-text-primary">MIT License</div>
          <div className="text-2xs text-text-tertiary mt-1 leading-relaxed">
            Copyright © 2026 CodeWhale Contributors. 本软件以 MIT 协议开源，可自由使用、修改与分发。
          </div>
        </div>
      </ConfigGroup>
    </ConfigCard>
  )
}
