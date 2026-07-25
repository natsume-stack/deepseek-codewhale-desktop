/**
 * 多会话标签状态管理（zustand）
 *
 * 参考 deepseek-tui-desktop 的多对话并行标签设计：
 *   - 维护多个会话标签（SessionTab[]），每个标签对应一个独立会话
 *   - 当前激活标签由 activeId 指向；同一时刻仅一个 active
 *   - 标签可置顶（pinned）、重命名、关闭
 *   - 状态持久化到 localStorage（key: codewhale-session-tabs），启动时恢复
 *   - 关闭 active 标签时自动切到相邻标签（优先右侧，其次左侧）
 *
 * 与 chat store 的协作：
 *   - chat store 拥有 sessionId（后端会话 id），与 SessionTab.id 一一对应
 *   - 当 chat store 的 sessionId 变化时，由 App.tsx 同步 sessions store 的 activeId
 *   - 当用户在 SessionTabs 切换标签时，调用 chat store.switchSession(id)
 */
import { create } from 'zustand'

/** 单个会话标签 */
export interface SessionTab {
  /** 标签唯一 id，与后端 session id 对应 */
  id: string
  /** 标签标题（默认为"新会话"，首条用户消息发送后更新为前 30 字符） */
  title: string
  /** 是否激活（同一时刻仅一个为 true；由 activeId 派生） */
  active: boolean
  /** 是否置顶（置顶的标签排在最前） */
  pinned: boolean
  /** 创建时间戳（ms） */
  createdAt: number
}

interface SessionsState {
  tabs: SessionTab[]
  /** 当前激活标签 id；null 表示无激活 */
  activeId: string | null

  /** 创建新会话标签，返回新 id */
  openNew: () => string
  /** 切换到指定标签 */
  switchTo: (id: string) => void
  /** 关闭指定标签（若关闭的是 active，自动切到相邻标签） */
  close: (id: string) => void
  /** 切换指定标签的置顶状态 */
  pin: (id: string) => void
  /** 重命名指定标签 */
  rename: (id: string, title: string) => void
  /** 自动从首条消息更新标签标题（截取前 30 字符） */
  updateTitle: (id: string, title: string) => void
  /** 设置当前 activeId（由 App.tsx 同步 chat store sessionId 时调用） */
  setActiveId: (id: string | null) => void
  /** 拖拽排序：将 fromId 移动到 toId 之前的位置 */
  moveTab: (fromId: string, toId: string) => void
}

const STORAGE_KEY = 'codewhale-session-tabs'

/** 标签 id 自增序列（避免与时间戳冲突） */
let tabIdSeq = 0
function genTabId(): string {
  tabIdSeq += 1
  return `tab_${Date.now().toString(36)}_${tabIdSeq}`
}

/** 默认新标签标题 */
const DEFAULT_TITLE = '新会话'

/** 截取标题前 N 字符（参考 deepseek-tui-desktop） */
function sliceTitle(text: string, max = 30): string {
  const trimmed = text.trim().replace(/\s+/g, ' ')
  if (trimmed.length <= max) return trimmed
  return trimmed.slice(0, max) + '…'
}

/** 排序：置顶在前，其次按 createdAt 升序（先创建的靠前） */
function sortTabs(tabs: SessionTab[]): SessionTab[] {
  return [...tabs].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
    return a.createdAt - b.createdAt
  })
}

/** 从 localStorage 加载持久化状态 */
function loadPersisted(): { tabs: SessionTab[]; activeId: string | null } {
  if (typeof window === 'undefined') return { tabs: [], activeId: null }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return { tabs: [], activeId: null }
    const data = JSON.parse(raw) as { tabs?: SessionTab[]; activeId?: string | null }
    if (!Array.isArray(data.tabs)) return { tabs: [], activeId: null }
    // 兼容性清洗：过滤掉字段缺失的项，重置 active 派生态
    const valid = data.tabs
      .filter((t) => t && typeof t.id === 'string')
      .map((t) => ({
        id: t.id,
        title: typeof t.title === 'string' ? t.title : DEFAULT_TITLE,
        active: false, // active 由 activeId 派生，不持久化
        pinned: !!t.pinned,
        createdAt: typeof t.createdAt === 'number' ? t.createdAt : Date.now(),
      }))
    const activeId = valid.some((t) => t.id === data.activeId) ? (data.activeId as string) : null
    return { tabs: sortTabs(valid), activeId }
  } catch {
    return { tabs: [], activeId: null }
  }
}

/** 持久化到 localStorage */
function persist(tabs: SessionTab[], activeId: string | null): void {
  if (typeof window === 'undefined') return
  try {
    // 仅持久化必要字段，active 由 activeId 派生
    const slim = tabs.map((t) => ({
      id: t.id,
      title: t.title,
      pinned: t.pinned,
      createdAt: t.createdAt,
    }))
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ tabs: slim, activeId }))
  } catch {
    /* localStorage 不可用时静默忽略 */
  }
}

/** 从 activeId 派生 tabs 中各项的 active 标志 */
function deriveActive(tabs: SessionTab[], activeId: string | null): SessionTab[] {
  return tabs.map((t) => ({ ...t, active: t.id === activeId }))
}

