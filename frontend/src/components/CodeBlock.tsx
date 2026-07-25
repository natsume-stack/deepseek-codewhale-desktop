/**
 * 代码块组件
 *
 * 特性:
 *  - 文件名头部（若 MarkdownLite 解析到则展示，否则显示语言标签）
 *  - 行号列
 *  - 复制代码按钮
 *  - 应用修改 / 拒绝修改按钮（由父组件可选挂载）
 *  - 极简语法着色（不引入 shiki / prismjs，保持轻量）
 *
 * 视觉规范对齐 Palot：暗色背景、文件名 chip、行号低饱和度。
 */
import { useMemo, useState } from 'react'

interface CodeBlockProps {
  code: string
  lang?: string
  filename?: string
  /** 应用修改回调（不传则不显示该按钮） */
  onApply?: () => void | Promise<void>
  /** 拒绝修改回调（不传则不显示该按钮） */
  onReject?: () => void | Promise<void>
}

const KEYWORDS = new Set([
  'fn', 'let', 'const', 'mut', 'pub', 'struct', 'enum', 'impl', 'trait', 'use',
  'mod', 'async', 'await', 'return', 'if', 'else', 'for', 'while', 'loop', 'match',
  'function', 'class', 'interface', 'type', 'export', 'import', 'from', 'new',
  'this', 'super', 'extends', 'static', 'readonly', 'void', 'null', 'undefined',
  'true', 'false', 'def', 'self', 'lambda', 'pass', 'raise', 'try', 'except',
  'finally', 'with', 'as', 'yield', 'namespace', 'template', 'typename',
])

const STRING_DELIMS = ['"', "'", '`'] as const

/** 极简 token 化：仅识别关键字 / 字符串 / 注释 / 数字 */
function tokenize(line: string, lang?: string) {
  const tokens: { text: string; cls: string }[] = []
  let i = 0
  const isRustLike = !lang || ['rust', 'ts', 'tsx', 'js', 'jsx', 'python', 'py', 'go', 'java', 'c', 'cpp', 'cs'].includes(lang)
  while (i < line.length) {
    const ch = line[i]
    // 行注释
    if (isRustLike && (ch === '/' && line[i + 1] === '/' || ch === '#')) {
      tokens.push({ text: line.slice(i), cls: 'text-text-tertiary italic' })
      break
    }
    // 字符串
    if (STRING_DELIMS.includes(ch as typeof STRING_DELIMS[number])) {
      const close = ch
      let j = i + 1
      while (j < line.length && line[j] !== close) {
        if (line[j] === '\\') j++
        j++
      }
      tokens.push({ text: line.slice(i, Math.min(j + 1, line.length)), cls: 'text-diff-added-text' })
      i = j + 1
      continue
    }
    // 标识符 / 关键字
    if (/[A-Za-z_]/.test(ch)) {
      let j = i + 1
      while (j < line.length && /[A-Za-z0-9_]/.test(line[j])) j++
      const word = line.slice(i, j)
      tokens.push({
        text: word,
        cls: KEYWORDS.has(word) ? 'text-accent-hover' : 'text-text-primary',
      })
      i = j
      continue
    }
    // 数字
    if (/[0-9]/.test(ch)) {
      let j = i + 1
      while (j < line.length && /[0-9._]/.test(line[j])) j++
      tokens.push({ text: line.slice(i, j), cls: 'text-[#b5cea8]' })
      i = j
      continue
    }
    // 单字符
    tokens.push({ text: ch, cls: 'text-text-secondary' })
    i++
  }
  return tokens
}

export function CodeBlock({ code, lang, filename, onApply, onReject }: CodeBlockProps) {
  const [copied, setCopied] = useState(false)
  const [applying, setApplying] = useState(false)
  const lines = useMemo(() => code.replace(/\n$/, '').split('\n'), [code])

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* ignore */
    }
  }

  const handleApply = async () => {
    if (!onApply) return
    setApplying(true)
    try {
      await onApply()
    } finally {
      setApplying(false)
    }
  }

  return (
    <div className="my-2 rounded-md border border-white/8 bg-white/4 overflow-hidden animate-fade-in">
      {/* 文件名头部 */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-white/6 border-b border-white/8">
        <div className="flex items-center gap-2 min-w-0">
          <FileIcon lang={lang} filename={filename} />
          <span className="text-xs font-mono text-text-secondary truncate">
            {filename || lang || 'code'}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={handleCopy}
            className="icon-btn"
            title="复制代码"
            data-selectable="true"
          >
            {copied ? <CheckIcon /> : <CopyIcon />}
          </button>
          {onApply && (
            <button
              onClick={handleApply}
              disabled={applying}
              className="btn-secondary !py-1 !px-2 !text-2xs"
              title="将此修改注册为 Diff，稍后在 Diff 面板应用"
            >
              {applying ? '注册中…' : '应用修改'}
            </button>
          )}
          {onReject && (
            <button
              onClick={onReject}
              className="icon-btn"
              title="拒绝修改"
            >
              <CloseIcon />
            </button>
          )}
        </div>
      </div>
      {/* 代码体 */}
      <div className="overflow-x-auto" data-selectable="true">
        <pre className="font-mono text-xs leading-5 py-2">
          {lines.map((line, idx) => (
            <div key={idx} className="flex px-3 hover:bg-white/4">
              <span className="select-none w-8 flex-shrink-0 pr-3 text-right text-text-tertiary">
                {idx + 1}
              </span>
              <code className="flex-1 whitespace-pre">
                {tokenize(line, lang).map((t, k) => (
                  <span key={k} className={t.cls}>{t.text}</span>
                ))}
                {line.length === 0 ? '\u00A0' : null}
              </code>
            </div>
          ))}
        </pre>
      </div>
    </div>
  )
}

function FileIcon({ lang, filename }: { lang?: string; filename?: string }) {
  // 极简图标：按扩展名着色
  const ext = filename?.split('.').pop()?.toLowerCase() || lang || ''
  const color =
    ext === 'rs' ? '#dea584' :
    ext === 'ts' || ext === 'tsx' ? '#3178c6' :
    ext === 'js' || ext === 'jsx' ? '#f7df1e' :
    ext === 'py' ? '#3572a5' :
    ext === 'json' ? '#cbcb41' :
    ext === 'md' ? '#519aba' :
    '#9d9d9d'
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" style={{ color }}>
      <path d="M3 1.5h7l3 3V14.5H3z" stroke="currentColor" strokeWidth="1" fill="currentColor" fillOpacity="0.15" />
      <path d="M10 1.5v3h3" stroke="currentColor" strokeWidth="1" />
    </svg>
  )
}

function CopyIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
      <rect x="5" y="5" width="8" height="8" rx="1" stroke="currentColor" strokeWidth="1.1" />
      <path d="M3 11V3h8" stroke="currentColor" strokeWidth="1.1" />
    </svg>
  )
}

function CheckIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" className="text-diff-added-text">
      <path d="M3 8l3 3 7-7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function CloseIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
      <line x1="4" y1="4" x2="12" y2="12" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <line x1="12" y1="4" x2="4" y2="12" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}
