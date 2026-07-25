/**
 * MCP 插件管理面板（Codex 风格 - P1）
 *
 *  - 展示已注册 MCP 插件列表
 *  - 每项：名称、描述、传输协议、连接状态、启用开关、连接/断开按钮
 *  - 「添加插件」按钮：弹出表单（stdio: command+args；sse: url）
 *  - 高危插件总开关 + 高危插件红色徽标
 *  - 插件调用测试按钮
 *  - 视觉：与 SkillListPanel 风格一致
 *
 * 用法：
 *   <MCPManagerPanel />              // 内嵌模式
 *   <MCPManagerPanel floating onClose={...} /> // 浮层模式
 */
import { useEffect, useState } from 'react'
import { useMcpStore, selectConnectedCount, selectHighRiskPlugins } from '../stores/mcp'
import { useDialogStore } from '../stores/dialog'
import { useChatStore } from '../stores/chat'
import type { McpCategory, McpConfig, McpTransport } from '../types'

interface MCPManagerPanelProps {
  /** 浮层模式：true 时渲染为模态遮罩，需配合 onClose */
  floating?: boolean
  onClose?: () => void
}

const CATEGORY_OPTIONS: McpCategory[] = ['lsp', 'knowledge', 'ci', 'database', 'security', 'other']

export function MCPManagerPanel({ floating, onClose }: MCPManagerPanelProps) {
  const plugins = useMcpStore((s) => s.plugins)
  const highRiskEnabled = useMcpStore((s) => s.highRiskEnabled)
  const loading = useMcpStore((s) => s.loading)
  const error = useMcpStore((s) => s.error)
  const fetchAll = useMcpStore((s) => s.fetchAll)
  const toggle = useMcpStore((s) => s.toggle)
  const connect = useMcpStore((s) => s.connect)
  const disconnect = useMcpStore((s) => s.disconnect)
  const remove = useMcpStore((s) => s.remove)
  const setHighRiskSwitch = useMcpStore((s) => s.setHighRiskSwitch)

  const [registerOpen, setRegisterOpen] = useState(false)

  useEffect(() => {
    void fetchAll()
  }, [fetchAll])

  const connectedCount = selectConnectedCount(plugins)
  const highRiskPlugins = selectHighRiskPlugins(plugins)

  const body = (
    <div className="h-full flex flex-col">
      {/* === 顶部操作条 === */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/5">
        <div className="flex items-center gap-2 min-w-0">
          <PluginIcon />
          <span className="text-sm font-semibold text-text-primary">MCP 插件</span>
          <span className="text-2xs text-text-tertiary font-mono">
            {connectedCount}/{plugins.length} 已连接
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setRegisterOpen(true)}
            className="btn-primary !py-1 !px-2 !text-2xs"
            title="添加 MCP 插件"
          >
            <PlusIcon />
            添加插件
          </button>
          <button
            onClick={() => void fetchAll()}
            disabled={loading}
            className="icon-btn !p-1"
            title="刷新"
          >
            <RefreshIcon spinning={loading} />
          </button>
          {floating && (
            <button onClick={() => onClose?.()} className="icon-btn !p-1" title="关闭">
              <CloseIcon />
            </button>
          )}
        </div>
      </div>

      {/* === 高危总开关条 === */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-white/5 bg-white/3">
        <div className="flex items-center gap-2 min-w-0">
          <ShieldIcon />
          <span className="text-2xs text-text-secondary">高危插件总开关</span>
          {highRiskPlugins.length > 0 && (
            <span className="px-1 py-0.5 rounded text-2xs font-mono bg-rose-500/20 text-rose-300 border border-rose-500/40">
              {highRiskPlugins.length} 个高危
            </span>
          )}
        </div>
        <ToggleSwitch
          enabled={highRiskEnabled}
          onToggle={() => void setHighRiskSwitch(!highRiskEnabled)}
        />
      </div>

      {/* === 错误条 === */}
      {error && (
        <div className="px-4 py-1.5 text-2xs text-diff-removed-text bg-diff-removed/20 border-b border-diff-removed/40">
          {error}
        </div>
      )}

      {/* === 插件列表 === */}
      <div className="flex-1 overflow-auto p-3 space-y-1.5">
        {plugins.length === 0 && !loading ? (
          <EmptyHint
            icon={<PluginIcon />}
            text="暂无 MCP 插件。点击「添加插件」注册新的 stdio 或 sse 插件。"
          />
        ) : (
          plugins.map((p) => (
            <PluginCard
              key={p.meta.id}
              plugin={p}
              highRiskGate={highRiskEnabled}
              onToggle={() => void toggle(p.meta.id)}
              onConnect={() => void connect(p.meta.id)}
              onDisconnect={() => void disconnect(p.meta.id)}
              onTest={async () => {
                const r = await useMcpStore.getState().call({
                  pluginId: p.meta.id,
                  tool: 'ping',
                  arguments: {},
                  sessionId: useChatStore.getState().sessionId ?? undefined,
                })
                if (r) {
                  await useDialogStore.getState().alert({
                    title: '调用结果',
                    message: r.summary || (r.success ? '调用成功' : '调用失败'),
                  })
                }
              }}
              onDelete={async () => {
                const ok = await useDialogStore.getState().confirm({
                  title: '删除插件',
                  message: `确认删除插件「${p.meta.name}」？此操作不可撤销。`,
                  danger: true,
                  confirmText: '删除',
                })
                if (ok) void remove(p.meta.id)
              }}
            />
          ))
        )}
      </div>

      {/* === 注册表单 Modal === */}
      {registerOpen && (
        <RegisterPluginModal
          onClose={() => setRegisterOpen(false)}
          onRegister={async (cfg) => {
            const def = await useMcpStore.getState().register(cfg)
            if (def) setRegisterOpen(false)
          }}
        />
      )}
    </div>
  )

  if (floating) {
    return (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm animate-fade-in"
        onClick={() => onClose?.()}
      >
        <div
          className="w-[640px] max-w-[92vw] max-h-[85vh] rounded-lg border border-white/10 bg-surface-elevated shadow-raised animate-scale-in flex flex-col overflow-hidden"
          onClick={(e) => e.stopPropagation()}
        >
          {body}
        </div>
      </div>
    )
  }

  return body
}

/* ============== 单条插件卡片 ============== */

interface PluginCardProps {
  plugin: McpConfig & { status: import('../types').McpStatus }
  highRiskGate: boolean
  onToggle: () => void
  onConnect: () => void
  onDisconnect: () => void
  onTest: () => void
  onDelete: () => void
}

function PluginCard({
  plugin,
  highRiskGate,
  onToggle,
  onConnect,
  onDisconnect,
  onTest,
  onDelete,
}: PluginCardProps) {
  const { meta, status } = plugin
  // 高危插件且总开关关闭 → 禁用调用
  const blockedByGate = meta.highRisk && !highRiskGate
  return (
    <div
      className={`group px-3 py-2.5 rounded-lg border transition-all duration-200 ease-out
        ${status.connected
          ? 'border-emerald-500/30 bg-emerald-500/5'
          : 'border-white/8 bg-white/4 hover:bg-white/6 hover:border-white/12'
        }`}
    >
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex-shrink-0">
          <PluginKindIcon category={meta.category} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-sm font-medium text-text-primary truncate">
              {meta.name}
            </span>
            <span className="px-1 py-0.5 rounded text-2xs font-mono bg-white/6 text-text-secondary border border-white/8">
              {meta.transport}
            </span>
            <span className="px-1 py-0.5 rounded text-2xs font-mono bg-accent/12 text-accent border border-accent/20">
              {meta.category}
            </span>
            {meta.highRisk && (
              <span className="px-1 py-0.5 rounded text-2xs font-mono bg-rose-500/20 text-rose-300 border border-rose-500/40">
                高危
              </span>
            )}
            <span className="text-2xs text-text-tertiary font-mono">v{meta.version}</span>
          </div>
          <div className="text-2xs text-text-tertiary mt-1 leading-relaxed line-clamp-2">
            {meta.description}
          </div>
          <div className="mt-1 flex items-center gap-2 text-2xs font-mono text-text-tertiary">
            <span className={`inline-flex items-center gap-1 ${status.connected ? 'text-emerald-400' : 'text-text-tertiary'}`}>
              <span className={`w-1.5 h-1.5 rounded-full ${status.connected ? 'bg-emerald-400' : 'bg-white/30'}`} />
              {status.connected ? '已连接' : '未连接'}
            </span>
            {status.callCount > 0 && (
              <span>· 调用 {status.callCount} 次</span>
            )}
            {status.lastError && (
              <span className="text-rose-300 truncate" title={status.lastError}>
                · {status.lastError}
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          <button
            onClick={onDelete}
            className="icon-btn !p-1 opacity-0 group-hover:opacity-100"
            title="删除"
          >
            <TrashIcon />
          </button>
          <button
            onClick={onTest}
            disabled={!status.connected || blockedByGate}
            className="icon-btn !p-1"
            title="调用测试"
          >
            <PlayIcon />
          </button>
          {status.connected ? (
            <button
              onClick={onDisconnect}
              className="btn-secondary !py-1 !px-2 !text-2xs"
              title="断开连接"
            >
              断开
            </button>
          ) : (
            <button
              onClick={onConnect}
              disabled={blockedByGate}
              className="btn-secondary !py-1 !px-2 !text-2xs disabled:opacity-30"
              title={blockedByGate ? '高危总开关已关闭' : '连接'}
            >
              连接
            </button>
          )}
          <ToggleSwitch enabled={meta.enabled} onToggle={onToggle} />
        </div>
      </div>
    </div>
  )
}

/* ============== 注册表单 Modal ============== */

function RegisterPluginModal({
  onClose,
  onRegister,
}: {
  onClose: () => void
  onRegister: (cfg: McpConfig) => Promise<void>
}) {
  const [id, setId] = useState('')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [transport, setTransport] = useState<McpTransport>('stdio')
  const [command, setCommand] = useState('')
  const [argsText, setArgsText] = useState('')
  const [url, setUrl] = useState('')
  const [category, setCategory] = useState<McpCategory>('other')
  const [highRisk, setHighRisk] = useState(false)
  const [permissionScope, setPermissionScope] = useState('workspace')
  const [timeoutSecs, setTimeoutSecs] = useState(30)
  const [submitting, setSubmitting] = useState(false)

  const handleSubmit = async () => {
    if (!id.trim() || !name.trim()) return
    if (transport === 'stdio' && !command.trim()) return
    if (transport === 'sse' && !url.trim()) return
    setSubmitting(true)
    try {
      const cfg: McpConfig = {
        meta: {
          id: id.trim(),
          name: name.trim(),
          description: description.trim(),
          version: '1.0.0',
          transport,
          enabled: true,
          highRisk,
          category,
          capabilities: '',
        },
        permissionScope,
        timeoutSecs,
      }
      if (transport === 'stdio') {
        cfg.command = command.trim()
        cfg.args = argsText
          .split(/\s+/)
          .map((s) => s.trim())
          .filter(Boolean)
      } else {
        cfg.url = url.trim()
      }
      await onRegister(cfg)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm animate-fade-in"
      onClick={onClose}
    >
      <div
        className="w-[560px] max-w-[92vw] max-h-[85vh] rounded-lg border border-white/10 bg-surface-elevated shadow-raised animate-scale-in flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/8">
          <div className="flex items-center gap-2">
            <PlusIcon />
            <span className="text-sm font-semibold text-text-primary">添加 MCP 插件</span>
          </div>
          <button onClick={onClose} className="icon-btn !p-1" title="关闭">
            <CloseIcon />
          </button>
        </div>
        <div className="flex-1 overflow-auto p-4 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="ID（唯一标识）" required>
              <input
                type="text"
                value={id}
                onChange={(e) => setId(e.target.value)}
                placeholder="如：local-lsp"
                className="input-base"
                data-selectable="true"
                spellCheck={false}
              />
            </Field>
            <Field label="名称" required>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="如：本地 LSP"
                className="input-base"
                data-selectable="true"
                spellCheck={false}
              />
            </Field>
          </div>
          <Field label="描述">
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="插件用途简短描述…"
              className="input-base"
              data-selectable="true"
              spellCheck={false}
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="传输协议">
              <select
                value={transport}
                onChange={(e) => setTransport(e.target.value as McpTransport)}
                className="input-base"
              >
                <option value="stdio">stdio</option>
                <option value="sse">sse</option>
              </select>
            </Field>
            <Field label="分类">
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value as McpCategory)}
                className="input-base"
              >
                {CATEGORY_OPTIONS.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          {transport === 'stdio' ? (
            <>
              <Field label="启动命令" required>
                <input
                  type="text"
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                  placeholder="如：npx 或 node"
                  className="input-base font-mono"
                  data-selectable="true"
                  spellCheck={false}
                />
              </Field>
              <Field label="参数（空格分隔）">
                <input
                  type="text"
                  value={argsText}
                  onChange={(e) => setArgsText(e.target.value)}
                  placeholder="如：--port 3000 --verbose"
                  className="input-base font-mono"
                  data-selectable="true"
                  spellCheck={false}
                />
              </Field>
            </>
          ) : (
            <Field label="URL" required>
              <input
                type="text"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://example.com/sse"
                className="input-base font-mono"
                data-selectable="true"
                spellCheck={false}
              />
            </Field>
          )}
          <div className="grid grid-cols-3 gap-3">
            <Field label="权限范围">
              <select
                value={permissionScope}
                onChange={(e) => setPermissionScope(e.target.value)}
                className="input-base"
              >
                <option value="workspace">workspace</option>
                <option value="file">file</option>
                <option value="network">network</option>
                <option value="shell">shell</option>
                <option value="database">database</option>
              </select>
            </Field>
            <Field label="超时（秒）">
              <input
                type="number"
                min={1}
                max={300}
                value={timeoutSecs}
                onChange={(e) => setTimeoutSecs(Number(e.target.value) || 30)}
                className="input-base font-mono"
                data-selectable="true"
                spellCheck={false}
              />
            </Field>
            <Field label="高危">
              <select
                value={highRisk ? '1' : '0'}
                onChange={(e) => setHighRisk(e.target.value === '1')}
                className="input-base"
              >
                <option value="0">否</option>
                <option value="1">是</option>
              </select>
            </Field>
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-white/8">
          <button onClick={onClose} className="btn-secondary !py-1 !px-3 !text-xs">
            取消
          </button>
          <button
            onClick={handleSubmit}
            disabled={
              submitting ||
              !id.trim() ||
              !name.trim() ||
              (transport === 'stdio' ? !command.trim() : !url.trim())
            }
            className="btn-primary !py-1 !px-3 !text-xs"
          >
            {submitting ? '提交中…' : '注册'}
          </button>
        </div>
      </div>
    </div>
  )
}

/* ============== 共用小组件 ============== */

function Field({
  label,
  required,
  children,
}: {
  label: string
  required?: boolean
  children: React.ReactNode
}) {
  return (
    <div>
      <div className="text-2xs text-text-secondary mb-1">
        {label}
        {required && <span className="text-accent"> *</span>}
      </div>
      {children}
    </div>
  )
}

function EmptyHint({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-2 text-center px-4">
      <span className="opacity-40">{icon}</span>
      <div className="text-xs text-text-tertiary leading-relaxed">{text}</div>
    </div>
  )
}

function ToggleSwitch({ enabled, onToggle }: { enabled: boolean; onToggle: () => void }) {
  return (
    <button
      onClick={(e) => {
        e.stopPropagation()
        onToggle()
      }}
      className={`flex-shrink-0 w-8 h-4 rounded-full transition-colors ${enabled ? 'bg-accent' : 'bg-white/12'}`}
      role="switch"
      aria-checked={enabled}
      title={enabled ? '点击禁用' : '点击启用'}
    >
      <div
        className={`w-3 h-3 rounded-full bg-white transition-transform ${enabled ? 'translate-x-4' : 'translate-x-0.5'}`}
      />
    </button>
  )
}

/* ============== 图标 ============== */

function PluginIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" className="text-accent">
      <path d="M6 3v2M10 3v2M4 5h8v3a4 4 0 11-8 0V5zM8 12v2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  )
}

function PluginKindIcon({ category }: { category: McpCategory }) {
  const color =
    category === 'lsp'
      ? 'text-accent'
      : category === 'knowledge'
        ? 'text-emerald-400'
        : category === 'ci'
          ? 'text-orange-400'
          : category === 'database'
            ? 'text-sky-400'
            : category === 'security'
              ? 'text-rose-400'
              : 'text-text-secondary'
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" className={color}>
      <path d="M6 3v2M10 3v2M4 5h8v3a4 4 0 11-8 0V5zM8 12v2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  )
}

function ShieldIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" className="text-text-secondary">
      <path d="M8 1l5 2v5c0 3-2 5-5 6-3-1-5-3-5-6V3l5-2z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
    </svg>
  )
}

function PlusIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
      <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

function TrashIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
      <path d="M3 4h10M6 4V2h4v2M5 4l1 9h4l1-9" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function PlayIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
      <path d="M4 3l9 5-9 5V3z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" fill="currentColor" />
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

function RefreshIcon({ spinning }: { spinning?: boolean }) {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" className={spinning ? 'animate-spin' : ''}>
      <path d="M13 8a5 5 0 11-1.5-3.5M13 2v3h-3" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  )
}
