/**
 * 右侧参数控制面板
 *
 * 三个 Expander 分组：
 *  1. API 配置：API Key / Base URL / 模型 / 测试连接
 *  2. 模型参数：推理强度 / 上下文缓存 / 上下文消息数（覆盖本轮）
 *  3. 会话管理：重置当前会话上下文
 *
 * 接口：
 *  - GET/PUT /api/config/deepseek
 *  - POST /api/config/deepseek/test
 *  - GET/PUT /api/params
 *  - POST /api/sessions/:id/reset
 */
import { useEffect, useState } from 'react'
import { configApi, paramsApi, type SetDeepSeekBody } from '../lib/api'
import { useChatStore } from '../stores/chat'
import { useDialogStore } from '../stores/dialog'
import type { DeepSeekConfig, InferenceParams, ReasoningEffort } from '../types'
import { SelectMenu } from './SettingsPage'

const EFFORTS: { value: ReasoningEffort; label: string; hint: string }[] = [
  { value: 'minimal', label: '极速', hint: '最低推理开销' },
  { value: 'low', label: '低', hint: '简短推理' },
  { value: 'medium', label: '中', hint: '均衡模式（默认）' },
  { value: 'high', label: '高', hint: '深度推理' },
]

const MODELS = ['deepseek-chat', 'deepseek-reasoner'] as const

