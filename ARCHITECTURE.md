# CodeWhale Desktop — 项目架构与交接文档

> **版本**: 0.1.0 | **更新日期**: 2026-07-26 | **作者**: CodeWhale Team

---

## 文档导航

| 文档 | 用途 | 状态 |
|------|------|------|
| **ARCHITECTURE.md**（本文档） | 项目架构全貌、交接总文档 | 当前 |
| [README.md](./README.md) | 项目入口、快速开始 | 当前 |
| [API.md](./API.md) | REST API 接口规范（基础端点） | 当前 |
| [AGENT_ROADMAP.md](./AGENT_ROADMAP.md) | Agent 能力路线图 | 当前 |

---

## 目录

1. [项目概览](#1-项目概览)
2. [技术栈](#2-技术栈)
3. [架构总览](#3-架构总览)
4. [目录结构](#4-目录结构)
5. [后端详解](#5-后端详解)
6. [前端详解](#6-前端详解)
7. [Tauri 桌面壳](#7-tauri-桌面壳)
8. [API 接口清单](#8-api-接口清单)
9. [Skill 技能生态](#9-skill-技能生态)
10. [MCP 插件生态](#10-mcp-插件生态)
11. [配置与部署](#11-配置与部署)
12. [开发工作流](#12-开发工作流)
13. [关键设计决策](#13-关键设计决策)
14. [新人上手指南](#14-新人上手指南)
15. [常见问题排查](#15-常见问题排查)
16. [待办与改进方向](#16-待办与改进方向)

---

## 1. 项目概览

**CodeWhale Desktop** 是一个基于 DeepSeek 大模型的 AI 编程桌面客户端，灵感来源于 GitHub Copilot / Cursor / Codex。核心能力：

- 对话式 AI 编程助手（SSE 流式响应）
- 文件树浏览与代码 Diff 管理（逐块应用/拒绝）
- 内置 17 个 Skill 技能（代码评审、测试生成、重构、安全审计等）
- 内置 12 个 MCP 插件（GitHub、Filesystem、Memory、Puppeteer 等）
- 三级权限沙盒（ReadOnly / WorkspaceWrite / FullAccess）
- Agent 操作审批弹窗（文件写/Shell/Git 需用户确认）
- Windows 11 Mica 云母毛玻璃视觉效果
- 白灰黑高级极简风格 UI，大圆角设计，非线性弹性动画

---

## 2. 技术栈

| 层级 | 技术 | 版本 |
|------|------|------|
| 桌面壳 | Tauri 2 | 2.x |
| 后端 | Rust + Axum + Tokio | Rust 1.88 |
| 前端 | React 18 + TypeScript | 18.x |
| 构建 | Vite 5 | 5.4.x |
| 样式 | Tailwind CSS 3 | 3.x |
| 状态管理 | Zustand | 4.x |
| AI 模型 | DeepSeek API (OpenAI 兼容) | `/v1/chat/completions` |
| 传输协议 | SSE (服务端推送事件) | text/event-stream |
| 缓存策略 | Reasonix 字节稳定前缀缓存 | 5 层分层架构 |

---

## 3. 架构总览

```
┌──────────────────────────────────────────────────────┐
│                  Tauri 2 桌面壳                       │
│  ┌────────────────────────────────────────────────┐  │
│  │              WebView (React 18)                 │  │
│  │  ┌──────────┐  ┌──────────────────────────┐    │  │
│  │  │ SideNav  │  │      WorkArea             │    │  │
│  │  │ (毛玻璃)  │  │  ┌────────────────────┐  │    │  │
│  │  │          │  │  │ ChatPanel           │  │    │  │
│  │  │ 对话/设置 │  │  │ FileTree | DiffPanel │  │    │  │
│  │  │          │  │  │ SettingsPage         │  │    │  │
│  │  └──────────┘  │  └────────────────────┘  │    │  │
│  │                └──────────────────────────┘    │  │
│  └────────────────────────────────────────────────┘  │
│                       │ fetch REST + SSE              │
│                       ▼                               │
│  ┌────────────────────────────────────────────────┐  │
│  │           Sidecar: codewhale-server            │  │
│  │           (Axum HTTP, 127.0.0.1:8787)          │  │
│  │  ┌──────────────────────────────────────────┐  │  │
│  │  │ 路由层: /api/chat, /api/sessions, ...     │  │  │
│  │  │ 会话层: SessionManager + PrefixCache      │  │  │
│  │  │ 工具层: read_file / write_file / git /    │  │  │
│  │  │         shell / sandbox / rag            │  │  │
│  │  │ Skill 层: SkillStore (17 项内置技能)     │  │  │
│  │  │ MCP 层:  McpStore (12 项内置插件)        │  │  │
│  │  └──────────────────────────────────────────┘  │  │
│  └────────────────────────────────────────────────┘  │
│                       │ HTTPS                         │
│                       ▼                               │
│               api.deepseek.com                        │
└──────────────────────────────────────────────────────┘
```

**通信路径**:
- **开发模式**: Vite Dev Server (5173) --proxy--> 后端 (8787)
- **桌面模式**: WebView 直接 fetch `http://127.0.0.1:8787/api/*`
- **Tauri 启动**: `lib.rs` 启动 sidecar 进程 → 等待 `/ping` 就绪 → 加载 WebView

---

## 4. 目录结构

```
deepseektui-desktop/
├── Cargo.toml                  # 后端 Rust workspace 配置
├── Cargo.lock
├── config.example.toml         # 配置文件模板
├── .env.example                # 环境变量模板
├── start.bat                   # Windows 一键启动脚本
├── start.ps1                   # PowerShell 启动脚本
├── start.sh                    # Linux/macOS 启动脚本
│
├── src/                        # ── Rust 后端 (codewhale-server) ──
│   ├── main.rs                 # 入口: 启动 Axum 服务
│   ├── state.rs                # 全局共享状态 SharedState
│   ├── config.rs               # 配置加载/持久化/三级权限
│   ├── deepseek.rs             # DeepSeek API 流式客户端
│   ├── session.rs              # 会话管理 + PrefixCache
│   ├── cache.rs                # Reasonix 字节稳定前缀缓存
│   ├── tools.rs                # 内置工具: 文件/Git/Shell
│   ├── skills.rs               # Skill 生态 (17 项内置)
│   ├── mcp.rs                  # MCP 插件生态 (12 项内置)
│   ├── smart_router.rs         # 复杂度路由 (轻/重/巨型)
│   ├── r1_harvest.rs           # R1 推理收获器
│   ├── diff.rs                 # Myers Diff 算法
│   ├── dsml.rs                 # DSML 标签生成
│   ├── rag.rs                  # RAG 项目索引/召回
│   ├── tool_repair.rs          # 工具调用自动修复
│   ├── error.rs                # 统一错误类型
│   └── routes/
│       ├── mod.rs              # 路由聚合 (所有 API 端点)
│       ├── chat.rs             # POST /api/chat (SSE)
│       ├── session.rs          # 会话 CRUD
│       ├── config_api.rs       # 配置/设置 API
│       ├── params.rs           # 推理参数
│       ├── project.rs          # 项目加载
│       ├── files.rs            # 文件系统 CRUD
│       ├── diffs.rs            # Diff 注册/应用/拒绝
│       ├── tools.rs            # 内置工具端点
│       ├── skills.rs           # Skill 管理端点
│       ├── mcp.rs              # MCP 管理端点
│       ├── todos.rs            # 代办任务
│       ├── approvals.rs        # Agent 操作审批
│       ├── git.rs              # Git/GitHub 联动
│       ├── health.rs           # 健康检查
│       ├── sandbox.rs          # 代码沙箱
│       └── rag.rs              # RAG 端点
│
├── frontend/                   # ── React 前端 ──
│   ├── package.json
│   ├── index.html
│   ├── vite.config.ts
│   ├── tailwind.config.js
│   ├── tsconfig.json
│   ├── postcss.config.js
│   ├── scripts/
│   │   └── prepare-sidecar.mjs # 编译后端并复制到 Tauri binary 目录
│   ├── src/
│   │   ├── main.tsx            # React 入口
│   │   ├── App.tsx             # 根组件 (三层架构)
│   │   ├── types.ts            # 全局类型定义
│   │   ├── index.css           # 全局 CSS + 组件类
│   │   ├── lib/
│   │   │   ├── api.ts          # REST API 客户端
│   │   │   ├── sse.ts          # SSE 流式解析
│   │   │   ├── diff.ts         # Diff 解析工具
│   │   │   └── formatter.ts    # 代码格式化
│   │   ├── stores/
│   │   │   ├── chat.ts         # 对话状态 (Zustand)
│   │   │   ├── sessions.ts     # 会话标签管理
│   │   │   ├── diffs.ts        # Diff 状态
│   │   │   ├── fileTree.ts     # 文件树状态
│   │   │   ├── skills.ts       # 技能状态
│   │   │   ├── mcp.ts          # MCP 状态
│   │   │   ├── approvals.ts    # 审批状态
│   │   │   ├── dialog.ts       # 全局弹窗
│   │   │   └── todos.ts        # 代办状态
│   │   ├── hooks/
│   │   │   ├── useAutoScroll.ts
│   │   │   └── useResizableLayout.ts
│   │   └── components/
│   │       ├── TitleBar.tsx     # 窗口标题栏
│   │       ├── SideNav.tsx      # 左侧导航
│   │       ├── WorkArea.tsx     # 工作区布局
│   │       ├── ChatPanel.tsx    # 聊天面板 (核心)
│   │       ├── MessageItem.tsx  # 单条消息
│   │       ├── ReasoningBlock.tsx # 推理过程
│   │       ├── CodeBlock.tsx    # 代码块
│   │       ├── MarkdownLite.tsx # Markdown 渲染
│   │       ├── FileTreePanel.tsx # 文件树
│   │       ├── DiffPanel.tsx    # 变更面板
│   │       ├── DiffViewer.tsx   # Diff 对比视图
│   │       ├── SettingsPage.tsx # 设置页面
│   │       ├── ModelSwitcher.tsx # 模型切换
│   │       ├── ParamsPanel.tsx  # 参数面板
│   │       ├── SlashMenu.tsx    # 斜杠指令菜单
│   │       ├── SkillListPanel.tsx # 技能列表
│   │       ├── SkillExecuteLog.tsx # 技能执行日志
│   │       ├── MCPManagerPanel.tsx # MCP 管理
│   │       ├── PluginMenu.tsx   # 插件菜单
│   │       ├── RagPanel.tsx     # RAG 面板
│   │       ├── RightPanel.tsx   # 右侧面板
│   │       ├── FilePicker.tsx   # 文件选择器
│   │       ├── ApprovalDialog.tsx # 审批弹窗
│   │       ├── DialogHost.tsx   # 全局弹窗宿主
│   │       ├── ContextMenu.tsx  # 右键菜单
│   │       ├── StatusBar.tsx    # 状态栏
│   │       ├── CodeToolbar.tsx  # 代码工具栏
│   │       └── fileIcons.tsx    # 文件图标
│   └── src-tauri/              # ── Tauri 桌面壳 ──
│       ├── Cargo.toml
│       ├── tauri.conf.json
│       ├── build.rs
│       ├── capabilities/
│       │   └── default.json
│       ├── src/
│       │   ├── main.rs         # Tauri 入口
│       │   └── lib.rs          # 窗口管理 + sidecar 生命周期
│       └── icons/              # 应用图标
│
```

---

## 5. 后端详解

### 5.1 入口 (`src/main.rs`)

```rust
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // 1. 加载配置 (config.toml > 环境变量 > 默认值)
    let cfg = config::AppConfig::load_or_init()?;

    // 2. 创建全局状态
    let state = state::SharedState::new(cfg);

    // 3. 初始化内置 Skill (17 项) + MCP (12 项)
    state.skills.init_builtin().await;
    state.mcp.init_builtin().await;

    // 4. 构建路由并启动 HTTP 服务
    let app = routes::build_router(state);
    axum::serve(listener, app).await?;
}
```

### 5.2 全局状态 (`src/state.rs`)

`SharedState` 是所有 API 处理函数的共享上下文，通过 Axum `State` 提取器注入：

| 字段 | 类型 | 用途 |
|------|------|------|
| `config` | `Arc<RwLock<AppConfig>>` | 运行时可变配置 |
| `sessions` | `SessionManager` | 会话 CRUD + 取消令牌 |
| `client` | `DeepSeekClient` | DeepSeek HTTP 流式客户端 |
| `project_root` | `Arc<RwLock<Option<PathBuf>>>` | 当前工作项目根目录 |
| `diffs` | `DiffRegistry` | 代码变更注册表 (按 session_id 分组) |
| `todos` | `TodoStore` | 代办任务内存存储 |
| `approvals` | `ApprovalStore` | Agent 操作审批队列 |
| `caches` | `CacheStore` | 缓存管理 |
| `skills` | `SkillStore` | 技能注册表 |
| `mcp` | `McpStore` | MCP 插件注册表 |
| `mcp_high_risk_enabled` | `Arc<RwLock<bool>>` | 高危插件总开关 |
| `skills_default_permission` | `Arc<RwLock<String>>` | 技能默认权限 |

### 5.3 配置系统 (`src/config.rs`)

**配置优先级**: `config.toml` > 环境变量 > 内置默认值

**持久化路径**: `%APPDATA%/codewhale-server/config.toml` (Windows)

**核心配置结构**:

```rust
AppConfig {
    server: ServerConfig { host, port },     // 监听地址
    deepseek: DeepSeekConfig { api_key, base_url, model },
    inference: InferenceDefaults { reasoning_effort, cache_enabled, context_length },
    permission: PermissionConfig { level, approval_on_write, approval_on_shell },
    model_profiles: ModelProfilesConfig,     // 多模型多凭证
    rag: RagConfig,                          // RAG 检索
    formatter: FormatterConfig,              // 代码格式化
    cache_debug: CacheDebugConfig,           // 缓存调试
    appearance: AppearanceConfig,            // 外观主题
    shortcuts: ShortcutsConfig,              // 快捷键
    security: SecurityConfig,                // 安全配置
}
```

**三级权限沙盒**:

| 等级 | 允许读文件 | 允许写文件 | 允许 Shell |
|------|-----------|-----------|-----------|
| `ReadOnly` | 是 | 否 | 否 |
| `WorkspaceWrite` (默认) | 是 | 是 | 否 |
| `FullAccess` | 是 | 是 | 是 |

### 5.4 DeepSeek 客户端 (`src/deepseek.rs`)

- 使用 OpenAI 兼容的 `/v1/chat/completions` 端点
- `stream: true` 启用 SSE 流式响应
- 双流解析: `content` (正文) + `reasoning_content` (推理过程)
- 支持透传 `reasoning_effort` (minimal/low/medium/high) 和 `enable_cache`
- 内置 `CancellationToken` 支持用户中断
- 系统提示词 `DEFAULT_AGENT_SYSTEM_PROMPT` 强制约束代码块格式、增量修改、权限边界

### 5.5 会话管理 (`src/session.rs`)

- 每个会话有唯一 UUID，支持创建/查询/删除/重置
- 同一时刻仅允许一个推理轮次（防止并发冲突）
- 上下文裁剪: 取尾部 `context_length` 条消息
- `PrefixCache` 集成: 5 层字节稳定分层架构，最大化 DeepSeek KV-Cache 命中率

### 5.6 Reasonix 缓存 (`src/cache.rs`)

5 层字节稳定分层：

| 层 | 内容 | 可变性 |
|----|------|--------|
| 1 | 系统 Prompt 前缀 | 不可变 |
| 2 | 项目持久记忆 | 不可变 |
| 3 | 挂载文件固定片段 | 追加-only |
| 4 | 历史对话只读追加区 | 追加-only |
| 5 | 当前最新用户消息 | 每轮可变 |

### 5.7 内置工具 (`src/tools.rs`)

| 工具 | 函数 | 权限要求 |
|------|------|---------|
| 读文件 | `read_file(root, rel)` | ReadOnly+ |
| 写文件 | `write_file(root, rel, content, create_dirs, permission)` | WorkspaceWrite+ |
| Git | `git(root, args, permission)` | FullAccess |
| Shell | `shell(root, command, timeout_secs, permission)` | FullAccess |

所有路径操作均通过 `config::ensure_within()` 校验项目根目录越界。

---

## 6. 前端详解

### 6.1 组件树

```
App
├── TitleBar                          # 窗口标题栏 (Mica 穿透)
├── SideNav                           # 左侧导航 (毛玻璃透明)
│   ├── 对话按钮
│   ├── 设置按钮
│   └── 账户信息
├── WorkArea                          # 工作区 (不透明板块)
│   ├── ChatPanel (核心)              # 聊天面板
│   │   ├── EmptyState                # 欢迎页 (Logo + 4 推荐卡片)
│   │   ├── 消息列表 (MessageItem)    # 对话消息
│   │   │   ├── ReasoningBlock        # 推理过程
│   │   │   ├── MarkdownLite          # Markdown 渲染
│   │   │   └── CodeBlock             # 代码块
│   │   └── ChatInputBar              # 复式输入框
│   │       ├── 上下文标签条 (项目/本地/Git)
│   │       ├── Textarea
│   │       └── 底部工具栏
│   │           ├── ➕ 添加按钮
│   │           ├── 🛡️ 权限切换
│   │           ├── 模型/推理强度选择
│   │           └── 发送/停止按钮
│   ├── FileTreePanel                 # 左侧文件树
│   ├── DiffPanel                     # 右侧变更面板
│   └── SettingsPage                  # 设置页面
│       ├── 模型 & API
│       ├── Skill 管理
│       ├── MCP 管理
│       ├── RAG 设置
│       ├── 格式化
│       ├── 缓存
│       ├── 外观
│       ├── 快捷键
│       └── 安全
├── ApprovalDialog                    # 审批弹窗
└── DialogHost                        # 全局弹窗宿主
```

### 6.2 状态管理 (Zustand Stores)

| Store | 文件 | 职责 |
|-------|------|------|
| `useChatStore` | `stores/chat.ts` | 消息列表、SSE 流式聚合、发送/停止/重试 |
| `useSessionsStore` | `stores/sessions.ts` | 会话标签管理、切换、重命名、拖拽排序 |
| `useDiffStore` | `stores/diffs.ts` | Diff 注册/应用/拒绝/还原 |
| `useFileTreeStore` | `stores/fileTree.ts` | 文件树加载、展开/折叠 |
| `useTodosStore` | `stores/todos.ts` | 代办任务 CRUD |
| `useApprovalsStore` | `stores/approvals.ts` | 审批队列轮询 |
| `useDialogStore` | `stores/dialog.ts` | 全局弹窗管理 |
| `useSkillsStore` | `stores/skills.ts` | 技能启用/禁用 |
| `useMcpStore` | `stores/mcp.ts` | MCP 插件启用/禁用/连接 |

### 6.3 API 客户端 (`lib/api.ts`)

- 自动检测环境: Tauri WebView 使用绝对 URL `http://127.0.0.1:8787/api`，浏览器开发使用 Vite 代理 `/api`
- 统一错误处理: `ApiError` 类
- 封装了所有 REST 接口: `chatApi`, `sessionsApi`, `configApi`, `paramsApi`, `projectApi`, `gitApi`, `mcpApi`, `permissionApi`, `skillApi`, `todoApi`, `approvalApi`, `ragApi`, `sandboxApi`, `diffApi`, `filesApi`, `modelProfilesApi`

### 6.4 UI 设计规范

**配色**: 白/灰/黑为主，橙色仅用于"完全访问"等警告语义
- 主强调色: `#FFFFFF` (白色)
- 警告色: `#F97316` (橙色)
- 文本: `rgba(255,255,255,0.95)` / `0.62` / `0.38`
- 表面: `#161617` (work) / `#1F1F21` (elevated) / `#262629` (hover)

**圆角**: 大圆角设计
- 输入框: `rounded-3xl` (32px)
- 卡片/弹窗: `rounded-2xl` (28px)
- 按钮: `rounded-xl` (22px)
- 标签/开关: `rounded-full` (9999px)

**字体**: 优先 Microsoft YaHei UI / PingFang SC / Segoe UI Variable

**动画**: 非线性弹性动画
- `cubic-bezier(0.34, 1.56, 0.64, 1)` 带回弹手感
- 页面切换: `animate-page-transition`
- 弹窗: `animate-scale-in`
- 新消息: `animate-slide-up-spring`

---

## 7. Tauri 桌面壳

### 7.1 窗口配置 (`tauri.conf.json`)

```json
{
  "windows": [{
    "title": "CodeWhale",
    "width": 1280, "height": 800,
    "decorations": false,   // 无边框窗口
    "transparent": true,    // 透明背景
    "windowEffects": {
      "effects": ["mica"],  // Win11 Mica 材质
      "radius": 12
    }
  }],
  "bundle": {
    "targets": ["msi", "nsis"],
    "externalBin": ["binaries/codewhale-server"]  // 后端 sidecar
  }
}
```

### 7.2 生命周期 (`lib.rs`)

1. **启动**: 通过 `shell.sidecar("codewhale-server")` 启动后端子进程
2. **等待就绪**: 轮询 `127.0.0.1:8787/ping`，最多等 15 秒
3. **加载窗口**: 后端就绪后加载 WebView 前端
4. **回收**: 窗口销毁时 `kill` sidecar 子进程

### 7.3 Tauri 命令

| 命令 | 用途 |
|------|------|
| `backend_health_check` | 前端轮询后端健康状态 |
| `min` | 最小化窗口 |
| `max` | 最大化/还原窗口 |
| `close` | 关闭窗口 |
| `is_maximized` | 查询最大化状态 |

---

## 8. API 接口清单

### 8.1 对话

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/chat` | 发起流式对话 (SSE) |
| `POST` | `/api/chat/stop` | 停止当前生成 |

### 8.2 会话

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/sessions` | 列出所有会话 |
| `POST` | `/api/sessions` | 创建会话 |
| `GET` | `/api/sessions/:id` | 获取会话详情 |
| `DELETE` | `/api/sessions/:id` | 删除会话 |
| `POST` | `/api/sessions/:id/reset` | 重置会话上下文 |

### 8.3 推理参数

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/params` | 获取默认推理参数 |
| `PUT` | `/api/params` | 更新默认推理参数 |

### 8.4 项目与文件

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/project/load` | 加载项目目录 |
| `GET` | `/api/project` | 获取当前项目信息 |
| `GET` | `/api/project/tree` | 获取文件树 |
| `POST` | `/api/files` | 创建文件 |
| `POST` | `/api/files/read` | 读取文件 |
| `POST` | `/api/files/write` | 写入文件 |
| `PATCH` | `/api/files/rename` | 重命名文件 |
| `POST` | `/api/files/reveal` | 在资源管理器显示 |
| `DELETE` | `/api/files` | 删除文件 |

### 8.5 Diff 管理

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/diffs` | 注册 Diff |
| `POST` | `/api/diffs/apply-all` | 应用全部 Diff |
| `POST` | `/api/diffs/:id/apply` | 应用单个 Diff |
| `POST` | `/api/diffs/:id/reject` | 拒绝单个 Diff |
| `POST` | `/api/diffs/:id/revert` | 还原单个 Diff |
| `POST` | `/api/diffs/:id/hunks/:hunk_index/apply` | 应用单个 Hunk |
| `POST` | `/api/diffs/:id/hunks/:hunk_index/reject` | 拒绝单个 Hunk |
| `GET` | `/api/diffs/:session_id` | 列出会话 Diff |

### 8.6 代办任务

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/todos` | 列出所有代办 |
| `POST` | `/api/todos` | 创建代办 |
| `GET` | `/api/todos/:id` | 获取代办详情 |
| `DELETE` | `/api/todos/:id` | 删除代办 |
| `POST` | `/api/todos/:id/status` | 更新状态 |
| `GET` | `/api/todos/session/:session_id` | 列出会话代办 |

### 8.7 审批

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/approvals` | 列出所有审批 |
| `POST` | `/api/approvals` | 创建审批请求 |
| `GET` | `/api/approvals/pending` | 列出待审批 |
| `GET` | `/api/approvals/:id` | 获取审批详情 |
| `POST` | `/api/approvals/:id/decide` | 批准/拒绝 |

### 8.8 配置

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET/PUT` | `/api/config/deepseek` | DeepSeek 配置 |
| `POST` | `/api/config/deepseek/test` | 测试 Key 有效性 |
| `GET/PUT` | `/api/config/permission` | 权限配置 |
| `GET/PUT` | `/api/config/model-profiles` | 多模型档案 |
| `POST` | `/api/config/profiles` | 添加 Profile |
| `PUT/DELETE` | `/api/config/profiles/:id` | 更新/删除 Profile |
| `POST` | `/api/config/profiles/:id/active` | 设为激活 |
| `GET/PUT` | `/api/config/rag` | RAG 配置 |
| `GET/PUT` | `/api/config/formatter` | 格式化配置 |
| `GET/PUT` | `/api/config/cache` | 缓存配置 |
| `POST` | `/api/config/cache/clear-session` | 清除会话缓存 |
| `POST` | `/api/config/cache/clear-memory` | 清除项目记忆 |
| `GET` | `/api/config/cache/stats` | 缓存统计 |
| `GET/PUT` | `/api/config/appearance` | 外观配置 |
| `GET/PUT/POST` | `/api/config/shortcuts` | 快捷键 |
| `GET/PUT` | `/api/config/security` | 安全配置 |
| `GET` | `/api/config/security/export-audit` | 导出审计日志 |
| `GET` | `/api/model-profiles` | 模型档案列表 |

### 8.9 Skill 技能

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/skills` | 列出所有技能 |
| `POST` | `/api/skills` | 创建自定义技能 |
| `GET` | `/api/skills/:id` | 获取技能详情 |
| `DELETE` | `/api/skills/:id` | 删除技能 |
| `PUT` | `/api/skills/:id/toggle` | 切换启用/禁用 |
| `PUT` | `/api/skills/:id/enabled` | 设置启用状态 |
| `POST` | `/api/skills/:id/export` | 导出技能 |
| `GET` | `/api/skills/config` | 获取技能配置 |
| `POST` | `/api/skills/find` | 模糊匹配技能 |
| `POST` | `/api/skills/import` | 导入技能包 |
| `POST` | `/api/skills/default-permission` | 设置默认权限 |
| `GET/PUT` | `/api/skills/agents-md` | 管理 AGENTS.md |

### 8.10 MCP 插件

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/mcp` | 列出所有插件 |
| `POST` | `/api/mcp` | 注册插件 |
| `DELETE` | `/api/mcp/:id` | 删除插件 |
| `PUT` | `/api/mcp/:id/toggle` | 切换启用/禁用 |
| `POST` | `/api/mcp/:id/enabled` | 设置启用状态 |
| `POST` | `/api/mcp/:id/connect` | 连接插件 |
| `POST` | `/api/mcp/:id/disconnect` | 断开插件 |
| `GET/POST` | `/api/mcp/services` | MCP 服务列表 |
| `POST` | `/api/mcp/global-enabled` | 全局启用开关 |
| `GET/PUT` | `/api/mcp/high-risk/switch` | 高危插件开关 |
| `POST` | `/api/mcp/call` | 调用插件工具 |

### 8.11 其他

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/ping` | 健康检查 |
| `GET` | `/api/rag/index` | 获取 RAG 索引 |
| `POST` | `/api/rag/index` | 构建 RAG 索引 |
| `POST` | `/api/rag/recall` | RAG 召回 |
| `DELETE` | `/api/rag/clear` | 清除索引 |
| `POST` | `/api/sandbox/exec` | 沙箱执行代码 |
| `GET` | `/api/sandbox/languages` | 支持的语言列表 |
| `POST` | `/api/sandbox/format` | 代码格式化 |
| `GET` | `/api/git/status` | Git 状态 |
| `POST` | `/api/git/diff` | Git Diff |
| `POST` | `/api/git/commit` | Git Commit |
| `POST` | `/api/git/branch` | Git 分支操作 |
| `POST` | `/api/git/pr-review` | PR 评审 |
| `GET` | `/api/git/log` | Git 日志 |
| `POST` | `/api/tools/file/read` | 读取文件 |
| `POST` | `/api/tools/file/write` | 写入文件 |
| `POST` | `/api/tools/git` | Git 工具 |
| `POST` | `/api/tools/shell` | Shell 工具 |

---

## 9. Skill 技能生态

### 9.1 内置 17 项技能

| ID | 名称 | 分类 | 权限 | 触发词 |
|----|------|------|------|--------|
| `code-review` | 代码评审 | review | WorkspaceWrite | review, 评审, code review |
| `tdd-gen` | 测试生成 | test | WorkspaceWrite | test, 测试, tdd, 单元测试 |
| `git-workflow` | Git 工作流 | git | FullAccess | commit, 提交, pr, 分支 |
| `large-refactor` | 大型重构 | refactor | WorkspaceWrite | refactor, 重构, 模块化, 拆分 |
| `bug-diagnose` | Bug 诊断 | bug | WorkspaceWrite | bug, 错误, 报错, 修复 bug |
| `lint-fix` | 格式化修复 | lint | WorkspaceWrite | lint, 格式化, format, prettier |
| `project-init` | 项目初始化 | init | WorkspaceWrite | init, 新建项目, scaffold |
| `perf-optimize` | 性能优化 | refactor | WorkspaceWrite | performance, 性能, 优化, 慢 |
| `security-audit` | 安全审计 | review | ReadOnly | security, 安全, 审计, CVE |
| `api-design` | API 设计 | refactor | WorkspaceWrite | api, 接口, REST, OpenAPI |
| `doc-gen` | 文档生成 | init | WorkspaceWrite | 文档, doc, README |
| `dep-check` | 依赖检查 | lint | WorkspaceWrite | 依赖, dependency, upgrade |
| `dockerize` | Docker 化 | init | WorkspaceWrite | docker, 容器, Dockerfile |
| `cicd-setup` | CI/CD 配置 | init | WorkspaceWrite | CI, CD, pipeline, Actions |
| `db-migration` | 数据库迁移 | refactor | WorkspaceWrite | migration, 迁移, schema |
| `code-style` | 代码风格统一 | lint | WorkspaceWrite | 风格, style, eslint, rustfmt |
| `release-notes` | 版本发布说明 | git | WorkspaceWrite | release, 发布, changelog |

### 9.2 技能匹配算法

模糊匹配基于关键词加权：
- **triggers 命中**: +0.5/词 (权重最高)
- **name 命中**: +0.3
- **description 命中**: +0.2
- **阈值**: score < 0.3 不返回
- **归一化**: 总分 cap 1.0

### 9.3 SKILL.md 格式

```markdown
---
id: my-skill
name: 我的技能
description: 简短描述
triggers: 关键词1,关键词2
category: custom
version: 1.0.0
default_permission: WorkspaceWrite
required_tools: read_file,write_file
---
# Steps
1. [analyze] 第一步 => todo1
2. [generate] 第二步
3. [hunk] 输出 Hunk
```

---

## 10. MCP 插件生态

### 10.1 内置 12 项插件

| ID | 名称 | 分类 | 传输 | 高危 | 能力 |
|----|------|------|------|------|------|
| `github` | GitHub | other | stdio | 否 | 仓库/Issue/PR 读写 |
| `filesystem` | Filesystem | other | stdio | 否 | 文件读写/目录遍历 |
| `memory` | Memory | knowledge | stdio | 否 | 知识图谱记忆存储 |
| `puppeteer` | Puppeteer | other | stdio | 否 | 浏览器自动化/截图/PDF |
| `brave-search` | Brave Search | knowledge | stdio | 否 | 网络搜索 |
| `fetch` | Fetch | other | stdio | 否 | HTTP 请求/网页抓取 |
| `sequential-thinking` | Sequential Thinking | other | stdio | 否 | 结构化思维链 |
| `sqlite` | SQLite | database | stdio | 是 | SQLite 数据库读写 |
| `time` | Time | other | stdio | 否 | 时间/时区查询 |
| `rust-lsp` | Rust LSP | lsp | stdio | 否 | Rust 类型/定义/引用 |
| `typescript-lsp` | TypeScript LSP | lsp | stdio | 否 | TS/JS 类型定义引用 |
| `context7` | Context7 | knowledge | stdio | 否 | 最新库文档查询 |

所有插件默认 `enabled=false`，需要用户主动启用。高危插件（SQLite）默认关闭并受 `high_risk` 总开关管控。

### 10.2 权限隔离

| 作用域 | 限制 |
|--------|------|
| `file` | 写操作需 can_write 权限 |
| `network` | 禁止访问本地文件系统 |
| `shell` | 需 FullAccess 权限 |
| `database` | 受 high_risk 总开关 + 审批管控 |

### 10.3 传输协议

- **stdio**: 启动子进程，stdin/stdout 传递 JSON-RPC 2.0，每行一个 JSON
- **SSE**: reqwest POST 到插件 URL，简化为单次请求/响应
- **超时**: 默认 30 秒，防插件卡死
- **摘要**: 调用结果截断至 2000 字符

---

## 11. 配置与部署

### 11.1 环境要求

| 组件 | 最低版本 |
|------|---------|
| Rust | 1.88+ |
| Node.js | 18+ |
| npm | 9+ |
| Windows SDK | 10.0.26100 (Mica 支持) |
| Tauri CLI | 2.x (通过 npm scripts 自动安装) |

### 11.2 快速启动

```bash
# Windows 一键启动
start.bat dev

# 或分步启动
cd frontend
npm install
npm run tauri:dev
```

### 11.3 配置 API Key

**方式一**: 在设置页面 UI 中输入

**方式二**: 环境变量
```bash
set CODEWHALE_DEEPSEEK__API_KEY=sk-your-key
```

**方式三**: 配置文件
编辑 `%APPDATA%/codewhale-server/config.toml`:
```toml
[deepseek]
api_key = "sk-your-key"
```

### 11.4 Release 构建

```bash
start.bat release
# 或
cd frontend && npm run tauri:build
```

产物位于 `frontend/src-tauri/target/release/bundle/`。

---

## 12. 开发工作流

### 12.1 仅启动后端

```bash
start.bat backend
# 或 cargo run
```

后端监听 `127.0.0.1:8787`，前端需要另外启动。

### 12.2 仅启动前端

```bash
start.bat frontend
# 或 cd frontend && npm run dev
```

Vite 代理 `/api` 到 `127.0.0.1:8787`。

### 12.3 代码检查

```bash
# 前端类型检查
cd frontend && npx tsc --noEmit

# 前端构建
cd frontend && npx vite build

# 后端检查
cargo check

# 环境检查
start.bat check
```

### 12.4 清理

```bash
start.bat clean
```

---

## 13. 关键设计决策

### 13.1 为什么是 Sidecar 架构？

Tauri 前端通过 `tauri-plugin-shell` 启动后端作为 sidecar 子进程。优点：
- 后端与前端完全解耦，可用任意 HTTP 客户端调试
- 后端崩溃不影响前端窗口
- 可独立编译/测试后端
- 前端通过标准 fetch API 通信，无需 Tauri invoke bridge

### 13.2 为什么是 Axum 而非 Actix-web？

- Axum 基于 Tower 生态，与 tokio/tower-http 集成更好
- 更轻量，编译更快
- 原生支持 SSE 流式响应

### 13.3 为什么是 Zustand 而非 Redux？

- Zustand 极简 API，无 boilerplate
- 天然支持 TypeScript
- 支持在 React 组件外通过 `getState()` 访问状态
- 可按需订阅，避免不必要渲染

### 13.4 字节稳定前缀缓存

核心想法：前 4 层上下文在会话期间不改变字节顺序，使 DeepSeek 服务端 KV-Cache 能命中缓存。只有第 5 层（当前消息）每轮可变。这样在长对话中可节省大量 token 和延迟。

### 13.5 所有 MCP 插件默认禁用

出于安全考虑，内置 12 个 MCP 插件全部 `enabled=false`。用户需要手动启用需要的插件。高危插件（如 SQLite）额外受 `mcp_high_risk_enabled` 总开关管控。

---

## 14. 新人上手指南

### 14.1 环境准备

```bash
# 1. 安装 Rust (1.88+)
winget install Rustlang.Rustup

# 2. 安装 Node.js (18+)
winget install OpenJS.NodeJS.LTS

# 3. 安装 Windows SDK 10.0.26100（Mica 材质必需）
# 在 Visual Studio Installer 中勾选「使用 C++ 的桌面开发」

# 4. 验证环境
start.bat check
```

### 14.2 首次启动

```bash
# 克隆仓库
git clone https://github.com/natsume-stack/deepseek-codewhale-desktop.git
cd deepseek-codewhale-desktop

# 配置 API Key（三选一）
# 方式 A: 启动后在设置页面 UI 中输入
# 方式 B: 复制 .env.example 为 .env，填入 Key
# 方式 C: 编辑 %APPDATA%/codewhale-server/config.toml

# 一键启动
start.bat dev
```

### 14.3 关键文件速查

**后端核心文件（按重要性排序）**:

| 文件 | 职责 | 何时修改 |
|------|------|---------|
| `src/main.rs` | 入口，启动服务 | 几乎不改 |
| `src/routes/mod.rs` | 所有 API 路由注册 | 新增 API 端点 |
| `src/routes/chat.rs` | SSE 对话核心逻辑 | 修改对话行为 |
| `src/state.rs` | 全局共享状态 | 新增全局数据 |
| `src/config.rs` | 配置 + 权限等级 | 新增配置项 |
| `src/deepseek.rs` | DeepSeek API 客户端 | 修改模型调用 |
| `src/session.rs` | 会话管理 + 前缀缓存 | 修改上下文策略 |
| `src/cache.rs` | Reasonix 5 层缓存 | 缓存策略调整 |
| `src/tools.rs` | 文件/Git/Shell 工具 | 新增工具 |
| `src/skills.rs` | Skill 技能注册表 | 新增内置技能 |
| `src/mcp.rs` | MCP 插件注册表 | 新增内置插件 |
| `src/diff.rs` | Myers Diff 算法 | Diff 算法调整 |

**前端核心文件（按重要性排序）**:

| 文件 | 职责 | 何时修改 |
|------|------|---------|
| `frontend/src/App.tsx` | 根组件，三层架构 | 修改整体布局 |
| `frontend/src/components/ChatPanel.tsx` | 聊天面板（核心） | 修改对话交互 |
| `frontend/src/stores/chat.ts` | 对话状态管理 | 修改消息流逻辑 |
| `frontend/src/lib/api.ts` | REST API 客户端 | 新增 API 调用 |
| `frontend/src/lib/sse.ts` | SSE 流式解析 | 修改流式处理 |
| `frontend/src/components/MessageItem.tsx` | 单条消息渲染 | 修改消息显示 |
| `frontend/src/components/SettingsPage.tsx` | 设置页面 | 新增设置项 |
| `frontend/src/index.css` | 全局样式 + 组件类 | 修改样式 |
| `frontend/tailwind.config.js` | Tailwind 主题配置 | 修改配色/圆角/字体 |
| `frontend/src/types.ts` | 全局类型定义 | 新增类型 |

### 14.4 如何添加新功能

**添加新 API 端点**:
1. 在 `src/routes/` 下创建新模块文件（如 `new_feature.rs`）
2. 在 `src/routes/mod.rs` 中声明模块并注册路由
3. 在 `frontend/src/lib/api.ts` 中添加对应的前端调用方法
4. 在 `frontend/src/types.ts` 中添加请求/响应类型

**添加新 Skill**:
1. 在 `src/skills.rs` 的 `init_builtin()` 方法中添加 `SkillDef` 结构体
2. 填写 id、name、description、triggers、category、default_permission 等字段
3. 前端会自动从 `/api/skills` 加载，无需额外修改

**添加新 MCP 插件**:
1. 在 `src/mcp.rs` 的 `init_builtin()` 方法中添加 `McpDef` 结构体
2. 填写 id、name、description、category、transport、high_risk 等字段
3. 前端会自动从 `/api/mcp` 加载

**添加新前端组件**:
1. 在 `frontend/src/components/` 下创建新 `.tsx` 文件
2. 如需全局状态，在 `frontend/src/stores/` 下创建 Zustand store
3. 在父组件中引入并渲染

### 14.5 代码检查命令

```bash
# 后端检查
cargo check                    # 快速编译检查
cargo fmt -- --check           # 格式化检查
cargo clippy                   # Lint 检查

# 前端检查
cd frontend
npx tsc --noEmit               # TypeScript 类型检查
npx vite build                 # 构建验证

# 一键检查
start.bat check
```

---

## 15. 常见问题排查

### 15.1 启动相关

| 问题 | 可能原因 | 解决方案 |
|------|---------|---------|
| `cargo: command not found` | Rust 未安装 | `winget install Rustlang.Rustup` |
| `error: linker 'link.exe' not found` | 缺少 VS C++ 工具链 | VS Installer 勾选「使用 C++ 的桌面开发」 |
| `Address already in use` (8787) | 端口被占用 | 结束占用进程或修改 `config.toml` 端口 |
| `npm: command not found` | Node.js 未安装 | `winget install OpenJS.NodeJS.LTS` |
| Mica 背景不显示 | Windows 10 或 SDK 版本不足 | 安装 Windows 11 SDK 10.0.26100 |
| 前端 404 错误 | 后端未启动 | 先启动后端再启动前端 |

### 15.2 API 相关

| 问题 | 可能原因 | 解决方案 |
|------|---------|---------|
| DeepSeek API 401 | API Key 无效或过期 | 在设置页面重新填入 Key |
| DeepSeek API 429 | 请求频率超限 | 降低发送频率，等待恢复 |
| SSE 流中断 | 网络抖动或后端重启 | 重新发送消息即可 |
| Skill/MCP 不显示 | 后端未正确初始化 | 检查 `init_builtin()` 是否被调用 |
| 路由 404 | 路由未注册或顺序错误 | 检查 `src/routes/mod.rs` 路由注册 |

### 15.3 前端相关

| 问题 | 可能原因 | 解决方案 |
|------|---------|---------|
| TS 类型错误 | 类型定义不匹配 | 运行 `npx tsc --noEmit` 查看具体错误 |
| 组件不渲染 | Zustand store 状态未更新 | 检查 store 的 `getState()` 和订阅 |
| 样式不生效 | Tailwind 类名拼写错误 | 检查 `tailwind.config.js` 配置 |
| 动画卡顿 | 过多并发动画 | 减少同时播放的 spring 动画数量 |
| 设置项无法点击 | 事件绑定缺失 | 检查 `onClick` 等事件处理函数 |

### 15.4 调试技巧

```bash
# 后端调试：开启详细日志
set RUST_LOG=debug,codewhale_server=trace
cargo run

# 前端调试：开启 Vite 开发模式
cd frontend && npm run dev
# 浏览器打开 http://localhost:5173，F12 查看控制台

# 单独测试后端 API
curl http://127.0.0.1:8787/ping
curl http://127.0.0.1:8787/api/skills
curl http://127.0.0.1:8787/api/mcp
```

---

## 16. 待办与改进方向

### 短期

- [ ] 对话历史持久化（当前内存存储，重启丢失）
- [ ] 多语言 i18n 国际化
- [ ] 更多 DeepSeek 模型支持（V4-Pro、reasoner）
- [ ] 会话导出/导入

### 中期

- [ ] 插件市场（社区贡献 Skill/MCP）
- [ ] 协作编程（多人同时编辑）
- [ ] VS Code / JetBrains 插件
- [ ] 移动端适配

### 长期

- [ ] 本地模型支持（Ollama / llama.cpp）
- [ ] 自定义 Agent 工作流编排
- [ ] 企业版 SSO / 审计 / 合规

---

> **文档维护**: 请在每次重大变更后更新本文档。如有疑问，联系 CodeWhale Team。
