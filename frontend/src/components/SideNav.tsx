/**
 * 左侧会话列表（Codex Desktop 风格 240px 宽边栏）
 *
 * 设计规范（对标 Codex / 苹果风）：
 *   - 顶部：纯文字 "codewhale"（无 icon 无下拉，小写粗黑体）
 *   - 操作区：icon + 文字 极简行（新建对话 / 代办 / 技能·插件），无按钮感
 *   - 搜索框：长椭圆 pill，半透明填充
 *   - 会话项：大圆角（rounded-xl），hover 圆润浮起，选中态蓝色高亮
 *   - 底部：设置 + 用户入口
 *
 * 视觉：透明背景，右侧极细分隔线，Mica 穿透
 *
 * 注：原 SideNav 通过 view 切换路由，但 NavView 仅含 'chat' | 'settings'，
 * 新增「技能/插件」入口因受文件写权限约束无法扩展 App.tsx 的 NavView 类型，
 * 故采用本地模态浮层（modal）形式承载 SkillListPanel / MCPManagerPanel。
 */
import { useState, useEffect } from 'react'
import type { NavView } from '../App'
import { SETTINGS_SECTIONS, type SettingsSection } from './SettingsPage'
import { SkillListPanel } from './SkillListPanel'
import { MCPManagerPanel } from './MCPManagerPanel'
import { sessionsApi } from '../lib/api'
import type { Session } from '../types'

interface SideNavProps {
  view: NavView
  onViewChange: (v: NavView) => void
  onNewSession: () => void
  onSessionSelect: (id: string) => void
  settingsSection: SettingsSection
  onSettingsSectionChange: (section: SettingsSection) => void
}

/** 技能/插件浮层内的子视图 */
type SkillsPluginsTab = 'skills' | 'plugins'

