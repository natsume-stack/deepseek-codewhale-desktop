/**
 * Agent 操作审批状态管理（P0-8）
 *
 * 负责:
 *  - 维护 ApprovalRequest 列表
 *  - 派生 pendingCount（pending 数量）
 *  - 拉取全部 / 仅 pending
 *  - decide(id, approved)
 *  - 提供 startPolling / stopPolling，使用 setInterval 每 3 秒拉取 pending 列表
 *
 * 模块级变量保存 timer，避免重复启动。
 */
import { create } from 'zustand'
import { approvalsApi } from '../lib/api'
import type { ApprovalRequest } from '../types'

interface ApprovalsState {
  approvals: ApprovalRequest[]
  loading: boolean
  error: string | null
  /** 是否处于轮询中 */
  polling: boolean

  /** 拉取全部审批 */
  fetchAll: () => Promise<void>
  /** 仅拉取 pending 列表（覆盖本地 pending，已决状态保留） */
  fetchPending: () => Promise<void>
  /** 决定审批 */
  decide: (id: string, approved: boolean) => Promise<boolean>
  /** 启动轮询（每 3 秒拉取 pending） */
  startPolling: () => void
  /** 停止轮询 */
  stopPolling: () => void
  /** 清空状态 */
  reset: () => void
}

/** 模块级 timer，避免 store 重建时丢失引用 */
let pollTimer: ReturnType<typeof setInterval> | null = null

/** 派生：pending 数量 */
export function selectPendingCount(list: ApprovalRequest[]): number {
  return list.filter((a) => a.status === 'pending').length
}

export const useApprovalsStore = create<ApprovalsState>((set, get) => ({
  approvals: [],
  loading: false,
  error: null,
  polling: false,

  fetchAll: async () => {
    set({ loading: true, error: null })
    try {
      const r = await approvalsApi.list()
      set({ approvals: r.approvals, loading: false })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      set({ loading: false, error: msg })
    }
  },

  fetchPending: async () => {
    try {
      const r = await approvalsApi.listPending()
      set((s) => {
        // 保留本地非 pending 状态（已决），用 pending 列表覆盖
        const decided = s.approvals.filter((a) => a.status !== 'pending')
        const merged = [...r.approvals, ...decided]
        // 按 createdAt 倒序
        merged.sort((a, b) => {
          const ta = new Date(a.createdAt).getTime() || 0
          const tb = new Date(b.createdAt).getTime() || 0
          return tb - ta
        })
        return { approvals: merged }
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      set({ error: msg })
    }
  },

  decide: async (id, approved) => {
    try {
      const item = await approvalsApi.decide(id, approved)
      set((s) => ({
        approvals: s.approvals.map((a) => (a.id === id ? item : a)),
      }))
      return true
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      set({ error: msg })
      return false
    }
  },

  startPolling: () => {
    if (pollTimer !== null) return // 避免重复启动
    // 立即拉一次
    void get().fetchPending()
    pollTimer = setInterval(() => {
      void get().fetchPending()
    }, 3000)
    set({ polling: true })
  },

  stopPolling: () => {
    if (pollTimer !== null) {
      clearInterval(pollTimer)
      pollTimer = null
    }
    set({ polling: false })
  },

  reset: () => set({ approvals: [], loading: false, error: null, polling: false }),
}))
