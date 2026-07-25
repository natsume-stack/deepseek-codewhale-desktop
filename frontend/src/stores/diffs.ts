/**
 * Diff 注册表状态管理
 *
 *  - 从后端拉取 Diff 列表（按 sessionId）
 *  - 注册新 Diff（代码块"应用修改"触发）
 *  - 单个 apply / reject / revert
 *  - 批量 apply-all
 *  - 当 chat store 拥有 sessionId 时自动拉取列表
 */
import { create } from 'zustand'
import { diffsApi } from '../lib/api'
import type { DiffEntry } from '../types'

interface DiffState {
  /** 当前会话的 Diff 列表 */
  diffs: DiffEntry[]
  /** 当前关联的 sessionId */
  sessionId: string | null
  loading: boolean
  error: string | null

  /** 设置关联会话并拉取 */
  bindSession: (sessionId: string | null) => Promise<void>
  /** 刷新列表 */
  refresh: () => Promise<void>
  /** 注册新 Diff（用于代码块"应用修改"） */
  register: (params: {
    filePath: string
    originalContent?: string
    modifiedContent: string
    sessionId?: string
  }) => Promise<string | null>
  /** 应用单个 */
  apply: (id: string) => Promise<boolean>
  /** 拒绝单个 */
  reject: (id: string) => Promise<boolean>
  /** 撤销单个（已应用的回滚） */
  revert: (id: string) => Promise<boolean>
  /** 批量应用当前会话全部 pending */
  applyAll: () => Promise<boolean>
}

export const useDiffStore = create<DiffState>((set, get) => ({
  diffs: [],
  sessionId: null,
  loading: false,
  error: null,

  bindSession: async (sessionId) => {
    set({ sessionId })
    if (!sessionId) {
      set({ diffs: [] })
      return
    }
    await get().refresh()
  },

  refresh: async () => {
    const { sessionId } = get()
    if (!sessionId) return
    set({ loading: true, error: null })
    try {
      const r = await diffsApi.list(sessionId)
      set({ diffs: r.diffs, loading: false })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      set({ loading: false, error: msg })
    }
  },

  register: async (params) => {
    try {
      const sid = params.sessionId ?? get().sessionId ?? undefined
      const entry = await diffsApi.register({ ...params, sessionId: sid })
      await get().refresh()
      return entry.id
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      set({ error: msg })
      return null
    }
  },

  apply: async (id) => {
    try {
      await diffsApi.apply(id)
      await get().refresh()
      return true
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      set({ error: msg })
      return false
    }
  },

  reject: async (id) => {
    try {
      await diffsApi.reject(id)
      await get().refresh()
      return true
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      set({ error: msg })
      return false
    }
  },

  revert: async (id) => {
    try {
      await diffsApi.revert(id)
      await get().refresh()
      return true
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      set({ error: msg })
      return false
    }
  },

  applyAll: async () => {
    const sid = get().sessionId
    try {
      await diffsApi.applyAll(sid ?? undefined)
      await get().refresh()
      return true
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      set({ error: msg })
      return false
    }
  },
}))

/** 派生选择器：pending / applied / rejected / reverted 分组 */
export function selectByStatus(diffs: DiffEntry[]) {
  return {
    pending: diffs.filter((d) => d.status === 'pending'),
    applied: diffs.filter((d) => d.status === 'applied'),
    rejected: diffs.filter((d) => d.status === 'rejected'),
    reverted: diffs.filter((d) => d.status === 'reverted'),
  }
}