export function SideNav({ view, onViewChange, onNewSession, onSessionSelect, settingsSection, onSettingsSectionChange }: SideNavProps) {
  const [sessions, setSessions] = useState<Session[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [activeSession, setActiveSession] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  /** 技能/插件浮层是否打开 */
  const [spOpen, setSpOpen] = useState(false)
  /** 浮层内当前子 Tab */
  const [spTab, setSpTab] = useState<SkillsPluginsTab>('skills')

  // 真实拉取会话列表
  useEffect(() => {
    let mounted = true
    setLoading(true)
    sessionsApi.list()
      .then((res) => {
        if (!mounted) return
        setSessions(res.sessions)
        setError(null)
        // 默认选中第一个（仅当当前未选中时）
        setActiveSession((prev) => prev ?? (res.sessions[0]?.id ?? null))
      })
      .catch((e) => {
        if (!mounted) return
        setError(e instanceof Error ? e.message : '加载会话失败')
        setSessions([])
      })
      .finally(() => {
        if (mounted) setLoading(false)
      })
    return () => { mounted = false }
  }, [])

  // 重试加载
  const retry = () => {
    setLoading(true)
    setError(null)
    sessionsApi.list()
      .then((res) => {
        setSessions(res.sessions)
        setActiveSession((prev) => prev ?? (res.sessions[0]?.id ?? null))
      })
      .catch((e) => {
        setError(e instanceof Error ? e.message : '加载会话失败')
        setSessions([])
      })
      .finally(() => setLoading(false))
  }

  // 基于真实数据过滤（title / preview / id 任一匹配）
  const filtered = sessions.filter((s) => {
    if (!query) return true
    const text = `${deriveTitle(s)} ${derivePreview(s)} ${s.id}`.toLowerCase()
    return text.includes(query.toLowerCase())
  })

  if (view === 'settings') {
    return (
      <nav className="flex flex-col w-60 flex-shrink-0 select-none">
        <div className="px-4 pt-4 pb-3">
          <button
            onClick={() => onViewChange('chat')}
            className="text-sm text-text-primary lowercase hover:text-white transition-colors"
          >
            codewhale
          </button>
        </div>
        <div className="px-4 pb-2 text-2xs uppercase tracking-wider text-text-tertiary">设置</div>
        <nav className="flex-1 overflow-auto px-2 pb-3 space-y-1">
          {SETTINGS_SECTIONS.map((item) => (
            <button
              key={item.key}
              onClick={() => onSettingsSectionChange(item.key)}
              className={`w-full text-left px-3 py-2.5 rounded-2xl transition-colors ${
                settingsSection === item.key
                  ? 'bg-white/10 text-text-primary'
                  : 'text-text-secondary hover:bg-white/8 hover:text-text-primary'
              }`}
            >
              <div className="text-xs">{item.label}</div>
              <div className="mt-0.5 text-2xs text-text-tertiary truncate">{item.desc}</div>
            </button>
          ))}
        </nav>
        <div className="px-3 py-2 border-t border-white/5">
          <NavAction icon={<BackToChatIcon />} label="返回对话" onClick={() => onViewChange('chat')} />
        </div>
      </nav>
    )
  }

  return (
    <nav className="flex flex-col w-60 flex-shrink-0 select-none">
      {/* === 顶部：纯文字品牌名（无 icon 无下拉） === */}
      <div className="px-4 pt-4 pb-3">
        <span className="text-sm font-semibold text-text-primary lowercase">
          codewhale
        </span>
      </div>

      {/* === 操作区：icon + 文字 极简行 === */}
      <div className="px-3 pb-2 space-y-0.5">
        <NavAction
          icon={<PlusIcon />}
          label="新建对话"
          active={view === 'chat'}
          onClick={() => {
            onViewChange('chat')
            onNewSession()
          }}
        />
        <NavAction
          icon={<TodoIcon />}
          label="代办"
          onClick={() => onViewChange('chat')}
        />
        <NavAction
          icon={<PluginIcon />}
          label="技能/插件"
          active={spOpen}
          onClick={() => setSpOpen(true)}
        />
      </div>

      {/* === 搜索框（长椭圆 pill） === */}
      <div className="px-3 pb-3 pt-1">
        <div className="relative">
          <SearchIcon />
          <input
            type="text"
            placeholder="搜索"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full pl-8 pr-3 py-2 rounded-full bg-white/6 text-xs text-text-primary placeholder-text-tertiary border border-white/5 focus:outline-none focus:border-white/20 focus:bg-white/8 focus:ring-2 focus:ring-white/10 transition-all duration-200 ease-out"
            data-selectable="true"
            spellCheck={false}
          />
        </div>
      </div>

      {/* === 最近会话列表（大圆角圆润项） === */}
      <div className="flex-1 overflow-auto px-2 pb-2">
        <div className="px-2 py-1.5 text-2xs uppercase tracking-wider text-text-tertiary font-semibold">
          最近
        </div>
        {/* 加载态：骨架屏 */}
        {loading && (
          <div className="space-y-1">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="px-3 py-2 rounded-[10px] mb-1 animate-pulse-soft">
                <div className="flex items-center justify-between gap-2">
                  <div className="h-3 w-2/3 rounded bg-white/6" />
                  <div className="h-1.5 w-1.5 rounded-full bg-white/6" />
                </div>
              </div>
            ))}
          </div>
        )}
        {/* 错误态：提示 + 重试 */}
        {!loading && error && (
          <div className="px-3 py-4 space-y-2">
            <div className="text-2xs text-rose-400 text-center">{error}</div>
            <button
              onClick={retry}
              className="w-full px-3 py-1.5 rounded-lg text-2xs text-text-secondary hover:bg-white/6 hover:text-text-primary transition-all duration-200 ease-out"
            >
              重试
            </button>
          </div>
        )}
        {/* 空态 */}
        {!loading && !error && filtered.length === 0 && (
          <div className="px-2 py-4 text-2xs text-text-tertiary text-center">
            {sessions.length === 0 ? '暂无会话，点击新建对话开始' : '未找到匹配会话'}
          </div>
        )}
        {/* 列表态 */}
        {!loading && !error && filtered.length > 0 && (
          filtered.map((s, index) => {
            const isActive = activeSession === s.id && view === 'chat'
            const status = s.running ? 'running' : 'done'
            return (
              <button
                key={s.id}
                onClick={() => {
                  setActiveSession(s.id)
                  onViewChange('chat')
                  onSessionSelect(s.id)
                }}
                className={`w-full flex items-center gap-2 text-left px-3 py-2 rounded-[10px] mb-1 transition-colors group animate-slide-up-spring
                  ${isActive
                    ? 'bg-white/10 text-text-primary'
                    : 'text-text-secondary hover:bg-white/8 hover:text-text-primary'
                  }`}
                style={{ animationDelay: `${index * 30}ms`, animationFillMode: 'both' }}
              >
                <span className="min-w-0 flex-1 text-xs truncate">{deriveTitle(s)}</span>
                  <StatusDot status={status} active={isActive} />
              </button>
            )
          })
        )}
      </div>

      {/* === 底部：设置 + 用户 === */}
      <div className="px-3 py-2 border-t border-white/5 space-y-0.5">
        <NavAction
          icon={<SettingsIcon />}
          label="设置"
          onClick={() => onViewChange('settings')}
        />
      </div>

      {/* === 技能/插件浮层（统一 Tab 切换） === */}
      {spOpen && (
        <SkillsPluginsModal
          tab={spTab}
          onTabChange={setSpTab}
          onClose={() => setSpOpen(false)}
        />
      )}
    </nav>
  )
}

/* ============== 技能/插件统一浮层 ============== */

interface SkillsPluginsModalProps {
  tab: SkillsPluginsTab
  onTabChange: (t: SkillsPluginsTab) => void
  onClose: () => void
}

