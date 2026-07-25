/**
 * 轻量 Markdown 渲染器
 *
 * 仅支持 AI 消息常用语法：
 *  - ```lang\n...\n``` 代码块（可选文件名: ```lang:path/to/file.ts）
 *  - `inline code`
 *  - **bold** / *italic*
 *  - [text](url) 链接
 *  - 段落、换行
 *  - - / * 列表
 *
 * 不引入 react-markdown / remark 等重型依赖，符合项目"禁止冗余重型依赖"约束。
 * 代码块通过 CodeBlock 组件渲染，支持复制/应用/拒绝。
 */
import { Fragment, type ReactNode } from 'react'
import { CodeBlock } from './CodeBlock'

interface ParsedBlock {
  type: 'code' | 'text'
  content: string
  lang?: string
  filename?: string
}

/** 将原始 markdown 文本切分为 代码块 / 文本块 序列 */
function parseBlocks(md: string): ParsedBlock[] {
  const blocks: ParsedBlock[] = []
  const re = /```([^\n]*)\n([\s\S]*?)```/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(md)) !== null) {
    if (m.index > last) {
      blocks.push({ type: 'text', content: md.slice(last, m.index) })
    }
    const header = (m[1] || '').trim()
    const code = m[2] ?? ''
    // 解析 ```lang:filename 或 ```filename.lang 形式
    let lang: string | undefined
    let filename: string | undefined
    if (header) {
      if (header.includes(':')) {
        const [l, f] = header.split(':', 2)
        lang = l.trim() || undefined
        filename = f.trim() || undefined
      } else if (header.includes('.')) {
        // 形如 ```app.tsx
        filename = header
        const dot = header.lastIndexOf('.')
        if (dot > 0) lang = header.slice(dot + 1)
      } else {
        lang = header
      }
    }
    blocks.push({ type: 'code', content: code, lang, filename })
    last = re.lastIndex
  }
  if (last < md.length) {
    blocks.push({ type: 'text', content: md.slice(last) })
  }
  return blocks
}

/** 渲染行内格式（粗体 / 斜体 / 行内代码 / 链接） */
function renderInline(text: string, keyBase: string): ReactNode[] {
  const nodes: ReactNode[] = []
  // 简单扫描，按优先级匹配
  const re = /(\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\))/g
  let last = 0
  let i = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) nodes.push(<Fragment key={`${keyBase}-t-${i}`}>{text.slice(last, m.index)}</Fragment>)
    if (m[2] !== undefined) {
      nodes.push(<strong key={`${keyBase}-b-${i}`} className="font-semibold text-text-primary">{m[2]}</strong>)
    } else if (m[3] !== undefined) {
      nodes.push(<em key={`${keyBase}-i-${i}`}>{m[3]}</em>)
    } else if (m[4] !== undefined) {
      nodes.push(
        <code key={`${keyBase}-c-${i}`} className="px-1 py-0.5 rounded bg-white/8 text-diff-added-text font-mono text-xs">
          {m[4]}
        </code>,
      )
    } else if (m[5] !== undefined && m[6] !== undefined) {
      nodes.push(
        <a key={`${keyBase}-a-${i}`} href={m[6]} target="_blank" rel="noreferrer noopener"
           className="text-accent hover:text-accent-hover underline underline-offset-2">
          {m[5]}
        </a>,
      )
    }
    last = re.lastIndex
    i++
  }
  if (last < text.length) {
    nodes.push(<Fragment key={`${keyBase}-t-end`}>{text.slice(last)}</Fragment>)
  }
  return nodes
}

/** 渲染文本块（段落 + 列表 + 换行） */
function renderTextBlock(text: string, keyBase: string): ReactNode {
  const lines = text.split('\n')
  const out: ReactNode[] = []
  let listBuf: string[] = []
  let listIdx = 0

  const flushList = () => {
    if (listBuf.length === 0) return
    const items = listBuf.map((item, idx) => (
      <li key={`${keyBase}-li-${idx}`} className="ml-5 list-disc text-text-primary">
        {renderInline(item, `${keyBase}-li-${idx}`)}
      </li>
    ))
    out.push(<ul key={`${keyBase}-ul-${listIdx++}`} className="my-1 space-y-0.5">{items}</ul>)
    listBuf = []
  }

  lines.forEach((line, idx) => {
    const trimmed = line.trim()
    if (/^[-*]\s+/.test(trimmed)) {
      listBuf.push(trimmed.replace(/^[-*]\s+/, ''))
    } else {
      flushList()
      if (trimmed === '') {
        // 空行：不渲染，自然形成段落间距
      } else {
        out.push(
          <p key={`${keyBase}-p-${idx}`} className="my-1 leading-relaxed text-text-primary">
            {renderInline(line, `${keyBase}-p-${idx}`)}
          </p>,
        )
      }
    }
  })
  flushList()
  return <>{out}</>
}

interface MarkdownLiteProps {
  text: string
  /** 当用户点击代码块"应用修改"时回调，返回 diffId */
  onApplyCode?: (code: string, filename?: string, lang?: string) => void | Promise<void>
  /** 当用户点击"拒绝修改"时回调 */
  onRejectCode?: (filename?: string) => void
}

export function MarkdownLite({ text, onApplyCode, onRejectCode }: MarkdownLiteProps) {
  const blocks = parseBlocks(text)
  return (
    <div className="space-y-2 text-sm">
      {blocks.map((b, i) => {
        if (b.type === 'code') {
          return (
            <CodeBlock
              key={`cb-${i}`}
              code={b.content}
              lang={b.lang}
              filename={b.filename}
              onApply={onApplyCode ? () => onApplyCode(b.content, b.filename, b.lang) : undefined}
              onReject={onRejectCode ? () => onRejectCode(b.filename) : undefined}
            />
          )
        }
        return <Fragment key={`tb-${i}`}>{renderTextBlock(b.content, `tb-${i}`)}</Fragment>
      })}
    </div>
  )
}
