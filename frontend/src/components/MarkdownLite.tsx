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
 *
 * DSML 块过滤（Agent Loop）：
 *  - <tool>...</tool>、<arg>...</arg>、<todo>...</todo>、<tool_result>...</tool_result>
 *    会被自动剥离，避免原始 XML 污染文本展示。
 *  - 这些块的实际展示由 ToolCallCard 组件负责（基于 SSE 事件，而非文本解析）。
 */
import { Fragment, type ReactNode } from 'react'
import { CodeBlock } from './CodeBlock'

interface ParsedBlock {
  type: 'code' | 'text'
  content: string
  lang?: string
  filename?: string
}

/**
 * 剥离 DSML XML 块。
 * 在流式累积中，未闭合的块（如 `<tool>` 但还没 `</tool>`）会被全部隐藏，
 * 直到闭合标签到达后才作为完整块剥离——这避免流式过程中显示半截 XML。
 */
function stripDsmlBlocks(text: string): string {
  // 已闭合的块：整体移除（含内容）
  // 注意：先剥 tool_result / tool / todo，再剥零散 <arg> 标签
  let out = text
  // <tool>...</tool>（含属性）
  out = out.replace(/<tool\b[^>]*>[\s\S]*?<\/tool>/g, '')
  // <todo>...</todo>
  out = out.replace(/<todo\b[^>]*>[\s\S]*?<\/todo>/g, '')
  // <tool_result>...</tool_result>
  out = out.replace(/<tool_result\b[^>]*>[\s\S]*?<\/tool_result>/g, '')
  // <arg>...</arg>（独立出现的零散 arg 标签）
  out = out.replace(/<arg\b[^>]*>[\s\S]*?<\/arg>/g, '')
  // 未闭合的 <tool> 或 <todo> 或 <tool_result> 起始标签及之后内容：全部隐藏
  // （流式中半截块不可展示）
  out = out.replace(/<tool\b[^>]*>[\s\S]*$/g, '')
  out = out.replace(/<todo\b[^>]*>[\s\S]*$/g, '')
  out = out.replace(/<tool_result\b[^>]*>[\s\S]*$/g, '')
  // 清理多余空行（剥离后可能留下连续空行）
  out = out.replace(/\n{3,}/g, '\n\n')
  return out
}

/**
 * XSS 防护：校验链接 url 协议白名单。
 * 仅允许 http/https/mailto/tel 协议，或无协议的相对路径（/path, #anchor, ./foo 等）。
 * 拒绝 javascript:, data:, vbscript: 等危险协议。
 */
function isSafeUrl(url: string): boolean {
  const trimmed = url.trim()
  if (trimmed === '') return false
  // 白名单协议
  if (/^(https?:|mailto:|tel:)/i.test(trimmed)) return true
  // 含有协议前缀但不在白名单（如 javascript:, data:, vbscript:）—— 拒绝
  if (/^[a-z][a-z0-9+\-.]*:/i.test(trimmed)) return false
  // 其他情况：无协议相对路径（如 /path, #anchor, ?query, ./foo, foo/bar）—— 安全
  return true
}

/** 将原始 markdown 文本切分为 代码块 / 文本块 序列 */
function parseBlocks(md: string): ParsedBlock[] {
  // 先剥离 DSML 块，再走代码块解析
  const cleaned = stripDsmlBlocks(md)
  // 流式渲染：检测未闭合的代码 fence（``` 数量为奇数时，自动在末尾补一个闭合 fence）
  // 仅用于本次渲染解析，不修改原始 content
  const fenceCount = (cleaned.match(/```/g) || []).length
  const parseTarget = fenceCount % 2 === 1 ? `${cleaned}\n\`\`\`\n` : cleaned
  const blocks: ParsedBlock[] = []
  const re = /```([^\n]*)\n([\s\S]*?)```/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(parseTarget)) !== null) {
    if (m.index > last) {
      blocks.push({ type: 'text', content: parseTarget.slice(last, m.index) })
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
  if (last < parseTarget.length) {
    blocks.push({ type: 'text', content: parseTarget.slice(last) })
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
      // XSS 防护：校验 url 协议白名单；不安全时降级为纯文本（不渲染 href）
      // 文本内容（m[5]）由 React 自动转义，无需手动处理
      const linkText = m[5]
      const rawUrl = m[6]
      if (isSafeUrl(rawUrl)) {
        nodes.push(
          <a key={`${keyBase}-a-${i}`} href={rawUrl} target="_blank" rel="noopener noreferrer"
             className="text-accent hover:text-accent-hover underline underline-offset-2">
            {linkText}
          </a>,
        )
      } else {
        nodes.push(
          <span key={`${keyBase}-a-${i}`} className="text-accent underline underline-offset-2 opacity-70">
            {linkText}
          </span>,
        )
      }
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
