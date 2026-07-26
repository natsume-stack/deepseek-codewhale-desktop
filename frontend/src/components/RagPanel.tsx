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
 * 依赖：ragApi（getIndex / buildIndex / recall / clear）+ types.ts 中的 RagIndex / RagRecall / RagChunk。
 */
import { useCallback, useEffect, useState } from 'react'
import { ragApi } from '../lib/api'
import type { RagChunk, RagIndex, RagRecall } from '../types'

const PREVIEW_LEN = 200
const DEFAULT_MAX_CHUNKS = 8

export function RagPanel() {
  // 索引状态
  const [indexInfo, setIndexInfo] = useState<RagIndex | null>(null)
  const [loadingStatus, setLoadingStatus] = useState(false)
  const [building, setBuilding] = useState(false)
  // 搜索
  const [query, setQuery] = useState('')
  const [recalls, setRecalls] = useState<RagChunk[]>([])
  const [truncated, setTruncated] = useState(false)
  const [searching, setSearching] = useState(false)
  // 展开的 chunk id
  const [expandedId, setExpandedId] = useState<string | null>(null)
  // 错误信息
  const [error, setError] = useState<string | null>(null)

  /** 拉取索引状态 */
  const refreshStatus = useCallback(async () => {
    setLoadingStatus(true)
    setError(null)
    try {
      const info = await ragApi.getIndex()
      setIndexInfo(info)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setIndexInfo(null)
    } finally {
      setLoadingStatus(false)
    }
  }, [])

  // 初次挂载拉取索引状态
  useEffect(() => {
    void refreshStatus()
  }, [refreshStatus])

  /** 搜索：调用 ragApi.recall（注意是 body 参数签名） */
  const handleSearch = useCallback(async () => {
    const q = query.trim()
    if (!q) return
    setSearching(true)
    setError(null)
    setExpandedId(null)
    try {
      const r: RagRecall = await ragApi.recall({
        query: q,
        maxChunks: DEFAULT_MAX_CHUNKS,
      })
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
    setBuilding(true)
    setError(null)
    try {
      const info = await ragApi.buildIndex()
      setIndexInfo(info)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBuilding(false)
    }
  }, [])

  /** 清空索引 */
  const handleClear = useCallback(async () => {
    setError(null)
    try {
      await ragApi.clear()
      setIndexInfo(null)
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
                {indexInfo.totalFiles} 文件
              </span>
              <span className="px-1.5 py-0.5 rounded bg-white/6 text-text-secondary">
                {formatTokens(indexInfo.totalTokens)} tokens
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
  chunk: RagChunk
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
      {/* 头部：文件名 + 行号范围 + token 数 */}
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
