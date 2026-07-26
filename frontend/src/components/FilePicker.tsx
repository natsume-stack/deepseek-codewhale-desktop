/**
 * @文件挂载选择器（P0-6）
 *
 *  - 输入框检测到 `@` 时由父组件显示本浮层
 *  - 调用 projectApi.tree(3) 获取文件树，过滤 node_modules/target/.git 等
 *  - 树形展开/折叠，多选文件，点击"添加"确认
 *  - 视觉：8px 圆角，半透明深色背景，文件图标按扩展名着色
 *  - 动画：cubic-bezier(0.16,1,0.3,1)，200ms
 */
import { useEffect, useMemo, useState } from 'react'
import { projectApi } from '../lib/api'
import type { FileNode } from '../types'

interface FilePickerProps {
  visible: boolean
  onPick: (paths: string[]) => void
  onClose: () => void
  position: { top: number; left: number }
}

/** 需要过滤的目录名 */
const BLOCKED_DIRS = new Set(['node_modules', 'target', '.git', '.next', 'dist', 'build', '.cache'])

/** 递归过滤文件树：剔除阻塞目录 */
function filterTree(node: FileNode): FileNode | null {
  if (node.isFolder) {
    if (BLOCKED_DIRS.has(node.name)) return null
    const children = node.children
      ?.map(filterTree)
      .filter((n): n is FileNode => n !== null)
    return { ...node, children }
  }
  return node
}

/** 递归扁平化展示用的可展开节点列表（按需展开，未展开的不递归） */
interface FlatNode {
  node: FileNode
  depth: number
  expanded: boolean
  hasChildren: boolean
}

