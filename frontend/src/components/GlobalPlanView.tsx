/**
 * 顶层规划可视化（GlobalPlanView）
 *
 * 布局:
 *   ┌─ 顶层规划 ──────────────────────────────────────┐
 *   │ 总目标: 克隆并部署 lokibox                       │
 *   │ 进度: ▓▓▓▓▓░░░░░ 3/5 (60%)                      │
 *   ├─────────────────────────────────────────────────┤
 *   │ ✓ 1. 克隆仓库到本地                              │
 *   │   验收: .git 目录存在                            │
 *   │ → 3. 安装依赖                                    │
 *   │   验收: node_modules 创建                        │
 *   │ ○ 4. 配置环境变量                                │
 *   │   验收: .env 文件创建                            │
 *   └─────────────────────────────────────────────────┘
 *
 * - 接收 plan: GlobalPlan | null
 * - 进度条: bg-white/20 底 + bg-white 填充
 * - 步骤图标按 status 渲染（completed/in_progress/pending/failed/skipped）
 * - 当前步骤高亮: bg-elevated + 左侧白色竖条
 * - 空状态: 等待规划生成...
 */
import type { GlobalPlan, PlanStep, PlanStepStatus } from '../types'

interface GlobalPlanViewProps {
  plan: GlobalPlan | null
}

export function GlobalPlanView({ plan }: GlobalPlanViewProps) {
  if (!plan) {
    return (
      <section className="rounded-2xl border border-white/6 bg-white/3 px-4 py-3 animate-fade-in">
        <div className="flex items-center gap-2 mb-2">
          <PlanIcon />
          <span className="text-xs font-semibold text-text-primary">顶层规划</span>
        </div>
        <div className="text-2xs text-text-tertiary py-2 text-center">
          等待规划生成…
        </div>
      </section>
    )
  }

  const total = plan.steps.length
  const completed = plan.steps.filter((s) => s.status === 'completed').length
  const percent = total > 0 ? Math.round((completed / total) * 100) : 0

  return (
    <section className="rounded-2xl border border-white/6 bg-white/3 overflow-hidden animate-scale-in">
      {/* === 标题 + 总目标 + 进度条 === */}
      <div className="px-4 py-3 border-b border-white/5">
        <div className="flex items-center gap-2 mb-2">
          <PlanIcon />
          <span className="text-xs font-semibold text-text-primary">顶层规划</span>
          <span className="text-2xs text-text-tertiary font-mono ml-auto">
            {completed}/{total} · {percent}%
          </span>
        </div>
        <div className="text-xs text-text-secondary leading-relaxed mb-2">
          <span className="text-text-tertiary">总目标：</span>
          {plan.overall_goal}
        </div>
        {/* 进度条 */}
        <div className="relative h-1.5 rounded-full bg-white/12 overflow-hidden">
          <div
            className="absolute inset-y-0 left-0 bg-white rounded-full transition-all duration-300 ease-smooth"
            style={{ width: `${percent}%` }}
          />
        </div>
      </div>

      {/* === 步骤列表 === */}
      <div className="px-2 py-2 max-h-[280px] overflow-auto">
        {plan.steps.map((step) => (
          <PlanStepRow
            key={step.id}
            step={step}
            isCurrent={step.index === plan.current_step_index}
          />
        ))}
      </div>
    </section>
  )
}

/* ============== 单步渲染 ============== */

interface PlanStepRowProps {
  step: PlanStep
  isCurrent: boolean
}

function PlanStepRow({ step, isCurrent }: PlanStepRowProps) {
  return (
    <div
      className={`relative px-3 py-2 rounded-xl transition-colors duration-150
        ${isCurrent ? 'bg-surface-elevated' : 'hover:bg-white/4'}`}
    >
      {/* 当前步骤左侧竖条 */}
      {isCurrent && (
        <span className="absolute left-0 top-2 bottom-2 w-0.5 rounded-full bg-white" />
      )}
      <div className="flex items-start gap-2.5">
        <StepStatusIcon status={step.status} />
        <div className="min-w-0 flex-1">
          <div
            className={`text-xs leading-relaxed ${
              step.status === 'skipped'
                ? 'text-text-tertiary line-through'
                : 'text-text-primary'
            }`}
          >
            <span className="text-text-tertiary font-mono mr-1.5">{step.index}.</span>
            {step.goal}
          </div>
          {step.success_criteria && (
            <div className="mt-0.5 text-2xs text-text-tertiary leading-relaxed">
              <span className="font-mono">验收：</span>
              {step.success_criteria}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/* ============== 步骤状态图标 ============== */

function StepStatusIcon({ status }: { status: PlanStepStatus }) {
  switch (status) {
    case 'completed':
      return (
        <span className="flex-shrink-0 inline-flex items-center justify-center w-4 h-4 rounded-full bg-white text-black text-2xs font-bold mt-0.5">
          ✓
        </span>
      )
    case 'in_progress':
      return (
        <span className="flex-shrink-0 inline-flex items-center justify-center w-4 h-4 rounded-full border border-white/60 text-white text-2xs font-bold mt-0.5 animate-pulse-soft">
          →
        </span>
      )
    case 'failed':
      return (
        <span className="flex-shrink-0 inline-flex items-center justify-center w-4 h-4 rounded-full bg-warn text-white text-2xs font-bold mt-0.5">
          ✗
        </span>
      )
    case 'skipped':
      return (
        <span className="flex-shrink-0 inline-flex items-center justify-center w-4 h-4 rounded-full border border-white/15 text-text-tertiary text-2xs font-bold mt-0.5">
          -
        </span>
      )
    case 'pending':
    default:
      return (
        <span className="flex-shrink-0 inline-flex items-center justify-center w-4 h-4 rounded-full border border-white/30 text-transparent text-2xs font-bold mt-0.5">
          ○
        </span>
      )
  }
}

/* ============== 图标 ============== */

function PlanIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="none"
      className="text-text-secondary flex-shrink-0"
    >
      <rect
        x="2"
        y="2.5"
        width="12"
        height="11"
        rx="1.5"
        stroke="currentColor"
        strokeWidth="1.1"
      />
      <path
        d="M5 6h6M5 8.5h6M5 11h3.5"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinecap="round"
      />
    </svg>
  )
}
