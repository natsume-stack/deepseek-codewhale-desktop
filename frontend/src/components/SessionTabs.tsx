/**
 * 多会话标签栏（Codex 风格，参考 deepseek-tui-desktop）
 *
 *  ┌──────────────────────────────────────────────────────────┐
 *  │ [会话A] [会话B] [会话C] + 新建                              │
 *  └──────────────────────────────────────────────────────────┘
 *
 * 视觉规范：
 *   - 圆角顶部（rounded-t-lg），半透明 rgba 背景
 *   - active 标签高亮（accent 色边/底）
 *   - pinned 标签前置，带小图钉标记
 *   - hover 显示关闭按钮
 *
 * 交互：
 *   - 左键点击：切换到该标签
 *   - 右键菜单：重命名 / 置顶(或取消置顶) / 关闭
 *   - 拖拽：HTML5 drag API（不引入新依赖），拖到目标标签前插入
 *
 * Props 见 SessionTabsProps。
 */
import { useState } from 'react'
import type { SessionTab } from '../stores/sessions'
import { useDialogStore } from '../stores/dialog'
import { ContextMenu, type MenuItem } from './ContextMenu'

interface SessionTabsProps {
  tabs: SessionTab[]
  activeId: string | null
  onSwitch: (id: string) => void
  onClose: (id: string) => void
  onNew: () => void
  onPin: (id: string) => void
  onRename?: (id: string, title: string) => void
  onMove?: (fromId: string, toId: string) => void
}

