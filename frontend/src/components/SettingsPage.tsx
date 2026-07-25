/**
 * 设置页面（Codex 风格）
 *
 *  ┌────────────────┬──────────────────────────────────────────┐
 *  │  设置分类菜单    │   内容面板（滚动）                          │
 *  │  - 通用         │                                            │
 *  │  - 外观         │   工作区板块已由 App.tsx 提供，              │
 *  │  - API 配置     │   内部仅用浮层做轻量分层                     │
 *  │  - 模型参数     │                                            │
 *  │  - 权限         │   权限板块：Agent 操作沙盒配置               │
 *  │  - 格式化       │   格式化板块：rustfmt/prettier/black 配置   │
 *  │  - 关于         │                                            │
 *  └────────────────┴──────────────────────────────────────────┘
 */
import { useEffect, useState } from 'react'
import { ParamsPanel } from './ParamsPanel'
import { permissionApi } from '../lib/api'
import { supportedLanguages } from '../lib/formatter'
import type { PermissionConfig, PermissionLevel } from '../types'

type SettingsSection = 'general' | 'appearance' | 'api' | 'model' | 'permission' | 'formatter' | 'about'

const SECTIONS: { key: SettingsSection; label: string; desc: string }[] = [
  { key: 'general', label: '通用', desc: '基础偏好' },
  { key: 'appearance', label: '外观', desc: '主题、字体、动效' },
  { key: 'api', label: 'API 配置', desc: '后端地址、密钥' },
  { key: 'model', label: '模型参数', desc: '推理强度、上下文缓存' },
  { key: 'permission', label: '权限', desc: 'Agent 操作沙盒' },
  { key: 'formatter', label: '格式化', desc: '代码格式化工具' },
  { key: 'about', label: '关于', desc: '版本、构建信息' },
]

export function SettingsPage() {
  const [section, setSection] = useState<SettingsSection>('api')

  return (
    <div className="flex h-full w-full p-4 gap-3 overflow-hidden">
      {/* === 左侧菜单（浮层） === */}
      <aside className="w-56 flex-shrink-0 surface p-2 overflow-auto">
        <div className="px-3 py-2 text-2xs uppercase tracking-wider text-text-tertiary font-semibold">
          设置
        </div>
        {SECTIONS.map((s) => (
          <button
            key={s.key}
            onClick={() => setSection(s.key)}
            className={`w-full text-left px-3 py-2 rounded transition-all duration-200 ${
              section === s.key
                ? 'bg-accent/12 text-accent'
                : 'text-text-secondary hover:bg-white/6 hover:text-text-primary'
            }`}
          >
            <div className="text-sm font-medium">{s.label}</div>
            <div className="text-2xs text-text-tertiary mt-0.5">{s.desc}</div>
          </button>
        ))}
      </aside>

      {/* === 右侧内容（浮层） === */}
      <main className="flex-1 min-w-0 surface p-6 overflow-auto">
        {section === 'api' || section === 'model' ? (
          <ParamsPanel embedded />
        ) : section === 'permission' ? (
          <PermissionSection />
        ) : section === 'formatter' ? (
          <FormatterSection />
        ) : (
          <PlaceholderSection section={section} />
        )}
      </main>
    </div>
  )
}

/* ============== 权限配置板块 ============== */

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

