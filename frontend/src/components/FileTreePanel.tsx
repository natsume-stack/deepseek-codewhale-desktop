/**
 * 左栏：文件树面板
 *
 *  - 顶部：项目名 + 新建文件/文件夹 + 刷新按钮
 *  - 主体：递归 TreeView，区分文件夹/文件图标，展开/折叠动画
 *  - 选中高亮、双击文件夹展开、单击文件选中
 *  - 右键上下文菜单：新建 / 删除 / 重命名 / 复制路径 / 在资源管理器打开
 *  - 空状态：未加载项目时显示打开目录按钮
 */
import { useMemo, useState, type MouseEvent } from 'react'
import { useFileTreeStore } from '../stores/fileTree'
import { useDialogStore } from '../stores/dialog'
import { FileIcon } from './fileIcons'
import { ContextMenu, type MenuItem } from './ContextMenu'
import type { FileNode } from '../types'

interface FileTreePanelProps {
  onOpenFolder: () => void
}

export function FileTreePanel({ onOpenFolder }: FileTreePanelProps) {
  const rootPath = useFileTreeStore((s) => s.rootPath)
  const tree = useFileTreeStore((s) => s.tree)
  const loading = useFileTreeStore((s) => s.loading)
  const error = useFileTreeStore((s) => s.error)
  const refresh = useFileTreeStore((s) => s.refresh)

  const [menu, setMenu] = useState<{ x: number; y: number; node: FileNode | null } | null>(null)

  const projectName = useMemo(() => {
    if (!rootPath) return '未打开项目'
    const parts = rootPath.replace(/\\/g, '/').split('/').filter(Boolean)
    return parts[parts.length - 1] ?? rootPath
  }, [rootPath])

  const handleContextMenu = (e: MouseEvent, node: FileNode | null) => {
    e.preventDefault()
    e.stopPropagation()
    setMenu({ x: e.clientX, y: e.clientY, node })
  }

  return (
    <div className="flex flex-col h-full border-r border-white/5" onContextMenu={(e) => handleContextMenu(e, null)}>
      {/* 顶栏 */}
      <div className="panel-header">
        <div className="flex items-center gap-2 min-w-0">
          <FolderTreeIcon />
          <span className="panel-title truncate" title={rootPath ?? ''}>{projectName}</span>
        </div>
        <div className="flex items-center gap-0.5">
          <button
            onClick={() => askCreate(false)}
            disabled={!rootPath}
            className="icon-btn"
            title="新建文件"
          >
            <NewFileIcon />
          </button>
          <button
            onClick={() => askCreate(true)}
            disabled={!rootPath}
            className="icon-btn"
            title="新建文件夹"
          >
            <NewFolderIcon />
          </button>
          <button
            onClick={() => void refresh()}
            disabled={!rootPath || loading}
            className="icon-btn"
            title="刷新"
          >
            <RefreshIcon spinning={loading} />
          </button>
        </div>
      </div>

      {/* 错误提示 */}
      {error && (
        <div className="px-3 py-1.5 text-2xs text-diff-removed-text bg-diff-removed/20 border-b border-diff-removed/40">
          {error}
        </div>
      )}

      {/* 文件树主体 */}
      <div className="flex-1 overflow-auto py-1">
        {!rootPath ? (
          <EmptyState onOpenFolder={onOpenFolder} />
        ) : !tree ? (
          <div className="px-3 py-2 text-xs text-text-tertiary">加载中…</div>
        ) : (
          <TreeChildren nodes={tree.children ?? []} depth={0} onContext={handleContextMenu} />
        )}
      </div>

      {/* 右键菜单 */}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={buildMenuItems(menu.node ?? tree, rootPath, setMenu)}
        />
      )}
    </div>
  )

  /** 触发新建：弹出输入框 */
  async function askCreate(isFolder: boolean) {
    const dialog = useDialogStore.getState()
    const name = await dialog.prompt({
      title: isFolder ? '新建文件夹' : '新建文件',
      message: isFolder ? '请输入文件夹名称：' : '请输入文件名称（可含相对路径）：',
      defaultValue: isFolder ? 'new-folder' : 'new-file.txt',
    })
    if (!name) return
    const { createFile, rootPath: root } = useFileTreeStore.getState()
    if (!root) return
    void createFile(root, name, isFolder, '')
  }
}

