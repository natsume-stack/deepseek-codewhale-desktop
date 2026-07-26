/**
 * 内置终端会话状态管理（zustand）
 *
 * 负责:
 *  - 维护会话列表 / 当前激活会话 / 各会话输出行缓冲 / 各会话执行态
 *  - 创建 / 关闭 / 切换会话
 *  - 通过 EventSource 订阅 /api/agent/terminal/sessions/:id/stream
 *    接收 terminal_output 事件，实时追加到 outputs[id]
 *
 * 后端 SSE 事件协议:
 *   event: terminal_output   data: {"line":"..."}
 *   event: terminal_closed   data: {}
 *
 * 注意:
 *  - 模块级 _subs: Map<sessionId, () => void> 托管所有活跃订阅，
 *    closeSession 时主动取消订阅，避免泄漏 EventSource。
 *  - execCommand 的同步返回值也会追加到输出（保持顺序），SSE 则负责异步流式追加。
 */
import { create } from 'zustand'
import { terminalApi } from '../lib/api'
import type { TerminalExecResult, TerminalSession } from '../types'

interface TerminalState {
  sessions: TerminalSession[]
  activeSessionId: string | null
  /** session_id -> 输出行数组 */
  outputs: Record<string, string[]>
  /** session_id -> 是否正在执行命令 */
  isExecuting: Record<string, boolean>

  // Actions
  createSession: (projectRoot: string) => Promise<string>
  closeSession: (id: string) => Promise<void>
  fetchSessions: () => Promise<void>
  selectSession: (id: string | null) => void
  execCommand: (id: string, command: string, timeoutSecs?: number) => Promise<TerminalExecResult>
  /** 订阅会话 SSE 输出流，返回 unsubscribe 函数 */
  subscribeSession: (id: string) => () => void
  appendOutput: (id: string, line: string) => void
  clearOutput: (id: string) => void
}

/** 模块级订阅句柄表：sessionId -> unsubscribe */
const _subs = new Map<string, () => void>()

/** 安全追加一行输出（自动初始化数组） */
function pushLine(
  outputs: Record<string, string[]>,
  id: string,
  line: string,
): Record<string, string[]> {
  const next = { ...outputs }
  const arr = next[id] ? [...next[id]] : []
  arr.push(line)
  next[id] = arr
  return next
}

export const useTerminalStore = create<TerminalState>((set, get) => ({
  sessions: [],
  activeSessionId: null,
  outputs: {},
  isExecuting: {},

  createSession: async (projectRoot) => {
    const { session_id } = await terminalApi.createSession(projectRoot)
    const session: TerminalSession = {
      session_id,
      created_at: new Date().toISOString(),
      cwd: projectRoot,
    }
    set((s) => ({
      sessions: [...s.sessions, session],
      activeSessionId: session_id,
      outputs: { ...s.outputs, [session_id]: [] },
      isExecuting: { ...s.isExecuting, [session_id]: false },
    }))
    // 创建后立即订阅输出流
    get().subscribeSession(session_id)
    return session_id
  },

  closeSession: async (id) => {
    // 先取消订阅，再调用后端 DELETE
    const unsub = _subs.get(id)
    if (unsub) {
      unsub()
      _subs.delete(id)
    }
    try {
      await terminalApi.closeSession(id)
    } catch (err) {
      // 后端可能已关闭，忽略错误但记录日志
      console.warn('[terminal] closeSession failed:', err)
    }
    set((s) => {
      const sessions = s.sessions.filter((x) => x.session_id !== id)
      const outputs = { ...s.outputs }
      delete outputs[id]
      const isExecuting = { ...s.isExecuting }
      delete isExecuting[id]
      const activeSessionId =
        s.activeSessionId === id
          ? (sessions[0]?.session_id ?? null)
          : s.activeSessionId
      return { sessions, outputs, isExecuting, activeSessionId }
    })
    // 若关闭的是当前会话，自动订阅新的激活会话
    const next = get().activeSessionId
    if (next && !_subs.has(next)) {
      get().subscribeSession(next)
    }
  },

  fetchSessions: async () => {
    try {
      const list = await terminalApi.listSessions()
      set((s) => {
        const sessions = list ?? []
        // 为新出现的会话补齐 outputs / isExecuting 槽位
        const outputs = { ...s.outputs }
        const isExecuting = { ...s.isExecuting }
        for (const sess of sessions) {
          if (!(sess.session_id in outputs)) outputs[sess.session_id] = []
          if (!(sess.session_id in isExecuting)) isExecuting[sess.session_id] = false
        }
        const activeSessionId =
          s.activeSessionId ??
          (sessions.length > 0 ? sessions[0].session_id : null)
        return { sessions, outputs, isExecuting, activeSessionId }
      })
      // 自动订阅激活会话
      const activeId = get().activeSessionId
      if (activeId && !_subs.has(activeId)) {
        get().subscribeSession(activeId)
      }
    } catch (err) {
      console.error('[terminal] fetchSessions failed:', err)
    }
  },

  selectSession: (id) => {
    set({ activeSessionId: id })
    if (id && !_subs.has(id)) {
      get().subscribeSession(id)
    }
  },

  execCommand: async (id, command, timeoutSecs) => {
    // 回显命令本身（终端习惯：$ <command>）
    get().appendOutput(id, `$ ${command}`)
    set((s) => ({ isExecuting: { ...s.isExecuting, [id]: true } }))
    try {
      const result = await terminalApi.execCommand(id, command, timeoutSecs)
      // 同步返回的 output 追加到缓冲（SSE 可能已部分追加，这里追加完整结果）
      if (result?.output) {
        const lines = result.output.split(/\r?\n/)
        for (const line of lines) {
          get().appendOutput(id, line)
        }
      }
      return result
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      get().appendOutput(id, `[ERROR] ${msg}`)
      throw err
    } finally {
      set((s) => ({ isExecuting: { ...s.isExecuting, [id]: false } }))
    }
  },

  subscribeSession: (id) => {
    // 已存在订阅则复用，避免重复连接
    if (_subs.has(id)) return _subs.get(id)!

    const url = terminalApi.streamUrl(id)
    const es = new EventSource(url)

    es.addEventListener('terminal_output', (e: MessageEvent) => {
      try {
        const d = JSON.parse(e.data) as { line?: string }
        if (typeof d.line === 'string') {
          get().appendOutput(id, d.line)
        }
      } catch {
        /* ignore malformed payload */
      }
    })

    es.addEventListener('terminal_closed', () => {
      get().appendOutput(id, '[session closed]')
      es.close()
      _subs.delete(id)
    })

    es.onerror = () => {
      // EventSource 会自动重连；这里仅记录，不主动关闭
      console.warn('[terminal] stream error for session', id)
    }

    const unsub = () => {
      es.close()
      _subs.delete(id)
    }
    _subs.set(id, unsub)
    return unsub
  },

  appendOutput: (id, line) => {
    set((s) => ({ outputs: pushLine(s.outputs, id, line) }))
  },

  clearOutput: (id) => {
    set((s) => ({ outputs: { ...s.outputs, [id]: [] } }))
  },
}))
