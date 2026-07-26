/**
 * 工作区（Codex 风格三栏布局容器）
 *
 *  ┌──────────────┬─────────────────────────────┬──────────────┐
 *  │ 文件树面板    │  对话面板                     │  变更面板     │
 *  │ (可拖拽折叠)  │                              │  (可拖拽折叠) │
 *  ├──────────────┴─────────────────────────────┴──────────────┤
 *  │  底部状态条（模型/权限/缓存/插件/会话/时间）                 │
 *  └────────────────────────────────────────────────────────────┘
 *
 * 工作区外层已由 App.tsx 的 .work-surface 提供不透明深色圆角板块背景，
 * 本组件内部面板使用更淡的浮层（surface-elevated）做视觉分层。
 * 参数配置已迁移到设置页（SettingsPage），不再占用工作区右栏。
 */
import type { useResizableLayout } from '../hooks/useResizableLayout'
import { FileTreePanel } from './FileTreePanel'
import { ChatPanel } from './ChatPanel'
import { RightPanel } from './RightPanel'

type Layout = ReturnType<typeof useResizableLayout>

interface WorkAreaProps {
  layout: Layout
}

export function WorkArea({ layout }: WorkAreaProps) {
  const {
    leftWidth,
    rightWidth,
    leftCollapsed,
    rightCollapsed,
    toggleLeft,
    toggleRight,
    startDragLeft,
    startDragRight,
  } = layout

  return (
    <div className="flex flex-col h-full w-full overflow-hidden">
      {/* === 三栏主体（可拉伸） === */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* === 左栏：文件树面板 === */}
        <div
          className={`flex-shrink-0 overflow-hidden transition-all duration-150 ease-out ${leftCollapsed ? 'w-0' : ''}`}
          style={{ width: leftCollapsed ? 0 : leftWidth }}
        >
          {!leftCollapsed && (
            <div className="h-full animate-fade-in">
              <FileTreePanel onOpenFolder={() => toggleLeft()} />
            </div>
          )}
        </div>
        {!leftCollapsed && <div className="splitter" onMouseDown={startDragLeft} />}

        {/* === 中栏：对话面板（弹性宽度） === */}
        <div className="flex-1 min-w-0 overflow-hidden">
          <ChatPanel
            onToggleLeft={toggleLeft}
            onToggleRight={toggleRight}
            leftCollapsed={leftCollapsed}
            rightCollapsed={rightCollapsed}
          />
        </div>

        {/* === 右栏：多功能面板 === */}
        {!rightCollapsed && <div className="splitter" onMouseDown={startDragRight} />}
        <div
          className={`flex-shrink-0 overflow-hidden transition-all duration-150 ease-out ${rightCollapsed ? 'w-0' : ''}`}
          style={{ width: rightCollapsed ? 0 : rightWidth }}
        >
          {!rightCollapsed && (
            <div className="h-full animate-fade-in">
              <RightPanel onClose={toggleRight} />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
