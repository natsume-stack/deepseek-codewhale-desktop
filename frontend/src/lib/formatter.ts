/**
 * 代码格式化（参考 Aider）
 *
 * 调用后端 sandbox/format 接口格式化代码，支持 rust/go/python/typescript/shell。
 * 后端会调用对应语言的格式化工具：
 *   - rust        → rustfmt
 *   - go          → gofmt
 *   - python      → black
 *   - typescript  → prettier
 *   - shell       → shfmt
 *
 * 前端只负责：
 *   1. 检测语言是否被支持（isFormatterAvailable）
 *   2. 调用后端 sandboxApi.format
 *   3. 处理返回结果（兼容字符串 / { code } 两种形态）
 *
 * 实际的格式化工具调用由后端在沙盒中执行（参考 Aider）。
 */
import { sandboxApi } from './api'

/** 语言 → 格式化工具名 映射 */
const FORMATTER_MAP: Record<string, string> = {
  rust: 'rustfmt',
  rs: 'rustfmt',
  go: 'gofmt',
  golang: 'gofmt',
  python: 'black',
  py: 'black',
  typescript: 'prettier',
  ts: 'prettier',
  tsx: 'prettier',
  javascript: 'prettier',
  js: 'prettier',
  jsx: 'prettier',
  shell: 'shfmt',
  sh: 'shfmt',
  bash: 'shfmt',
  zsh: 'shfmt',
}

/**
 * 调用后端 sandbox/format 接口格式化代码
 *
 * @param code 原始代码
 * @param language 语言标识（rust/go/python/typescript/shell 或文件扩展名）
 * @returns 格式化后的代码；若后端不可用或格式化失败，返回原始代码
 */
export async function formatCode(code: string, language: string): Promise<string> {
  const lang = normalizeLanguage(language)
  if (!lang) return code
  if (!isFormatterAvailable(lang)) return code

  // 兼容 Agent 4 尚未添加 sandboxApi 的情况（runtime 防御）
  if (!sandboxApi || typeof (sandboxApi as { format?: unknown }).format !== 'function') {
    return code
  }

  try {
    const result = await (sandboxApi as {
      format: (code: string, language: string) => Promise<string | { code: string; language: string }>
    }).format(code, lang)
    // 兼容两种返回形态：直接字符串 或 { code: string }
    if (typeof result === 'string') return result
    if (result && typeof result === 'object' && typeof result.code === 'string') {
      return result.code
    }
    return code
  } catch {
    // 格式化失败不阻塞编辑流程，返回原始代码
    return code
  }
}

/**
 * 检测本地是否安装了对应格式化工具
 *
 * 前端简化实现：仅判断语言是否被支持；实际工具是否安装由后端沙盒检测。
 *
 * @param language 语言标识或文件扩展名
 */
export function isFormatterAvailable(language: string): boolean {
  const lang = normalizeLanguage(language)
  return !!lang && lang in FORMATTER_MAP
}

/**
 * 获取格式化工具显示名
 *
 * @param language 语言标识或文件扩展名
 * @returns 形如 "rustfmt" / "prettier" / "black"；未知语言返回空串
 */
export function formatterName(language: string): string {
  const lang = normalizeLanguage(language)
  if (!lang) return ''
  return FORMATTER_MAP[lang] ?? ''
}

/**
 * 获取所有受支持的语言列表（用于设置页展示）
 */
export function supportedLanguages(): { language: string; tool: string }[] {
  // 去重：以语言名为主，扩展名为别名不重复展示
  const seen = new Set<string>()
  const list: { language: string; tool: string }[] = []
  for (const key of Object.keys(FORMATTER_MAP)) {
    const tool = FORMATTER_MAP[key]
    if (seen.has(tool)) continue
    seen.add(tool)
    // 选择规范语言名（rust/go/python/typescript/shell 优先）
    const langName =
      key === 'rust' || key === 'rs' ? 'rust' :
      key === 'go' || key === 'golang' ? 'go' :
      key === 'python' || key === 'py' ? 'python' :
      key === 'typescript' || key === 'ts' || key === 'tsx' ? 'typescript' :
      key === 'javascript' || key === 'js' || key === 'jsx' ? 'javascript' :
      key === 'shell' || key === 'sh' || key === 'bash' || key === 'zsh' ? 'shell' :
      key
    if (!list.some((x) => x.language === langName)) {
      list.push({ language: langName, tool })
    }
  }
  return list
}

/** 将语言标识统一为标准 key（支持扩展名 / 别名） */
function normalizeLanguage(language: string): string {
  if (!language) return ''
  const lower = language.toLowerCase().trim()
  // 去掉可能的扩展名前缀点
  const key = lower.startsWith('.') ? lower.slice(1) : lower
  // 直接命中
  if (key in FORMATTER_MAP) return key
  // 别名归一化
  if (key === 'rs') return 'rust'
  if (key === 'golang') return 'go'
  if (key === 'py') return 'python'
  if (key === 'ts' || key === 'tsx') return 'typescript'
  if (key === 'js' || key === 'jsx') return 'javascript'
  if (key === 'sh' || key === 'bash' || key === 'zsh') return 'shell'
  return ''
}