export function FilePicker({ visible, onPick, onClose, position }: FilePickerProps) {
  const [root, setRoot] = useState<FileNode | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** 展开的目录 path 集合 */
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  /** 选中的文件 path 集合 */
  const [selected, setSelected] = useState<Set<string>>(new Set())
  /** 搜索过滤 */
  const [filter, setFilter] = useState('')

  // 拉取文件树
  useEffect(() => {
    if (!visible) return
    let cancelled = false
    setLoading(true)
    setError(null)
    void projectApi
      .tree(3)
      .then((r) => {
        if (cancelled) return
        const filtered = r.tree ? filterTree(r.tree) : null
        setRoot(filtered)
        // 默认展开根目录
        if (filtered) {
          setExpanded(new Set([filtered.path]))
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return
        const msg = err instanceof Error ? err.message : String(err)
        setError(msg)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [visible])

  // Esc 关闭
  useEffect(() => {
    if (!visible) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [visible, onClose])

  // 切换可见时清空已选
  useEffect(() => {
    if (visible) {
      setSelected(new Set())
      setFilter('')
    }
  }, [visible])

  // 扁平化渲染列表（仅展开的目录递归）
  const flatList = useMemo<FlatNode[]>(() => {
    if (!root) return []
    const out: FlatNode[] = []
    const walk = (node: FileNode, depth: number) => {
      const hasChildren = !!node.children && node.children.length > 0
      const isExpanded = expanded.has(node.path)
      out.push({ node, depth, expanded: isExpanded, hasChildren })
      if (hasChildren && isExpanded) {
        // 子节点排序：目录在前，文件在后，按名字排序
        const children = [...(node.children ?? [])].sort((a, b) => {
          if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1
          return a.name.localeCompare(b.name)
        })
        for (const c of children) walk(c, depth + 1)
      }
    }
    walk(root, 0)
    return out
  }, [root, expanded])

  // 搜索过滤：若有 filter，则展示包含关键字的文件（扁平展示）
  const visibleList = useMemo<FlatNode[]>(() => {
    if (!filter.trim()) return flatList
    const q = filter.trim().toLowerCase()
    // 递归收集所有匹配文件
    const matched: FlatNode[] = []
    if (root) {
      const walk = (node: FileNode, depth: number) => {
        if (node.isFolder) {
          node.children?.forEach((c) => walk(c, depth))
        } else if (node.name.toLowerCase().includes(q) || node.path.toLowerCase().includes(q)) {
          matched.push({ node, depth: 0, expanded: false, hasChildren: false })
        }
      }
      walk(root, 0)
    }
    return matched
  }, [flatList, filter, root])

  const toggleExpand = (path: string) => {
    setExpanded((s) => {
      const next = new Set(s)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const toggleSelect = (path: string) => {
    setSelected((s) => {
      const next = new Set(s)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const handleAdd = () => {
    if (selected.size === 0) return
    onPick(Array.from(selected).sort())
  }

  if (!visible) return null

  return (
    <div
      className="fixed z-50 w-80 rounded-lg border border-white/8 bg-surface-elevated/95 shadow-raised animate-scale-in flex flex-col"
      style={{ top: position.top, left: position.left, maxHeight: 360, transformOrigin: 'bottom left' }}
      data-selectable="true"
    >
      {/* 顶部搜索栏 */}
      <div className="p-2 border-b border-white/5">
        <input
          autoFocus
          className="input-base !py-1 !text-xs"
          placeholder="搜索文件名…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          spellCheck={false}
        />
        <div className="mt-1.5 px-0.5 flex items-center justify-between text-2xs font-mono text-text-tertiary">
          <span>选择文件挂载到对话</span>
          <span>{selected.size} 已选</span>
        </div>
      </div>

      {/* 文件树 */}
      <div className="flex-1 overflow-y-auto py-1 min-h-[80px]">
        {loading && (
          <div className="px-3 py-2 text-2xs text-text-tertiary">加载中…</div>
        )}
        {error && (
          <div className="px-3 py-2 text-2xs text-rose-300">加载失败：{error}</div>
        )}
        {!loading && !error && visibleList.length === 0 && (
          <div className="px-3 py-2 text-2xs text-text-tertiary">
            {filter ? '无匹配文件' : '项目为空'}
          </div>
        )}
        {visibleList.map((fn, idx) => (
          <FileTreeRow
            key={`${fn.node.path}-${idx}`}
            flat={fn}
            isSelected={selected.has(fn.node.path)}
            onToggleExpand={() => toggleExpand(fn.node.path)}
            onToggleSelect={() => toggleSelect(fn.node.path)}
          />
        ))}
      </div>

      {/* 底部操作栏 */}
      <div className="flex items-center justify-end gap-2 p-2 border-t border-white/5">
        <button
          className="btn-secondary !py-1 !px-2 !text-2xs"
          onClick={onClose}
          title="取消"
        >
          取消
        </button>
        <button
          className="btn-primary !py-1 !px-2 !text-2xs disabled:opacity-30 disabled:cursor-not-allowed"
          onClick={handleAdd}
          disabled={selected.size === 0}
          title="添加选中文件到附件"
        >
          添加{selected.size > 0 ? ` (${selected.size})` : ''}
        </button>
      </div>
    </div>
  )
}

interface FileTreeRowProps {
  flat: FlatNode
  isSelected: boolean
  onToggleExpand: () => void
  onToggleSelect: () => void
}

function FileTreeRow({ flat, isSelected, onToggleExpand, onToggleSelect }: FileTreeRowProps) {
  const { node, depth, expanded } = flat
  return (
    <div
      className={`flex items-center gap-1 px-2 py-0.5 cursor-pointer transition-colors duration-200 ease-out ${
        isSelected ? 'bg-accent/12' : 'hover:bg-white/6'
      }`}
      style={{ paddingLeft: 8 + depth * 12 }}
      onClick={() => {
        // 目录：点击切换展开；文件：点击切换选中
        if (node.isFolder) {
          onToggleExpand()
        } else {
          onToggleSelect()
        }
      }}
    >
      {node.isFolder ? (
        <button
          className="inline-flex items-center justify-center w-3 h-3 text-text-tertiary hover:text-text-primary"
          onClick={(e) => {
            e.stopPropagation()
            onToggleExpand()
          }}
          title={expanded ? '折叠' : '展开'}
        >
          <ChevronIcon expanded={expanded} />
        </button>
      ) : (
        <span className="inline-block w-3 h-3" />
      )}
      <FileExtIcon name={node.name} isFolder={node.isFolder} />
      <span
        className={`text-xs truncate flex-1 ${
          node.isFolder ? 'text-text-secondary' : 'text-text-primary'
        }`}
      >
        {node.name}
      </span>
      {!node.isFolder && (
        <span
          className={`inline-flex items-center justify-center w-3.5 h-3.5 rounded-sm border text-2xs transition-all duration-200 ${
            isSelected
              ? 'bg-white border-white text-black'
              : 'border-white/15 text-transparent'
          }`}
        >
          <CheckMiniIcon />
        </span>
      )}
    </div>
  )
}

function ChevronIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 16 16"
      fill="none"
      className={expanded ? 'rotate-90' : ''}
      style={{ transition: 'transform 200ms cubic-bezier(0.16,1,0.3,1)' }}
    >
      <path
        d="M6 4l4 4-4 4"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function CheckMiniIcon() {
  return (
    <svg width="8" height="8" viewBox="0 0 16 16" fill="none">
      <path
        d="M3 8l3 3 7-7"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** 按扩展名着色的文件图标（参考 CodeBlock.tsx / fileIcons.tsx） */
function FileExtIcon({ name, isFolder }: { name: string; isFolder: boolean }) {
  if (isFolder) {
    return (
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" className="text-accent/80 flex-shrink-0">
        <path
          d="M1.5 4h4l1.5 1.5h7.5v8h-13V4z"
          fill="currentColor"
          fillOpacity="0.25"
          stroke="currentColor"
          strokeWidth="1"
          strokeLinejoin="round"
        />
      </svg>
    )
  }
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  const color =
    ext === 'rs' ? '#dea584' :
    ext === 'ts' || ext === 'tsx' ? '#3178c6' :
    ext === 'js' || ext === 'jsx' ? '#f7df1e' :
    ext === 'py' ? '#3572a5' :
    ext === 'json' ? '#cbcb41' :
    ext === 'md' ? '#519aba' :
    ext === 'toml' ? '#9c4221' :
    ext === 'go' ? '#00add8' :
    ext === 'yaml' || ext === 'yml' ? '#cb171e' :
    ext === 'html' ? '#e34c26' :
    ext === 'css' ? '#563d7c' :
    '#9d9d9d'
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" style={{ color }} className="flex-shrink-0">
      <path
        d="M3 1.5h7l3 3V14.5H3z"
        stroke="currentColor"
        strokeWidth="1"
        fill="currentColor"
        fillOpacity="0.18"
      />
      <path d="M10 1.5v3h3" stroke="currentColor" strokeWidth="1" />
    </svg>
  )
}