function PermissionSection() {
  const [config, setConfig] = useState<PermissionConfig | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void load()
  }, [])

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const c = await permissionApi.get()
      setConfig(c)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  /** 即时保存：调用 permissionApi.set(patch) */
  async function update(patch: Partial<PermissionConfig>) {
    if (!config) return
    setSaving(true)
    setError(null)
    try {
      const c = await permissionApi.set(patch)
      setConfig(c)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return <div className="text-sm text-text-tertiary">加载权限配置中…</div>
  }

  return (
    <div className="max-w-2xl space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-text-primary mb-1">权限配置</h2>
        <p className="text-sm text-text-secondary leading-relaxed">
          配置 Agent 在工作区可执行的操作范围与审批策略。修改即时保存。
        </p>
      </div>

      {error && (
        <div className="px-3 py-2 rounded-lg text-2xs text-diff-removed-text bg-diff-removed/20 border border-diff-removed/40">
          {error}
        </div>
      )}

      {/* 权限等级单选卡片 */}
      <div className="space-y-2">
        <div className="text-2xs uppercase tracking-wider text-text-tertiary font-semibold">
          操作范围
        </div>
        {PERMISSION_LEVELS.map((lvl) => {
          const selected = config?.level === lvl.value
          return (
            <button
              key={lvl.value}
              onClick={() => void update({ level: lvl.value })}
              disabled={saving}
              className={`w-full flex items-start gap-3 px-3 py-2.5 rounded-lg border text-left transition-all duration-200 ease-out
                ${selected
                  ? 'bg-accent/12 border-accent/40'
                  : 'bg-white/4 border-white/8 hover:bg-white/6 hover:border-white/12'
                }`}
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
      </div>

      {/* 审批策略开关 */}
      <div className="space-y-2">
        <div className="text-2xs uppercase tracking-wider text-text-tertiary font-semibold">
          审批策略
        </div>
        <div className="rounded-lg border border-white/8 bg-white/4 divide-y divide-white/5 overflow-hidden">
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
        </div>
        <div className="text-2xs text-text-tertiary leading-relaxed">
          审批请求会以右下角浮窗形式弹出，可单条或批量处理。
        </div>
      </div>

      {/* 当前配置摘要 */}
      {config && (
        <div className="mt-2 px-3 py-2 rounded-lg border border-white/8 bg-white/4 text-2xs text-text-tertiary leading-relaxed">
          当前：level=<span className="text-text-secondary">{config.level}</span>
          {' · '}writeApproval=<span className="text-text-secondary">{config.approvalOnWrite ? 'on' : 'off'}</span>
          {' · '}shellApproval=<span className="text-text-secondary">{config.approvalOnShell ? 'on' : 'off'}</span>
        </div>
      )}
    </div>
  )
}

function ToggleRow({
  label,
  desc,
  on,
  disabled,
  onChange,
}: {
  label: string
  desc: string
  on: boolean
  disabled?: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <div className="flex items-center justify-between px-3 py-2.5">
      <div className="min-w-0">
        <div className="text-sm text-text-primary">{label}</div>
        <div className="text-2xs text-text-tertiary mt-0.5">{desc}</div>
      </div>
      <button
        className={`w-8 h-4 rounded-full transition-colors flex-shrink-0 ${on ? 'bg-accent' : 'bg-white/12'} ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
        onClick={() => !disabled && onChange(!on)}
        role="switch"
        aria-checked={on}
        disabled={disabled}
      >
        <div
          className={`w-3 h-3 rounded-full bg-white transition-transform ${on ? 'translate-x-4' : 'translate-x-0.5'}`}
        />
      </button>
    </div>
  )
}

/* ============== 占位板块 ============== */

function PlaceholderSection({ section }: { section: SettingsSection }) {
  const titles: Record<SettingsSection, string> = {
    general: '通用设置',
    appearance: '外观设置',
    api: 'API 配置',
    model: '模型参数',
    permission: '权限配置',
    formatter: '格式化配置',
    about: '关于 CodeWhale',
  }
  return (
    <div className="max-w-2xl">
      <h2 className="text-lg font-semibold text-text-primary mb-3">{titles[section]}</h2>
      <p className="text-sm text-text-secondary leading-relaxed">
        该部分将在后续迭代中扩展。当前可用的可配置项请切换至「API 配置」、「模型参数」或「权限」。
      </p>
      {section === 'about' && (
        <div className="mt-6 surface p-4">
          <div className="text-sm text-text-primary font-medium">CodeWhale Desktop</div>
          <div className="text-2xs text-text-tertiary mt-1">v0.1.0 · Tauri + Rust + React</div>
          <div className="text-2xs text-text-tertiary mt-0.5">DeepSeek V4 · Mica Acrylic</div>
        </div>
      )}
    </div>
  )
}

/* ============== 格式化配置板块（参考 Aider） ============== */

const FORMATTER_STORAGE_KEY = 'codewhale-formatter-config'

/** 单个格式化工具配置 */
interface FormatterToolConfig {
  /** 是否启用 */
  enabled: boolean
  /** 自定义可执行文件路径（可选，空则使用 PATH 中的默认工具） */
  path: string
}

/** 格式化总配置 */
interface FormatterConfig {
  /** 全局：保存时自动格式化 */
  formatOnSave: boolean
  /** 各语言工具配置 */
  tools: Record<string, FormatterToolConfig>
}

/** 默认配置：所有受支持语言默认启用，路径为空 */
function defaultFormatterConfig(): FormatterConfig {
  const tools: Record<string, FormatterToolConfig> = {}
  for (const { language } of supportedLanguages()) {
    tools[language] = { enabled: true, path: '' }
  }
  return { formatOnSave: false, tools }
}

/** 从 localStorage 加载配置 */
function loadFormatterConfig(): FormatterConfig {
  if (typeof window === 'undefined') return defaultFormatterConfig()
  try {
    const raw = window.localStorage.getItem(FORMATTER_STORAGE_KEY)
    if (!raw) return defaultFormatterConfig()
    const data = JSON.parse(raw) as Partial<FormatterConfig>
    const base = defaultFormatterConfig()
    // 合并：保证新出现的语言有默认值
    const tools = { ...base.tools }
    if (data.tools && typeof data.tools === 'object') {
      for (const lang of Object.keys(tools)) {
        const t = (data.tools as Record<string, Partial<FormatterToolConfig>>)[lang]
        if (t) {
          tools[lang] = {
            enabled: typeof t.enabled === 'boolean' ? t.enabled : true,
            path: typeof t.path === 'string' ? t.path : '',
          }
        }
      }
    }
    return {
      formatOnSave: typeof data.formatOnSave === 'boolean' ? data.formatOnSave : false,
      tools,
    }
  } catch {
    return defaultFormatterConfig()
  }
}

/** 保存配置到 localStorage */
function saveFormatterConfig(cfg: FormatterConfig): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(FORMATTER_STORAGE_KEY, JSON.stringify(cfg))
  } catch {
    /* localStorage 不可用时静默忽略 */
  }
}

function FormatterSection() {
  const [config, setConfig] = useState<FormatterConfig>(() => loadFormatterConfig())

  /** 更新配置并持久化 */
  const update = (next: FormatterConfig) => {
    setConfig(next)
    saveFormatterConfig(next)
  }

  /** 切换 formatOnSave */
  const toggleFormatOnSave = (v: boolean) => {
    update({ ...config, formatOnSave: v })
  }

  /** 切换某语言工具的启用状态 */
  const toggleTool = (language: string, enabled: boolean) => {
    const cur = config.tools[language] ?? { enabled: true, path: '' }
    update({
      ...config,
      tools: { ...config.tools, [language]: { ...cur, enabled } },
    })
  }

  /** 修改某语言工具的自定义路径 */
  const setToolPath = (language: string, path: string) => {
    const cur = config.tools[language] ?? { enabled: true, path: '' }
    update({
      ...config,
      tools: { ...config.tools, [language]: { ...cur, path } },
    })
  }

  /** 恢复默认配置 */
  const handleReset = () => {
    const def = defaultFormatterConfig()
    update(def)
  }

  const langs = supportedLanguages()

  return (
    <div className="max-w-2xl space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-text-primary mb-1">格式化配置</h2>
        <p className="text-sm text-text-secondary leading-relaxed">
          配置各语言的代码格式化工具（参考 Aider）。Agent 在写入代码后会自动调用对应工具进行格式化。
        </p>
      </div>

      {/* 全局开关：Format on Save */}
      <div className="space-y-2">
        <div className="text-2xs uppercase tracking-wider text-text-tertiary font-semibold">
          全局
        </div>
        <div className="rounded-lg border border-white/8 bg-white/4 overflow-hidden">
          <ToggleRow
            label="保存时格式化"
            desc="写入文件到磁盘前自动调用对应语言格式化工具"
            on={config.formatOnSave}
            onChange={toggleFormatOnSave}
          />
        </div>
      </div>

      {/* 各语言工具配置 */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <div className="text-2xs uppercase tracking-wider text-text-tertiary font-semibold">
            工具
          </div>
          <button
            onClick={handleReset}
            className="btn-secondary !py-1 !px-2 !text-2xs"
            title="恢复默认配置"
          >
            恢复默认
          </button>
        </div>
        <div className="space-y-2">
          {langs.map(({ language, tool }) => {
            const t = config.tools[language] ?? { enabled: true, path: '' }
            return (
              <FormatterToolRow
                key={language}
                language={language}
                tool={tool}
                enabled={t.enabled}
                path={t.path}
                onToggle={(v) => toggleTool(language, v)}
                onPathChange={(p) => setToolPath(language, p)}
              />
            )
          })}
        </div>
        <div className="text-2xs text-text-tertiary leading-relaxed">
          路径可留空，将使用系统 PATH 中的默认工具；填写绝对路径可指定特定版本。
        </div>
      </div>

      {/* 当前配置摘要 */}
      <div className="mt-2 px-3 py-2 rounded-lg border border-white/8 bg-white/4 text-2xs text-text-tertiary leading-relaxed">
        formatOnSave=<span className="text-text-secondary">{config.formatOnSave ? 'on' : 'off'}</span>
        {' · '}启用工具=<span className="text-text-secondary">
          {Object.values(config.tools).filter((x) => x.enabled).length}/{langs.length}
        </span>
      </div>
    </div>
  )
}

/** 单个工具配置行：语言名 + 工具名 + 启用开关 + 路径输入框 */
function FormatterToolRow({
  language,
  tool,
  enabled,
  path,
  onToggle,
  onPathChange,
}: {
  language: string
  tool: string
  enabled: boolean
  path: string
  onToggle: (v: boolean) => void
  onPathChange: (v: string) => void
}) {
  return (
    <div
      className={`rounded-lg border px-3 py-2.5 transition-all duration-200 ease-out
        ${enabled
          ? 'border-white/8 bg-white/4'
          : 'border-white/5 bg-white/2 opacity-70'
        }`}
    >
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-sm font-medium text-text-primary">{language}</span>
          <span className="px-1.5 py-0.5 rounded text-2xs font-mono bg-accent/12 text-accent">
            {tool}
          </span>
        </div>
        <button
          className={`w-8 h-4 rounded-full transition-colors flex-shrink-0 ${enabled ? 'bg-accent' : 'bg-white/12'} cursor-pointer`}
          onClick={() => onToggle(!enabled)}
          role="switch"
          aria-checked={enabled}
        >
          <div
            className={`w-3 h-3 rounded-full bg-white transition-transform ${enabled ? 'translate-x-4' : 'translate-x-0.5'}`}
          />
        </button>
      </div>
      <input
        type="text"
        placeholder={`自定义 ${tool} 路径（可选）`}
        value={path}
        onChange={(e) => onPathChange(e.target.value)}
        disabled={!enabled}
        className="input-base !py-1 !text-2xs font-mono disabled:opacity-50"
        spellCheck={false}
        data-selectable="true"
      />
    </div>
  )
}
