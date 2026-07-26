import { useEffect, useRef, useState } from 'react'
import { useDialogStore } from '../stores/dialog'

export function DialogHost() {
  const current = useDialogStore((s) => s._current)
  const close = useDialogStore((s) => s._close)

  const [inputValue, setInputValue] = useState('')
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (current?.kind === 'prompt') {
      setInputValue(current.defaultValue ?? '')
      requestAnimationFrame(() => {
        inputRef.current?.focus()
        inputRef.current?.select()
      })
    }
  }, [current])

  // 组件 unmount 时（路由切换 / 父组件卸载 / 面板关闭等），
  // reject 所有 pending Promise，避免调用方 `await dialog.prompt(...)` 永久挂起
  useEffect(() => {
    return () => {
      useDialogStore.getState()._fail('Dialog unmounted')
    }
  }, [])

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
      e.preventDefault()
      handleConfirm()
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 animate-fade-in"
      onKeyDown={handleKey}
      onClick={handleCancel}
    >
      <div
        className="w-[460px] max-w-[92vw] rounded-3xl border border-surface-border bg-surface-elevated shadow-raised animate-scale-in overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-white/5">
          <div className="text-base font-semibold text-text-primary">{current.title}</div>
        </div>

        <div className="px-5 py-5">
          {current.message && (
            <div className="text-sm text-text-secondary whitespace-pre-wrap mb-4 leading-relaxed">
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

        <div className="flex justify-end gap-3 px-5 py-4 border-t border-white/5 bg-white/3">
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
            className={current.danger ? 'btn-warn' : 'btn-primary'}
            disabled={isPrompt && inputValue.trim() === ''}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  )
}
