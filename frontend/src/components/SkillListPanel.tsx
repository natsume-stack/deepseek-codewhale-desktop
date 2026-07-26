/**
 * Skill 列表面板（Codex 风格 - P0）
 *
 *  - 展示所有 Skill 列表（按 category 分组）
 *  - 每项：名称、描述、触发词、启用开关、分类徽标
 *  - 点击 Skill 查看完整定义（弹出 modal）
 *  - 「创建技能」按钮：弹出表单输入 id/name/description/triggers/rawMarkdown
 *  - 「编辑 AGENTS.md」按钮：弹出编辑器
 *  - 视觉：Codex 风格卡片，圆角 8px
 *
 * 用法：
 *   <SkillListPanel />              // 内嵌模式（占满父容器）
 *   <SkillListPanel floating onClose={...} /> // 浮层模式
 */
import { useEffect, useMemo, useState } from 'react'
import { useSkillsStore, selectSkillsByCategory } from '../stores/skills'
import { useDialogStore } from '../stores/dialog'
import type { SkillMeta } from '../types'

interface SkillListPanelProps {
  /** 浮层模式：true 时渲染为模态遮罩，需配合 onClose */
  floating?: boolean
  onClose?: () => void
}

export function SkillListPanel({ floating, onClose }: SkillListPanelProps) {
  const skills = useSkillsStore((s) => s.skills)
  const loading = useSkillsStore((s) => s.loading)
  const error = useSkillsStore((s) => s.error)
  const fetchAll = useSkillsStore((s) => s.fetchAll)
  const toggle = useSkillsStore((s) => s.toggle)
  const remove = useSkillsStore((s) => s.remove)
  const create = useSkillsStore((s) => s.create)
  const fetchAgentsMd = useSkillsStore((s) => s.fetchAgentsMd)
  const saveAgentsMd = useSkillsStore((s) => s.saveAgentsMd)

  const [detailSkillId, setDetailSkillId] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [agentsOpen, setAgentsOpen] = useState(false)

  useEffect(() => {
    void fetchAll()
  }, [fetchAll])

  const grouped = useMemo(() => selectSkillsByCategory(skills), [skills])
  const categories = Object.keys(grouped).sort()
  const enabledCount = skills.filter((s) => s.enabled).length

  const body = (
    <div className="h-full flex flex-col">
      {/* === 顶部操作条 === */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/5">
        <div className="flex items-center gap-2 min-w-0">
          <SkillIcon />
          <span className="text-sm font-semibold text-text-primary">技能</span>
          <span className="text-2xs text-text-tertiary font-mono">
            {enabledCount}/{skills.length} 已启用
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setAgentsOpen(true)}
            className="btn-secondary !py-1 !px-2 !text-2xs"
            title="编辑 AGENTS.md"
          >
            <DocIcon />
            AGENTS.md
          </button>
          <button
            onClick={() => setCreateOpen(true)}
            className="btn-primary !py-1 !px-2 !text-2xs"
            title="创建新技能"
          >
            <PlusIcon />
            创建技能
          </button>
          <button
            onClick={() => void fetchAll()}
            disabled={loading}
            className="icon-btn !p-1"
            title="刷新"
          >
            <RefreshIcon spinning={loading} />
          </button>
          {floating && (
            <button onClick={() => onClose?.()} className="icon-btn !p-1" title="关闭">
              <CloseIcon />
            </button>
          )}
        </div>
      </div>

      {/* === 错误条 === */}
      {error && (
        <div className="px-4 py-1.5 text-2xs text-diff-removed-text bg-diff-removed/20 border-b border-diff-removed/40">
          {error}
        </div>
      )}

      {/* === 列表（按 category 分组） === */}
      <div className="flex-1 overflow-auto p-3 space-y-4">
        {skills.length === 0 && !loading ? (
          <EmptyHint
            icon={<SkillIcon />}
            text="暂无技能。点击「创建技能」新增，或编辑 AGENTS.md 注入技能描述。"
          />
        ) : (
          categories.map((cat) => (
            <div key={cat}>
              <div className="text-2xs uppercase tracking-wider text-text-tertiary font-mono px-1 pb-1.5">
                {cat}（{grouped[cat].length}）
              </div>
              <div className="space-y-1.5">
                {grouped[cat].map((s) => (
                  <SkillCard
                    key={s.id}
                    skill={s}
                    onToggle={() => void toggle(s.id)}
                    onClick={() => setDetailSkillId(s.id)}
                    onDelete={async () => {
                      const ok = await useDialogStore.getState().confirm({
                        title: '删除技能',
                        message: `确认删除技能「${s.name}」？此操作不可撤销。`,
                        danger: true,
                        confirmText: '删除',
                      })
                      if (ok) void remove(s.id)
                    }}
                  />
                ))}
              </div>
            </div>
          ))
        )}
      </div>

      {/* === 详情 Modal === */}
      {detailSkillId && (
        <SkillDetailModal
          skillId={detailSkillId}
          onClose={() => setDetailSkillId(null)}
        />
      )}

      {/* === 创建表单 Modal === */}
      {createOpen && (
        <CreateSkillModal
          onClose={() => setCreateOpen(false)}
          onCreate={async (body) => {
            const def = await create(body)
            if (def) {
              setCreateOpen(false)
              setDetailSkillId(def.meta.id)
            }
          }}
        />
      )}

      {/* === AGENTS.md 编辑器 Modal === */}
      {agentsOpen && (
        <AgentsMdModal
          onClose={() => setAgentsOpen(false)}
          onOpen={() => void fetchAgentsMd()}
          onSave={async (content) => {
            const ok = await saveAgentsMd(content)
            if (ok) setAgentsOpen(false)
          }}
        />
      )}
    </div>
  )

  if (floating) {
    return (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm animate-fade-in"
        onClick={() => onClose?.()}
      >
        <div
          className="w-[680px] max-w-[94vw] max-h-[85vh] rounded-3xl border border-surface-border bg-surface-elevated shadow-raised animate-scale-in flex flex-col overflow-hidden"
          onClick={(e) => e.stopPropagation()}
        >
          {body}
        </div>
      </div>
    )
  }

  return body
}

