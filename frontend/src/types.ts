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

/** 工具调用状态 */
export type ToolCallStatus = 'running' | 'success' | 'failed'

/** 单次 DSML 工具调用（Agent Loop 中产生） */
export interface ToolCallEntry {
  /** 前端临时 id */
  localId: string
  /** 工具名：read_file / list_files / search_files / write_file / edit_file / shell / git / ask_followup_question / attempt_completion */
  name: string
  /** 意图说明（AI 给出的人类可读描述） */
  intent: string
  /** 要求的权限等级 */
  requiredPermission?: 'readOnly' | 'workspaceWrite' | 'fullAccess'
  /** 参数对象 */
  args?: Record<string, unknown>
  /** 执行状态 */
  status: ToolCallStatus
  /** 执行结果文本（成功为数据，失败为错误信息） */
  result?: string
  /** 时间戳（ms） */
  ts: number
}

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
  /** Agent Loop 产生的工具调用列表（按时间顺序） */
  toolCalls?: ToolCallEntry[]
  /** 是否为任务收尾消息（attempt_completion） */
  completion?: boolean
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

/* ============================================================
 * Skill 技能生态（P0）
 * ============================================================ */
export interface SkillMeta {
  id: string
  name: string
  description: string
  triggers: string[]
  category: string
  version: string
  enabled: boolean
  builtin: boolean
}

export interface SkillStep {
  order: number
  description: string
  action: string
  todoText?: string
}

export interface SkillDefinition {
  meta: SkillMeta
  steps: SkillStep[]
  requiredTools: string[]
  defaultPermission: string
  rawMarkdown: string
}

export interface SkillMatch {
  skillId: string
  skillName: string
  score: number
  matchedKeywords: string[]
}

/** 技能执行日志条目（前端维护，记录每次技能触发的步骤与结果） */
export interface SkillLogEntry {
  id: string
  ts: number
  skillId: string
  skillName: string
  stepOrder: number
  stepTotal: number
  action: string
  description: string
  result: 'running' | 'success' | 'failed' | 'skipped'
  message?: string
}

/* ============================================================
 * MCP 插件生态（P1）
 * ============================================================ */
export type McpTransport = 'stdio' | 'sse'
export type McpCategory = 'lsp' | 'knowledge' | 'ci' | 'database' | 'security' | 'other'

export interface McpMeta {
  id: string
  name: string
  description: string
  version: string
  transport: McpTransport
  enabled: boolean
  highRisk: boolean
  category: McpCategory
  capabilities: string
}

export interface McpConfig {
  meta: McpMeta
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  permissionScope: string
  timeoutSecs: number
}

export interface McpStatus {
  id: string
  connected: boolean
  lastError?: string
  lastCallAt?: string
  callCount: number
}

/* ============================================================
 * 设置页面配置类型（P2）
 * ============================================================ */
export interface ApiProfile {
  id: string
  name: string
  provider: string
  apiKeyMasked: string
  baseUrl: string
  model: string
  displayName: string
  supportsReasoning: boolean
  maxTokens: number
}

export interface ModelProfilesConfig {
  profiles: ApiProfile[]
  activeProfileId?: string
}

export interface RagConfig {
  enabled: boolean
  chunkSize: number
  maxTokens: number
  recallWeight: number
  fileFilter: string[]
  autoIndex: boolean
}

export interface FormatterConfig {
  rustEnabled: boolean
  goEnabled: boolean
  pythonEnabled: boolean
  typescriptEnabled: boolean
  formatOnSave: boolean
  customCommands: Record<string, string>
}

export interface CacheDebugConfig {
  fingerprintCheck: boolean
  mountSizeThreshold: number
  autoCompressThreshold: number
}

/** 缓存实时统计（仪表盘用） */
export interface CacheStats {
  hitRate: number
  hits: number
  misses: number
  fingerprint: string
}

export interface AppearanceConfig {
  micaEnabled: boolean
  theme: string
  cornerRadius: number
  animationDurationMs: number
  codeHighlightTheme: string
}

export interface ShortcutsConfig {
  bindings: Record<string, string>
}

export interface SecurityConfig {
  approvalTimeoutSecs: number
  shellBlacklist: string[]
  sessionExpireHours: number
  auditLogPath?: string
}

/* ============================================================
 * 设置页面 - Skill / MCP 管理类型（P2 扩展）
 *
 * 注意：与上方 P0/P1 的 SkillMeta / McpConfig 是不同视角：
 *   - SkillMeta / McpConfig 描述「单条技能/插件定义」
 *   - SkillItem / McpService 描述「设置页列表中的轻量条目」
 * 两者字段重叠但不完全一致，故独立定义。
 * ============================================================ */
export type SkillDefaultPermission = 'readOnly' | 'workspaceWrite' | 'fullAccess' | 'ask'

/** 设置页技能列表条目（轻量视图模型） */
export interface SkillItem {
  id: string
  name: string
  description: string
  /** 来源：本地 .workspace/.skills 或外部导入 */
  source: 'local' | 'external'
  enabled: boolean
}