export function ParamsPanel({ embedded = false }: { embedded?: boolean }) {
  const [connected, setConnected] = useState<boolean | null>(null)

  // DeepSeek 配置
  const [dsConfig, setDsConfig] = useState<DeepSeekConfig | null>(null)
  const [apiKeyInput, setApiKeyInput] = useState('')
  const [baseUrlInput, setBaseUrlInput] = useState('')
  const [modelInput, setModelInput] = useState<string>('deepseek-chat')
  const [savingCfg, setSavingCfg] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testMsg, setTestMsg] = useState<{ ok: boolean; text: string } | null>(null)

  // 推理参数
  const [params, setParams] = useState<InferenceParams | null>(null)
  const [effort, setEffort] = useState<ReasoningEffort>('medium')
  const [cache, setCache] = useState(true)
  const [ctxLen, setCtxLen] = useState(20)
  const [savingParams, setSavingParams] = useState(false)

  const sessionId = useChatStore((s) => s.sessionId)
  const streaming = useChatStore((s) => s.streaming)
  const resetSession = useChatStore((s) => s.resetSession)
  const setOverrides = useChatStore((s) => s.setOverrides)

  // 初次加载
  useEffect(() => {
    void loadConfig()
    void loadParams()
  }, [])

  // 同步覆盖参数到 chatStore（影响下一轮 SSE 请求）
  useEffect(() => {
    setOverrides({ reasoningEffort: effort, cacheEnabled: cache, contextLength: ctxLen })
  }, [effort, cache, ctxLen, setOverrides])

  async function loadConfig() {
    try {
      const c = await configApi.get()
      setDsConfig(c)
      setBaseUrlInput(c.baseUrl)
      setModelInput(c.model)
      setConnected(c.configured)
    } catch {
      setConnected(false)
    }
  }

  async function loadParams() {
    try {
      const p = await paramsApi.get()
      setParams(p)
      setEffort(p.reasoningEffort)
      setCache(p.cacheEnabled)
      setCtxLen(p.contextLength)
    } catch {
      /* ignore */
    }
  }

  async function handleSaveConfig() {
    setSavingCfg(true)
    try {
      const body: SetDeepSeekBody = {
        baseUrl: baseUrlInput,
        model: modelInput,
      }
      if (apiKeyInput.trim()) body.apiKey = apiKeyInput.trim()
      const c = await configApi.set(body)
      setDsConfig(c)
      setApiKeyInput('')
      setConnected(c.configured)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      await useDialogStore.getState().alert({ title: '保存失败', message: msg })
    } finally {
      setSavingCfg(false)
    }
  }

  async function handleTest() {
    setTesting(true)
    setTestMsg(null)
    try {
      const r = await configApi.test()
      setTestMsg({ ok: true, text: `连接成功：${r.model}` })
      setConnected(true)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setTestMsg({ ok: false, text: `失败：${msg}` })
      setConnected(false)
    } finally {
      setTesting(false)
    }
  }

  async function handleSaveParams() {
    setSavingParams(true)
    try {
      const p = await paramsApi.update({
        reasoningEffort: effort,
        cacheEnabled: cache,
        contextLength: ctxLen,
      })
      setParams(p)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      await useDialogStore.getState().alert({ title: '保存参数失败', message: msg })
    } finally {
      setSavingParams(false)
    }
  }

  async function handleResetSession() {
    if (streaming) {
      await useDialogStore.getState().alert({ title: '提示', message: '请先停止当前生成' })
      return
    }
    const ok = await useDialogStore.getState().confirm({
      title: '重置会话上下文',
      message: '确认重置当前会话上下文？此操作不可撤销。',
      confirmText: '重置',
      danger: true,
    })
    if (!ok) return
    await resetSession()
  }

  return (
    <div className={`flex flex-col h-full ${embedded ? '' : 'border-l border-white/5'}`}>
      {/* 顶部状态条 */}
      {!embedded && (
        <div className="panel-header">
          <div className="flex items-center gap-2">
            <StatusDot state={connected} />
            <span className="text-xs text-text-secondary">
              {connected === null ? '检测中…' : connected ? '已连接' : '未配置'}
            </span>
          </div>
          {dsConfig?.configured && (
            <span className="text-2xs font-mono text-text-tertiary">{dsConfig.apiKeyMasked}</span>
          )}
        </div>
      )}

      <div className="flex-1 overflow-auto p-3 space-y-2">
        {/* 1. API 配置 */}
        <Expander title="API 配置" defaultOpen>
          <div className="space-y-2.5 pt-2">
            <Field label="后端地址">
              <input
                className="input-base"
                placeholder="https://api.deepseek.com"
                value={baseUrlInput}
                onChange={(e) => setBaseUrlInput(e.target.value)}
                data-selectable="true"
                spellCheck={false}
              />
            </Field>
            <Field label="API 密钥" hint={dsConfig?.apiKeyMasked ? `当前：${dsConfig.apiKeyMasked}` : undefined}>
              <input
                type="password"
                className="input-base"
                placeholder={dsConfig?.configured ? '已配置（留空则不修改）' : 'sk-...'}
                value={apiKeyInput}
                onChange={(e) => setApiKeyInput(e.target.value)}
                data-selectable="true"
                spellCheck={false}
              />
            </Field>
            <Field label="模型">
              <SelectMenu
                value={MODELS.includes(modelInput as typeof MODELS[number]) ? modelInput : ''}
                onChange={(value) => setModelInput(value || 'deepseek-chat')}
                options={[
                  ...MODELS.map((value) => ({ value, label: value })),
                  ...(!MODELS.includes(modelInput as typeof MODELS[number]) ? [{ value: modelInput, label: `${modelInput}（自定义）` }] : []),
                ]}
              />
            </Field>
            <div className="flex gap-1.5">
              <button
                onClick={handleSaveConfig}
                disabled={savingCfg}
                className="btn-primary flex-1"
              >
                {savingCfg ? '保存中…' : '保存配置'}
              </button>
              <button
                onClick={handleTest}
                disabled={testing || !dsConfig?.configured}
                className="btn-secondary flex-1"
              >
                {testing ? '测试中…' : '测试连接'}
              </button>
            </div>
            {testMsg && (
              <div className={`text-2xs px-2 py-1 rounded ${testMsg.ok ? 'text-diff-added-text bg-diff-added/30' : 'text-diff-removed-text bg-diff-removed/30'}`}>
                {testMsg.text}
              </div>
            )}
          </div>
        </Expander>

        {/* 2. 模型参数 */}
        <Expander title="模型参数" defaultOpen>
          <div className="space-y-2.5 pt-2">
            <Field label="推理强度">
              <div className="grid grid-cols-4 gap-1">
                {EFFORTS.map((e) => (
                  <button
                    key={e.value}
                    onClick={() => setEffort(e.value)}
                    title={e.hint}
                    className={`px-2 py-1.5 rounded text-2xs transition-colors
                      ${effort === e.value
                        ? 'bg-white text-black'
                        : 'bg-white/6 text-text-secondary border border-white/8 hover:bg-white/12'
                      }`}
                  >
                    {e.label}
                  </button>
                ))}
              </div>
            </Field>
            <div className="flex items-center justify-between py-1">
              <div>
                <div className="text-2xs text-text-secondary">上下文缓存</div>
                <div className="text-2xs text-text-tertiary">DeepSeek 前缀缓存，降低重复请求成本</div>
              </div>
              <ToggleSwitch on={cache} onChange={setCache} />
            </div>
            <Field label="上下文消息数" hint="参与推理的历史消息条数">
              <input
                type="number"
                className="input-base"
                min={1}
                max={200}
                value={ctxLen}
                onChange={(e) => {
                  const v = parseInt(e.target.value, 10)
                  if (!Number.isNaN(v)) setCtxLen(Math.max(1, Math.min(200, v)))
                }}
                data-selectable="true"
              />
            </Field>
            <button
              onClick={handleSaveParams}
              disabled={savingParams}
              className="btn-secondary w-full"
            >
              {savingParams ? '保存中…' : '保存为默认参数'}
            </button>
            <div className="text-2xs text-text-tertiary leading-relaxed">
              参数变更将作为下一轮对话的覆盖项；点击"保存为默认参数"会持久化到后端 config.toml。
            </div>
          </div>
        </Expander>

        {/* 3. 会话管理 */}
        <Expander title="会话管理">
          <div className="space-y-2 pt-2">
            <div className="text-2xs text-text-tertiary leading-relaxed">
              当前会话 ID：
              <span className="font-mono text-text-secondary">
                {sessionId ? sessionId.slice(0, 8) + '…' : '（尚未创建）'}
              </span>
            </div>
            <button
              onClick={handleResetSession}
              disabled={streaming || !sessionId}
              className="btn-secondary w-full"
            >
              重置当前会话上下文
            </button>
            <div className="text-2xs text-text-tertiary leading-relaxed">
              清空消息历史但保留会话 ID 与项目根。
            </div>
          </div>
        </Expander>

        {/* 配置摘要 */}
        {params && (
          <div className="mt-2 px-3 py-2 rounded border border-white/8 bg-white/4 text-2xs text-text-tertiary leading-relaxed">
            <div>当前默认：effort=<span className="text-text-secondary">{params.reasoningEffort}</span> · cache=<span className="text-text-secondary">{params.cacheEnabled ? 'on' : 'off'}</span> · ctx=<span className="text-text-secondary">{params.contextLength}</span></div>
          </div>
        )}
      </div>
    </div>
  )
}

