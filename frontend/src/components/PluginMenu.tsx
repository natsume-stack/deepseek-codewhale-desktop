/**
 * 插件菜单（P1 - 参考 Continue.dev 插件生态 + DeepSeekAgents 技能系统）
 *
 *  - 显示已安装插件列表（mock 数据：formatter/git-helper/test-gen/doc-gen）
 *  - 每个插件：名称、描述、启用开关、`/plugin:xxx` 指令复制按钮
 *  - "插件市场"按钮（占位，点击弹"敬请期待"）
 *  - 视觉：浮层卡片，与 Codex 设置页风格一致
 *
 * 用法：
 *   <PluginMenu visible={true} onClose={() => ...} onPickCommand={(cmd) => ...} />
 */
import { useEffect, useMemo, useState } from 'react'
import { useDialogStore } from '../stores/dialog'

interface PluginMenuProps {
  visible: boolean
  onClose: () => void
  /** 选中指令时回调（如 /plugin:formatter） */
  onPickCommand?: (cmd: string) => void
}

interface PluginEntry {
  id: string
  name: string
  description: string
  command: string
  enabled: boolean
}

/** mock 已安装插件 */
const DEFAULT_PLUGINS: PluginEntry[] = [
  {
    id: 'formatter',
    name: 'Formatter',
    description: '代码格式化插件（rustfmt / prettier / gofmt）',
    command: '/plugin:formatter',
    enabled: true,
  },
  {
    id: 'git-helper',
    name: 'Git Helper',
    description: '常用 Git 操作封装：commit / branch / PR 审阅',
    command: '/plugin:git-helper',
    enabled: true,
  },
  {
    id: 'test-gen',
    name: 'Test Generator',
    description: '基于现有代码自动生成单元测试骨架',
    command: '/plugin:test-gen',
    enabled: false,
  },
  {
    id: 'doc-gen',
    name: 'Doc Generator',
    description: '为函数 / 模块生成注释与文档（Rustdoc / JSDoc）',
    command: '/plugin:doc-gen',
    enabled: true,
  },
]

export function PluginMenu({ visible, onClose, onPickCommand }: PluginMenuProps) {
  const [plugins, setPlugins] = useState<PluginEntry[]>(DEFAULT_PLUGINS)
  const [copiedId, setCopiedId] = useState<string | null>(null)

  // Esc 关闭
  useEffect(() => {
    if (!visible) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [visible, onClose])

  // 切换开关
  const togglePlugin = (id: string) => {
    setPlugins((list) =>
      list.map((p) => (p.id === id ? { ...p, enabled: !p.enabled } : p)),
    )
  }

  // 复制指令 / 触发 onPickCommand
  const handleCommand = async (p: PluginEntry) => {
    if (onPickCommand) {
      onPickCommand(p.command)
      onClose()
      return
    }
    try {
      await navigator.clipboard.writeText(p.command)
      setCopiedId(p.id)
      setTimeout(() => setCopiedId(null), 1500)
    } catch {
      /* ignore */
    }
  }

  // 进入插件市场（占位）
  const handleMarketplace = async () => {
    await useDialogStore.getState().alert({
      title: '插件市场',
      message: '敬请期待，插件市场将在后续版本上线。',
    })
  }

  const enabledCount = useMemo(
    () => plugins.filter((p) => p.enabled).length,
    [plugins],
  )

  if (!visible) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm animate-fade-in"
      onClick={onClose}
    >
      <div
        className="w-[480px] max-w-[90vw] max-h-[80vh] rounded-lg border border-white/10 bg-surface-elevated shadow-raised animate-scale-in flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 标题栏 */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/8">
          <div className="flex items-center gap-2 min-w-0">
            <PluginIcon />
            <span className="text-sm font-semibold text-text-primary">插件</span>
            <span className="text-2xs text-text-tertiary font-mono">
              {enabledCount}/{plugins.length} 已启用
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              onClick={handleMarketplace}
              className="btn-secondary !py-1 !px-2 !text-2xs"
              title="浏览插件市场（敬请期待）"
            >
              <MarketIcon />
              插件市场
            </button>
            <button onClick={onClose} className="icon-btn !p-1" title="关闭">
              <CloseIcon />
            </button>
          </div>
        </div>

        {/* 插件列表 */}
        <div className="flex-1 overflow-auto p-2 space-y-1">
          {plugins.map((p) => (
            <PluginRow
              key={p.id}
              plugin={p}
              copied={copiedId === p.id}
              onToggle={() => togglePlugin(p.id)}
              onUseCommand={() => void handleCommand(p)}
            />
          ))}
        </div>

        {/* 底部提示 */}
        <div className="px-4 py-2 border-t border-white/8 bg-white/4 text-2xs text-text-tertiary leading-relaxed">
          点击 <span className="font-mono text-text-secondary">/plugin:xxx</span> 按钮复制指令到输入框，可在对话中调用插件能力。
        </div>
      </div>
    </div>
  )
}

