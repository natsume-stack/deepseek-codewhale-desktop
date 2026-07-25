/**
 * 全局对话框 store（替代 window.prompt / window.alert / window.confirm）
 *
 * 浏览器开发态与 Tauri 桌面环境均可用，避免 window.prompt 在 Tauri webview 中不被支持。
 *
 * 用法：
 *   const dialog = useDialogStore()
 *   const path = await dialog.prompt({ title: '打开项目', defaultValue: 'C:\\' })
 *   const ok = await dialog.confirm({ title: '删除', message: '确认？', danger: true })
 *   await dialog.alert({ title: '提示', message: '已保存' })
 *
 * 同时在 App.tsx 挂载一次 <DialogHost />。
 */
import { create } from 'zustand'

type DialogKind = 'prompt' | 'confirm' | 'alert'

interface BaseConfig {
  title: string
  message?: string
  /** prompt 默认值 */
  defaultValue?: string
  /** prompt 占位符 */
  placeholder?: string
  /** 确认按钮文案 */
  confirmText?: string
  /** 取消按钮文案 */
  cancelText?: string
  /** 危险操作（确认按钮变红） */
  danger?: boolean
}

interface DialogState {
  _current: (BaseConfig & { kind: DialogKind }) | null
  _resolve: ((v: string | boolean | null) => void) | null

  prompt: (cfg: BaseConfig) => Promise<string | null>
  confirm: (cfg: BaseConfig) => Promise<boolean>
  alert: (cfg: BaseConfig) => Promise<void>
  _close: (value: string | boolean | null) => void
}

export const useDialogStore = create<DialogState>((set, get) => ({
  _current: null,
  _resolve: null,

  prompt: (cfg) =>
    new Promise<string | null>((resolve) => {
      set({
        _current: { ...cfg, kind: 'prompt' },
        _resolve: resolve as (v: string | boolean | null) => void,
      })
    }),

  confirm: (cfg) =>
    new Promise<boolean>((resolve) => {
      set({
        _current: { ...cfg, kind: 'confirm' },
        _resolve: resolve as (v: string | boolean | null) => void,
      })
    }),

  alert: (cfg) =>
    new Promise<void>((resolve) => {
      set({
        _current: { ...cfg, kind: 'alert' },
        _resolve: () => {
          resolve()
        },
      })
    }),

  _close: (value) => {
    const r = get()._resolve
    set({ _current: null, _resolve: null })
    r?.(value)
  },
}))

/** 便捷引用：在 React 组件外直接调用（如 store 内部） */
export const dialog = {
  prompt: (cfg: BaseConfig) => useDialogStore.getState().prompt(cfg),
  confirm: (cfg: BaseConfig) => useDialogStore.getState().confirm(cfg),
  alert: (cfg: BaseConfig) => useDialogStore.getState().alert(cfg),
}
