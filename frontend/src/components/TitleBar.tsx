/**
 * 顶部菜单栏（Codex Desktop 风格自绘标题栏）
 *
 * 视觉规范：
 *   - 透明背景 + 底部极细分隔线，让 Mica 完全穿透
 *   - 左侧：文字菜单项（文件/编辑/视图），无 logo 无应用名（与 SideNav 顶部避免重复）
 *   - 中央：当前项目名（极简灰字）
 *   - 右侧：模型名（小灰字） + 窗口控制按钮
 *
 * 拖拽：整个标题栏 data-tauri-drag-region，按钮区 data-no-drag
 * 窗口控制：通过 Tauri v2 invoke 调用 lib.rs 注册的 min/max/close 命令
 */
import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { useFileTreeStore } from '../stores/fileTree'

interface TitleBarProps {
  model: string
}

export function TitleBar({ model }: TitleBarProps) {
  const rootPath = useFileTreeStore((s) => s.rootPath)
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    invoke<boolean>('is_maximized')
      .then((v) => setMaximized(v))
      .catch(() => {})
  }, [])

  const handleMin = () => {
    void invoke('min').catch(() => {})
  }
  const handleMax = () => {
    void invoke<boolean>('max')
      .then((v) => setMaximized(v))
      .catch(() => {})
  }
  const handleClose = () => {
    void invoke('close').catch(() => {})
  }

  const projectName = rootPath
    ? rootPath.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? rootPath
    : null

  return (
    <div
      data-tauri-drag-region
      className="relative flex items-center justify-between h-9 px-3 flex-shrink-0 border-b border-white/5 select-none"
    >
      {/* === 左侧：文字菜单（无 logo 无应用名，避免与 SideNav 顶部重复） === */}
      <nav className="flex items-center gap-0.5" data-no-drag>
        {['文件', '编辑', '视图'].map((m) => (
          <button
            key={m}
            className="px-2.5 py-1 text-2xs text-text-secondary hover:bg-white/8 hover:text-text-primary rounded-md transition-all duration-200 ease-out"
          >
            {m}
          </button>
        ))}
      </nav>

      {/* === 中央：当前项目名（极简灰字） === */}
      <div className="absolute left-1/2 -translate-x-1/2 flex items-center gap-1.5 pointer-events-none">
        {projectName && (
          <span className="text-2xs text-text-tertiary max-w-[280px] truncate font-mono">
            {projectName}
          </span>
        )}
      </div>

      {/* === 右侧：模型名（小灰字） + 窗口控制 === */}
      <div className="flex items-center gap-2">
        <span className="text-2xs text-text-tertiary font-mono">{model}</span>
        <div className="flex items-center gap-1 ml-1" data-no-drag>
          <button
            onClick={handleMin}
            className="w-8 h-7 inline-flex items-center justify-center rounded-md text-text-secondary hover:bg-white/8 transition-all duration-200 ease-out"
            title="最小化"
          >
            <MinimizeIcon />
          </button>
          <button
            onClick={handleMax}
            className="w-8 h-7 inline-flex items-center justify-center rounded-md text-text-secondary hover:bg-white/8 transition-all duration-200 ease-out"
            title={maximized ? '还原' : '最大化'}
          >
            {maximized ? <RestoreIcon /> : <MaximizeIcon />}
          </button>
          <button
            onClick={handleClose}
            className="w-8 h-7 inline-flex items-center justify-center rounded-md text-text-secondary hover:bg-rose-500/80 hover:text-white transition-all duration-200 ease-out"
            title="关闭"
          >
            <CloseIcon />
          </button>
        </div>
      </div>
    </div>
  )
}

/* ============== 图标 ============== */

function MinimizeIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
      <path d="M2 6h8" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
    </svg>
  )
}

function MaximizeIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
      <rect x="2" y="2" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.1" />
    </svg>
  )
}

function RestoreIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
      <rect x="3" y="1.5" width="6.5" height="6.5" rx="1.5" stroke="currentColor" strokeWidth="1.1" />
      <rect x="2" y="3" width="6.5" height="6.5" rx="1.5" stroke="currentColor" strokeWidth="1.1" fill="rgba(0,0,0,0.25)" />
    </svg>
  )
}

function CloseIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
      <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
    </svg>
  )
}
