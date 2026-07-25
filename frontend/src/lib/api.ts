/**
 * 后端 REST API 客户端
 * - 浏览器开发态：走 vite dev 代理 /api -> http://127.0.0.1:8787
 * - Tauri 桌面端：直接访问 http://127.0.0.1:8787/api（无 Node 代理）
 *
 * 仅封装常规 JSON 接口；SSE 流式见 lib/sse.ts
 */
import type {
  ApprovalKind,
  ApprovalRequest,
  DeepSeekConfig,
  DiffEntry,
  FileNode,
  GitCommit,
  GitStatus,
  InferenceParams,
  ModelProfile,
  PermissionConfig,
  PrReview,
  ProjectInfo,
  RagIndex,
  RagRecall,
  ReasoningEffort,
  SandboxLanguage,
  SandboxResult,
  Session,
  TodoItem,
  TodoStatus,
} from '../types'

/**
 * 返回当前环境下 API 的根路径前缀。
 * Tauri webview 中无 Vite 代理，必须用绝对 URL。
 */
function resolveBase(): string {
  // @ts-expect-error Tauri v2 注入的全局对象
  if (typeof window !== 'undefined' && window.__TAURI_INTERNALS__) {
    return 'http://127.0.0.1:8787/api'
  }
  return '/api'
}

