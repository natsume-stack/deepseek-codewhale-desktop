/**
 * 左侧会话列表（Codex Desktop 风格 240px 宽边栏）
 *
 * 设计规范（对标 Codex / 苹果风）：
 *   - 顶部：纯文字 "codewhale"（无 icon 无下拉，小写粗黑体）
 *   - 操作区：icon + 文字 极简行（新建对话 / 插件 /代办），无按钮感
 *   - 搜索框：长椭圆 pill，半透明填充
 *   - 会话项：大圆角（rounded-xl），hover 圆润浮起，选中态蓝色高亮
 *   - 底部：设置 + 用户入口
 *
 * 视觉：透明背景，右侧极细分隔线，Mica 穿透
 */
import { useState } from 'react'
import type { NavView } from '../App'

interface SideNavProps {
  view: NavView
  onViewChange: (v: NavView) => void
}

/** 模拟最近会话（实际应来自后端 sessions API） */
interface SessionItem {
  id: string
  title: string
  preview: string
  ts: string
  /** 状态：idle / running / done */
  status?: 'idle' | 'running' | 'done'
}

const MOCK_SESSIONS: SessionItem[] = [
  { id: 's1', title: '实现 sha256 工具函数', preview: '在 src/utils.rs 添加…', ts: '刚刚', status: 'running' },
  { id: 's2', title: '修复 unwrap panic', preview: '分析堆栈后定位到…', ts: '2 小时前', status: 'done' },
  { id: 's3', title: '重构 chat_handler', preview: '拆分为 parse/dispatch…', ts: '昨天', status: 'done' },
  { id: 's4', title: '解释 Myers 算法', preview: 'src/diff.rs 中实现…', ts: '3 天前', status: 'idle' },
]

export function SideNav({ view, onViewChange }: SideNavProps) {
  const [activeSession, setActiveSession] = useState<string>('s1')
  const [query, setQuery] = useState('')

  const filtered = MOCK_SESSIONS.filter(
    (s) => !query || s.title.includes(query) || s.preview.includes(query),
  )

  return (
    <nav className="flex flex-col w-60 flex-shrink-0 border-r border-white/5 select-none">
      {/* === 顶部：纯文字品牌名（无 icon 无下拉） === */}
      <div className="px-4 pt-4 pb-3">
        <span className="text-sm font-bold text-text-primary tracking-tight lowercase">
          codewhale
        </span>
      </div>

      {/* === 操作区：icon + 文字 极简行 === */}
      <div className="px-3 pb-2 space-y-0.5">
        <NavAction
          icon={<PlusIcon />}
          label="新建对话"
          active={view === 'chat'}
          onClick={() => onViewChange('chat')}
        />
        <NavAction
          icon={<TodoIcon />}
          label="代办"
          onClick={() => onViewChange('chat')}
        />
        <NavAction
          icon={<PluginIcon />}
          label="插件"
          onClick={() => onViewChange('chat')}
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
            className="w-full pl-7 pr-3 py-1.5 rounded-full bg-white/6 text-2xs text-text-primary placeholder-text-tertiary border border-white/5 focus:outline-none focus:border-accent/40 focus:bg-white/8 transition-all duration-200 ease-out"
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
        {filtered.length === 0 ? (
          <div className="px-2 py-4 text-2xs text-text-tertiary text-center">
            未找到匹配会话
          </div>
        ) : (
          filtered.map((s) => {
            const isActive = activeSession === s.id && view === 'chat'
            return (
              <button
                key={s.id}
                onClick={() => {
                  setActiveSession(s.id)
                  onViewChange('chat')
                }}
                className={`w-full text-left px-3 py-2.5 rounded-xl mb-1 transition-all duration-200 ease-out group
                  ${isActive
                    ? 'bg-white/8 text-text-primary'
                    : 'text-text-secondary hover:bg-white/4 hover:text-text-primary'
                  }`}
              >
                <div className="flex items-center justify-between gap-2 mb-0.5">
                  <span className="text-xs font-semibold truncate">{s.title}</span>
                  <StatusDot status={s.status} active={isActive} />
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-2xs text-text-tertiary truncate">{s.preview}</span>
                  <span className="text-2xs text-text-tertiary flex-shrink-0">{s.ts}</span>
                </div>
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
          active={view === 'settings'}
          onClick={() => onViewChange('settings')}
        />
      </div>
    </nav>
  )
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
      className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-medium transition-all duration-200 ease-out
        ${active
          ? 'bg-accent/12 text-accent'
          : 'text-text-secondary hover:bg-white/6 hover:text-text-primary'
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
      ? 'bg-accent'
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
