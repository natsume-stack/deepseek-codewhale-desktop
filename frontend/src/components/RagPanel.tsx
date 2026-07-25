/**
 * RAG 召回面板（参考 Reasonix）
 *
 *  ┌──────────────────────────────────────────┐
 *  │ 索引状态：N 文件 · M tokens  [重建] [清空]  │
 *  ├──────────────────────────────────────────┤
 *  │ [搜索框]                          [搜索]   │
 *  ├──────────────────────────────────────────┤
 *  │ 召回 8 片段（已裁剪）                       │
 *  │  ┌────────────────────────────────────┐  │
 *  │  │ src/main.rs  L1-L40   120 tokens   │  │
 *  │  │ 代码内容预览（前 200 字符）…          │  │
 *  │  └────────────────────────────────────┘  │
 *  │  ... 更多召回结果                         │
 *  └──────────────────────────────────────────┘
 *
 * 视觉：与 ChangesTab 风格一致，圆角 8px 半透明卡片。
 *
 * 依赖 Agent 4 提供 ragApi（recall / indexStatus / rebuild / clear）。
 * 在 Agent 4 完成前，使用 runtime 防御兜底，避免崩溃。
 */
import { useCallback, useEffect, useState } from 'react'
import { ragApi } from '../lib/api'

/* ============== 本地类型定义 ==============
 * 与 Agent 4 在 types.ts 中追加的 RagRecall / RagIndex 形状对齐；
 * 此处定义仅为本组件内部使用，避免依赖未完成的类型扩展。
 */
interface RagRecall {
  id: string
  filePath: string
  startLine?: number
  endLine?: number
  content: string
  tokens?: number
  score?: number
}

interface RagIndex {
  fileCount: number
  tokenCount: number
  lastBuiltAt?: number
  building?: boolean
  progress?: number // 0-100
}

/** ragApi 的预期形状（用于 runtime 防御） */
interface RagApiShape {
  recall?: (query: string, topK?: number) => Promise<{ chunks: RagRecall[]; truncated?: boolean }>
  indexStatus?: () => Promise<RagIndex>
  rebuild?: () => Promise<RagIndex>
  clear?: () => Promise<{ cleared?: boolean }>
}

/** 取得 ragApi；若 Agent 4 未添加则返回 null */
function getRagApi(): RagApiShape | null {
  if (!ragApi) return null
  return ragApi as unknown as RagApiShape
}

const PREVIEW_LEN = 200
const DEFAULT_TOP_K = 8