/**
 * 统一浮层：顶部 Tab 切换「技能 / 插件」，内嵌 SkillListPanel / MCPManagerPanel
 * 非浮层模式（由本组件提供外层 modal 容器）。
 */
function SkillsPluginsModal({ tab, onTabChange, onClose }: SkillsPluginsModalProps) {
  const tabs: { key: SkillsPluginsTab; label: string }[] = [
    { key: 'skills', label: '技能' },
    { key: 'plugins', label: '插件' },
  ]
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm animate-fade-in"
      onClick={onClose}
    >
      <div
        className="w-[720px] max-w-[94vw] h-[82vh] rounded-3xl border border-surface-border bg-surface-elevated shadow-raised animate-scale-in flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* === 顶部 Tab 切换栏 === */}
        <div className="flex items-center justify-between px-4 pt-4 border-b border-white/8 gap-3">
          <div className="flex items-center gap-1">
            {tabs.map((t) => (
              <button
                key={t.key}
                onClick={() => onTabChange(t.key)}
                className={`flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-xl transition-all duration-200 ease-bounce
                  ${tab === t.key
                    ? 'text-text-primary bg-white/10'
                    : 'text-text-tertiary hover:text-text-secondary hover:bg-white/8'
                  }`}
              >
                {t.label}
              </button>
            ))}
          </div>
          <button onClick={onClose} className="icon-btn" title="关闭">
            <CloseIcon />
          </button>
        </div>
        {/* === Tab 内容（非浮层模式，占满剩余空间） === */}
        <div className="flex-1 min-h-0 overflow-hidden">
          <div key={tab} className="h-full animate-fade-in">
            {tab === 'skills' ? <SkillListPanel /> : <MCPManagerPanel />}
          </div>
        </div>
      </div>
    </div>
  )
}

/* ============== Session 显示派生（无 title 字段，从消息/时间派生） ============== */

/** 会话标题：取首条用户消息（截断），无消息时回退到 id 前 8 位 */
function deriveTitle(s: Session): string {
  const firstUser = s.messages.find((m) => m.role === 'user')
  if (firstUser && firstUser.content.trim()) {
    const line = firstUser.content.trim().split('\n')[0]
    return line.length > 30 ? line.slice(0, 30) + '…' : line
  }
  return `会话 ${s.id.slice(0, 8)}`
}

/** 会话预览：取最后一条消息（截断） */
function derivePreview(s: Session): string {
  if (s.messages.length === 0) return ''
  const last = s.messages[s.messages.length - 1]
  const line = last.content.trim().split('\n')[0]
  if (!line) return ''
  return line.length > 40 ? line.slice(0, 40) + '…' : line
}

/* ============== 子组件 ============== */

/** 极简导航行：icon + 文字，无按钮感（透明，hover 圆润浮起） */
function NavAction({
  icon,
  label,
  active = false,
  onClick,
}: {
  icon: React.ReactNode
  label: string
  active?: boolean
  onClick?: () => void
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-3 px-3 py-2 rounded-[10px] text-xs font-medium transition-colors
        ${active
          ? 'bg-white/10 text-text-primary'
          : 'text-text-secondary hover:bg-white/8 hover:text-text-primary'
        }`}
    >
      <span className="flex-shrink-0 opacity-80">{icon}</span>
      <span>{label}</span>
    </button>
  )
}

/** 会话状态指示点 */
function StatusDot({ status, active }: { status?: 'idle' | 'running' | 'done'; active: boolean }) {
  if (!status || status === 'idle') return null
  const color =
    status === 'running'
      ? 'bg-warn'
      : 'bg-text-tertiary'
  return (
    <span
      className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${color} ${status === 'running' ? 'animate-pulse-soft' : ''} ${!active && status === 'done' ? 'opacity-50' : ''}`}
    />
  )
}

/* ============== 图标 ============== */

function SearchIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-tertiary pointer-events-none">
      <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.2" fill="none" />
      <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  )
}

function PlusIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
      <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

function TodoIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
      <rect x="2.5" y="3" width="2.5" height="2.5" rx="0.5" stroke="currentColor" strokeWidth="1.3" />
      <path d="M7 4.25h7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <rect x="2.5" y="7.5" width="2.5" height="2.5" rx="0.5" stroke="currentColor" strokeWidth="1.3" />
      <path d="M7 8.75h7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <rect x="2.5" y="12" width="2.5" height="2.5" rx="0.5" stroke="currentColor" strokeWidth="1.3" />
      <path d="M7 13.25h7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}

function PluginIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
      <path d="M6 3v2M10 3v2M4 5h8v3a4 4 0 11-8 0V5zM8 12v2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  )
}

function SettingsIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.4 1.4M11.6 11.6L13 13M3 13l1.4-1.4M11.6 4.4L13 3"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  )
}

function BackToChatIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
      <path d="M10 3L5 8l5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
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