/* ============== 单条插件行 ============== */
function PluginRow({
  plugin,
  copied,
  onToggle,
  onUseCommand,
}: {
  plugin: PluginEntry
  copied: boolean
  onToggle: () => void
  onUseCommand: () => void
}) {
  return (
    <div
      className={`flex items-start gap-3 px-3 py-2.5 rounded-lg border transition-all duration-200 ease-out
        ${plugin.enabled
          ? 'bg-white/4 border-white/8'
          : 'bg-transparent border-white/5 opacity-70'
        }`}
    >
      <div className="mt-0.5 flex-shrink-0">
        <PluginKindIcon id={plugin.id} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="text-sm font-medium text-text-primary truncate">
            {plugin.name}
          </span>
          {!plugin.enabled && (
            <span className="px-1 py-0.5 rounded text-2xs font-mono bg-white/8 text-text-tertiary">
              已禁用
            </span>
          )}
        </div>
        <div className="text-2xs text-text-tertiary mt-0.5 leading-relaxed">
          {plugin.description}
        </div>
        <div className="mt-1.5 flex items-center gap-1.5">
          <button
            type="button"
            onClick={onUseCommand}
            disabled={!plugin.enabled}
            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-2xs font-mono text-accent bg-accent/10 border border-accent/25 hover:bg-accent/15 disabled:opacity-30 disabled:cursor-not-allowed transition-all duration-200 ease-out"
            title="使用此插件指令"
          >
            {copied ? <CopiedIcon /> : <CommandIcon />}
            {copied ? '已复制' : plugin.command}
          </button>
        </div>
      </div>
      <button
        onClick={onToggle}
        className={`flex-shrink-0 w-8 h-4 rounded-full transition-colors ${plugin.enabled ? 'bg-accent' : 'bg-white/12'}`}
        role="switch"
        aria-checked={plugin.enabled}
        title={plugin.enabled ? '点击禁用' : '点击启用'}
      >
        <div
          className={`w-3 h-3 rounded-full bg-white transition-transform ${plugin.enabled ? 'translate-x-4' : 'translate-x-0.5'}`}
        />
      </button>
    </div>
  )
}

/* ============== 图标 ============== */
function PluginIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" className="text-accent">
      <path d="M8 1.5l1.5 3 3.5.5-2.5 2.4.6 3.4L8 9.2 4.9 10.8l.6-3.4L2.9 5l3.5-.5L8 1.5z" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" />
    </svg>
  )
}

function PluginKindIcon({ id }: { id: string }) {
  if (id === 'formatter') {
    return (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" className="text-accent">
        <path d="M2 4h12M2 8h8M2 12h12" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      </svg>
    )
  }
  if (id === 'git-helper') {
    return (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" className="text-orange-400">
        <circle cx="4" cy="4" r="1.5" stroke="currentColor" strokeWidth="1.1" />
        <circle cx="4" cy="12" r="1.5" stroke="currentColor" strokeWidth="1.1" />
        <circle cx="12" cy="8" r="1.5" stroke="currentColor" strokeWidth="1.1" />
        <path d="M4 5.5v5M4.8 4.5L11 7.2" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
      </svg>
    )
  }
  if (id === 'test-gen') {
    return (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" className="text-emerald-400">
        <path d="M3 3h10v6a5 5 0 01-10 0V3z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
        <path d="M5.5 7l1.5 1.5L10 5.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    )
  }
  // doc-gen
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" className="text-sky-400">
      <path d="M3 2h6l3 3v9H3V2z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
      <path d="M9 2v3h3M5.5 8.5h5M5.5 10.5h5M5.5 12.5h3" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
    </svg>
  )
}

function MarketIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
      <path d="M3 5h10l-.7 7a1 1 0 01-1 .9H4.7a1 1 0 01-1-.9L3 5z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
      <path d="M6 5V3.5a2 2 0 014 0V5" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
    </svg>
  )
}

function CommandIcon() {
  return (
    <svg width="9" height="9" viewBox="0 0 16 16" fill="none">
      <rect x="5" y="5" width="8" height="8" rx="1" stroke="currentColor" strokeWidth="1.1" />
      <path d="M3 11V3h8" stroke="currentColor" strokeWidth="1.1" />
    </svg>
  )
}

function CopiedIcon() {
  return (
    <svg width="9" height="9" viewBox="0 0 16 16" fill="none" className="text-diff-added-text">
      <path d="M3 8l3 3 7-7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function CloseIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
      <line x1="4" y1="4" x2="12" y2="12" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <line x1="12" y1="4" x2="4" y2="12" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}
