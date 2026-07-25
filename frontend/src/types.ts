/**
 * 全局共享类型定义
 * 与 Rust 后端 serde camelCase 序列化保持一致
 */

/* ============================================================
 * 会话与消息
 * ============================================================ */

export type MessageRole = 'user' | 'assistant' | 'system' | 'tool'

export interface ChatMessage {
  role: MessageRole
  content: string
  /** deepseek-reasoner 推理过程（仅 assistant 消息可能携带） */
  reasoning?: string
  /** 工具调用产生的元信息（保留扩展） */
  toolCalls?: unknown[]
}

export interface Session {
  id: string
  messages: ChatMessage[]
  projectRoot?: string
  createdAt: string
  updatedAt: string
  running: boolean
}

/* ============================================================
 * 推理参数与 DeepSeek 配置
 * ============================================================ */

export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high'

export interface InferenceParams {
  reasoningEffort: ReasoningEffort
  cacheEnabled: boolean
  contextLength: number
}

export interface DeepSeekConfig {
  configured: boolean
  apiKeyMasked: string
  baseUrl: string
  model: string
}

/* ============================================================
 * 项目与文件树
 * ============================================================ */

export interface ProjectInfo {
  path: string | null
  loaded: boolean
}

export interface FileNode {
  name: string
  path: string
  isFolder: boolean
  children?: FileNode[]
  size?: number
  modified?: string
}

/* ============================================================
 * Diff 管理
 * ============================================================ */

export type DiffStatus = 'pending' | 'applied' | 'rejected' | 'reverted'

export interface DiffEntry {
  id: string
  filePath: string
  originalContent?: string
  modifiedContent: string
  status: DiffStatus
  createdAt: number
  sessionId?: string
}

/* ============================================================
 * SSE 事件（POST /api/chat 流式响应）
 * ============================================================ */
export type ChatSseEvent =
  | { event: 'session'; sessionId: string }
  | { event: 'delta'; content: string }
  | { event: 'reasoning'; content: string }
  | { event: 'finish'; finishReason: string }
  | { event: 'error'; message: string }
  | { event: 'done'; sessionId: string }

/* ============================================================
 * 前端 UI 派生状态（消息流中渲染用）
 * ============================================================ */
export interface ChatStreamMessage {
  /** 前端生成的临时 id，便于 React key 与流式更新 */
  localId: string
  role: MessageRole
  content: string
  reasoning?: string
  /** 是否处于流式接收中 */
  streaming?: boolean
  /** 关联的会话 id */
  sessionId?: string
  /** 错误信息（assistant 出错时） */
  error?: string
  /** 创建时间戳（ms） */
  ts: number
  /** 是否折叠显示（P1：MessageItem 操作工具栏触发） */
  folded?: boolean
}

/* ============================================================
 * 代办任务（P0-7）
 * ============================================================ */
export type TodoStatus = 'pending' | 'running' | 'done'

export interface TodoItem {
  id: string
  sessionId?: string
  text: string
  status: TodoStatus
  source?: string
  createdAt: string
  updatedAt: string
}

/* ============================================================
 * Agent 操作审批（P0-8）
 * ============================================================ */
// 注意：ApprovalKind 字符串值与后端 serde 实际输出对齐
// 后端 ApprovalKind 是 #[serde(rename_all = "lowercase")]
//   FileWrite -> "filewrite" / FileDelete -> "filedelete" / Shell -> "shell" / Git -> "git"
export type ApprovalKind = 'filewrite' | 'filedelete' | 'shell' | 'git'
export type ApprovalStatus = 'pending' | 'approved' | 'rejected'

export interface ApprovalRequest {
  id: string
  kind: ApprovalKind
  description: string
  detail?: string
  sessionId?: string
  status: ApprovalStatus
  createdAt: string
}

/* ============================================================
 * 权限配置（P0-8）
 * ============================================================ */
export type PermissionLevel = 'readOnly' | 'workspaceWrite' | 'fullAccess'

export interface PermissionConfig {
  level: PermissionLevel
  approvalOnWrite: boolean
  approvalOnShell: boolean
}

/* ============================================================
 * Git/GitHub 联动（P1）
 * ============================================================ */
export interface GitFileChange {
  path: string
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked'
  insertions: number
  deletions: number
}

export interface GitStatus {
  branch: string
  ahead: number
  behind: number
  staged: GitFileChange[]
  unstaged: GitFileChange[]
  untracked: string[]
  clean: boolean
}

export interface GitCommit {
  hash: string
  author: string
  message: string
  date: string
}

export interface PrReview {
  prNumber: number
  title: string
  summary: string
  issues: Array<{ severity: 'critical' | 'warning' | 'suggestion'; file: string; line: number; comment: string }>
  verdict: 'approve' | 'request_changes' | 'comment'
}

/* ============================================================
 * RAG 项目检索（P1）
 * ============================================================ */
export interface RagChunk {
  id: string
  filePath: string
  startLine: number
  endLine: number
  content: string
  tokens: number
}

export interface RagIndex {
  projectRoot: string
  chunks: RagChunk[]
  totalFiles: number
  totalTokens: number
  indexedAt: string
}

export interface RagRecall {
  chunks: RagChunk[]
  totalFound: number
  truncated: boolean
  query: string
}

/* ============================================================
 * 代码沙箱（P1）
 * ============================================================ */
export type SandboxLanguage = 'rust' | 'go' | 'python' | 'typescript' | 'shell'

export interface SandboxResult {
  exitCode: number
  stdout: string
  stderr: string
  success: boolean
  durationMs: number
  fixSuggestion?: string
  fixDiff?: string
}

/* ============================================================
 * 多模型档案（P1）
 * ============================================================ */
export interface ModelProfile {
  id: string
  name: string
  displayName: string
  description: string
  maxTokens: number
  supportsReasoning: boolean
}

/* ============================================================
 * 复杂度路由（P1）
 * ============================================================ */
export type Complexity = 'light' | 'heavy' | 'mega'

export interface RouteDecision {
  complexity: Complexity
  recommendedModel: string
  reason: string
  needsTodoSplit: boolean
  concurrency: number
}