/** 设置页技能配置（list 响应） */
export interface SkillsConfig {
  skills: SkillItem[]
  defaultPermission: SkillDefaultPermission
}

/** MCP 权限作用域（设置页表单用） */
export type McpPermissionScope = 'file' | 'network' | 'shell' | 'database'

/** MCP 服务运行状态（设置页列表用） */
export type McpServiceStatus = 'connected' | 'disconnected' | 'error'

/** 设置页 MCP 服务列表条目（轻量视图模型） */
export interface McpService {
  id: string
  name: string
  transport: McpTransport
  endpoint: string
  permissions: McpPermissionScope[]
  enabled: boolean
  status: McpServiceStatus
}

/** 设置页 MCP 配置（list 响应） */
export interface McpServicesConfig {
  services: McpService[]
  globalEnabled: boolean
}

/* ============================================================
 * Agent 自治任务模块
 *
 * 与后端 /api/agent/* 路由对齐，SSE 事件协议见
 * GET /api/agent/tasks/:id/stream。
 * ============================================================ */
export type TaskState =
  | 'pending'
  | 'planning'
  | 'acting'
  | 'observing'
  | 'reflecting'
  | 'paused'
  | 'awaiting_approval'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type ExecutionMode = 'autonomous' | 'approval'

export type StepStatus = 'pending' | 'in_progress' | 'done' | 'skipped' | 'failed'

export type ArtifactKind =
  | 'file_change'
  | 'diff_hunk'
  | 'shell_output'
  | 'git_commit'
  | 'file_created'
  | 'file_deleted'

export interface ToolCall {
  id: string
  tool_name: string
  arguments: Record<string, unknown>
  expected_output?: string
}

export interface ToolArtifact {
  kind: ArtifactKind
  path?: string
  diff_id?: string
  summary: string
}

export interface ToolResult {
  success: boolean
  output: string
  error?: string
  artifacts: ToolArtifact[]
}

export interface ToolInfo {
  name: string
  description: string
  schema: Record<string, unknown>
  required_permission: PermissionLevel
}

export interface TaskStep {
  id: string
  description: string
  status: StepStatus
  tool_calls: ToolCall[]
}

export interface ReActStep {
  iteration: number
  thought: string
  action: ToolCall | null
  observation: string
  reflection: string | null
  timestamp: string
  /** 自省校验结果（若该步骤触发了 SelfReflection） */
  reflection_result?: ReflectionResult | null
}

export interface Checkpoint {
  iteration: number
  step_index: number
  saved_at: string
}

export interface AgentTask {
  id: string
  session_id: string
  user_request: string
  state: TaskState
  mode: ExecutionMode
  plan: TaskStep[]
  current_step: number
  history: ReActStep[]
  max_iterations: number
  current_iteration: number
  checkpoint: Checkpoint | null
  error: string | null
  created_at: string
  updated_at: string
  /** 顶层长期规划（由 GlobalPlanner 生成） */
  global_plan?: GlobalPlan | null
}

/** SSE 事件联合类型（GET /api/agent/tasks/:id/stream） */
export type AgentEvent =
  | { type: 'task_state'; state: TaskState; iteration: number }
  | { type: 'thought'; content: string }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'tool_result'; result: ToolResult }
  | { type: 'reflection'; conclusion: string; next_action?: string }
  | { type: 'plan_created'; steps: string[] }
  | { type: 'task_complete'; summary: string }
  | { type: 'task_error'; error: string; recoverable: boolean }
  | { type: 'log'; level: string; message: string }
  | { type: 'global_plan_created'; plan: GlobalPlan }
  | { type: 'plan_step_changed'; step_index: number; status: string; goal: string }
  | { type: 'self_reflection'; result: ReflectionResult }
  | { type: 'sandbox_alert'; reason: string; call: ToolCall }
  | { type: 'loop_detected'; pattern: string }

// ===== 终端会话 =====
export interface TerminalSession {
  session_id: string
  created_at: string
  cwd: string
}

export interface TerminalExecResult {
  output: string
  cwd: string
}

export interface TerminalOutputEvent {
  line: string
}

// ===== GlobalPlan 顶层规划 =====
export type PlanStepStatus = 'pending' | 'in_progress' | 'completed' | 'skipped' | 'failed'

export interface PlanStep {
  id: string
  index: number
  goal: string
  success_criteria: string
  status: PlanStepStatus
  started_at: string | null
  completed_at: string | null
}

export interface GlobalPlan {
  task_id: string
  overall_goal: string
  steps: PlanStep[]
  current_step_index: number
  created_at: string
  updated_at: string
}

// ===== SelfReflection 自省校验 =====
export interface ReflectionResult {
  success: boolean
  issue: string | null
  fix_attempts: number
  fixed: boolean
  fix_diffs: string[]
  log: string
}

// ===== Sandbox 高危告警 =====
export interface SandboxAlert {
  reason: string
  call: ToolCall
}
