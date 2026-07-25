/**
 * 三栏可拖拽布局 Hook
 * 管理左右栏宽度、折叠状态、拖拽逻辑，宽度持久化到 localStorage
 */
import { useCallback, useEffect, useRef, useState } from 'react'

const STORAGE_KEY = 'codewhale.layout'

interface LayoutState {
  leftWidth: number
  rightWidth: number
  leftCollapsed: boolean
  rightCollapsed: boolean
}

const DEFAULT_STATE: LayoutState = {
  leftWidth: 260,
  rightWidth: 320,
  leftCollapsed: false,
  rightCollapsed: false,
}

const MIN_WIDTH = 200
const MAX_LEFT = 480
const MAX_RIGHT = 560

function loadState(): LayoutState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_STATE
    return { ...DEFAULT_STATE, ...JSON.parse(raw) }
  } catch {
    return DEFAULT_STATE
  }
}

export function useResizableLayout() {
  const [state, setState] = useState<LayoutState>(loadState)
  const draggingRef = useRef<'left' | 'right' | null>(null)
  const startXRef = useRef(0)
  const startWidthRef = useRef(0)

  // 持久化
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
    } catch {
      // 忽略
    }
  }, [state])

  // 全局鼠标事件（拖拽中）
  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!draggingRef.current) return
      const delta = e.clientX - startXRef.current
      if (draggingRef.current === 'left') {
        setState((s) => ({
          ...s,
          leftWidth: Math.min(MAX_LEFT, Math.max(MIN_WIDTH, startWidthRef.current + delta)),
        }))
      } else {
        setState((s) => ({
          ...s,
          rightWidth: Math.min(MAX_RIGHT, Math.max(MIN_WIDTH, startWidthRef.current - delta)),
        }))
      }
    }
    const onMouseUp = () => {
      draggingRef.current = null
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    return () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }
  }, [])

  const startDrag = useCallback((side: 'left' | 'right') => (e: React.MouseEvent) => {
    e.preventDefault()
    draggingRef.current = side
    startXRef.current = e.clientX
    startWidthRef.current = side === 'left' ? state.leftWidth : state.rightWidth
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }, [state.leftWidth, state.rightWidth])

  const toggleLeft = useCallback(() => {
    setState((s) => ({ ...s, leftCollapsed: !s.leftCollapsed }))
  }, [])

  const toggleRight = useCallback(() => {
    setState((s) => ({ ...s, rightCollapsed: !s.rightCollapsed }))
  }, [])

  return {
    leftWidth: state.leftCollapsed ? 0 : state.leftWidth,
    rightWidth: state.rightCollapsed ? 0 : state.rightWidth,
    leftCollapsed: state.leftCollapsed,
    rightCollapsed: state.rightCollapsed,
    startDragLeft: startDrag('left'),
    startDragRight: startDrag('right'),
    toggleLeft,
    toggleRight,
  }
}
