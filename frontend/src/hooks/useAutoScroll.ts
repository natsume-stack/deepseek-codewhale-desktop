/**
 * 自动滚动到底部 Hook
 * 当 deps 变化时，若用户当前贴近底部则自动滚动，否则不打扰阅读。
 */
import { useEffect, useRef } from 'react'

export function useAutoScroll<T>(dep: T) {
  const ref = useRef<HTMLDivElement | null>(null)
  const stickRef = useRef(true)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onScroll = () => {
      const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
      stickRef.current = distFromBottom < 80
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (stickRef.current) {
      el.scrollTop = el.scrollHeight
    }
  }, [dep])

  return ref
}
