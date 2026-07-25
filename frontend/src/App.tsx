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
import { SettingsPage } from './components/SettingsPage'
import { SessionTabs } from './components/SessionTabs'
import { DialogHost } from './components/DialogHost'
import { ApprovalDialog } from './components/ApprovalDialog'
import { useFileTreeStore } from './stores/fileTree'
import { useSessionsStore } from './stores/sessions'
import { useChatStore } from './stores/chat'
import { configApi, projectApi } from './lib/api'

export type NavView = 'chat' | 'settings'

export default function App() {
  const layout = useResizableLayout()
  const [view, setView] = useState<NavView>('chat')
  const [model, setModel] = useState<string>('deepseek-chat')

  // 多会话标签状态（仅订阅 tabs/activeId；actions 通过 getState 调用以避免多余渲染）
  const tabs = useSessionsStore((s) => s.tabs)
  const activeId = useSessionsStore((s) => s.activeId)
  const chatSessionId = useChatStore((s) => s.sessionId)

  // 启动时拉取后端配置 + 同步已加载项目
  useEffect(() => {
    void configApi.get().then((c) => setModel(c.model)).catch(() => {})
    void projectApi
      .get()
      .then((p) => {
        if (p.loaded && p.path) {
          void useFileTreeStore.getState().loadProject(p.path)
        }
      })
      .catch(() => {})
  }, [])

  // 同步 chat.sessionId → sessions.activeId
  // 当后端创建新会话（首条消息后 SSE 'session' 事件）时，确保 sessions store 有对应标签
  // 若当前 active 是 openNew 创建的占位符（tab_ 前缀），sessions store 会自动重绑定
  useEffect(() => {
    if (chatSessionId) {
      useSessionsStore.getState().setActiveId(chatSessionId)
    }
  }, [chatSessionId])

  /* ============== SessionTabs 事件处理 ============== */

  /** 切换会话标签：同步 sessions store + 加载后端历史 */
  const handleSessionSwitch = (id: string) => {
    useSessionsStore.getState().switchTo(id)
    // 占位符标签（tab_ 前缀）无对应后端会话，跳过历史拉取
    if (!id.startsWith('tab_')) {
      void useChatStore.getState().switchSession(id).catch(() => {})
    }
  }

  /** 关闭会话标签：若关闭的是 active，自动切到相邻标签并同步对话视图 */
  const handleSessionClose = (id: string) => {
    const wasActive = id === useSessionsStore.getState().activeId
    useSessionsStore.getState().close(id)
    if (wasActive) {
      const nextActive = useSessionsStore.getState().activeId
      if (nextActive && !nextActive.startsWith('tab_')) {
        void useChatStore.getState().switchSession(nextActive).catch(() => {})
      } else if (!nextActive) {
        // 无标签剩余：清空对话视图
        useChatStore.getState().clearView()
      }
    }
  }

  /** 新建会话标签：创建占位符标签 + 清空当前对话视图 */
  const handleNewSession = () => {
    useSessionsStore.getState().openNew()
    useChatStore.getState().clearView()
  }

  /** 置顶/取消置顶 */
  const handleSessionPin = (id: string) => {
    useSessionsStore.getState().pin(id)
  }

  /** 重命名标签 */
  const handleSessionRename = (id: string, title: string) => {
    useSessionsStore.getState().rename(id, title)
  }

  /** 拖拽排序：将 fromId 移动到 toId 之前的位置 */
  const handleSessionMove = (fromId: string, toId: string) => {
    useSessionsStore.getState().moveTab(fromId, toId)
  }

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden text-text-primary">
      {/* === 顶部菜单栏（透明，Mica 穿透） === */}
      <TitleBar model={model} />

      {/* === 会话标签栏（仅对话页显示，Mica 穿透） === */}
      {view === 'chat' && (
        <SessionTabs
          tabs={tabs}
          activeId={activeId}
          onSwitch={handleSessionSwitch}
          onClose={handleSessionClose}
          onNew={handleNewSession}
          onPin={handleSessionPin}
          onRename={handleSessionRename}
          onMove={handleSessionMove}
        />
      )}

      {/* === 主体：左侧窄导航（Mica 穿透） + 右侧工作区（不透明板块） === */}
      <div className="flex flex-1 min-h-0">
        {/* 左侧窄导航栏（透明，Mica 穿透） */}
        <SideNav view={view} onViewChange={setView} />

        {/* 右侧工作区（不透明圆角板块，与 SideNav 视觉分层） */}
        <div className="flex-1 min-w-0 min-h-0 p-2 pl-0">
          <div className="work-surface h-full w-full">
            {view === 'chat' ? (
              <WorkArea layout={layout} />
            ) : (
              <SettingsPage />
            )}
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