// 启动时加载持久化状态
const initial = loadPersisted()

export const useSessionsStore = create<SessionsState>((set, get) => ({
  tabs: deriveActive(initial.tabs, initial.activeId),
  activeId: initial.activeId,

  openNew: () => {
    const id = genTabId()
    const newTab: SessionTab = {
      id,
      title: DEFAULT_TITLE,
      active: true,
      pinned: false,
      createdAt: Date.now(),
    }
    set((s) => {
      // 新标签插入到非置顶组的最前；置顶标签保持在前
      const pinned = s.tabs.filter((t) => t.pinned)
      const others = s.tabs.filter((t) => !t.pinned)
      const nextTabs = deriveActive([...pinned, newTab, ...others], id)
      persist(nextTabs, id)
      return { tabs: nextTabs, activeId: id }
    })
    return id
  },

  switchTo: (id) => {
    const { tabs } = get()
    if (!tabs.some((t) => t.id === id)) return
    const nextTabs = deriveActive(tabs, id)
    persist(nextTabs, id)
    set({ tabs: nextTabs, activeId: id })
  },

  close: (id) => {
    const { tabs, activeId } = get()
    const idx = tabs.findIndex((t) => t.id === id)
    if (idx === -1) return
    const nextTabs = tabs.filter((t) => t.id !== id)

    // 若关闭的是 active，自动切到相邻标签（优先右侧，其次左侧）
    let nextActiveId = activeId
    if (activeId === id) {
      if (nextTabs.length === 0) {
        nextActiveId = null
      } else {
        const neighborIdx = Math.min(idx, nextTabs.length - 1)
        nextActiveId = nextTabs[neighborIdx].id
      }
    }

    const derived = deriveActive(nextTabs, nextActiveId)
    persist(derived, nextActiveId)
    set({ tabs: derived, activeId: nextActiveId })
  },

  pin: (id) => {
    const { tabs, activeId } = get()
    const nextTabs = sortTabs(
      tabs.map((t) => (t.id === id ? { ...t, pinned: !t.pinned } : t)),
    )
    const derived = deriveActive(nextTabs, activeId)
    persist(derived, activeId)
    set({ tabs: derived })
  },

  rename: (id, title) => {
    const { tabs, activeId } = get()
    const nextTabs = tabs.map((t) =>
      t.id === id ? { ...t, title: title.trim() || DEFAULT_TITLE } : t,
    )
    const derived = deriveActive(nextTabs, activeId)
    persist(derived, activeId)
    set({ tabs: derived })
  },

  updateTitle: (id, title) => {
    const { tabs, activeId } = get()
    // 仅当标题非默认值或新标题非空时更新，避免无谓重渲染
    const cur = tabs.find((t) => t.id === id)
    if (!cur) return
    const newTitle = sliceTitle(title)
    if (cur.title === newTitle) return
    const nextTabs = tabs.map((t) => (t.id === id ? { ...t, title: newTitle } : t))
    const derived = deriveActive(nextTabs, activeId)
    persist(derived, activeId)
    set({ tabs: derived })
  },

  setActiveId: (id) => {
    const { tabs, activeId } = get()
    // 若 id 不在 tabs 中，但 id 非 null
    if (id && !tabs.some((t) => t.id === id)) {
      // 若当前 active tab 是占位符（openNew 创建的 tab_xxx），重绑定到真实 session id
      // 避免"新建标签后首条消息触发后端新建会话"产生重复标签
      const activeTab = activeId ? tabs.find((t) => t.id === activeId) : null
      if (activeTab && activeTab.id.startsWith('tab_')) {
        const rebound = tabs.map((t) =>
          t.id === activeTab.id ? { ...t, id } : t,
        )
        const derived = deriveActive(rebound, id)
        persist(derived, id)
        set({ tabs: derived, activeId: id })
        return
      }
      // 否则追加新标签
      const newTab: SessionTab = {
        id,
        title: DEFAULT_TITLE,
        active: true,
        pinned: false,
        createdAt: Date.now(),
      }
      const pinned = tabs.filter((t) => t.pinned)
      const others = tabs.filter((t) => !t.pinned)
      const nextTabs = deriveActive([...pinned, newTab, ...others], id)
      persist(nextTabs, id)
      set({ tabs: nextTabs, activeId: id })
      return
    }
    const nextTabs = deriveActive(tabs, id)
    persist(nextTabs, id)
    set({ tabs: nextTabs, activeId: id })
  },

  moveTab: (fromId, toId) => {
    if (fromId === toId) return
    const { tabs, activeId } = get()
    const fromIdx = tabs.findIndex((t) => t.id === fromId)
    const toIdx = tabs.findIndex((t) => t.id === toId)
    if (fromIdx === -1 || toIdx === -1) return
    // 移动元素（保持置顶分组语义：若跨置顶组移动，仍按位置插入）
    const next = [...tabs]
    const [moved] = next.splice(fromIdx, 1)
    next.splice(toIdx, 0, moved)
    const derived = deriveActive(next, activeId)
    persist(derived, activeId)
    set({ tabs: derived })
  },
}))
