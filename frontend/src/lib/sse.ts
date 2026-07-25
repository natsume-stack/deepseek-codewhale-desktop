/**
 * SSE 解析器：基于 fetch + ReadableStream 解析 text/event-stream
 *
 * 后端 SSE 事件示例:
 *   event: delta
 *   data: {"content":"增量文本"}
 *
 *   event: reasoning
 *   data: {"content":"推理增量"}
 *
 *   event: done
 *   data: {"sessionId":"..."}
 *
 * 不使用 EventSource：因为 EventSource 仅支持 GET，本后端 /api/chat 是 POST。
 */

export interface ParsedSseEvent {
  event: string
  data: string
}

/**
 * 解析一段 SSE 文本块为事件列表（按空行分隔）。
 * 内部供 streamSse 使用，导出仅为便于测试。
 */
export function parseSseChunk(chunk: string): ParsedSseEvent[] {
  const events: ParsedSseEvent[] = []
  // 兼容 \n\n 与 \r\n\r\n 分隔
  const blocks = chunk.split(/\r?\n\r?\n/)
  for (const block of blocks) {
    if (!block.trim()) continue
    let event = 'message'
    const dataLines: string[] = []
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith(':')) continue // 注释行
      if (line.startsWith('event:')) {
        event = line.slice(6).trim()
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart())
      }
    }
    if (dataLines.length === 0) continue
    events.push({ event, data: dataLines.join('\n') })
  }
  return events
}

/**
 * 发起 POST 请求并以 SSE 形式消费响应流。
 *
 * @param url       请求 URL
 * @param body      JSON 请求体
 * @param onEvent   每解析出一个事件回调
 * @param signal    可选 AbortSignal，用于中断
 *
 * 注意：调用方应在 onEvent('done' | 'error' | abort) 时清理状态。
 */
export async function postSse(
  url: string,
  body: unknown,
  onEvent: (ev: ParsedSseEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify(body),
    signal,
  })

  if (!resp.ok) {
    let msg = `HTTP ${resp.status}`
    try {
      const txt = await resp.text()
      if (txt) msg = `${msg}: ${txt}`
    } catch {
      /* ignore */
    }
    throw new Error(msg)
  }

  if (!resp.body) {
    throw new Error('响应体为空，无法建立 SSE 流')
  }

  const reader = resp.body.getReader()
  const decoder = new TextDecoder('utf-8')
  // 残留缓冲：SSE 事件可能跨 chunk 切分，需保留半截
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      // 仅处理完整事件（以空行结尾），剩余留存 buffer
      let lastSplit = -1
      // 找到最后一个完整事件分隔位置
      // 兼容 \n\n 与 \r\n\r\n
      const re = /\r?\n\r?\n/g
      let m: RegExpExecArray | null
      let lastEnd = -1
      while ((m = re.exec(buffer)) !== null) {
        lastEnd = m.index + m[0].length
      }
      if (lastEnd !== -1) {
        const complete = buffer.slice(0, lastEnd)
        buffer = buffer.slice(lastEnd)
        for (const ev of parseSseChunk(complete)) {
          onEvent(ev)
        }
        void lastSplit // 静默 unused
      }
    }
    // flush 残留
    if (buffer.trim()) {
      for (const ev of parseSseChunk(buffer)) {
        onEvent(ev)
      }
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      /* ignore */
    }
  }
}
