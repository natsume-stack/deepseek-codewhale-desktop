/**
 * 对话状态管理（zustand）
 *
 * 负责:
 *  - 维护当前会话消息列表（前端流式聚合）
 *  - 发送消息 -> POST /api/chat (SSE)
 *  - 接收 delta/reasoning 增量并实时更新 assistant 消息
 *  - 停止生成（abort）
 *  - 切换/重置会话时与后端 /api/sessions 同步
 *
 * 后端 SSE 事件契约见 src/routes/chat.rs 注释。
 */
import { create } from 'zustand'
import { postSse, type ParsedSseEvent } from '../lib/sse'
import { chatApi, sessionsApi, BASE } from '../lib/api'
import { useTodosStore } from './todos'
import type { ChatStreamMessage, ReasoningEffort, TodoItem } from '../types'

interface ChatState {
  /** 当前会话 id（首次发送后由后端 session 事件赋值） */
  sessionId: string | null
  /** 流式消息列表（含 user / assistant） */
  messages: ChatStreamMessage[]
  /** 是否正在流式接收 */
  streaming: boolean
  /** 最近一次错误（用于顶栏提示） */
  lastError: string | null

  // 本轮覆盖参数（不传则用后端默认）
  overrideReasoningEffort?: ReasoningEffort
  overrideCacheEnabled?: boolean
  overrideContextLength?: number

  // 引用：当前 SSE 请求的 AbortController
  _abortor: AbortController | null

  /** 设置本轮覆盖参数（来自 ParamsPanel） */
  setOverrides: (o: {
    reasoningEffort?: ReasoningEffort
    cacheEnabled?: boolean
    contextLength?: number
  }) => void

  /** 发送一条消息并启动 SSE 流
   *  opts.attachments: 已挂载的文件路径
   *  opts.slashCommand: 斜杠指令（如 /refactor）
   */
  send: (text: string, opts?: { attachments?: string[]; slashCommand?: string }) => Promise<void>
  /** 中断当前流式 */
  stop: () => Promise<void>
  /** 清空前端消息视图（不删后端会话） */
  clearView: () => void
  /** 切换会话：拉取后端历史并替换视图 */
  switchSession: (id: string) => Promise<void>
  /** 重置当前会话上下文：调用后端 reset 并清空视图 */
  resetSession: () => Promise<void>
  /** 重试指定 assistant 消息：删除它及其后所有消息，重新发送上一条 user 消息
   *  注意：不破坏缓存前缀（仅重置尾部对话，由后端处理） */
  retry: (localId: string) => Promise<void>
  /** 删除指定消息（按 localId） */
  deleteMessage: (localId: string) => void
  /** 切换指定消息的折叠状态（按 localId） */
  toggleFold: (localId: string) => void
}

let localIdSeq = 0
const nextLocalId = () => `m${Date.now()}_${++localIdSeq}`