export const BASE = resolveBase()

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
    this.name = 'ApiError'
  }
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const resp = await fetch(`${BASE}${path}`, {
    method,
    headers: body !== undefined
      ? { 'Content-Type': 'application/json' }
      : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (!resp.ok) {
    let msg = `HTTP ${resp.status}`
    try {
      const txt = await resp.text()
      if (txt) msg = `${msg}: ${txt}`
    } catch {
      /* ignore */
    }
    throw new ApiError(resp.status, msg)
  }
  // 204 / 空体
  const text = await resp.text()
  if (!text) return undefined as unknown as T
  return JSON.parse(text) as T
}

/* ============================================================
 * 会话
 * ============================================================ */
export const sessionsApi = {
  list: () => request<{ sessions: Session[]; count: number }>('GET', '/sessions'),
  create: () => request<Session>('POST', '/sessions'),
  get: (id: string) => request<Session>('GET', `/sessions/${encodeURIComponent(id)}`),
  delete: (id: string) => request<{ sessionId: string; deleted: boolean }>('DELETE', `/sessions/${encodeURIComponent(id)}`),
  reset: (id: string) => request<{ sessionId: string; reset: boolean }>('POST', `/sessions/${encodeURIComponent(id)}/reset`),
}

/* ============================================================
 * 推理参数
 * ============================================================ */
export const paramsApi = {
  get: () => request<InferenceParams>('GET', '/params'),
  update: (patch: Partial<InferenceParams>) => request<InferenceParams>('PUT', '/params', patch),
}

/* ============================================================
 * DeepSeek 配置
 * ============================================================ */
export interface SetDeepSeekBody {
  apiKey?: string
  baseUrl?: string
  model?: string
}

export const configApi = {
  get: () => request<DeepSeekConfig>('GET', '/config/deepseek'),
  set: (body: SetDeepSeekBody) => request<DeepSeekConfig>('PUT', '/config/deepseek', body),
  test: () => request<{ ok: boolean; model: string; baseUrl: string }>('POST', '/config/deepseek/test'),
}

/* ============================================================
 * 项目
 * ============================================================ */
export const projectApi = {
  load: (path: string) => request<{ path: string; loaded: boolean }>('POST', '/project/load', { path }),
  get: () => request<ProjectInfo>('GET', '/project'),
  tree: (depth = 3) => request<{ root: string; tree: FileNode | null }>('GET', `/project/tree?depth=${depth}`),
}

/* ============================================================
 * 文件 CRUD
 * ============================================================ */
export interface CreateFileBody {
  name: string
  parentPath?: string
  isFolder?: boolean
  content?: string
}
export interface ReadFileBody { path: string }
export interface WriteFileBody { path: string; content: string }
export interface RenameFileBody { from: string; to: string }
export interface RevealFileBody { path: string }

export const filesApi = {
  create: (body: CreateFileBody) => request<{ path: string; name: string; isFolder: boolean }>('POST', '/files', body),
  read: (body: ReadFileBody) => request<{ path: string; content: string; size: number }>('POST', '/files/read', body),
  write: (body: WriteFileBody) => request<{ path: string; written: boolean }>('POST', '/files/write', body),
  rename: (body: RenameFileBody) => request<{ from: string; to: string }>('PATCH', '/files/rename', body),
  reveal: (body: RevealFileBody) => request<{ path: string; revealed: boolean }>('POST', '/files/reveal', body),
  delete: (path: string) => request<{ path: string; deleted: boolean }>('DELETE', `/files?path=${encodeURIComponent(path)}`),
}

/* ============================================================
 * Diff 管理
 * ============================================================ */
export interface RegisterDiffBody {
  sessionId?: string
  filePath: string
  originalContent?: string
  modifiedContent: string
}

export const diffsApi = {
  register: (body: RegisterDiffBody) => request<DiffEntry>('POST', '/diffs', body),
  apply: (id: string) => request<{ id: string; filePath: string; status: string }>('POST', `/diffs/${encodeURIComponent(id)}/apply`),
  reject: (id: string) => request<{ id: string; status: string }>('POST', `/diffs/${encodeURIComponent(id)}/reject`),
  revert: (id: string) => request<{ id: string; status: string }>('POST', `/diffs/${encodeURIComponent(id)}/revert`),
  applyAll: (sessionId?: string) => request<{ applied: string[] }>('POST', '/diffs/apply-all', sessionId ? { sessionId } : {}),
  list: (sessionId: string) => request<{ diffs: DiffEntry[] }>('GET', `/diffs/${encodeURIComponent(sessionId)}`),
}

/* ============================================================
 * 对话（SSE 单独走 lib/sse.ts，这里仅提供停止）
 * ============================================================ */
export const chatApi = {
  stop: (sessionId: string) =>
    request<{ sessionId: string; aborted: boolean }>('POST', '/chat/stop', { sessionId }),
}

/* ============================================================
 * 代办任务（P0-7）
 * ============================================================ */
export const todosApi = {
  list: () => request<{ todos: TodoItem[]; total: number }>('GET', '/todos'),
  create: (body: { text: string; sessionId?: string; source?: string }) => request<TodoItem>('POST', '/todos', body),
  get: (id: string) => request<TodoItem>('GET', `/todos/${encodeURIComponent(id)}`),
  delete: (id: string) => request<{ deleted: boolean }>('DELETE', `/todos/${encodeURIComponent(id)}`),
  updateStatus: (id: string, status: TodoStatus) => request<TodoItem>('POST', `/todos/${encodeURIComponent(id)}/status`, { status }),
  listBySession: (sessionId: string) => request<{ todos: TodoItem[]; total: number }>('GET', `/todos/session/${encodeURIComponent(sessionId)}`),
}

/* ============================================================
 * Agent 操作审批（P0-8）
 * ============================================================ */
export const approvalsApi = {
  list: () => request<{ approvals: ApprovalRequest[]; total: number }>('GET', '/approvals'),
  listPending: () => request<{ approvals: ApprovalRequest[]; total: number }>('GET', '/approvals/pending'),
  create: (body: { kind: ApprovalKind; description: string; detail?: string; sessionId?: string }) => request<ApprovalRequest>('POST', '/approvals', body),
  get: (id: string) => request<ApprovalRequest>('GET', `/approvals/${encodeURIComponent(id)}`),
  decide: (id: string, approved: boolean) => request<ApprovalRequest>('POST', `/approvals/${encodeURIComponent(id)}/decide`, { approved }),
}

/* ============================================================
 * 权限配置（P0-8）
 * ============================================================ */
export const permissionApi = {
  get: () => request<PermissionConfig>('GET', '/config/permission'),
  set: (body: Partial<PermissionConfig>) => request<PermissionConfig>('PUT', '/config/permission', body),
}

/* ============================================================
 * Git / GitHub 联动（P1）
 * ============================================================ */
export const gitApi = {
  status: () => request<GitStatus>('GET', '/git/status'),
  diff: (body: { staged?: boolean; path?: string }) => request<{ diff: string }>('POST', '/git/diff', body),
  commit: (body: { message?: string; autoGenerate?: boolean; addAll?: boolean }) => request<{ hash: string; message: string }>('POST', '/git/commit', body),
  branch: (body: { action: 'create' | 'switch' | 'list' | 'delete'; name?: string }) => request<unknown>('POST', '/git/branch', body),
  prReview: (body: { prNumber: number; repo?: string }) => request<PrReview>('POST', '/git/pr-review', body),
  log: (limit = 10) => request<{ commits: GitCommit[] }>('GET', `/git/log?limit=${limit}`),
}

/* ============================================================
 * RAG 项目检索（P1）
 * ============================================================ */
export const ragApi = {
  getIndex: () => request<RagIndex>('GET', '/rag/index'),
  buildIndex: () => request<RagIndex>('POST', '/rag/index'),
  recall: (body: { query: string; maxChunks?: number; maxTokens?: number }) => request<RagRecall>('POST', '/rag/recall', body),
  clear: () => request<{ cleared: boolean }>('DELETE', '/rag/clear'),
}

/* ============================================================
 * 代码沙箱（P1）
 * ============================================================ */
export const sandboxApi = {
  exec: (body: { language: SandboxLanguage; code: string; stdin?: string; timeoutSecs?: number; autoFix?: boolean }) => request<SandboxResult>('POST', '/sandbox/exec', body),
  languages: () => request<{ languages: Array<{ id: string; name: string; available: boolean }> }>('GET', '/sandbox/languages'),
  // 注：format 保留位置参数签名 (code, language) 以与 lib/formatter.ts 既有调用约定兼容；
  // 实际 HTTP body 仍为 { code, language }，后端 /sandbox/format 返回 { formatted: string }。
  format: (code: string, language: string) =>
    request<string | { code: string; language: string; formatted?: string }>(
      'POST',
      '/sandbox/format',
      { code, language },
    ),
}

/* ============================================================
 * 多模型档案（P1）
 * 注意：后端可能无此路由，简化场景下使用 builtin 列表占位
 * ============================================================ */
export const modelProfilesApi = {
  list: () => request<{ profiles: ModelProfile[] }>('GET', '/model-profiles'),
}

/* ============================================================
 * 类型再导出（便于外部统一从 api 模块取用）
 * ============================================================ */
export type { ReasoningEffort }