/** 递归构建菜单项 */
function buildMenuItems(
  node: FileNode | null,
  rootPath: string | null,
  setMenu: (m: null) => void,
): MenuItem[] {
  if (!rootPath) return []
  const store = useFileTreeStore.getState()
  const target = node ?? { name: rootPath, path: rootPath, isFolder: true }
  const isFolder = !!target.isFolder
  const items: MenuItem[] = []

  if (isFolder) {
    items.push(
      {
        label: '新建文件',
        icon: <NewFileIcon />,
        onClick: async () => {
          const dialog = useDialogStore.getState()
          const name = await dialog.prompt({
            title: '新建文件',
            message: '请输入文件名称：',
            defaultValue: 'new-file.txt',
          })
          if (name) void store.createFile(target.path, name, false, '')
        },
      },
      {
        label: '新建文件夹',
        icon: <NewFolderIcon />,
        onClick: async () => {
          const dialog = useDialogStore.getState()
          const name = await dialog.prompt({
            title: '新建文件夹',
            message: '请输入文件夹名称：',
            defaultValue: 'new-folder',
          })
          if (name) void store.createFile(target.path, name, true)
        },
      },
      { type: 'separator' },
    )
  }

  if (node) {
    items.push({
      label: '重命名',
      icon: <RenameIcon />,
      onClick: async () => {
        const dialog = useDialogStore.getState()
        const newName = await dialog.prompt({
          title: '重命名',
          message: '请输入新名称：',
          defaultValue: target.name,
        })
        if (!newName) return
        const parent = target.path.replace(/[/\\][^/\\]+$/, '')
        const newPath = `${parent}/${newName}`.replace(/\//g, '\\')
        void store.rename(target.path, newPath)
      },
    })
    if (!isFolder) {
      items.push({
        label: '复制文件路径',
        icon: <CopyIcon />,
        onClick: () => void store.copyPath(target.path),
      })
    }
    items.push({
      label: '在资源管理器中打开',
      icon: <ExplorerIcon />,
      onClick: () => void store.reveal(target.path),
    })
    items.push({ type: 'separator' })
    items.push({
      label: '删除',
      icon: <DeleteIcon />,
      danger: true,
      onClick: async () => {
        const dialog = useDialogStore.getState()
        const ok = await dialog.confirm({
          title: '确认删除',
          message: `确认删除 ${target.name}？${isFolder ? '该文件夹下所有内容将被递归删除。' : ''}`,
          confirmText: '删除',
          danger: true,
        })
        if (ok) void store.remove(target.path)
      },
    })
  } else {
    items.push({
      label: '在资源管理器中打开项目根',
      icon: <ExplorerIcon />,
      onClick: () => void store.reveal(rootPath),
    })
  }

  void setMenu
  return items
}

/** 递归子节点渲染 */
function TreeChildren({
  nodes,
  depth,
  onContext,
}: {
  nodes: FileNode[]
  depth: number
  onContext: (e: MouseEvent, node: FileNode) => void
}) {
  // 文件夹优先排序，同类按名称
  const sorted = [...nodes].sort((a, b) => {
    if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1
    return a.name.localeCompare(b.name)
  })

  return (
    <>
      {sorted.map((node) => (
        <TreeRow key={node.path} node={node} depth={depth} onContext={onContext} />
      ))}
    </>
  )
}

function TreeRow({
  node,
  depth,
  onContext,
}: {
  node: FileNode
  depth: number
  onContext: (e: MouseEvent, node: FileNode) => void
}) {
  const expanded = useFileTreeStore((s) => s.expanded.has(node.path))
  const selected = useFileTreeStore((s) => s.selectedPath === node.path)
  const toggleExpand = useFileTreeStore((s) => s.toggleExpand)
  const select = useFileTreeStore((s) => s.select)
  const hasChildren = node.isFolder && (node.children?.length ?? 0) > 0

  const handleClick = () => {
    select(node.path)
    if (node.isFolder) toggleExpand(node.path)
  }

  return (
    <>
      <div
        onClick={handleClick}
        onContextMenu={(e) => onContext(e, node)}
        className={`flex items-center gap-1.5 pr-2 h-6 cursor-pointer text-xs transition-colors group
          ${selected ? 'bg-accent/15 text-text-primary' : 'text-text-secondary hover:bg-white/6'}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        title={node.path}
      >
        {node.isFolder ? (
          <ChevronIcon open={expanded} />
        ) : (
          <span className="w-3 inline-block" />
        )}
        <FileIcon node={node} expanded={expanded} size={14} />
        <span className={`truncate ${node.isFolder ? 'font-medium' : ''}`}>
          {node.name}
        </span>
      </div>
      {node.isFolder && expanded && hasChildren && (
        <div className="animate-fade-in">
          <TreeChildren nodes={node.children!} depth={depth + 1} onContext={onContext} />
        </div>
      )}
    </>
  )
}

function EmptyState({ onOpenFolder }: { onOpenFolder: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-3 px-4 text-center">
      <FolderBigIcon />
      <div className="text-sm text-text-secondary">尚未加载项目</div>
      <button onClick={onOpenFolder} className="btn-primary !py-1.5">
        <OpenIcon />
        打开项目目录
      </button>
      <div className="text-2xs text-text-tertiary leading-relaxed">
        加载后可浏览文件树、右键新建/删除/重命名
      </div>
    </div>
  )
}

/* ============== 图标 ============== */

function FolderTreeIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" className="text-accent">
      <path d="M1.5 4h4l1.5 1.5h7.5v8h-13V4z" stroke="currentColor" strokeWidth="1.1" fill="currentColor" fillOpacity="0.25" strokeLinejoin="round" />
    </svg>
  )
}

function NewFileIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
      <path d="M3 1.5h7l3 3V14.5H3z" stroke="currentColor" strokeWidth="1" />
      <path d="M10 1.5v3h3" stroke="currentColor" strokeWidth="1" />
      <path d="M8 7v5M5.5 9.5h5" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
    </svg>
  )
}

function NewFolderIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
      <path d="M1.5 4h4l1.5 1.5h7.5v8h-13V4z" stroke="currentColor" strokeWidth="1" fill="currentColor" fillOpacity="0.18" />
      <path d="M8 7v4M6 9h4" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
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

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 16 16"
      fill="none"
      className={`text-text-tertiary transition-transform duration-150 ${open ? 'rotate-90' : ''}`}
    >
      <path d="M5 3l6 5-6 5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function RenameIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
      <path d="M11 2l3 3-8 8H3v-3l8-8z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
    </svg>
  )
}

function CopyIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
      <rect x="5" y="5" width="8" height="8" rx="1" stroke="currentColor" strokeWidth="1" />
      <path d="M3 11V3h8" stroke="currentColor" strokeWidth="1" />
    </svg>
  )
}

function ExplorerIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
      <rect x="1.5" y="3" width="13" height="10" rx="1" stroke="currentColor" strokeWidth="1" />
      <path d="M1.5 6h13" stroke="currentColor" strokeWidth="1" />
      <rect x="5" y="8" width="6" height="4" fill="currentColor" fillOpacity="0.18" />
    </svg>
  )
}

function DeleteIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
      <path d="M3 4h10M6 4V2h4v2M5 4l1 9h4l1-9" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function FolderBigIcon() {
  return (
    <svg width="48" height="48" viewBox="0 0 16 16" fill="none" className="text-text-tertiary">
      <path d="M1.5 4h4l1.5 1.5h7.5v8h-13V4z" stroke="currentColor" strokeWidth="1" fill="currentColor" fillOpacity="0.4" strokeLinejoin="round" />
    </svg>
  )
}

function OpenIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
      <path d="M3 8h10M9 4l4 4-4 4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  )
}
