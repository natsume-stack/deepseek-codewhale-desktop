/**
 * 自治任务监控面板（主面板）
 *
 * 布局:
 *   ┌─────────────────────────────────────────────┐
 *   │ 自治任务监控              [自动] [审批]      │  顶部标题栏 + ModeSwitcher
 *   ├─────────────────────────────────────────────┤
 *   │ ┌─ 当前任务 ──────────────────────────────┐ │
 *   │ │ #UUID缩写  状态徽标  迭代 N/M            │ │
 *   │ │ 需求: "..."                             │ │
 *   │ │ [▶启动] [⏸暂停] [⏭续跑] [⏹停止]         │ │
 *   │ └────────────────────────────────────────┘ │
 *   ├─────────────────────────────────────────────┤
 *   │ ┌─ ReAct 时间线 ─────────────────────────┐  │
 *   │ │ <ReActTimeline/>                       │  │
 *   │ └────────────────────────────────────────┘  │
 *   ├─────────────────────────────────────────────┤
 *   │ ┌─ 历史任务（横向滚动卡片网格）──────────┐  │
 *   │ └────────────────────────────────────────┘  │
 *   └─────────────────────────────────────────────┘
 *
 * - 顶部 ModeSwitcher 切换全局默认模式
 * - 当前任务卡片：状态徽标带颜色（acting=白色脉冲/completed=白色实心/failed=橙色/paused=灰色）
 * - 历史任务横向滚动卡片网格
 * - 空状态：插画 + "创建首个自治任务"按钮
 */
import { useEffect, useState } from 'react'
import { useAgentTasksStore } from '../stores/agentTasks'
import { useChatStore } from '../stores/chat'
import { useDialogStore } from '../stores/dialog'
import { projectApi, sessionsApi } from '../lib/api'
import { ModeSwitcher } from './ModeSwitcher'
import { ReActTimeline } from './ReActTimeline'
import type { AgentTask, TaskState } from '../types'

