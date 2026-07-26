/**
 * 后端 REST API 客户端
 * - 浏览器开发态：走 vite dev 代理 /api -> http://127.0.0.1:8787
 * - Tauri 桌面端：直接访问 http://127.0.0.1:8787/api（无 Node 代理）
 *
 * 仅封装常规 JSON 接口；SSE 流式见 lib/sse.ts
 */
import type {
  ApiProfile,
  ApprovalKind,
  ApprovalRequest,
  AppearanceConfig,
  CacheDebugConfig,
  CacheStats,
  DeepSeekConfig,
  DiffEntry,
  FileNode,
  FormatterConfig,
  GitCommit,
  GitStatus,
  InferenceParams,
  McpConfig,
  McpPermissionScope,
  McpServicesConfig,
  McpStatus,
  ModelProfile,
  ModelProfilesConfig,
  PermissionConfig,
  PrReview,
  ProjectInfo,
  RagConfig,
  RagIndex,
  RagRecall,
  ReasoningEffort,
  SandboxLanguage,
  SandboxResult,
  SecurityConfig,
  Session,
  ShortcutsConfig,
  SkillDefaultPermission,
  SkillDefinition,
  SkillMatch,
  SkillMeta,
  SkillsConfig,
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
 * DeepSeek 配置（基础 API Key/BaseURL/Model）
 * ============================================================ */
export interface SetDeepSeekBody {
  apiKey?: string
  baseUrl?: string
  model?: string
}

/* ============================================================
 * 全套配置 API（P2 设置页面）
 *
 * 保留旧 get/set/test（DeepSeek 基础配置）以兼容 ParamsPanel/App.tsx；
 * 追加 model-profiles / rag / formatter / cache / appearance /
 * shortcuts / security 等多组配置接口。
 * ============================================================ */
export const configApi = {
  // ---- DeepSeek 基础（旧接口，保留） ----
  get: () => request<DeepSeekConfig>('GET', '/config/deepseek'),
  set: (body: SetDeepSeekBody) => request<DeepSeekConfig>('PUT', '/config/deepseek', body),
  test: () => request<{ ok: boolean; model: string; baseUrl: string }>('POST', '/config/deepseek/test'),

  // ---- 模型 & API 多凭证 ----
  getModelProfiles: () => request<ModelProfilesConfig>('GET', '/config/model-profiles'),
  setModelProfiles: (body: ModelProfilesConfig) => request<ModelProfilesConfig>('PUT', '/config/model-profiles', body),
  addProfile: (body: ApiProfile) => request<{ ok: boolean; profile: ApiProfile }>('POST', '/config/profiles', body),
  updateProfile: (id: string, body: ApiProfile) => request<{ ok: boolean; profile: ApiProfile }>('PUT', `/config/profiles/${encodeURIComponent(id)}`, body),
  deleteProfile: (id: string) => request<{ deleted: boolean }>('DELETE', `/config/profiles/${encodeURIComponent(id)}`),
  setActiveProfile: (id: string) => request<{ activeId: string }>('POST', `/config/profiles/${encodeURIComponent(id)}/active`),

  // ---- RAG ----
  getRagConfig: () => request<RagConfig>('GET', '/config/rag'),
  setRagConfig: (body: RagConfig) => request<RagConfig>('PUT', '/config/rag', body),

  // ---- 格式化 ----
  getFormatterConfig: () => request<FormatterConfig>('GET', '/config/formatter'),
  setFormatterConfig: (body: FormatterConfig) => request<FormatterConfig>('PUT', '/config/formatter', body),

  // ---- 缓存调试 ----
  getCacheConfig: () => request<CacheDebugConfig>('GET', '/config/cache'),
  setCacheConfig: (body: CacheDebugConfig) => request<CacheDebugConfig>('PUT', '/config/cache', body),
  clearSessionCache: (sessionId: string) => request<{ cleared: boolean }>('POST', '/config/cache/clear-session', { sessionId }),
  clearProjectMemory: (sessionId: string) => request<{ cleared: boolean }>('POST', '/config/cache/clear-memory', { sessionId }),
  /** 缓存实时统计（仪表盘用） */
  getCacheStats: () => request<CacheStats>('GET', '/config/cache/stats'),

  // ---- 外观 ----
  getAppearance: () => request<AppearanceConfig>('GET', '/config/appearance'),
  setAppearance: (body: AppearanceConfig) => request<AppearanceConfig>('PUT', '/config/appearance', body),

  // ---- 快捷键 ----
  getShortcuts: () => request<ShortcutsConfig>('GET', '/config/shortcuts'),
  setShortcuts: (body: ShortcutsConfig) => request<ShortcutsConfig>('PUT', '/config/shortcuts', body),
  resetShortcuts: () => request<{ ok: boolean; shortcuts: ShortcutsConfig }>('POST', '/config/shortcuts'),

  // ---- 安全 ----
  getSecurity: () => request<SecurityConfig>('GET', '/config/security'),
  setSecurity: (body: SecurityConfig) => request<SecurityConfig>('PUT', '/config/security', body),
  exportAuditLog: () => request<{ log: string }>('GET', '/config/security/export-audit'),
}

/* ============================================================
 * Skill 技能生态（P0 - 新版 + P2 设置页扩展）
 *
 * 与后端 /api/skills/* 路由对齐：
 *   - list      GET    /skills                 -> { skills: SkillMeta[] }
 *   - get       GET    /skills/:id             -> SkillDefinition
 *   - find      POST   /skills/find            -> { matches: SkillMatch[] }
 *   - create    POST   /skills                 -> SkillDefinition
 *   - toggle    PUT    /skills/:id/toggle      -> { enabled: boolean }
 *   - delete    DELETE /skills/:id             -> { deleted: boolean }
 *   - agentsMd  GET/PUT /skills/agents-md      -> { content } / { saved }
 *
 * P2 设置页扩展方法（设置页独占，不影响其他调用方）：
 *   - setEnabled           PUT    /skills/:id/enabled       -> { id; enabled }
 *   - setDefaultPermission POST   /skills/default-permission -> SkillsConfig
 *   - importPack           POST   /skills/import            -> { imported }
 *   - exportSkill          POST   /skills/:id/export        -> { exported; path }
 *   - readAgentsMd         GET    /skills/agents-md         -> { content }（getAgentsMd 别名）
 *   - writeAgentsMd        PUT    /skills/agents-md         -> { written }（updateAgentsMd 别名）
 *   - listConfig           GET    /skills                   -> SkillsConfig（list 的设置页视图）
 * ============================================================ */
export const skillsApi = {
  list: () => request<{ skills: SkillMeta[] }>('GET', '/skills'),
  get: (id: string) => request<SkillDefinition>('GET', `/skills/${encodeURIComponent(id)}`),
  find: (message: string) => request<{ matches: SkillMatch[] }>('POST', '/skills/find', { message }),
  create: (body: { id: string; name: string; description: string; triggers: string[]; rawMarkdown: string }) =>
    request<SkillDefinition>('POST', '/skills', body),
  toggle: (id: string) => request<{ enabled: boolean }>('PUT', `/skills/${encodeURIComponent(id)}/toggle`),
  delete: (id: string) => request<{ deleted: boolean }>('DELETE', `/skills/${encodeURIComponent(id)}`),
  getAgentsMd: () => request<{ content: string }>('GET', '/skills/agents-md'),
  updateAgentsMd: (content: string) => request<{ saved: boolean }>('PUT', '/skills/agents-md', { content }),

  // ---- P2 设置页扩展 ----
  /** 设置页：显式启用/禁用某技能 */
  setEnabled: (id: string, enabled: boolean) =>
    request<{ id: string; enabled: boolean }>('PUT', `/skills/${encodeURIComponent(id)}/enabled`, { enabled }),
  /** 设置页：设置技能调用默认权限 */
  setDefaultPermission: (permission: SkillDefaultPermission) =>
    request<SkillsConfig>('POST', '/skills/default-permission', { permission }),
  /** 设置页：导入外部技能包 */
  importPack: (body: { path: string }) =>
    request<{ imported: number }>('POST', '/skills/import', body),
  /** 设置页：导出单个技能 */
  exportSkill: (id: string) =>
    request<{ exported: boolean; path: string }>('POST', `/skills/${encodeURIComponent(id)}/export`),
  /** 设置页：读取 AGENTS.md（getAgentsMd 语义别名） */
  readAgentsMd: () => request<{ content: string }>('GET', '/skills/agents-md'),
  /** 设置页：写入 AGENTS.md（updateAgentsMd 语义别名） */
  writeAgentsMd: (content: string) =>
    request<{ written: boolean }>('PUT', '/skills/agents-md', { content }),
  /** 设置页：获取技能列表配置（含 defaultPermission） */
  listConfig: () => request<SkillsConfig>('GET', '/skills/config'),
}

/* ============================================================
 * MCP 插件生态（P1 - 新版 + P2 设置页扩展）
 *
 * 与后端 /api/mcp/* 路由对齐：
 *   - list        GET    /mcp                       -> { plugins: Array<McpConfig & { status: McpStatus }> }
 *   - register    POST   /mcp                       -> McpConfig
 *   - delete      DELETE /mcp/:id                   -> { deleted: boolean }
 *   - toggle      PUT    /mcp/:id/toggle            -> { enabled: boolean }
 *   - connect     POST   /mcp/:id/connect           -> { connected: boolean }
 *   - disconnect  POST   /mcp/:id/disconnect        -> { connected: boolean }
 *   - call        POST   /mcp/call                  -> { success; data; summary }
 *   - highRisk    GET/PUT /mcp/high-risk/switch     -> { enabled }
 *
 * P2 设置页扩展方法（设置页独占，不影响其他调用方）：
 *   - setGlobalEnabled POST /mcp/global-enabled       -> { globalEnabled }
 *   - setEnabled       POST /mcp/:id/enabled          -> { id; enabled }
 *   - remove           DELETE /mcp/:id                -> { deleted }（delete 别名）
 *   - add              POST   /mcp                     -> { id }（register 的设置页视图）
 *   - listServices     GET    /mcp/services            -> McpServicesConfig
 * ============================================================ */
export const mcpApi = {
  list: () => request<{ plugins: Array<McpConfig & { status: McpStatus }> }>('GET', '/mcp'),
  register: (body: McpConfig) => request<McpConfig>('POST', '/mcp', body),
  delete: (id: string) => request<{ deleted: boolean }>('DELETE', `/mcp/${encodeURIComponent(id)}`),
  toggle: (id: string) => request<{ enabled: boolean }>('PUT', `/mcp/${encodeURIComponent(id)}/toggle`),
  connect: (id: string) => request<{ connected: boolean }>('POST', `/mcp/${encodeURIComponent(id)}/connect`),
  disconnect: (id: string) => request<{ connected: boolean }>('POST', `/mcp/${encodeURIComponent(id)}/disconnect`),
  call: (body: { pluginId: string; tool: string; arguments: unknown; sessionId?: string }) =>
    request<{ success: boolean; data: unknown; summary: string }>('POST', '/mcp/call', body),
  getHighRiskSwitch: () => request<{ enabled: boolean }>('GET', '/mcp/high-risk/switch'),
  setHighRiskSwitch: (enabled: boolean) =>
    request<{ enabled: boolean }>('PUT', '/mcp/high-risk/switch', { enabled }),

  // ---- P2 设置页扩展 ----
  /** 设置页：全局总开关（高危插件） */
  setGlobalEnabled: (enabled: boolean) =>
    request<{ globalEnabled: boolean }>('POST', '/mcp/global-enabled', { enabled }),
  /** 设置页：显式启用/禁用某服务 */
  setEnabled: (id: string, enabled: boolean) =>
    request<{ id: string; enabled: boolean }>('POST', `/mcp/${encodeURIComponent(id)}/enabled`, { enabled }),
  /** 设置页：移除服务（delete 语义别名） */
  remove: (id: string) => request<{ deleted: boolean }>('DELETE', `/mcp/${encodeURIComponent(id)}`),
  /** 设置页：添加服务（设置页视图，参数简化） */
  add: (body: { name: string; transport: 'sse' | 'stdio'; endpoint: string; permissions: McpPermissionScope[] }) =>
    request<{ id: string }>('POST', '/mcp/services', body),
  /** 设置页：获取服务列表配置（含 globalEnabled） */
  listServices: () => request<McpServicesConfig>('GET', '/mcp/services'),
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
  getIndex: () => request<{ hasIndex: boolean; index: RagIndex | null }>('GET', '/rag/index').then(({ index }) => index),
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
 * 后端路由：GET /api/model-profiles
 * ============================================================ */
export const modelProfilesApi = {
  list: () => request<{ profiles: ModelProfile[] }>('GET', '/model-profiles'),
}

/* ============================================================
 * 类型再导出（便于外部统一从 api 模块取用）
 * ============================================================ */
export type { ReasoningEffort }