export function SessionTabs({
  tabs,
  activeId,
  onSwitch,
  onClose,
  onNew,
  onPin,
  onRename,
  onMove,
}: SessionTabsProps) {
  // 右键菜单状态
  const [menu, setMenu] = useState<{ x: number; y: number; tab: SessionTab } | null>(null)
  // 拖拽中：记录被拖拽的 tab id
  const [dragId, setDragId] = useState<string | null>(null)
  // 拖拽悬停目标：记录当前 hover 的 tab id（用于高亮提示）
  const [dragOverId, setDragOverId] = useState<string | null>(null)

  /** 右键菜单弹出 */
  const handleContextMenu = (e: React.MouseEvent, tab: SessionTab) => {
    e.preventDefault()
    e.stopPropagation()
    setMenu({ x: e.clientX, y: e.clientY, tab })
  }

  /** 关闭菜单 */
  const closeMenu = () => setMenu(null)

  /** 构造右键菜单项 */
  const buildMenuItems = (tab: SessionTab): MenuItem[] => {
    const items: MenuItem[] = [
      {
        label: '重命名',
        onClick: async () => {
          // 使用全局对话框 store（兼容 Tauri webview，window.prompt 在其中不可用）
          const newTitle = await useDialogStore.getState().prompt({
            title: '重命名会话标签',
            placeholder: '输入新的标签标题',
            defaultValue: tab.title,
            confirmText: '保存',
          })
          if (newTitle && newTitle.trim() && onRename) {
            onRename(tab.id, newTitle.trim())
          }
        },
      },
      {
        label: tab.pinned ? '取消置顶' : '置顶',
        onClick: () => onPin(tab.id),
      },
      { type: 'separator' },
      {
        label: '关闭',
        danger: true,
        onClick: () => onClose(tab.id),
      },
    ]
    return items
  }

  /* === 拖拽事件（HTML5 drag API） === */
  const handleDragStart = (e: React.DragEvent, tab: SessionTab) => {
    setDragId(tab.id)
    e.dataTransfer.effectAllowed = 'move'
    // 必须 setData 才能在某些浏览器触发 dragover
    try {
      e.dataTransfer.setData('text/plain', tab.id)
    } catch {
      /* ignore */
    }
  }
  const handleDragEnd = () => {
    setDragId(null)
    setDragOverId(null)
  }
  const handleDragOver = (e: React.DragEvent, tab: SessionTab) => {
    if (!dragId || dragId === tab.id) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setDragOverId(tab.id)
  }
  const handleDragLeave = (tab: SessionTab) => {
    if (dragOverId === tab.id) setDragOverId(null)
  }
  const handleDrop = (e: React.DragEvent, tab: SessionTab) => {
    e.preventDefault()
    if (!dragId || dragId === tab.id) {
      setDragId(null)
      setDragOverId(null)
      return
    }
    onMove?.(dragId, tab.id)
    setDragId(null)
    setDragOverId(null)
  }

  return (
    <div className="relative flex items-end gap-1 px-2 pt-1.5 pb-0 select-none">
      {tabs.length === 0 && (
        <button
          onClick={onNew}
          className="flex items-center gap-1 px-3 py-1.5 rounded-t-lg text-2xs text-text-secondary hover:text-text-primary hover:bg-white/4 transition-all duration-200 ease-out"
          title="新建会话"
        >
          <PlusIcon />
          新建会话
        </button>
      )}

      {tabs.map((tab) => {
        const isActive = tab.id === activeId
        const isDragging = dragId === tab.id
        const isDragOver = dragOverId === tab.id && dragId !== tab.id
        return (
          <div
            key={tab.id}
            draggable
            onDragStart={(e) => handleDragStart(e, tab)}
            onDragEnd={handleDragEnd}
            onDragOver={(e) => handleDragOver(e, tab)}
            onDragLeave={() => handleDragLeave(tab)}
            onDrop={(e) => handleDrop(e, tab)}
            onContextMenu={(e) => handleContextMenu(e, tab)}
            onClick={() => onSwitch(tab.id)}
            className={`group flex items-center gap-1.5 pl-3 pr-2 py-1.5 rounded-t-lg text-2xs font-medium cursor-pointer transition-all duration-200 ease-out max-w-[200px]
              ${isActive
                ? 'bg-white/8 text-text-primary border-t-2 border-accent'
                : 'bg-white/3 text-text-secondary hover:bg-white/6 hover:text-text-primary border-t-2 border-transparent'
              }
              ${isDragging ? 'opacity-40' : ''}
              ${isDragOver && !isActive ? 'ring-1 ring-accent/40' : ''}
            `}
            title={tab.title}
          >
            {tab.pinned && (
              <span className="flex-shrink-0 text-accent/70" aria-label="已置顶">
                <PinIcon />
              </span>
            )}
            <span className="truncate flex-1 min-w-0">{tab.title}</span>
            {/* 关闭按钮：hover 或 active 时可见 */}
            <button
              onClick={(e) => {
                e.stopPropagation()
                onClose(tab.id)
              }}
              className={`flex-shrink-0 w-4 h-4 inline-flex items-center justify-center rounded text-text-tertiary hover:bg-white/12 hover:text-text-primary transition-all duration-150
                ${isActive ? 'opacity-80' : 'opacity-0 group-hover:opacity-80'}`}
              title="关闭标签"
            >
              <CloseMiniIcon />
            </button>
          </div>
        )
      })}

      {/* + 新建按钮（已存在标签时显示在末尾） */}
      {tabs.length > 0 && (
        <button
          onClick={onNew}
          className="flex-shrink-0 w-7 h-7 inline-flex items-center justify-center rounded text-text-tertiary hover:text-text-primary hover:bg-white/6 transition-all duration-200 ease-out"
          title="新建会话"
        >
          <PlusIcon />
        </button>
      )}

      {/* 右键菜单 */}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={buildMenuItems(menu.tab)}
          onClose={closeMenu}
        />
      )}
    </div>
  )
}

/* ============== 图标 ============== */

function PlusIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
      <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

function CloseMiniIcon() {
  return (
    <svg width="9" height="9" viewBox="0 0 16 16" fill="none">
      <line x1="4" y1="4" x2="12" y2="12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <line x1="12" y1="4" x2="4" y2="12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

function PinIcon() {
  return (
    <svg width="9" height="9" viewBox="0 0 16 16" fill="none">
      <path
        d="M9.5 1.5L14.5 6.5L11.5 7.5L9 10L4.5 5.5L7 3L9.5 1.5Z"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinejoin="round"
        fill="currentColor"
        fillOpacity="0.3"
      />
      <path d="M7 10L3 14" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
    </svg>
  )
}