/* ============== 单条技能卡片 ============== */

interface SkillCardProps {
  skill: SkillMeta
  onToggle: () => void
  onClick: () => void
  onDelete: () => void
}

function SkillCard({ skill, onToggle, onClick, onDelete }: SkillCardProps) {
  return (
    <div
      className="group px-4 py-3 rounded-xl border border-white/6 bg-surface-elevated/60 hover:bg-white/8 hover:border-white/12 transition-all duration-200 ease-bounce cursor-pointer hover:scale-[1.01]"
      onClick={onClick}
    >
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex-shrink-0">
          <SkillKindIcon category={skill.category} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-sm font-medium text-text-primary truncate">
              {skill.name}
            </span>
            <span className="px-1 py-0.5 rounded text-2xs font-mono bg-accent/12 text-accent border border-accent/20">
              {skill.category}
            </span>
            {skill.builtin && (
              <span className="px-1 py-0.5 rounded text-2xs font-mono bg-white/8 text-text-tertiary">
                内置
              </span>
            )}
            <span className="text-2xs text-text-tertiary font-mono">v{skill.version}</span>
          </div>
          <div className="text-2xs text-text-tertiary mt-1 leading-relaxed line-clamp-2">
            {skill.description}
          </div>
          {skill.triggers.length > 0 && (
            <div className="mt-1.5 flex items-center gap-1 flex-wrap">
              {skill.triggers.slice(0, 4).map((t) => (
                <span
                  key={t}
                  className="px-1.5 py-0.5 rounded text-2xs font-mono bg-white/6 text-text-secondary border border-white/8"
                >
                  {t}
                </span>
              ))}
              {skill.triggers.length > 4 && (
                <span className="text-2xs text-text-tertiary">
                  +{skill.triggers.length - 4}
                </span>
              )}
            </div>
          )}
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          <button
            onClick={(e) => {
              e.stopPropagation()
              onDelete()
            }}
            className="icon-btn !p-1 opacity-0 group-hover:opacity-100"
            title="删除"
          >
            <TrashIcon />
          </button>
          <ToggleSwitch enabled={skill.enabled} onToggle={onToggle} />
        </div>
      </div>
    </div>
  )
}

