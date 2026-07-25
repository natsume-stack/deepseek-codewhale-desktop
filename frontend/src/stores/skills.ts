/**
 * Skill 技能生态状态管理（P0）
 *
 * 负责:
 *  - 维护 SkillMeta 列表
 *  - 维护当前匹配结果（SkillMatch[]，由 find 写入）
 *  - 维护技能执行日志（SkillLogEntry[]，供 SkillExecuteLog Tab 渲染）
 *  - 拉取全部 / 按消息匹配 / 启用切换 / 删除 / 创建
 *  - 维护 AGENTS.md 文本（编辑器读写）
 *  - 提供 dispatchSkillMatchEvent 用于在 ChatPanel 中模拟 SSE 'skill_match' 事件
 *
 * 不实现自动轮询；如需轮询由组件层 useEffect 控制。
 */
import { create } from 'zustand'
import { skillsApi } from '../lib/api'
import type {
  SkillDefinition,
  SkillLogEntry,
  SkillMatch,
  SkillMeta,
} from '../types'

/** 创建本地日志条目用的自增 id */
let logIdSeq = 0
const nextLogId = () => `sl_${Date.now()}_${++logIdSeq}`

interface SkillsState {
  /** 全部已注册技能 */
  skills: SkillMeta[]
  /** 当前消息匹配结果（由 find() 写入） */
  matches: SkillMatch[]
  /** 当前会话的技能执行日志 */
  logs: SkillLogEntry[]
  /** AGENTS.md 文本内容（点击「编辑 AGENTS.md」时拉取） */
  agentsMd: string
  /** 详细定义缓存（按 skillId 索引，点击列表项展开时拉取） */
  definitions: Record<string, SkillDefinition>
  loading: boolean
  error: string | null

  /** 拉取全部技能 */
  fetchAll: () => Promise<void>
  /** 拉取单个技能详细定义 */
  fetchDefinition: (id: string) => Promise<SkillDefinition | null>
  /** 按消息文本匹配技能（结果存入 matches） */
  find: (message: string) => Promise<SkillMatch[]>
  /** 切换启用状态 */
  toggle: (id: string) => Promise<boolean>
  /** 删除技能 */
  remove: (id: string) => Promise<boolean>
  /** 创建技能 */
  create: (body: {
    id: string
    name: string
    description: string
    triggers: string[]
    rawMarkdown: string
  }) => Promise<SkillDefinition | null>
  /** 拉取 AGENTS.md 文本 */
  fetchAgentsMd: () => Promise<void>
  /** 保存 AGENTS.md 文本 */
  saveAgentsMd: (content: string) => Promise<boolean>
  /** 追加一条执行日志（由 SSE skill_match / 手动触发） */
  appendLog: (entry: Omit<SkillLogEntry, 'id'>) => void
  /** 更新日志条目结果状态 */
  updateLog: (id: string, patch: Partial<SkillLogEntry>) => void
  /** 清空执行日志 */
  clearLogs: () => void
  /** 重置状态 */
  reset: () => void
}

export const useSkillsStore = create<SkillsState>((set) => ({
  skills: [],
  matches: [],
  logs: [],
  agentsMd: '',
  definitions: {},
  loading: false,
  error: null,

  fetchAll: async () => {
    set({ loading: true, error: null })
    try {
      const r = await skillsApi.list()
      set({ skills: r.skills, loading: false })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      set({ loading: false, error: msg })
    }
  },

  fetchDefinition: async (id) => {
    try {
      const def = await skillsApi.get(id)
      set((s) => ({ definitions: { ...s.definitions, [id]: def } }))
      return def
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      set({ error: msg })
      return null
    }
  },

  find: async (message) => {
    try {
      const r = await skillsApi.find(message)
      set({ matches: r.matches })
      // 同步派发 window 事件，便于 ChatPanel 在消息流中插入 SkillMatch 卡片
      if (typeof window !== 'undefined' && r.matches.length > 0) {
        window.dispatchEvent(
          new CustomEvent('skill_match', { detail: { matches: r.matches, message } }),
        )
      }
      return r.matches
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      set({ error: msg })
      return []
    }
  },

  toggle: async (id) => {
    try {
      const r = await skillsApi.toggle(id)
      set((s) => ({
        skills: s.skills.map((sk) =>
          sk.id === id ? { ...sk, enabled: r.enabled } : sk,
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
      await skillsApi.delete(id)
      set((s) => ({
        skills: s.skills.filter((sk) => sk.id !== id),
        definitions: Object.fromEntries(
          Object.entries(s.definitions).filter(([k]) => k !== id),
        ),
      }))
      return true
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      set({ error: msg })
      return false
    }
  },

  create: async (body) => {
    try {
      const def = await skillsApi.create(body)
      set((s) => ({
        skills: [...s.skills, def.meta],
        definitions: { ...s.definitions, [def.meta.id]: def },
      }))
      return def
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      set({ error: msg })
      return null
    }
  },

  fetchAgentsMd: async () => {
    try {
      const r = await skillsApi.getAgentsMd()
      set({ agentsMd: r.content })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      set({ error: msg })
    }
  },

  saveAgentsMd: async (content) => {
    try {
      await skillsApi.updateAgentsMd(content)
      set({ agentsMd: content })
      return true
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      set({ error: msg })
      return false
    }
  },

  appendLog: (entry) => {
    set((s) => ({
      logs: [...s.logs, { ...entry, id: nextLogId() }],
    }))
  },

  updateLog: (id, patch) => {
    set((s) => ({
      logs: s.logs.map((l) => (l.id === id ? { ...l, ...patch } : l)),
    }))
  },

  clearLogs: () => set({ logs: [] }),

  reset: () =>
    set({
      skills: [],
      matches: [],
      logs: [],
      agentsMd: '',
      definitions: {},
      loading: false,
      error: null,
    }),
}))

/** 派生：按 category 分组的技能映射 */
export function selectSkillsByCategory(skills: SkillMeta[]): Record<string, SkillMeta[]> {
  const map: Record<string, SkillMeta[]> = {}
  for (const s of skills) {
    if (!map[s.category]) map[s.category] = []
    map[s.category].push(s)
  }
  return map
}

/** 派生：当前匹配的最佳结果（score 最高） */
export function selectTopMatch(matches: SkillMatch[]): SkillMatch | null {
  if (matches.length === 0) return null
  return matches.reduce((best, cur) => (cur.score > best.score ? cur : best), matches[0])
}
