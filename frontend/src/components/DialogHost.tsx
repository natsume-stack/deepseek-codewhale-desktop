/**
 * 全局对话框渲染根：在 App.tsx 挂载一次即可
 *
 * 监听 useDialogStore._current，渲染 prompt/confirm/alert 三种模态。
 */
import { useEffect, useRef, useState } from 'react'
import { useDialogStore } from '../stores/dialog'

export function DialogHost() {
  const current = useDialogStore((s) => s._current)
  const close = useDialogStore((s) => s._close)

  const [inputValue, setInputValue] = useState('')
  const inputRef = useRef<HTMLInputElement | null>(null)

  // 每次弹窗打开时，重置输入值并自动聚焦
  useEffect(() => {
    if (current?.kind === 'prompt') {
      setInputValue(current.defaultValue ?? '')
      // 下一帧聚焦，避免 DOM 还没渲染
      requestAnimationFrame(() => {
        inputRef.current?.focus()
        inputRef.current?.select()
      })
    }
  }, [current])

  if (!current) return null

  const isPrompt = current.kind === 'prompt'
  const isConfirm = current.kind === 'confirm'
  const isAlert = current.kind === 'alert'

  const confirmText = current.confirmText ?? (isAlert ? '知道了' : '确定')
  const cancelText = current.cancelText ?? '取消'

  const handleConfirm = () => {
    if (isPrompt) {
      close(inputValue)
    } else if (isConfirm) {
      close(true)
    } else {
      close(null)
    }
  }

  const handleCancel = () => {
    close(isPrompt ? null : false)
  }

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      handleCancel()
    } else if (e.key === 'Enter' && (isPrompt || isConfirm || isAlert)) {
      // prompt: 回车确认；alert: 回车关闭；confirm: 回车确认
      e.preventDefault()
      handleConfirm()
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm animate-fade-in"
      onKeyDown={handleKey}
      onClick={handleCancel}
    >
      <div
        className="w-[420px] max-w-[90vw] rounded-lg border border-white/10 bg-white/10 shadow-raised animate-scale-in"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 标题栏 */}
        <div className="px-4 py-3 border-b border-white/8">
          <div className="text-sm font-semibold text-text-primary">{current.title}</div>
        </div>

        {/* 主体 */}
        <div className="px-4 py-4">
          {current.message && (
            <div className="text-sm text-text-secondary whitespace-pre-wrap mb-3 leading-relaxed">
              {current.message}
            </div>
          )}
          {isPrompt && (
            <input
              ref={inputRef}
              type="text"
              className="input-base w-full"
              value={inputValue}
              placeholder={current.placeholder}
              onChange={(e) => setInputValue(e.target.value)}
              spellCheck={false}
            />
          )}
        </div>

        {/* 按钮栏 */}
        <div className="flex justify-end gap-2 px-4 py-3 border-t border-white/8 bg-white/4">
          {!isAlert && (
            <button
              onClick={handleCancel}
              className="btn-secondary"
              autoFocus={!isPrompt}
            >
              {cancelText}
            </button>
          )}
          <button
            onClick={handleConfirm}
            className={current.danger ? 'btn-danger' : 'btn-primary'}
            disabled={isPrompt && inputValue.trim() === ''}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  )
}
