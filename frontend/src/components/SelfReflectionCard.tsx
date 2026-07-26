/**
 * 自省校验日志卡片（SelfReflectionCard）
 *
 * 布局:
 *   ┌─ 自省校验 ──────────────────────────────────────┐
 *   │ ⚠ 检测到问题: 测试失败 (3 个用例未通过)         │
 *   │ 修复尝试: 2 次                                   │
 *   │ ✓ 已修复                                         │
 *   │ [展开日志 ▾]                                     │
 *   ├─────────────────────────────────────────────────┤
 *   │ > npm test                                      │
 *   │ FAIL src/auth.test.ts                           │
 *   │ 修复 Diff:                                       │
 *   │ --- a/src/auth.ts                               │
 *   │ +++ b/src/auth.ts                               │
 *   └─────────────────────────────────────────────────┘
 *
 * - 接收 result: ReflectionResult
 * - 状态徽标:
 *   - success + fixed  -> 白色 ✓ 已修复
 *   - success + no issue -> 灰色 无需修复
 *   - !success         -> 橙色 ⚠ 无法修复
 * - 日志默认折叠，点击展开 max-h-60 overflow-auto
 * - Diff 用 <pre> 等宽字体，绿色 + 行 / 红色 - 行
 */
import { useState } from 'react'
import type { ReflectionResult } from '../types'

interface SelfReflectionCardProps {
  result: ReflectionResult
}

export function SelfReflectionCard({ result }: SelfReflectionCardProps) {
  const [expanded, setExpanded] = useState(false)
  const badge = badgeOf(result)

  return (
    <div className="rounded-xl border border-white/8 bg-white/4 px-3 py-2.5 animate-slide-up-spring">
      {/* === 标题行：状态徽标 + 折叠按钮 === */}
      <div className="flex items-center gap-2 flex-wrap">
        <StatusBadge variant={badge.variant} icon={badge.icon} text={badge.text} />
        {result.fix_attempts > 0 && (
          <span className="text-2xs text-text-tertiary font-mono">
            修复尝试：{result.fix_attempts} 次
          </span>
        )}
        <button
          onClick={() => setExpanded((v) => !v)}
          className="ml-auto text-2xs text-text-tertiary hover:text-text-secondary transition-colors inline-flex items-center gap-1"
        >
          <ChevronIcon open={expanded} />
          {expanded ? '收起日志' : '展开日志'}
        </button>
      </div>

      {/* === 问题摘要 === */}
      {result.issue && (
        <div className="mt-1.5 text-xs text-text-secondary leading-relaxed">
          <span className="text-text-tertiary">检测到问题：</span>
          {result.issue}
        </div>
      )}

      {/* === 展开内容：日志 + Diff === */}
      {expanded && (
        <div className="mt-2 space-y-2 max-h-60 overflow-auto pr-1">
          {result.log && (
            <div>
              <FieldLabel>日志</FieldLabel>
              <pre
                className="px-2.5 py-2 rounded-md bg-black/30 text-2xs font-mono whitespace-pre-wrap break-all text-text-secondary"
                data-selectable="true"
              >
                {result.log}
              </pre>
            </div>
          )}
          {result.fix_diffs.length > 0 && (
            <div>
              <FieldLabel>修复 Diff</FieldLabel>
              <div className="space-y-1.5">
                {result.fix_diffs.map((diff, i) => (
                  <DiffBlock key={i} diff={diff} />
                ))}
              </div>
            </div>
          )}
          {!result.log && result.fix_diffs.length === 0 && (
            <div className="text-2xs text-text-tertiary italic px-1 py-1">
              （无详细日志）
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/* ============== 状态徽标 ============== */

type BadgeVariant = 'success' | 'neutral' | 'warn'

interface BadgeInfo {
  variant: BadgeVariant
  icon: string
  text: string
}

function badgeOf(r: ReflectionResult): BadgeInfo {
  if (!r.success) {
    return { variant: 'warn', icon: '⚠', text: '无法修复' }
  }
  if (!r.issue) {
    return { variant: 'neutral', icon: '✓', text: '无需修复' }
  }
  // success + issue：根据 fixed 字段区分
  return r.fixed
    ? { variant: 'success', icon: '✓', text: '已修复' }
    : { variant: 'warn', icon: '⚠', text: '未修复' }
}

function StatusBadge({
  variant,
  icon,
  text,
}: {
  variant: BadgeVariant
  icon: string
  text: string
}) {
  const cls =
    variant === 'success'
      ? 'bg-white text-black'
      : variant === 'warn'
        ? 'bg-warn/20 text-warn'
        : 'bg-white/8 text-text-tertiary'
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-2xs font-semibold ${cls}`}
    >
      <span className="text-2xs">{icon}</span>
      {text}
    </span>
  )
}

/* ============== Diff 渲染 ============== */

function DiffBlock({ diff }: { diff: string }) {
  const lines = diff.split(/\r?\n/)
  return (
    <pre
      className="px-2.5 py-2 rounded-md bg-black/40 text-2xs font-mono whitespace-pre-wrap break-all overflow-hidden"
      data-selectable="true"
    >
      {lines.map((line, i) => (
        <DiffLine key={i} line={line} />
      ))}
    </pre>
  )
}

function DiffLine({ line }: { line: string }) {
  let cls = 'text-text-secondary'
  if (line.startsWith('+') && !line.startsWith('+++')) {
    cls = 'text-diff-addedText bg-diff-added/40'
  } else if (line.startsWith('-') && !line.startsWith('---')) {
    cls = 'text-diff-removedText bg-diff-removed/40'
  } else if (line.startsWith('@@')) {
    cls = 'text-text-tertiary'
  }
  return <div className={`px-1 ${cls}`}>{line || ' '}</div>
}

/* ============== 通用小组件 ============== */

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-2xs uppercase tracking-wider text-text-tertiary font-mono mb-0.5">
      {children}
    </div>
  )
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="9"
      height="9"
      viewBox="0 0 16 16"
      fill="none"
      className={`text-text-tertiary transition-transform duration-150 ${open ? 'rotate-90' : ''}`}
    >
      <path
        d="M5 3l6 5-6 5"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