export function RagPanel() {
  // 索引状态
  const [indexInfo, setIndexInfo] = useState<RagIndex | null>(null)
  const [loadingStatus, setLoadingStatus] = useState(false)
  const [building, setBuilding] = useState(false)
  // mock 进度（0-100）
  const [buildProgress, setBuildProgress] = useState(0)
  // 搜索
  const [query, setQuery] = useState('')
  const [recalls, setRecalls] = useState<RagRecall[]>([])
  const [truncated, setTruncated] = useState(false)
  const [searching, setSearching] = useState(false)
  // 展开的 chunk id
  const [expandedId, setExpandedId] = useState<string | null>(null)
  // 错误信息
  const [error, setError] = useState<string | null>(null)

  /** 拉取索引状态 */
  const refreshStatus = useCallback(async () => {
    const api = getRagApi()
    if (!api || typeof api.indexStatus !== 'function') {
      // 兜底：使用 mock 状态
      setIndexInfo({ fileCount: 0, tokenCount: 0 })
      return
    }
    setLoadingStatus(true)
    setError(null)
    try {
      const info = await api.indexStatus()
      setIndexInfo(info)
      if (info.building) {
        setBuilding(true)
        setBuildProgress(info.progress ?? 0)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoadingStatus(false)
    }
  }, [])

  // 初次挂载拉取索引状态
  useEffect(() => {
    void refreshStatus()
  }, [refreshStatus])

  /** 索引构建中：mock 进度推进 */
  useEffect(() => {
    if (!building) return
    const timer = window.setInterval(() => {
      setBuildProgress((p) => {
        const next = Math.min(100, p + Math.random() * 12 + 3)
        if (next >= 100) {
          window.clearInterval(timer)
          // 完成后刷新状态
          setBuilding(false)
          void refreshStatus()
          return 100
        }
        return next
      })
    }, 240)
    return () => window.clearInterval(timer)
  }, [building, refreshStatus])

  /** 搜索：调用 ragApi.recall */
  const handleSearch = useCallback(async () => {
    const q = query.trim()
    if (!q) return
    const api = getRagApi()
    if (!api || typeof api.recall !== 'function') {
      setError('RAG 接口未就绪（ragApi.recall 不可用）')
      return
    }
    setSearching(true)
    setError(null)
    setExpandedId(null)
    try {
      const r = await api.recall(q, DEFAULT_TOP_K)
      setRecalls(r.chunks ?? [])
      setTruncated(!!r.truncated)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setRecalls([])
      setTruncated(false)
    } finally {
      setSearching(false)
    }
  }, [query])

  /** 重建索引 */
  const handleRebuild = useCallback(async () => {
    const api = getRagApi()
    if (!api || typeof api.rebuild !== 'function') {
      // 兜底：mock 进度
      setBuilding(true)
      setBuildProgress(0)
      return
    }
    setBuilding(true)
    setBuildProgress(0)
    setError(null)
    try {
      const info = await api.rebuild()
      setIndexInfo(info)
      if (!info.building) {
        // 同步完成
        setBuilding(false)
        setBuildProgress(100)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBuilding(false)
    }
  }, [])

  /** 清空索引 */
  const handleClear = useCallback(async () => {
    const api = getRagApi()
    if (!api || typeof api.clear !== 'function') {
      // 兜底：直接清空本地状态
      setIndexInfo({ fileCount: 0, tokenCount: 0 })
      setRecalls([])
      setTruncated(false)
      return
    }
    setError(null)
    try {
      await api.clear()
      setIndexInfo({ fileCount: 0, tokenCount: 0 })
      setRecalls([])
      setTruncated(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  return (
    <div className="h-full flex flex-col">
      {/* === 顶部：索引状态 + 操作按钮 === */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-white/5">
        <div className="flex items-center gap-2 text-2xs font-mono">
          {loadingStatus ? (
            <span className="text-text-tertiary">加载中…</span>
          ) : indexInfo ? (
            <>
              <span className="px-1.5 py-0.5 rounded bg-white/6 text-text-secondary">
                {indexInfo.fileCount} 文件
              </span>
              <span className="px-1.5 py-0.5 rounded bg-white/6 text-text-secondary">
                {formatTokens(indexInfo.tokenCount)} tokens
              </span>
            </>
          ) : (
            <span className="text-text-tertiary">未索引</span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => void handleRebuild()}
            disabled={building}
            className="btn-secondary !py-1 !px-2 !text-2xs"
            title="重建 RAG 索引"
          >
            {building ? '构建中…' : '重建索引'}
          </button>
          <button
            onClick={() => void handleClear()}
            disabled={building}
            className="icon-btn !p-1"
            title="清空索引"
          >
            <TrashIcon />
          </button>
        </div>
      </div>

      {/* === 索引构建进度条（mock） === */}
      {building && (
        <div className="px-3 py-2 border-b border-white/5 bg-accent/5">
          <div className="flex items-center justify-between text-2xs text-accent mb-1">
            <span>正在构建索引…</span>
            <span className="font-mono">{Math.round(buildProgress)}%</span>
          </div>
          <div className="h-1 rounded-full bg-white/8 overflow-hidden">
            <div
              className="h-full bg-accent transition-all duration-200 ease-out"
              style={{ width: `${buildProgress}%` }}
            />
          </div>
        </div>
      )}

      {/* === 错误条 === */}
      {error && (
        <div className="px-3 py-1.5 text-2xs text-diff-removed-text bg-diff-removed/20 border-b border-diff-removed/40">
          {error}
        </div>
      )}

      {/* === 搜索框 === */}
      <div className="px-3 py-2 border-b border-white/5">
        <div className="flex items-center gap-1.5">
          <div className="relative flex-1">
            <SearchIcon />
            <input
              type="text"
              placeholder="输入查询，召回相关代码片段…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  void handleSearch()
                }
              }}
              className="w-full pl-7 pr-3 py-1.5 rounded bg-white/6 text-2xs text-text-primary placeholder-text-tertiary border border-white/5 focus:outline-none focus:border-accent/40 focus:bg-white/8 transition-all duration-200 ease-out"
              spellCheck={false}
              data-selectable="true"
            />
          </div>
          <button
            onClick={() => void handleSearch()}
            disabled={searching || !query.trim()}
            className="btn-secondary !py-1 !px-2 !text-2xs"
            title="搜索召回"
          >
            {searching ? '搜索中…' : '搜索'}
          </button>
        </div>
      </div>

      {/* === 召回结果统计 === */}
      {(recalls.length > 0 || searching) && (
        <div className="px-3 py-1.5 border-b border-white/5 flex items-center justify-between text-2xs">
          <span className="text-text-tertiary font-mono">
            {searching ? '召回中…' : `召回 ${recalls.length} 片段`}
          </span>
          {!searching && truncated && (
            <span className="px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 font-mono">
              已裁剪
            </span>
          )}
        </div>
      )}

      {/* === 召回结果列表 === */}
      <div className="flex-1 overflow-auto p-2 space-y-1">
        {recalls.length === 0 ? (
          <EmptyHint
            icon={<RagIcon />}
            text="输入查询语句，点击搜索查看 RAG 召回的代码片段。"
          />
        ) : (
          recalls.map((chunk) => (
            <RagChunkItem
              key={chunk.id}
              chunk={chunk}
              expanded={expandedId === chunk.id}
              onToggle={() =>
                setExpandedId((v) => (v === chunk.id ? null : chunk.id))
              }
            />
          ))
        )}
      </div>
    </div>
  )
}

/* ============== 单个召回片段卡片 ============== */

interface RagChunkItemProps {
  chunk: RagRecall
  expanded: boolean
  onToggle: () => void
}

function RagChunkItem({ chunk, expanded, onToggle }: RagChunkItemProps) {
  const fileName = chunk.filePath.replace(/\\/g, '/').split('/').pop() ?? chunk.filePath
  const lineRange =
    chunk.startLine != null && chunk.endLine != null
      ? `L${chunk.startLine}-L${chunk.endLine}`
      : chunk.startLine != null
        ? `L${chunk.startLine}`
        : ''
  const preview = expanded ? chunk.content : chunk.content.slice(0, PREVIEW_LEN)
  const isTruncatedPreview = !expanded && chunk.content.length > PREVIEW_LEN

  return (
    <button
      onClick={onToggle}
      className="w-full text-left px-2.5 py-2 rounded-lg bg-white/4 hover:bg-white/6 border border-white/5 transition-all duration-200 ease-out"
    >
      {/* 头部：文件名 + 行号范围 + token 数 + 评分 */}
      <div className="flex items-center gap-2 mb-1">
        <FileBadge filePath={chunk.filePath} />
        <span className="text-xs font-mono text-text-primary truncate flex-1" title={chunk.filePath}>
          {fileName}
        </span>
        {lineRange && (
          <span className="text-2xs font-mono text-text-tertiary flex-shrink-0">
            {lineRange}
          </span>
        )}
        {chunk.tokens != null && (
          <span className="text-2xs font-mono text-text-tertiary flex-shrink-0">
            {chunk.tokens} tok
          </span>
        )}
        {chunk.score != null && (
          <span
            className="px-1.5 py-0.5 rounded text-2xs font-mono bg-accent/12 text-accent flex-shrink-0"
            title="相似度评分"
          >
            {chunk.score.toFixed(2)}
          </span>
        )}
      </div>
      {/* 内容预览 / 完整内容 */}
      <div
        className="font-mono text-2xs text-text-secondary leading-relaxed whitespace-pre-wrap break-all max-h-[280px] overflow-auto"
        data-selectable="true"
      >
        {preview || '\u00A0'}
        {isTruncatedPreview && (
          <span className="text-text-tertiary"> …（点击展开）</span>
        )}
      </div>
    </button>
  )
}

/* ============== 共用子组件 ============== */

function EmptyHint({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-2 text-center px-4">
      <span className="opacity-40">{icon}</span>
      <div className="text-xs text-text-tertiary leading-relaxed">{text}</div>
    </div>
  )
}

function FileBadge({ filePath }: { filePath: string }) {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
  const color =
    ext === 'rs' ? '#dea584' :
    ext === 'ts' || ext === 'tsx' ? '#3178c6' :
    ext === 'js' || ext === 'jsx' ? '#f7df1e' :
    ext === 'py' ? '#3572a5' :
    ext === 'go' ? '#00add8' :
    ext === 'md' ? '#9d9d9d' :
    '#9d9d9d'
  return (
    <span
      className="px-1.5 py-0.5 rounded text-2xs font-mono font-bold flex-shrink-0"
      style={{ color, backgroundColor: `${color}22` }}
    >
      {ext.toUpperCase().slice(0, 4)}
    </span>
  )
}

/** 格式化 token 数（>1000 显示为 k） */
function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

/* ============== 图标 ============== */

function RagIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" className="text-text-secondary">
      <ellipse cx="7" cy="4" rx="5" ry="2.2" stroke="currentColor" strokeWidth="1.1" />
      <path d="M2 4v8c0 1.2 2.2 2.2 5 2.2s5-1 5-2.2V4" stroke="currentColor" strokeWidth="1.1" fill="none" />
      <path d="M2 8c0 1.2 2.2 2.2 5 2.2s5-1 5-2.2" stroke="currentColor" strokeWidth="1.1" fill="none" />
      <path d="M11 10l3 3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  )
}

function SearchIcon() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 16 16"
      fill="none"
      className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-tertiary pointer-events-none"
    >
      <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.2" fill="none" />
      <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  )
}

function TrashIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
      <path
        d="M3 4h10M6 4V2h4v2M5 4l1 9h4l1-9"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
