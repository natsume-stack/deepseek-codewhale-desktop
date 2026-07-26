/**
 * 代办任务状态管理（P0-7）
 *
 * 负责:
 *  - 维护 TodoItem 列表
 *  - 拉取全部 / 按会话拉取
 *  - 创建 / 更新状态 / 删除
 *  - 提供 refresh() 由组件 useEffect 触发刷新
 *  - upsertMany 用于 SSE 'todos' 事件批量注入
 *
 * 不实现自动轮询；如需轮询由组件层 useEffect 控制。
 */
import { create } from 'zustand'
import { todosApi } from '../lib/api'
import type { TodoItem, TodoStatus } from '../types'

interface TodosState {
  todos: TodoItem[]
  loading: boolean
  error: string | null
  /** 当前绑定的会话 id（若调用过 fetchBySession） */
  sessionId: string | null

  /** 拉取全部代办 */
  fetchAll: () => Promise<void>
  /** 按会话拉取代办 */
  fetchBySession: (sessionId: string) => Promise<void>
  /** 创建代办 */
  create: (text: string, sessionId?: string, source?: string) => Promise<TodoItem | null>
  /** 更新代办状态 */
  updateStatus: (id: string, status: TodoStatus) => Promise<boolean>
  /** 删除代办 */
  remove: (id: string) => Promise<boolean>
  /** 重新拉取（按上次 sessionId 决定走 list 还是 listBySession） */
  refresh: () => Promise<void>
  /** 批量 upsert（SSE 'todos' 事件触发），按 id 合并并去重 */
  upsertMany: (items: TodoItem[]) => void
  /** 清空状态 */
  reset: () => void
}

export const useTodosStore = create<TodosState>((set, get) => ({
  todos: [],
  loading: false,
  error: null,
  sessionId: null,

  fetchAll: async () => {
    // P0 修复跨会话污染：切换数据源时立即清空，避免旧会话数据闪烁
    set({ loading: true, error: null, sessionId: null, todos: [] })
    try {
      const r = await todosApi.list()
      set({ todos: r.todos, loading: false })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      set({ loading: false, error: msg })
    }
  },

  fetchBySession: async (sessionId) => {
    // P0 修复跨会话污染：切换会话时立即清空，避免旧会话数据闪烁
    set({ loading: true, error: null, sessionId, todos: [] })
    try {
      const r = await todosApi.listBySession(sessionId)
      set({ todos: r.todos, loading: false })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      set({ loading: false, error: msg })
    }
  },

  create: async (text, sessionId, source) => {
    try {
      const item = await todosApi.create({ text, sessionId, source })
      set((s) => ({ todos: [item, ...s.todos] }))
      return item
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      set({ error: msg })
      return null
    }
  },

  updateStatus: async (id, status) => {
    try {
      const item = await todosApi.updateStatus(id, status)
      set((s) => ({ todos: s.todos.map((t) => (t.id === id ? item : t)) }))
      return true
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      set({ error: msg })
      return false
    }
  },

  remove: async (id) => {
    try {
      await todosApi.delete(id)
      set((s) => ({ todos: s.todos.filter((t) => t.id !== id) }))
      return true
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      set({ error: msg })
      return false
    }
  },

  refresh: async () => {
    const { sessionId } = get()
    if (sessionId) {
      await get().fetchBySession(sessionId)
    } else {
      await get().fetchAll()
    }
  },

  upsertMany: (items) => {
    if (!items || items.length === 0) return
    set((s) => {
      const map = new Map<string, TodoItem>()
      for (const t of s.todos) map.set(t.id, t)
      for (const t of items) map.set(t.id, t)
      // 按 createdAt 倒序（新建靠前）
      const merged = Array.from(map.values()).sort((a, b) => {
        const ta = new Date(a.createdAt).getTime() || 0
        const tb = new Date(b.createdAt).getTime() || 0
        return tb - ta
      })
      return { todos: merged }
    })
  },

  reset: () => set({ todos: [], loading: false, error: null, sessionId: null }),
}))
