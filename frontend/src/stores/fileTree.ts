/**
 * 文件树状态管理（zustand）
 *
 * 负责:
 *  - 当前项目根目录加载（POST /api/project/load）
 *  - 文件树拉取（GET /api/project/tree?depth=N）
 *  - 展开/折叠/选中状态
 *  - 文件 CRUD：新建文件 / 新建文件夹 / 删除 / 重命名
 *  - 复制路径 / 在资源管理器打开
 *
 * 后端契约见 src/routes/files.rs
 */
import { create } from 'zustand'
import { filesApi, projectApi } from '../lib/api'
import type { FileNode } from '../types'

interface FileTreeState {
  /** 当前项目根目录（绝对路径），null 表示未加载 */
  rootPath: string | null
  /** 文件树根节点 */
  tree: FileNode | null
  /** 加载中 */
  loading: boolean
  /** 最近一次错误 */
  error: string | null
  /** 展开的文件夹 path 集合 */
  expanded: Set<string>
  /** 当前选中节点 path */
  selectedPath: string | null
  /** 最近操作时间戳（供 UI 刷新） */
  refreshedAt: number

  /** 加载项目目录 */
  loadProject: (path: string) => Promise<boolean>
  /** 刷新文件树（保持展开/选中状态） */
  refresh: () => Promise<void>
  /** 展开/折叠切换 */
  toggleExpand: (path: string) => void
  /** 设置选中 */
  select: (path: string | null) => void

  /** 新建文件 */
  createFile: (parentPath: string, name: string, isFolder: boolean, content?: string) => Promise<boolean>
  /** 删除 */
  remove: (path: string) => Promise<boolean>
  /** 重命名 */
  rename: (from: string, to: string) => Promise<boolean>
  /** 在资源管理器打开 */
  reveal: (path: string) => Promise<void>
  /** 复制路径到剪贴板 */
  copyPath: (path: string) => Promise<void>
}

export const useFileTreeStore = create<FileTreeState>((set, get) => ({
  rootPath: null,
  tree: null,
  loading: false,
  error: null,
  expanded: new Set<string>(),
  selectedPath: null,
  refreshedAt: 0,

  loadProject: async (path) => {
    set({ loading: true, error: null })
    try {
      const r = await projectApi.load(path)
      set({ rootPath: r.path })
      await get().refresh()
      return true
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      set({ loading: false, error: msg })
      return false
    }
  },

  refresh: async () => {
    const { rootPath } = get()
    if (!rootPath) return
    set({ loading: true, error: null })
    try {
      const r = await projectApi.tree(4)
      set({
        tree: r.tree,
        loading: false,
        refreshedAt: Date.now(),
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      set({ loading: false, error: msg })
    }
  },

  toggleExpand: (path) =>
    set((s) => {
      const next = new Set(s.expanded)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return { expanded: next }
    }),

  select: (path) => set({ selectedPath: path }),

  createFile: async (parentPath, name, isFolder, content) => {
    try {
      await filesApi.create({ name, parentPath, isFolder, content })
      // 自动展开父目录
      set((s) => {
        const next = new Set(s.expanded)
        next.add(parentPath)
        return { expanded: next }
      })
      await get().refresh()
      return true
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      set({ error: msg })
      return false
    }
  },

  remove: async (path) => {
    try {
      await filesApi.delete(path)
      await get().refresh()
      return true
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      set({ error: msg })
      return false
    }
  },

  rename: async (from, to) => {
    try {
      await filesApi.rename({ from, to })
      await get().refresh()
      return true
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      set({ error: msg })
      return false
    }
  },

  reveal: async (path) => {
    try {
      await filesApi.reveal({ path })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      set({ error: msg })
    }
  },

  copyPath: async (path) => {
    try {
      await navigator.clipboard.writeText(path)
    } catch {
      /* ignore */
    }
  },
}))
