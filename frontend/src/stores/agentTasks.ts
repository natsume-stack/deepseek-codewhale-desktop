/**
 * Agent 自治任务状态管理（zustand）
 *
 * 负责:
 *  - 维护任务列表 / 当前任务 / 工具列表 / 全局默认模式
 *  - 创建 / 启动 / 暂停 / 续跑 / 停止 任务
 *  - 通过 EventSource 订阅 /api/agent/tasks/:id/stream，按 `event:` 字段
 *    解析为 AgentEvent 联合类型，实时更新 currentTask.history（ReAct 步骤）
 *    与 currentTask.state
 *  - 维护事件日志（最多保留 200 条）
 *
 * 后端 SSE 事件协议:
 *   event: task_state      data: {"state":"acting","iteration":3}
 *   event: thought         data: {"content":"..."}
 *   event: tool_call       data: {"id":"uuid","tool_name":"file.read","arguments":{...}}
 *   event: tool_result     data: {"success":true,"output":"...","artifacts":[]}
 *   event: reflection      data: {"conclusion":"...","next_action":"..."}
 *   event: plan_created    data: {"steps":["...","..."]}
 *   event: task_complete   data: {"summary":"..."}
 *   event: task_error      data: {"error":"...","recoverable":true}
 *   event: log             data: {"level":"info","message":"..."}
 */
import { create } from 'zustand'
import { agentApi } from '../lib/api'
import type {
  AgentEvent,
  AgentTask,
  ExecutionMode,
  GlobalPlan,
  ReflectionResult,
  ReActStep,
  SandboxAlert,
  TaskState,
  ToolInfo,
} from '../types'

interface AgentTasksState {
  tasks: AgentTask[]
  currentTaskId: string | null
  currentTask: AgentTask | null
  tools: ToolInfo[]
  defaultMode: ExecutionMode
  isStreaming: boolean
  /** 当前任务的事件流（最多保留 200 条） */
  eventLog: AgentEvent[]
  /** 当前待处理的高危操作告警（SandboxAlert），由 sandbox_alert 事件推送 */
  sandboxAlert: SandboxAlert | null
  /** 最近一次死循环检测结果（loop_detected 事件） */
  loopPattern: string | null

  // Actions
  fetchTasks: (sessionId?: string) => Promise<void>
  fetchTask: (id: string) => Promise<void>
  createTask: (sessionId: string, request: string, mode: ExecutionMode) => Promise<AgentTask>
  startTask: (id: string, projectRoot: string) => Promise<void>
  pauseTask: (id: string) => Promise<void>
  resumeTask: (id: string) => Promise<void>
  stopTask: (id: string) => Promise<void>
  fetchTools: () => Promise<void>
  fetchDefaultMode: () => Promise<void>
  setDefaultMode: (mode: ExecutionMode) => Promise<void>
  /** 订阅任务事件流，返回 unsubscribe 函数关闭 EventSource */
  subscribeToTask: (id: string) => () => void
  clearEventLog: () => void
  selectTask: (id: string | null) => void
  /** 关闭当前 sandbox 告警弹窗 */
  dismissSandboxAlert: () => void
}

/** 当前活跃的 EventSource 取消订阅器（模块级，避免在接口中暴露内部字段） */
let _currentUnsub: (() => void) | null = null

/** 按 iteration upsert ReActStep：存在则合并 patch，否则新建一步 */
function upsertStep(
  history: ReActStep[],
  iteration: number,
  patch: Partial<ReActStep>,
): ReActStep[] {
  const idx = history.findIndex((s) => s.iteration === iteration)
  if (idx >= 0) {
    const next = [...history]
    next[idx] = { ...next[idx], ...patch }
    return next
  }
  const newStep: ReActStep = {
    iteration,
    thought: '',
    action: null,
    observation: '',
    reflection: null,
    timestamp: new Date().toISOString(),
    ...patch,
  }
  return [...history, newStep]
}

/** 把事件追加到 eventLog，保留最近 200 条 */
function appendEvent(log: AgentEvent[], ev: AgentEvent): AgentEvent[] {
  const next = [...log, ev]
  return next.length > 200 ? next.slice(next.length - 200) : next
}