/* ============== 详情 Modal ============== */

function SkillDetailModal({
  skillId,
  onClose,
}: {
  skillId: string
  onClose: () => void
}) {
  const definition = useSkillsStore((s) => s.definitions[skillId])
  const skills = useSkillsStore((s) => s.skills)
  const fetchDefinition = useSkillsStore((s) => s.fetchDefinition)
  const [loading, setLoading] = useState(!definition)

  const meta = skills.find((s) => s.id === skillId)

  useEffect(() => {
    if (!definition) {
      setLoading(true)
      void fetchDefinition(skillId).finally(() => setLoading(false))
    }
  }, [skillId, definition, fetchDefinition])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm animate-fade-in"
      onClick={onClose}
    >
      <div
        className="w-[600px] max-w-[94vw] max-h-[82vh] rounded-3xl border border-surface-border bg-surface-elevated shadow-raised animate-scale-in flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/8">
          <div className="flex items-center gap-2 min-w-0">
            <SkillIcon />
            <span className="text-sm font-semibold text-text-primary truncate">
              {meta?.name ?? skillId}
            </span>
            {meta && (
              <span className="text-2xs text-text-tertiary font-mono">
                v{meta.version} · {meta.category}
              </span>
            )}
          </div>
          <button onClick={onClose} className="icon-btn !p-1" title="关闭">
            <CloseIcon />
          </button>
        </div>
        <div className="flex-1 overflow-auto p-4 space-y-3">
          {loading ? (
            <div className="text-2xs text-text-tertiary">加载中…</div>
          ) : definition ? (
            <>
              <Section title="描述">
                <p className="text-xs text-text-secondary leading-relaxed">
                  {definition.meta.description}
                </p>
              </Section>
              <Section title="触发词">
                <div className="flex flex-wrap gap-1">
                  {definition.meta.triggers.map((t) => (
                    <span
                      key={t}
                      className="px-1.5 py-0.5 rounded text-2xs font-mono bg-white/6 text-text-secondary border border-white/8"
                    >
                      {t}
                    </span>
                  ))}
                </div>
              </Section>
              <Section title={`执行步骤（${definition.steps.length}）`}>
                <ol className="space-y-1.5">
                  {definition.steps.map((st) => (
                    <li
                      key={st.order}
                      className="px-2.5 py-2 rounded bg-white/4 border border-white/8"
                    >
                      <div className="flex items-center gap-2 mb-0.5">
                        <span className="w-5 h-5 rounded-full bg-accent/15 text-accent text-2xs font-mono flex items-center justify-center flex-shrink-0">
                          {st.order}
                        </span>
                        <span className="text-2xs font-mono text-text-tertiary">
                          {st.action}
                        </span>
                      </div>
                      <div className="text-xs text-text-primary pl-7">
                        {st.description}
                      </div>
                      {st.todoText && (
                        <div className="text-2xs text-text-tertiary pl-7 mt-0.5">
                          → 待办：{st.todoText}
                        </div>
                      )}
                    </li>
                  ))}
                </ol>
              </Section>
              <Section title="所需工具">
                <div className="flex flex-wrap gap-1">
                  {definition.requiredTools.map((t) => (
                    <span
                      key={t}
                      className="px-1.5 py-0.5 rounded text-2xs font-mono bg-white/6 text-text-secondary border border-white/8"
                    >
                      {t}
                    </span>
                  ))}
                </div>
              </Section>
              <Section title="默认权限">
                <span className="px-1.5 py-0.5 rounded text-2xs font-mono bg-accent/12 text-accent border border-accent/20">
                  {definition.defaultPermission}
                </span>
              </Section>
              <Section title="原始 Markdown">
                <pre className="text-2xs font-mono text-text-secondary bg-black/30 border border-white/8 rounded p-2.5 overflow-auto max-h-48 whitespace-pre-wrap break-words">
                  {definition.rawMarkdown}
                </pre>
              </Section>
            </>
          ) : (
            <div className="text-2xs text-diff-removed-text">加载失败</div>
          )}
        </div>
      </div>
    </div>
  )
}