export function TaskMonitorPanel() {
  const tasks = useAgentTasksStore((s) => s.tasks)
  const currentTask = useAgentTasksStore((s) => s.currentTask)
  const currentTaskId = useAgentTasksStore((s) => s.currentTaskId)
  const defaultMode = useAgentTasksStore((s) => s.defaultMode)
  const fetchTasks = useAgentTasksStore((s) => s.fetchTasks)
  const fetchDefaultMode = useAgentTasksStore((s) => s.fetchDefaultMode)
  const createTask = useAgentTasksStore((s) => s.createTask)
  const startTask = useAgentTasksStore((s) => s.startTask)
  const pauseTask = useAgentTasksStore((s) => s.pauseTask)
  const resumeTask = useAgentTasksStore((s) => s.resumeTask)
  const stopTask = useAgentTasksStore((s) => s.stopTask)
  const selectTask = useAgentTasksStore((s) => s.selectTask)

  const [busy, setBusy] = useState(false)

  // 挂载时拉取任务列表 + 默认模式
  useEffect(() => {
    void fetchTasks()
    void fetchDefaultMode()
  }, [fetchTasks, fetchDefaultMode])

  // 卸载时取消订阅事件流（由 store 内部模块级变量托管，这里无需手动清理）
  const handleCreate = async () => {
    const text = await useDialogStore.getState().prompt({
      title: '创建自治任务',
      placeholder: '描述要让 Agent 完成的需求…',
      confirmText: '创建',
    })
    if (!text || !text.trim()) return
    let sid = useChatStore.getState().sessionId
    if (!sid) {
      // 无当前会话时新建一个会话承载任务
      const s = await sessionsApi.create()
      sid = s.id
    }
    try {
      setBusy(true)
      await createTask(sid, text.trim(), defaultMode)
    } catch (err) {
      void useDialogStore.getState().alert({
        title: '创建失败',
        message: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setBusy(false)
    }
  }

  const handleStart = async (id: string) => {
    try {
      setBusy(true)
      const p = await projectApi.get()
      await startTask(id, p.path ?? '')
    } catch (err) {
      void useDialogStore.getState().alert({
        title: '启动失败',
        message: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setBusy(false)
    }
  }

  const handlePause = async (id: string) => {
    try {
      setBusy(true)
      await pauseTask(id)
    } finally {
      setBusy(false)
    }
  }

  const handleResume = async (id: string) => {
    try {
      setBusy(true)
      const p = await projectApi.get()
      // resume 复用 projectRoot 以便后端在需要时重载上下文
      void p
      await resumeTask(id)
    } finally {
      setBusy(false)
    }
  }

  const handleStop = async (id: string) => {
    try {
      setBusy(true)
      await stopTask(id)
    } finally {
      setBusy(false)
    }
  }

  const running = currentTask ? isRunningState(currentTask.state) : false

  return (
    <div className="h-full w-full flex flex-col overflow-hidden">
      {/* === 顶部标题栏 === */}
      <div className="flex items-center justify-between px-5 py-3 border-b border-white/5">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-text-primary">自治任务监控</span>
          <span className="text-2xs text-text-tertiary font-mono">
            {tasks.length > 0 ? `${tasks.length} 个任务` : ''}
          </span>
        </div>
        <ModeSwitcher mode={defaultMode} />
      </div>

      {/* === 主体（滚动区） === */}
      <div className="flex-1 min-h-0 overflow-auto px-5 py-4 space-y-4">
        {/* 当前任务卡片 */}
        {currentTask ? (
          <CurrentTaskCard
            task={currentTask}
            busy={busy}
            running={running}
            onStart={() => void handleStart(currentTask.id)}
            onPause={() => void handlePause(currentTask.id)}
            onResume={() => void handleResume(currentTask.id)}
            onStop={() => void handleStop(currentTask.id)}
          />
        ) : (
          <EmptyHero onCreate={() => void handleCreate()} busy={busy} />
        )}

        {/* ReAct 时间线 */}
        {currentTask && (
          <section className="rounded-2xl border border-white/6 bg-white/3 overflow-hidden">
            <SectionHeader title="ReAct 时间线" hint={`${currentTask.history.length} 步`} />
            <div className="h-[320px]">
              <ReActTimeline steps={currentTask.history} />
            </div>
          </section>
        )}

        {/* 历史任务 */}
        {tasks.length > 0 && (
          <section className="rounded-2xl border border-white/6 bg-white/3 overflow-hidden">
            <SectionHeader title="历史任务" hint={`${tasks.length}`} />
            <HistoryTaskGrid
              tasks={tasks}
              currentId={currentTaskId}
              onSelect={(id) => selectTask(id)}
            />
          </section>
        )}
      </div>
    </div>
  )
}

/* ============== 当前任务卡片 ============== */

interface CurrentTaskCardProps {
  task: AgentTask
  busy: boolean
  running: boolean
  onStart: () => void
  onPause: () => void
  onResume: () => void
  onStop: () => void
}

function CurrentTaskCard({ task, busy, running, onStart, onPause, onResume, onStop }: CurrentTaskCardProps) {
  return (
    <section
      className="rounded-2xl border border-white/8 bg-surface-elevated px-4 py-3.5 animate-scale-in"
    >
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs font-mono text-text-tertiary">#{task.id.slice(0, 8)}</span>
        <StateBadge state={task.state} />
        <span className="text-2xs text-text-tertiary font-mono ml-auto">
          迭代 {task.current_iteration}/{task.max_iterations}
        </span>
      </div>

      <div className="mt-2 text-xs text-text-primary leading-relaxed line-clamp-2">
        <span className="text-text-tertiary">需求：</span>
        {task.user_request}
      </div>

      {task.error && (
        <div className="mt-2 px-2.5 py-1.5 rounded-md text-2xs text-warn bg-warn/10 border border-warn/20">
          {task.error}
        </div>
      )}

      {/* 操作按钮组 */}
      <div className="mt-3 flex items-center gap-2 flex-wrap">
        <button
          onClick={onStart}
          disabled={busy || running}
          className="btn-primary !py-1 !px-3 !text-xs disabled:opacity-40"
          title="启动任务"
        >
          ▶ 启动
        </button>
        <button
          onClick={onPause}
          disabled={busy || !running}
          className="btn-secondary !py-1 !px-3 !text-xs disabled:opacity-40"
          title="暂停任务"
        >
          ⏸ 暂停
        </button>
        <button
          onClick={onResume}
          disabled={busy || running || task.state !== 'paused'}
          className="btn-secondary !py-1 !px-3 !text-xs disabled:opacity-40"
          title="续跑任务"
        >
          ⏭ 续跑
        </button>
        <button
          onClick={onStop}
          disabled={busy || !running}
          className="btn-danger !py-1 !px-3 !text-xs disabled:opacity-40"
          title="停止任务"
        >
          ⏹ 停止
        </button>
      </div>
    </section>
  )
}

/* ============== 状态徽标 ============== */

function StateBadge({ state }: { state: TaskState }) {
  const { label, cls, pulse } = stateStyle(state)
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-2xs font-semibold ${cls} ${pulse ? 'animate-pulse-soft' : ''}`}
    >
      <span className="inline-block w-1.5 h-1.5 rounded-full bg-current" />
      {label}
    </span>
  )
}

function stateStyle(state: TaskState): { label: string; cls: string; pulse: boolean } {
  switch (state) {
    case 'acting':
    case 'planning':
    case 'observing':
    case 'reflecting':
      return { label: stateLabel(state), cls: 'bg-white/15 text-white', pulse: state === 'acting' }
    case 'completed':
      return { label: '已完成', cls: 'bg-white text-black', pulse: false }
    case 'failed':
      return { label: '失败', cls: 'bg-warn/20 text-warn', pulse: false }
    case 'paused':
      return { label: '已暂停', cls: 'bg-white/8 text-text-tertiary', pulse: false }
    case 'awaiting_approval':
      return { label: '待审批', cls: 'bg-warn/15 text-warn', pulse: true }
    case 'cancelled':
      return { label: '已取消', cls: 'bg-white/6 text-text-tertiary', pulse: false }
    case 'pending':
    default:
      return { label: '待启动', cls: 'bg-white/8 text-text-secondary', pulse: false }
  }
}

function stateLabel(state: TaskState): string {
  const map: Record<TaskState, string> = {
    pending: '待启动',
    planning: '规划中',
    acting: '执行中',
    observing: '观察中',
    reflecting: '反思中',
    paused: '已暂停',
    awaiting_approval: '待审批',
    completed: '已完成',
    failed: '失败',
    cancelled: '已取消',
  }
  return map[state] ?? state
}

function isRunningState(state: TaskState): boolean {
  return (
    state === 'acting' ||
    state === 'planning' ||
    state === 'observing' ||
    state === 'reflecting' ||
    state === 'awaiting_approval'
  )
}

/* ============== 空状态 ============== */

function EmptyHero({ onCreate, busy }: { onCreate: () => void; busy: boolean }) {
  return (
    <div className="flex flex-col items-center justify-center text-center px-6 py-12 gap-3 rounded-2xl border border-dashed border-white/10 bg-white/2 animate-fade-in">
      <span className="text-4xl opacity-50">🤖</span>
      <div className="text-sm text-text-primary">还没有自治任务</div>
      <div className="text-2xs text-text-tertiary leading-relaxed max-w-xs">
        描述一个目标，Agent 将以 ReAct 循环自主规划、调用工具并反思迭代，直至完成。
      </div>
      <button
        onClick={onCreate}
        disabled={busy}
        className="btn-primary !py-1.5 !px-4 !text-xs mt-1 disabled:opacity-40"
      >
        {busy ? '创建中…' : '创建首个自治任务'}
      </button>
    </div>
  )
}

/* ============== 区块标题 ============== */

function SectionHeader({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex items-center justify-between px-3 py-2 border-b border-white/5">
      <span className="text-xs font-semibold text-text-primary">{title}</span>
      {hint && <span className="text-2xs text-text-tertiary font-mono">{hint}</span>}
    </div>
  )
}

/* ============== 历史任务卡片网格 ============== */

interface HistoryTaskGridProps {
  tasks: AgentTask[]
  currentId: string | null
  onSelect: (id: string) => void
}

function HistoryTaskGrid({ tasks, currentId, onSelect }: HistoryTaskGridProps) {
  return (
    <div className="flex gap-2 overflow-x-auto px-3 py-3">
      {tasks.map((t, i) => {
        const active = t.id === currentId
        return (
          <button
            key={t.id}
            onClick={() => onSelect(t.id)}
            className={`flex-shrink-0 w-56 text-left rounded-xl border px-3 py-2.5 transition-all duration-200 ease-bounce animate-slide-up-spring
              ${active
                ? 'border-white/20 bg-white/10'
                : 'border-white/6 bg-white/3 hover:bg-white/6 hover:border-white/10'
              }`}
            style={{ animationDelay: `${i * 30}ms`, animationFillMode: 'both' }}
          >
            <div className="flex items-center gap-1.5">
              <span className="text-2xs font-mono text-text-tertiary">#{t.id.slice(0, 8)}</span>
              <StateBadge state={t.state} />
            </div>
            <div className="mt-1.5 text-xs text-text-primary line-clamp-2 leading-relaxed">
              {t.user_request}
            </div>
            <div className="mt-1.5 text-2xs text-text-tertiary font-mono">
              迭代 {t.current_iteration}/{t.max_iterations}
            </div>
          </button>
        )
      })}
    </div>
  )
}