/** 解析 SSE data 字段为对象，失败返回 null */
function parseData<T = Record<string, unknown>>(raw: string | null): T | null {
  if (!raw) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

export const useAgentTasksStore = create<AgentTasksState>((set, get) => ({
  tasks: [],
  currentTaskId: null,
  currentTask: null,
  tools: [],
  defaultMode: 'autonomous',
  isStreaming: false,
  eventLog: [],
  sandboxAlert: null,
  loopPattern: null,

  fetchTasks: async (sessionId) => {
    try {
      const list = await agentApi.listTasks(sessionId)
      set({ tasks: list ?? [] })
    } catch (err) {
      console.error('[agentTasks] fetchTasks failed:', err)
    }
  },

  fetchTask: async (id) => {
    try {
      const task = await agentApi.getTask(id)
      set({ currentTask: task, currentTaskId: id })
    } catch (err) {
      console.error('[agentTasks] fetchTask failed:', err)
    }
  },

  createTask: async (sessionId, userRequest, mode) => {
    const task = await agentApi.createTask(sessionId, userRequest, mode)
    set((s) => ({
      tasks: [task, ...s.tasks],
      currentTask: task,
      currentTaskId: task.id,
      eventLog: [],
    }))
    return task
  },

  startTask: async (id, projectRoot) => {
    await agentApi.startTask(id, projectRoot)
    // 启动后立即订阅事件流
    get().subscribeToTask(id)
  },

  pauseTask: async (id) => {
    await agentApi.pauseTask(id)
    set((s) => ({
      currentTask:
        s.currentTask && s.currentTask.id === id
          ? { ...s.currentTask, state: 'paused' as TaskState }
          : s.currentTask,
    }))
  },

  resumeTask: async (id) => {
    await agentApi.resumeTask(id)
    get().subscribeToTask(id)
  },

  stopTask: async (id) => {
    await agentApi.stopTask(id)
    if (_currentUnsub) {
      _currentUnsub()
      _currentUnsub = null
    }
    set((s) => ({
      currentTask:
        s.currentTask && s.currentTask.id === id
          ? { ...s.currentTask, state: 'cancelled' as TaskState }
          : s.currentTask,
      isStreaming: false,
    }))
  },

  fetchTools: async () => {
    try {
      const tools = await agentApi.listTools()
      set({ tools: tools ?? [] })
    } catch (err) {
      console.error('[agentTasks] fetchTools failed:', err)
    }
  },

  fetchDefaultMode: async () => {
    try {
      const mode = await agentApi.getDefaultMode()
      set({ defaultMode: mode ?? 'autonomous' })
    } catch (err) {
      console.error('[agentTasks] fetchDefaultMode failed:', err)
    }
  },

  setDefaultMode: async (mode) => {
    await agentApi.setDefaultMode(mode)
    set({ defaultMode: mode })
  },

  subscribeToTask: (id) => {
    // 关闭旧订阅，避免并发流污染
    if (_currentUnsub) {
      _currentUnsub()
      _currentUnsub = null
    }

    const url = agentApi.taskStreamUrl(id)
    const es = new EventSource(url)
    set({ isStreaming: true })

    const pushEvent = (ev: AgentEvent) => {
      set((s) => ({ eventLog: appendEvent(s.eventLog, ev) }))
    }

    const patchCurrent = (patch: (t: AgentTask) => Partial<AgentTask>) => {
      set((s) => {
        if (!s.currentTask) return {}
        return { currentTask: { ...s.currentTask, ...patch(s.currentTask) } }
      })
    }

    es.addEventListener('task_state', (e: MessageEvent) => {
      const d = parseData<{ state: TaskState; iteration: number }>(e.data)
      if (!d) return
      pushEvent({ type: 'task_state', state: d.state, iteration: d.iteration })
      patchCurrent(() => ({
        state: d.state,
        current_iteration: d.iteration,
      }))
    })

    es.addEventListener('thought', (e: MessageEvent) => {
      const d = parseData<{ content: string }>(e.data)
      if (!d) return
      pushEvent({ type: 'thought', content: d.content })
      patchCurrent((t) => ({
        history: upsertStep(t.history, t.current_iteration, { thought: d.content }),
      }))
    })

    es.addEventListener('tool_call', (e: MessageEvent) => {
      const d = parseData<{ id: string; tool_name: string; arguments: Record<string, unknown> }>(e.data)
      if (!d) return
      const call = { id: d.id, tool_name: d.tool_name, arguments: d.arguments }
      pushEvent({ type: 'tool_call', call })
      patchCurrent((t) => ({
        history: upsertStep(t.history, t.current_iteration, { action: call }),
      }))
    })

    es.addEventListener('tool_result', (e: MessageEvent) => {
      const d = parseData<{ success: boolean; output: string; error?: string; artifacts?: [] }>(e.data)
      if (!d) return
      const result = {
        success: d.success,
        output: d.output,
        error: d.error,
        artifacts: d.artifacts ?? [],
      }
      pushEvent({ type: 'tool_result', result })
      // 失败时用 [ERROR] 前缀标记，便于 UI 渲染红色背景
      const obs = d.success ? d.output : `[ERROR] ${d.error ?? d.output}`
      patchCurrent((t) => ({
        history: upsertStep(t.history, t.current_iteration, { observation: obs }),
      }))
    })

    es.addEventListener('reflection', (e: MessageEvent) => {
      const d = parseData<{ conclusion: string; next_action?: string }>(e.data)
      if (!d) return
      pushEvent({
        type: 'reflection',
        conclusion: d.conclusion,
        next_action: d.next_action,
      })
      patchCurrent((t) => ({
        history: upsertStep(t.history, t.current_iteration, { reflection: d.conclusion }),
      }))
    })

    es.addEventListener('plan_created', (e: MessageEvent) => {
      const d = parseData<{ steps: string[] }>(e.data)
      if (!d) return
      pushEvent({ type: 'plan_created', steps: d.steps })
    })

    es.addEventListener('task_complete', (e: MessageEvent) => {
      const d = parseData<{ summary: string }>(e.data)
      if (!d) return
      pushEvent({ type: 'task_complete', summary: d.summary })
      patchCurrent(() => ({ state: 'completed' as TaskState }))
      set({ isStreaming: false })
      es.close()
      _currentUnsub = null
    })

    es.addEventListener('task_error', (e: MessageEvent) => {
      const d = parseData<{ error: string; recoverable: boolean }>(e.data)
      if (!d) return
      pushEvent({ type: 'task_error', error: d.error, recoverable: d.recoverable })
      patchCurrent(() => ({
        state: 'failed' as TaskState,
        error: d.error,
      }))
      // 不可恢复的错误关闭流；可恢复的保留连接等待重试
      if (!d.recoverable) {
        set({ isStreaming: false })
        es.close()
        _currentUnsub = null
      }
    })

    es.addEventListener('log', (e: MessageEvent) => {
      const d = parseData<{ level: string; message: string }>(e.data)
      if (!d) return
      pushEvent({ type: 'log', level: d.level, message: d.message })
    })

    // GlobalPlan 创建（任务启动时由 GlobalPlanner 生成）
    es.addEventListener('global_plan_created', (e: MessageEvent) => {
      const d = parseData<{ plan: GlobalPlan }>(e.data)
      if (!d) return
      pushEvent({ type: 'global_plan_created', plan: d.plan })
      patchCurrent(() => ({ global_plan: d.plan }))
    })

    // GlobalPlan 步骤状态变更
    es.addEventListener('plan_step_changed', (e: MessageEvent) => {
      const d = parseData<{ step_index: number; status: string; goal: string }>(e.data)
      if (!d) return
      pushEvent({
        type: 'plan_step_changed',
        step_index: d.step_index,
        status: d.status,
        goal: d.goal,
      })
      // 同步更新 currentTask.global_plan 中对应步骤状态
      patchCurrent(() => {
        const prev = get().currentTask?.global_plan
        if (!prev) return {}
        const steps = prev.steps.map((s) =>
          s.index === d.step_index
            ? {
                ...s,
                status: d.status as GlobalPlan['steps'][number]['status'],
                started_at:
                  d.status === 'in_progress' ? s.started_at ?? new Date().toISOString() : s.started_at,
                completed_at:
                  d.status === 'completed' || d.status === 'failed' || d.status === 'skipped'
                    ? new Date().toISOString()
                    : s.completed_at,
              }
            : s,
        )
        const current_step_index =
          d.status === 'completed' || d.status === 'skipped' || d.status === 'failed'
            ? Math.max(prev.current_step_index, d.step_index + 1)
            : prev.current_step_index
        return { global_plan: { ...prev, steps, current_step_index } }
      })
    })

    // 自省校验结果
    es.addEventListener('self_reflection', (e: MessageEvent) => {
      const d = parseData<{ result: ReflectionResult }>(e.data)
      if (!d) return
      pushEvent({ type: 'self_reflection', result: d.result })
      // 挂载到当前 ReAct 步骤的 reflection_result
      patchCurrent(() => {
        const task = get().currentTask
        if (!task) return {}
        const history = task.history
        if (history.length === 0) return {}
        const lastIdx = history.length - 1
        const history2 = history.slice()
        history2[lastIdx] = { ...history2[lastIdx], reflection_result: d.result }
        return { history: history2 }
      })
    })

    // 高危操作拦截告警
    es.addEventListener('sandbox_alert', (e: MessageEvent) => {
      const d = parseData<SandboxAlert>(e.data)
      if (!d) return
      pushEvent({ type: 'sandbox_alert', reason: d.reason, call: d.call })
      set({ sandboxAlert: d })
    })

    // 死循环熔断检测
    es.addEventListener('loop_detected', (e: MessageEvent) => {
      const d = parseData<{ pattern: string }>(e.data)
      if (!d) return
      pushEvent({ type: 'loop_detected', pattern: d.pattern })
      set({ loopPattern: d.pattern })
    })

    es.onerror = () => {
      // EventSource 会自动重连；仅在任务终态时彻底关闭
      const st = get().currentTask?.state
      if (st === 'completed' || st === 'failed' || st === 'cancelled') {
        es.close()
        _currentUnsub = null
        set({ isStreaming: false })
      }
    }

    const unsub = () => {
      es.close()
      _currentUnsub = null
      set({ isStreaming: false })
    }
    _currentUnsub = unsub
    return unsub
  },

  clearEventLog: () => set({ eventLog: [] }),

  dismissSandboxAlert: () => set({ sandboxAlert: null }),

  selectTask: (id) => {
    // 切换任务前先停掉旧流，避免旧事件污染新视图
    if (_currentUnsub) {
      _currentUnsub()
      _currentUnsub = null
    }
    set({ currentTaskId: id, currentTask: null, eventLog: [], isStreaming: false })
    if (id) {
      void get().fetchTask(id)
    }
  },
}))