/* ============== 创建技能 Modal ============== */

interface CreateSkillBody {
  id: string
  name: string
  description: string
  triggers: string[]
  rawMarkdown: string
}

function CreateSkillModal({
  onClose,
  onCreate,
}: {
  onClose: () => void
  onCreate: (body: CreateSkillBody) => Promise<void>
}) {
  const [id, setId] = useState('')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [triggersText, setTriggersText] = useState('')
  const [rawMarkdown, setRawMarkdown] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const handleSubmit = async () => {
    if (!id.trim() || !name.trim()) return
    setSubmitting(true)
    try {
      await onCreate({
        id: id.trim(),
        name: name.trim(),
        description: description.trim(),
        triggers: triggersText
          .split(/[\s,]+/)
          .map((s) => s.trim())
          .filter(Boolean),
        rawMarkdown: rawMarkdown,
      })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm animate-fade-in"
      onClick={onClose}
    >
      <div
        className="w-[560px] max-w-[94vw] max-h-[85vh] rounded-3xl border border-surface-border bg-surface-elevated shadow-raised animate-scale-in flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/8">
          <div className="flex items-center gap-2">
            <PlusIcon />
            <span className="text-sm font-semibold text-text-primary">创建技能</span>
          </div>
          <button onClick={onClose} className="icon-btn !p-1" title="关闭">
            <CloseIcon />
          </button>
        </div>
        <div className="flex-1 overflow-auto p-4 space-y-3">
          <Field label="ID（唯一标识）" required>
            <input
              type="text"
              value={id}
              onChange={(e) => setId(e.target.value)}
              placeholder="如：refactor-extract-function"
              className="input-base"
              data-selectable="true"
              spellCheck={false}
            />
          </Field>
          <Field label="名称" required>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="如：抽取函数重构"
              className="input-base"
              data-selectable="true"
              spellCheck={false}
            />
          </Field>
          <Field label="描述">
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="技能用途与适用场景的简短描述…"
              rows={2}
              className="input-base resize-none"
              data-selectable="true"
              spellCheck={false}
            />
          </Field>
          <Field label="触发词（空格或逗号分隔）">
            <input
              type="text"
              value={triggersText}
              onChange={(e) => setTriggersText(e.target.value)}
              placeholder="重构 抽取 extract"
              className="input-base"
              data-selectable="true"
              spellCheck={false}
            />
          </Field>
          <Field label="原始 Markdown（SKILL.md 内容）">
            <textarea
              value={rawMarkdown}
              onChange={(e) => setRawMarkdown(e.target.value)}
              placeholder={'---\nid: ...\nname: ...\n---\n\n## Steps\n1. ...'}
              rows={6}
              className="input-base resize-none font-mono !text-2xs"
              data-selectable="true"
              spellCheck={false}
            />
          </Field>
        </div>
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-white/8">
          <button onClick={onClose} className="btn-secondary !py-1 !px-3 !text-xs">
            取消
          </button>
          <button
            onClick={handleSubmit}
            disabled={submitting || !id.trim() || !name.trim()}
            className="btn-primary !py-1 !px-3 !text-xs"
          >
            {submitting ? '提交中…' : '创建'}
          </button>
        </div>
      </div>
    </div>
  )
}

/* ============== AGENTS.md 编辑器 Modal ============== */

function AgentsMdModal({
  onClose,
  onOpen,
  onSave,
}: {
  onClose: () => void
  onOpen: () => void
  onSave: (content: string) => Promise<void>
}) {
  const agentsMd = useSkillsStore((s) => s.agentsMd)
  const [draft, setDraft] = useState(agentsMd)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (agentsMd === '' && draft === '') {
      onOpen()
    }
    // 仅在首次挂载或外部刷新后同步
    setDraft(agentsMd)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentsMd])

  const handleSave = async () => {
    setSaving(true)
    try {
      await onSave(draft)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm animate-fade-in"
      onClick={onClose}
    >
      <div
        className="w-[680px] max-w-[94vw] h-[82vh] rounded-3xl border border-surface-border bg-surface-elevated shadow-raised animate-scale-in flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/8">
          <div className="flex items-center gap-2">
            <DocIcon />
            <span className="text-sm font-semibold text-text-primary">编辑 AGENTS.md</span>
          </div>
          <button onClick={onClose} className="icon-btn !p-1" title="关闭">
            <CloseIcon />
          </button>
        </div>
        <div className="flex-1 min-h-0 p-3">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="在此输入 AGENTS.md 内容…"
            className="w-full h-full resize-none bg-black/30 border border-white/8 rounded p-3 text-2xs font-mono text-text-primary placeholder-text-tertiary focus:outline-none focus:border-accent/40"
            data-selectable="true"
            spellCheck={false}
          />
        </div>
        <div className="flex items-center justify-between gap-2 px-4 py-3 border-t border-white/8">
          <span className="text-2xs text-text-tertiary font-mono">
            {draft.length} 字符
          </span>
          <div className="flex items-center gap-2">
            <button onClick={onClose} className="btn-secondary !py-1 !px-3 !text-xs">
              取消
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="btn-primary !py-1 !px-3 !text-xs"
            >
              {saving ? '保存中…' : '保存'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

/* ============== 共用小组件 ============== */

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-2xs uppercase tracking-wider text-text-tertiary font-mono mb-1.5">
        {title}
      </div>
      {children}
    </div>
  )
}

function Field({
  label,
  required,
  children,
}: {
  label: string
  required?: boolean
  children: React.ReactNode
}) {
  return (
    <div>
      <div className="text-2xs text-text-secondary mb-1">
        {label}
        {required && <span className="text-accent"> *</span>}
      </div>
      {children}
    </div>
  )
}

function EmptyHint({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-2 text-center px-4">
      <span className="opacity-40">{icon}</span>
      <div className="text-xs text-text-tertiary leading-relaxed">{text}</div>
    </div>
  )
}

function ToggleSwitch({ enabled, onToggle }: { enabled: boolean; onToggle: () => void }) {
  return (
    <button
      onClick={(e) => {
        e.stopPropagation()
        onToggle()
      }}
      className={`flex-shrink-0 w-11 h-6 rounded-full transition-all duration-300 ease-bounce hover:scale-105 ${enabled ? 'bg-white' : 'bg-white/12'}`}
      role="switch"
      aria-checked={enabled}
      title={enabled ? '点击禁用' : '点击启用'}
    >
      <div
        className={`w-5 h-5 rounded-full bg-black shadow-md transition-transform duration-300 ease-bounce ${enabled ? 'translate-x-5' : 'translate-x-0.5'}`}
      />
    </button>
  )
}

/* ============== 图标 ============== */

function SkillIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" className="text-accent">
      <path d="M8 1.5l1.5 3 3.5.5-2.5 2.4.6 3.4L8 9.2 4.9 10.8l.6-3.4L2.9 5l3.5-.5L8 1.5z" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" />
    </svg>
  )
}

function SkillKindIcon({ category }: { category: string }) {
  const color =
    category === 'refactor'
      ? 'text-accent'
      : category === 'test'
        ? 'text-emerald-400'
        : category === 'doc'
          ? 'text-sky-400'
          : 'text-orange-400'
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" className={color}>
      <path d="M3 2h6l3 3v9H3V2z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
      <path d="M9 2v3h3M5.5 8.5h5M5.5 10.5h5M5.5 12.5h3" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
    </svg>
  )
}

function PlusIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
      <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

function DocIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
      <path d="M3 2h6l3 3v9H3V2z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
      <path d="M9 2v3h3M5.5 8.5h5M5.5 10.5h5M5.5 12.5h3" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
    </svg>
  )
}

function TrashIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
      <path d="M3 4h10M6 4V2h4v2M5 4l1 9h4l1-9" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function CloseIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
      <line x1="4" y1="4" x2="12" y2="12" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <line x1="12" y1="4" x2="4" y2="12" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

function RefreshIcon({ spinning }: { spinning?: boolean }) {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" className={spinning ? 'animate-spin' : ''}>
      <path d="M13 8a5 5 0 11-1.5-3.5M13 2v3h-3" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  )
}
