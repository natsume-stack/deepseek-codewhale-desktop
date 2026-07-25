/**
 * MCP 插件生态状态管理（P1）
 *
 * 负责:
 *  - 维护已注册 MCP 插件列表（含运行时 status）
 *  - 维护高危插件总开关
 *  - 拉取全部 / 注册 / 切换启用 / 连接 / 断开 / 删除
 *  - 调用插件工具（call）并返回结果摘要
 *  - 维护高危总开关读取/写入
 *
 * 不实现自动轮询；如需轮询由组件层 useEffect 控制。
 */
import { create } from 'zustand'
import { mcpApi } from '../lib/api'
import type { McpConfig, McpStatus } from '../types'

type PluginWithStatus = McpConfig & { status: McpStatus }

interface McpState {
  /** 已注册插件列表（含运行时 status） */
  plugins: PluginWithStatus[]
  /** 高危插件总开关 */
  highRiskEnabled: boolean
  loading: boolean
  error: string | null

  /** 拉取全部插件 + 高危开关 */
  fetchAll: () => Promise<void>
  /** 注册新插件 */
  register: (body: McpConfig) => Promise<McpConfig | null>
  /** 切换启用状态 */
  toggle: (id: string) => Promise<boolean>
  /** 连接插件 */
  connect: (id: string) => Promise<boolean>
  /** 断开插件 */
  disconnect: (id: string) => Promise<boolean>
  /** 删除插件 */
  remove: (id: string) => Promise<boolean>
  /** 设置高危总开关 */
  setHighRiskSwitch: (enabled: boolean) => Promise<boolean>
  /** 调用插件工具（返回 summary 字符串） */
  call: (body: {
    pluginId: string
    tool: string
    arguments: unknown
    sessionId?: string
  }) => Promise<{ success: boolean; summary: string; data: unknown } | null>
  /** 重置状态 */
  reset: () => void
}

export const useMcpStore = create<McpState>((set) => ({
  plugins: [],
  highRiskEnabled: false,
  loading: false,
  error: null,

  fetchAll: async () => {
    set({ loading: true, error: null })
    try {
      const [list, sw] = await Promise.all([
        mcpApi.list(),
        mcpApi.getHighRiskSwitch().catch(() => ({ enabled: false })),
      ])
      set({
        plugins: list.plugins,
        highRiskEnabled: sw.enabled,
        loading: false,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      set({ loading: false, error: msg })
    }
  },

  register: async (body) => {
    try {
      const def = await mcpApi.register(body)
      set((s) => ({
        plugins: [
          ...s.plugins,
          {
            ...def,
            status: {
              id: def.meta.id,
              connected: false,
              callCount: 0,
            },
          },
        ],
      }))
      return def
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      set({ error: msg })
      return null
    }
  },

  toggle: async (id) => {
    try {
      const r = await mcpApi.toggle(id)
      set((s) => ({
        plugins: s.plugins.map((p) =>
          p.meta.id === id ? { ...p, meta: { ...p.meta, enabled: r.enabled } } : p,
        ),
      }))
      return true
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      set({ error: msg })
      return false
    }
  },

  connect: async (id) => {
    try {
      const r = await mcpApi.connect(id)
      set((s) => ({
        plugins: s.plugins.map((p) =>
          p.meta.id === id
            ? {
                ...p,
                status: {
                  ...p.status,
                  connected: r.connected,
                  lastError: r.connected ? undefined : p.status.lastError,
                },
              }
            : p,
        ),
      }))
      return true
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      set((s) => ({
        error: msg,
        plugins: s.plugins.map((p) =>
          p.meta.id === id
            ? {
                ...p,
                status: { ...p.status, connected: false, lastError: msg },
              }
            : p,
        ),
      }))
      return false
    }
  },

  disconnect: async (id) => {
    try {
      const r = await mcpApi.disconnect(id)
      set((s) => ({
        plugins: s.plugins.map((p) =>
          p.meta.id === id
            ? {
                ...p,
                status: { ...p.status, connected: r.connected ? false : p.status.connected },
              }
            : p,
        ),
      }))
      return true
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      set({ error: msg })
      return false
    }
  },

  remove: async (id) => {
    try {
      await mcpApi.delete(id)
      set((s) => ({
        plugins: s.plugins.filter((p) => p.meta.id !== id),
      }))
      return true
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      set({ error: msg })
      return false
    }
  },

  setHighRiskSwitch: async (enabled) => {
    try {
      const r = await mcpApi.setHighRiskSwitch(enabled)
      set({ highRiskEnabled: r.enabled })
      return true
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      set({ error: msg })
      return false
    }
  },

  call: async (body) => {
    try {
      const r = await mcpApi.call(body)
      // 更新调用计数与最近调用时间
      set((s) => ({
        plugins: s.plugins.map((p) =>
          p.meta.id === body.pluginId
            ? {
                ...p,
                status: {
                  ...p.status,
                  callCount: p.status.callCount + 1,
                  lastCallAt: new Date().toISOString(),
                },
              }
            : p,
        ),
      }))
      return { success: r.success, summary: r.summary, data: r.data }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      set({ error: msg })
      return null
    }
  },

  reset: () =>
    set({
      plugins: [],
      highRiskEnabled: false,
      loading: false,
      error: null,
    }),
}))

/** 派生：已连接插件数量 */
export function selectConnectedCount(plugins: PluginWithStatus[]): number {
  return plugins.filter((p) => p.status.connected).length
}

/** 派生：高危插件列表 */
export function selectHighRiskPlugins(plugins: PluginWithStatus[]): PluginWithStatus[] {
  return plugins.filter((p) => p.meta.highRisk)
}