export const useChatStore = create<ChatState>((set, get) => ({
  sessionId: null,
  messages: [],
  streaming: false,
  lastError: null,
  _abortor: null,

  setOverrides: (o) => set((s) => ({
    overrideReasoningEffort: o.reasoningEffort ?? s.overrideReasoningEffort,
    overrideCacheEnabled: o.cacheEnabled ?? s.overrideCacheEnabled,
    overrideContextLength: o.contextLength ?? s.overrideContextLength,
  })),

  send: async (text, opts) => {
    const trimmed = text.trim()
    if (!trimmed) return
    const state = get()
    if (state.streaming) return // 防止并发

    // 1. 立即追加 user 消息 + 占位 assistant 消息
    const userMsg: ChatStreamMessage = {
      localId: nextLocalId(),
      role: 'user',
      content: trimmed,
      ts: Date.now(),
    }
    const assistantMsg: ChatStreamMessage = {
      localId: nextLocalId(),
      role: 'assistant',
      content: '',
      reasoning: '',
      streaming: true,
      ts: Date.now(),
    }
    set((s) => ({
      messages: [...s.messages, userMsg, assistantMsg],
      streaming: true,
      lastError: null,
    }))

    // 2. 发起 SSE 请求
    const abortor = new AbortController()
    set({ _abortor: abortor })

    const body: Record<string, unknown> = {
      message: trimmed,
      sessionId: state.sessionId ?? undefined,
    }
    if (state.overrideReasoningEffort) body.reasoningEffort = state.overrideReasoningEffort
    if (state.overrideCacheEnabled !== undefined) body.cacheEnabled = state.overrideCacheEnabled
    if (state.overrideContextLength) body.contextLength = state.overrideContextLength
    // 附件与斜杠指令
    if (opts?.attachments && opts.attachments.length > 0) {
      body.attachments = opts.attachments
    }
    if (opts?.slashCommand) {
      body.slashCommand = opts.slashCommand
    }

    const assistantLocalId = assistantMsg.localId
    const updateAssistant = (patch: Partial<ChatStreamMessage>) =>
      set((s) => ({
        messages: s.messages.map((m) =>
          m.localId === assistantLocalId ? { ...m, ...patch } : m,
        ),
      }))

    try {
      await postSse(
        `${BASE}/chat`,
        body,
        (ev: ParsedSseEvent) => {
          let payload: Record<string, unknown> = {}
          try {
            payload = ev.data ? JSON.parse(ev.data) : {}
          } catch {
            /* ignore */
          }
          switch (ev.event) {
            case 'session': {
              const sid = payload.sessionId as string | undefined
              if (sid) set({ sessionId: sid })
              break
            }
            case 'delta': {
              const c = (payload.content as string | undefined) ?? ''
              if (!c) break
              set((s) => ({
                messages: s.messages.map((m) =>
                  m.localId === assistantLocalId
                    ? { ...m, content: m.content + c }
                    : m,
                ),
              }))
              break
            }
            case 'reasoning': {
              const c = (payload.content as string | undefined) ?? ''
              if (!c) break
              set((s) => ({
                messages: s.messages.map((m) =>
                  m.localId === assistantLocalId
                    ? { ...m, reasoning: (m.reasoning ?? '') + c }
                    : m,
                ),
              }))
              break
            }
            case 'finish': {
              // 仅记录，等 done 收尾
              break
            }
            case 'todos': {
              // 后端推送代办任务列表，注入 todos store
              const items = (payload.items as TodoItem[] | undefined) ?? []
              if (items.length > 0) {
                useTodosStore.getState().upsertMany(items)
              }
              break
            }
            case 'error': {
              const msg = (payload.message as string | undefined) ?? '生成失败'
              updateAssistant({ streaming: false, error: msg })
              set({ lastError: msg, streaming: false })
              break
            }
            case 'done': {
              updateAssistant({ streaming: false })
              set({ streaming: false })
              break
            }
            default:
              break
          }
        },
        abortor.signal,
      )
    } catch (err: unknown) {
      // 主动 abort 不视为错误
      if (err instanceof DOMException && err.name === 'AbortError') {
        updateAssistant({ streaming: false })
        set({ streaming: false })
        return
      }
      const msg = err instanceof Error ? err.message : String(err)
      updateAssistant({ streaming: false, error: msg })
      set({ lastError: msg, streaming: false })
    } finally {
      set({ _abortor: null })
    }
  },

  stop: async () => {
    const state = get()
    // 1. 本地 abort SSE
    state._abortor?.abort()
    // 2. 通知后端取消当前轮次（落地已累积内容）
    if (state.sessionId) {
      try {
        await chatApi.stop(state.sessionId)
      } catch {
        /* ignore */
      }
    }
    set((s) => ({
      streaming: false,
      messages: s.messages.map((m) =>
        m.streaming ? { ...m, streaming: false } : m,
      ),
    }))
  },

  clearView: () => set({ messages: [], lastError: null }),

  switchSession: async (id) => {
    try {
      const s = await sessionsApi.get(id)
      const messages: ChatStreamMessage[] = s.messages.map((m) => ({
        localId: nextLocalId(),
        role: m.role,
        content: m.content,
        reasoning: m.reasoning,
        ts: new Date(s.updatedAt).getTime(),
      }))
      set({ sessionId: s.id, messages, lastError: null })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      set({ lastError: msg })
    }
  },

  resetSession: async () => {
    const sid = get().sessionId
    if (!sid) {
      set({ messages: [], lastError: null })
      return
    }
    try {
      await sessionsApi.reset(sid)
      set({ messages: [], lastError: null })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      set({ lastError: msg })
    }
  },

  retry: async (localId) => {
    const state = get()
    if (state.streaming) return // 防止并发重试
    const idx = state.messages.findIndex((m) => m.localId === localId)
    if (idx < 0) return
    // 找到该消息之前最近的一条 user 消息
    let userIdx = -1
    for (let i = idx - 1; i >= 0; i--) {
      if (state.messages[i].role === 'user') {
        userIdx = i
        break
      }
    }
    if (userIdx < 0) return // 没有上一条 user 消息，无法重试
    const userText = state.messages[userIdx].content
    if (!userText.trim()) return
    // 删除从该 user 消息开始的所有后续消息（含目标 assistant 消息）
    // 这样调用 send 会重新追加 user + assistant 占位，避免重复
    set((s) => ({
      messages: s.messages.slice(0, userIdx),
      lastError: null,
    }))
    // 重新发送上一条 user 消息
    await get().send(userText)
  },

  deleteMessage: (localId) => {
    set((s) => ({
      messages: s.messages.filter((m) => m.localId !== localId),
    }))
  },

  toggleFold: (localId) => {
    set((s) => ({
      messages: s.messages.map((m) =>
        m.localId === localId ? { ...m, folded: !m.folded } : m,
      ),
    }))
  },
}))
