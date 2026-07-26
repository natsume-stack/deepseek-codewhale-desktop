/**
 * App 根组件 - Codex 桌面客户端风格
 *
 * 严格三层架构：
 *   1. 系统窗口层（Tauri + Win32 Mica）：由 tauri.conf.json 配置
 *   2. WebView 容器（html/body/#root）：全透明（见 index.css）
 *   3. 前端组件层：分为两个视觉区域
 *      - 左侧 SideNav：透明，让 Mica 穿透显示（毛玻璃区域）
 *      - 右侧工作区：不透明深色圆角板块（黑灰区域）
 *
 * 布局（严格复刻 Codex Desktop）：
 *   ┌─────────────────────────────────────────────────────┐
 *   │  顶部菜单栏（透明，Mica 穿透 + 自绘标题栏）            │  data-tauri-drag-region
 *   ├─────────────────────────────────────────────────────┤
 *   │  会话标签栏 [会话A][会话B][会话C] +                    │  仅对话页显示
 *   ├──────┬──────────────────────────────────────────────┤
 *   │ 窄   │  ╭────────────────────────────────────────╮ │
 *   │ 导   │  │                                          │ │
 *   │ 航   │  │      工作区（不透明圆角板块）              │ │
 *   │ 栏   │  │   - 对话页：FileTree | Chat | Diff       │ │
 *   │ 毛   │  │   - 设置页：左侧菜单 + 右侧内容            │ │
 *   │ 玻   │  │                                          │ │
 *   │ 璃   │  ╰────────────────────────────────────────╯ │
 *   └──────┴──────────────────────────────────────────────┘
 */
import { useEffect, useState } from 'react'
import { useResizableLayout } from './hooks/useResizableLayout'
import { TitleBar } from './components/TitleBar'
import { SideNav } from './components/SideNav'
import { WorkArea } from './components/WorkArea'
import { SettingsPage, applyAppearanceConfig, type SettingsSection } from './components/SettingsPage'
import { DialogHost } from './components/DialogHost'
import { ApprovalDialog } from './components/ApprovalDialog'
import { useFileTreeStore } from './stores/fileTree'
import { useChatStore } from './stores/chat'
import { configApi, projectApi } from './lib/api'

export type NavView = 'chat' | 'settings'

export default function App() {
  const layout = useResizableLayout()
  const [view, setView] = useState<NavView>('chat')
  const [model, setModel] = useState<string>('deepseek-chat')
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('model')

  // 启动时拉取后端配置 + 同步已加载项目
  useEffect(() => {
    void configApi.get().then((c) => setModel(c.model)).catch(() => {})
    void configApi.getAppearance().then(applyAppearanceConfig).catch(() => {})
    void projectApi
      .get()
      .then((p) => {
        if (p.loaded && p.path) {
          void useFileTreeStore.getState().loadProject(p.path)
        }
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    let bindings: Record<string, string> = {}
    const normalize = (event: KeyboardEvent) => {
      const parts: string[] = []
      if (event.ctrlKey) parts.push('Ctrl')
      if (event.altKey) parts.push('Alt')
      if (event.shiftKey) parts.push('Shift')
      if (event.metaKey) parts.push('Meta')
      const key = event.key === ' ' ? 'Space' : event.key
      if (!['Control', 'Alt', 'Shift', 'Meta'].includes(key)) parts.push(key.length === 1 ? key.toUpperCase() : key)
      return parts.join('+')
    }
    const onKeyDown = (event: KeyboardEvent) => {
      const shortcut = normalize(event)
      if (shortcut === bindings['new-session']) {
        event.preventDefault()
        handleNewSession()
      } else if (shortcut === bindings['toggle-settings']) {
        event.preventDefault()
        setView((current) => current === 'settings' ? 'chat' : 'settings')
      } else if (shortcut === bindings['stop-generation'] && useChatStore.getState().streaming) {
        event.preventDefault()
        void useChatStore.getState().stop()
      }
    }
    void configApi.getShortcuts().then((config) => { bindings = config.bindings }).catch(() => {})
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  /** 切换会话：加载后端历史。会话入口保留在左侧「最近」列表。 */
  const handleSessionSwitch = (id: string) => {
    if (!id.startsWith('tab_')) {
      void useChatStore.getState().switchSession(id).catch(() => {})
    }
  }

  /** 新建会话：清空当前对话视图，首次发送时由后端创建会话。 */
  const handleNewSession = () => {
    useChatStore.getState().clearView()
  }

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden text-text-primary">
      {/* === 顶部菜单栏（透明，Mica 穿透） === */}
      <TitleBar model={model} />

      {/* === 主体：左侧窄导航（Mica 穿透） + 右侧工作区（不透明板块） === */}
      <div className="flex flex-1 min-h-0">
        {/* 左侧窄导航栏（透明，Mica 穿透） */}
        <SideNav
          view={view}
          onViewChange={setView}
          onNewSession={handleNewSession}
          onSessionSelect={handleSessionSwitch}
          settingsSection={settingsSection}
          onSettingsSectionChange={setSettingsSection}
        />

        {/* 右侧工作区（不透明圆角板块，与 SideNav 视觉分层） */}
        <div className="flex-1 min-w-0 min-h-0">
          <div className="work-surface h-full w-full">
            <div key={view} className="h-full w-full animate-page-transition">
              {view === 'chat' ? (
                <WorkArea layout={layout} />
              ) : (
                <SettingsPage section={settingsSection} />
              )}
            </div>
          </div>
        </div>
      </div>

      {/* === 全局审批监听浮窗（非阻塞，右下角，z-40） === */}
      <ApprovalDialog />

      {/* === 全局模态对话框（最顶层浮层） === */}
      <DialogHost />
    </div>
  )
}