/* ============== 子组件 ============== */

function Expander({
  title,
  defaultOpen = false,
  children,
}: {
  title: string
  defaultOpen?: boolean
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="border border-white/8 rounded overflow-hidden bg-white/3">
      <button
        className="w-full flex items-center justify-between px-3 py-2 text-sm text-text-primary hover:bg-white/6 transition-colors"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="font-medium">{title}</span>
        <ChevronIcon open={open} />
      </button>
      {open && (
        <div className="px-3 pb-3 animate-fade-in">
          {children}
        </div>
      )}
    </div>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="flex items-center justify-between mb-1">
        <span className="text-2xs text-text-secondary">{label}</span>
        {hint && <span className="text-2xs text-text-tertiary">{hint}</span>}
      </label>
      {children}
    </div>
  )
}

function StatusDot({ state }: { state: boolean | null }) {
  const cls =
    state === null ? 'bg-text-tertiary' :
    state ? 'bg-diff-added-text' : 'bg-diff-removed-text'
  return <div className={`w-2 h-2 rounded-full ${cls} ${state === null ? 'animate-pulse-soft' : ''}`} />
}

function ToggleSwitch({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      className={`w-8 h-4 rounded-full transition-colors ${on ? 'bg-accent' : 'bg-white/12'}`}
      onClick={() => onChange(!on)}
      role="switch"
      aria-checked={on}
    >
      <div
        className={`w-3 h-3 rounded-full bg-white transition-transform ${on ? 'translate-x-4' : 'translate-x-0.5'}`}
      />
    </button>
  )
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      className={`text-text-tertiary transition-transform duration-150 ${open ? 'rotate-90' : ''}`}
    >
      <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
