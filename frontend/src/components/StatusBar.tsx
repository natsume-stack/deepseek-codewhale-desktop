import { useEffect, useState } from 'react'
import { useChatStore } from '../stores/chat'
import { useMcpStore, selectConnectedCount } from '../stores/mcp'
import { configApi, permissionApi } from '../lib/api'
import type { PermissionLevel } from '../types'

const PERMISSION_LABEL: Record<PermissionLevel, string> = {
  readOnly: '只读',
  workspaceWrite: '工作区',
  fullAccess: '完全访问',
}

const PERMISSION_COLOR: Record<PermissionLevel, string> = {
  readOnly: 'text-text-tertiary',
  workspaceWrite: 'text-text-secondary',
  fullAccess: 'text-warn',
}

export function StatusBar() {
  const sessionId = useChatStore((s) => s.sessionId)
  const plugins = useMcpStore((s) => s.plugins)
  const fetchAllMcp = useMcpStore((s) => s.fetchAll)

  const [model, setModel] = useState<string>('deepseek-chat')
  const [permission, setPermission] = useState<PermissionLevel>('workspaceWrite')
  const [hitRate, setHitRate] = useState<number | null>(null)
  const [now, setNow] = useState<Date>(new Date())

  useEffect(() => {
    void configApi.get().then((c) => setModel(c.model)).catch(() => {})
    void permissionApi
      .get()
      .then((p) => setPermission(p.level))
      .catch(() => {})
  }, [])

  useEffect(() => {
    void fetchAllMcp().catch(() => {})
  }, [fetchAllMcp])

  useEffect(() => {
    let cancelled = false
    const pull = () => {
      void configApi
        .getCacheStats()
        .then((s) => {
          if (!cancelled) setHitRate(s.hitRate)
        })
        .catch(() => {})
    }
    pull()
    const timer = window.setInterval(pull, 10_000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [])

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1_000)
    return () => window.clearInterval(timer)
  }, [])

  const connectedPlugins = selectConnectedCount(plugins)
  const totalPlugins = plugins.length
  const hitRateText =
    hitRate === null ? '—' : `${(hitRate * 100).toFixed(1)}%`
  const sessionText = sessionId ? sessionId.slice(0, 8) : '—'
  const timeText = formatTime(now)

  return (
    <div
      className="flex items-center justify-between gap-4 h-9 px-5 rounded-t-2xl bg-black/35 border-t border-white/5 text-xs font-mono text-text-tertiary select-none"
      data-selectable="false"
    >
      <div className="flex items-center gap-3 min-w-0">
        <span className="flex items-center gap-1.5 text-text-secondary truncate">
          <ModelIcon />
          <span className="truncate" title={model}>{model}</span>
        </span>
        <Sep />
        <span className={`flex items-center gap-1.5 ${PERMISSION_COLOR[permission]}`}>
          <ShieldIcon />
          <span>{PERMISSION_LABEL[permission]}</span>
        </span>
      </div>

      <div className="flex items-center gap-3 flex-1 justify-center min-w-0">
        <span className="flex items-center gap-1.5">
          <CacheIcon />
          <span>缓存命中</span>
          <span className={hitRate !== null && hitRate >= 0.5 ? 'text-emerald-400' : 'text-text-secondary'}>
            {hitRateText}
          </span>
        </span>
        <Sep />
        <span className="flex items-center gap-1.5">
          <PluginIcon />
          <span>
            插件
            <span className={connectedPlugins > 0 ? 'text-emerald-400' : 'text-text-secondary'}>
              {' '}{connectedPlugins}/{totalPlugins}
            </span>
          </span>
        </span>
      </div>

      <div className="flex items-center gap-3 flex-shrink-0">
        <span className="flex items-center gap-1.5">
          <SessionIcon />
          <span title={sessionId ?? ''}>{sessionText}</span>
        </span>
        <Sep />
        <span className="text-text-secondary tabular-nums">{timeText}</span>
      </div>
    </div>
  )
}

function formatTime(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function Sep() {
  return <span className="text-white/10">·</span>
}

function ModelIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" className="text-text-tertiary">
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.1" fill="none" />
      <path d="M2 8h12M8 2c2 2 2 10 0 12M8 2c-2 2-2 10 0 12" stroke="currentColor" strokeWidth="1.1" fill="none" />
    </svg>
  )
}

function ShieldIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
      <path d="M8 1l5 2v5c0 3-2 5-5 6-3-1-5-3-5-6V3l5-2z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" fill="none" />
    </svg>
  )
}

function CacheIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" className="text-text-tertiary">
      <path d="M2 4l6-2 6 2-6 2-6-2z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" fill="none" />
      <path d="M2 8l6 2 6-2M2 12l6 2 6-2" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" fill="none" />
    </svg>
  )
}

function PluginIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" className="text-text-tertiary">
      <path d="M6 3v2M10 3v2M4 5h8v3a4 4 0 11-8 0V5zM8 12v2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  )
}

function SessionIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" className="text-text-tertiary">
      <rect x="2.5" y="3" width="11" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.1" fill="none" />
      <path d="M5 6h6M5 8.5h6M5 11h3" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
    </svg>
  )
}
