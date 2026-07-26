<div align="center">

# 🐋 CodeWhale

### DeepSeek 原生工程级 AI 编程 Agent · 桌面端

**Tauri 2 + Rust + React 18 · Windows 11 Mica 原生毛玻璃 · Reasonix 字节稳定前缀缓存**

对标 OpenAI Codex++ 桌面智能体，深度适配 DeepSeek V4-Flash / V4-Pro / R1 全链路。

</div>

---

## ✨ 核心特性

| 能力 | 实现 |
| --- | --- |
| 🧠 **双流 SSE** | 推理思考（reasoning）与正式代码（content）分层流式输出，R1 推理块独立折叠 |
| ⚡ **Reasonix 缓存体系** | 5 层字节稳定前缀：系统提示→项目记忆→挂载文件→历史只读→当前消息，目标命中率 90%+，长会话 Token 成本降至 1/5 |
| 🔧 **Myers Hunk Diff** | 增量代码变更按 Hunk 粒度独立 apply / reject，拒绝则本地零变更 |
| 🛡️ **三级权限沙盒** | ReadOnly / WorkspaceWrite / FullAccess，高危操作可视化审批弹窗 |
| 📝 **代办任务自动推送** | 复杂需求 `<todo>` 标签解析，三态跟踪（pending/running/done） |
| 🎯 **智能任务路由** | Light→V4-Flash / Heavy→V4-Pro / Mega→V4-Pro+并发限流（防 429） |
| 🔌 **DSML 工具调用** | 标准化执行意图标签，权限不足主动终止并引导设置 |
| 🗂️ **项目 RAG 检索** | 500 行分块 + 关键词评分召回，固定顺序注入不打乱前缀 |
| 🧪 **代码沙箱** | Rust / Go / Python / TS / Shell 多语言运行 + 失败自动修复建议 |
| 🔗 **Git/GitHub 联动** | Conventional Commits 自动推断 + PR 评审 |
| 🎨 **Codex 风格 UI** | 三栏布局、Mica 透明、圆润交互、200ms 缓动 |
| 🗂️ **最近会话工作流** | 左侧单行最近会话列表，切换时加载独立上下文与缓存前缀 |

---

## 🏗️ 架构总览

```
┌─────────────────────────────────────────────────────────────────────┐
│                      CodeWhale Desktop (Tauri 2)                     │
├─────────────────────────────────────────────────────────────────────┤
│  前端 (frontend/)              │  后端 (src/ + sidecar)              │
│  React 18 + TS + Tailwind     │  Rust + Axum + Tokio                │
│  Zustand 状态管理              │  监听 127.0.0.1:8787                │
│  Codex 风格三栏布局            │  REST + SSE 双流                    │
│                                │                                     │
│  ┌──────────┐ ┌────────────┐  │  ┌──────────────────────────────┐  │
│  │ 文件树    │ │ 最近会话列表 │  │  │ Reasonix 前缀缓存层          │  │
│  │ SideNav  │ │ SideNav    │  │  │ cache.rs (5 层字节稳定)       │  │
│  └────┬─────┘ └─────┬──────┘  │  └──────────────────────────────┘  │
│       │             │         │  ┌──────────────────────────────┐  │
│  ┌────▼─────────────▼──────┐  │  │ Myers Hunk Diff              │  │
│  │   WorkArea 三栏工作区    │  │  │ diff.rs (LCS + hunk 粒度)    │  │
│  │ ┌─────┐ ┌──────┐ ┌────┐ │  │  └──────────────────────────────┘  │
│  │ │Chat │ │ Diff │ │RAG │ │──HTTP──► /api/chat (SSE 双流)         │
│  │ │Panel│ │Panel │ │Tab │ │  │  /api/diffs (Hunk apply/reject)    │
│  │ └─────┘ └──────┘ └────┘ │  │  /api/todos /api/approvals         │
│  └─────────────────────────┘  │  /api/git/* /api/sandbox/*          │
│  ┌─────────────────────────┐  │  /api/rag/* /api/config/*           │
│  │ SettingsPage 抽屉设置    │  │                                     │
│  │ · API · 模型 · 权限      │  │  ┌──────────────────────────────┐  │
│  │ · 格式化 · 缓存          │  │  │ DeepSeek API                 │  │
│  └─────────────────────────┘  │  │ V4-Flash / V4-Pro / R1       │  │
│                                │  └──────────────────────────────┘  │
└────────────────────────────────┴─────────────────────────────────────┘
```

---

## 🛠️ 技术栈

| 层 | 技术 |
| --- | --- |
| 桌面壳 | Tauri 2（Windows 11 Mica 原生毛玻璃，transparent + decorations:false） |
| 前端 | React 18 + TypeScript 5.6 + Vite 5 + Tailwind 3.4 + Zustand 4 |
| 后端 | Rust 2021 (1.88+) + Axum 0.7 + Tokio + Reqwest + Serde |
| AI 模型 | DeepSeek V4-Flash（轻量）/ V4-Pro（深度）/ R1（推理） |
| Diff 算法 | LCS-based Myers（含上下文行 + 行号偏移跟踪） |
| 缓存 | Reasonix 5 层字节稳定前缀（DefaultHasher 指纹校验） |

---

## 🚀 快速开始

### 环境要求

| 组件 | 版本 |
| --- | --- |
| Rust 工具链 | 1.88+（stable） |
| Node.js | 18+ |
| Windows SDK | 10.0.26100.0（Mica 材质必需） |
| 操作系统 | Windows 11 21H2+（完整 Mica）/ Windows 10 1809+（降级运行） |

### 1. 克隆仓库

```bash
git clone https://github.com/natsume-stack/deepseek-codewhale-desktop.git
cd deepseek-codewhale-desktop
```

### 2. 配置 DeepSeek API Key

```bash
# 复制环境变量模板
cp .env.example .env
# 编辑 .env 填入你的 DeepSeek API Key
# CODEWHALE_DEEPSEEK__API_KEY=sk-your-real-key
```

或启动后在客户端「设置 → API」中填入（自动落盘至 `%APPDATA%\codewhale-server\config.toml`）。

### 3. 启动开发模式

**方式 A：完整 Tauri 桌面应用（推荐）**

```powershell
# 一键启动（Windows）
start.bat dev

# 或分步启动
cd frontend
npm install
npm run tauri:dev
```

**方式 B：仅后端（调试 API）**

```powershell
# 一键启动后端
start.bat backend

# 或直接 cargo run
cargo run
# 监听 http://127.0.0.1:8787
```

**方式 C：仅前端（Vite 热更新，需后端已启动）**

```powershell
cd frontend
npm install
npm run dev    # http://localhost:5173
```

### 4. 首次使用

1. 启动后在「设置 → API」填入 DeepSeek API Key，点击「测试连接」
2. 左侧「打开项目」选择本地代码仓库
3. 中央输入开发需求，Enter 发送
4. 输入框 `/` 唤起斜杠指令，`@` 唤起文件挂载
5. 右侧 Tab 切换：变更（Hunk Diff）/ 代办 / RAG

---

## 📁 项目结构

```
deepseek-codewhale-desktop/
├── src/                          # Rust 后端（codewhale-server）
│   ├── main.rs                   # 入口
│   ├── config.rs                 # 配置 + 权限等级 + IGNORED_DIRS
│   ├── state.rs                  # SharedState（config/sessions/client/diffs/todos/approvals/caches）
│   ├── deepseek.rs               # DeepSeek 客户端 + DEFAULT_AGENT_SYSTEM_PROMPT
│   ├── cache.rs                  # ⭐ Reasonix 字节稳定前缀缓存（5 层）
│   ├── r1_harvest.rs             # R1 推理块工具提取
│   ├── tool_repair.rs            # 工具调用自动修复
│   ├── dsml.rs                   # DSML 标准工具调用标签
│   ├── smart_router.rs           # V4-Flash/Pro 智能路由 + 并发限流
│   ├── diff.rs                   # Myers Hunk Diff 算法
│   ├── rag.rs                    # 项目 RAG 分块索引
│   ├── session.rs                # 会话管理 + 分层上下文
│   ├── tools.rs                  # 文件/Git/Shell 工具（含权限检查）
│   └── routes/                   # Axum 路由
│       ├── chat.rs               # SSE 双流 + todo 解析 + 附件挂载 + 缓存事件
│       ├── diffs.rs              # Diff 管理 + Hunk 粒度
│       ├── approvals.rs          # 审批队列
│       ├── todos.rs              # 代办任务
│       ├── git.rs                # Git/GitHub 联动
│       ├── sandbox.rs            # 代码沙箱执行
│       ├── files.rs              # 文件系统 CRUD
│       ├── tools.rs              # 工具调用（含审批流程）
│       ├── config_api.rs         # 配置 + 权限 API
│       └── ...
├── frontend/                     # React 前端
│   ├── src/
│   │   ├── components/           # Codex 风格组件
│   │   │   ├── ChatPanel.tsx     # 对话面板（SlashMenu + FilePicker）
│   │   │   ├── DiffViewer.tsx    # Hunk 粒度 Diff 查看器
│   │   │   ├── RightPanel.tsx    # 右侧三 Tab（变更/代办/RAG）
│   │   │   ├── ApprovalDialog.tsx# 审批浮窗
│   │   │   ├── ModelSwitcher.tsx # 多模型切换
│   │   │   ├── CodeToolbar.tsx   # 代码悬浮工具栏
│   │   │   └── ...
│   │   ├── stores/               # Zustand 状态
│   │   ├── lib/                  # api / sse / formatter
│   │   └── index.css             # Mica 透明 + Codex 主题
│   └── src-tauri/                # Tauri 桌面壳配置
│       └── tauri.conf.json       # Mica + transparent + 12px 圆角
├── .env.example                  # 环境变量模板
├── config.example.toml           # 配置文件模板
├── start.ps1 / start.sh          # 后端启动脚本
└── Cargo.toml                    # Rust 工作空间
```

---

## 📡 API 端点

### 核心 API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/chat` | SSE 双流式对话（reasoning + content + cache_stats） |
| POST | `/api/chat/stop` | 中断当前推理 |
| GET/POST | `/api/sessions` | 会话管理 |
| GET | `/api/project/tree` | 文件树（自动过滤 IGNORED_DIRS） |
| POST | `/api/project/load` | 加载项目根目录 |

### Diff 与代办

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/diffs/register` | 注册 Diff（自动计算 Hunk） |
| POST | `/api/diffs/:id/hunks/:idx/apply` | 应用单个 Hunk |
| POST | `/api/diffs/:id/hunks/:idx/reject` | 拒绝单个 Hunk |
| GET/POST | `/api/todos` | 代办任务 CRUD |
| GET/POST | `/api/approvals` | 审批队列（pending/decide） |

### Git / 沙箱 / RAG

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/git/status` | Git 状态 |
| POST | `/api/git/commit` | Conventional Commits 自动提交（需审批） |
| POST | `/api/git/pr-review` | PR 评审（DeepSeek 分析） |
| POST | `/api/sandbox/exec` | 多语言代码执行（需 FullAccess） |
| POST | `/api/rag/recall` | RAG 关键词召回 |
| GET/PUT | `/api/config/permission` | 三级权限配置 |

完整 API 文档见 [API.md](./API.md)。

---

## ⚡ Reasonix 缓存体系（核心）

对齐 [Reasonix](https://github.com/esengine/deepseek-reasonix) 的 DeepSeek 专属缓存工程规范。

### 5 层字节稳定前缀

```
┌─────────────────────────────────────────┐
│ 第 1 层：系统 Prompt（全程字节不可变）    │  ← DeepSeek KV-Cache 命中区
├─────────────────────────────────────────┤
│ 第 2 层：项目持久记忆（首次 init 后不变）│  ← KV-Cache 命中区
├─────────────────────────────────────────┤
│ 第 3 层：挂载文件固定片段（追加 only）   │  ← KV-Cache 命中区
├─────────────────────────────────────────┤
│ 第 4 层：历史对话只读追加区（不重排）    │  ← KV-Cache 命中区
├─────────────────────────────────────────┤
│ 第 5 层：当前最新用户消息（每轮可变）    │  ← 仅此处每轮变化
└─────────────────────────────────────────┘
```

### 铁律

1. **仅追加上下文**：禁止在前 4 层插入/删除/重排，任意改动击穿前缀缓存
2. **附件外挂**：`@文件挂载` 进入第 3 层而非 user message，保持第 5 层纯文本
3. **压缩兜底**：长上下文仅裁剪第 4 层尾部，绝不触碰前 3 层
4. **指纹校验**：DefaultHasher 计算前 4 层指纹，SSE 推送 `cache_stats.verified` 字段
5. **单文件上限**：50KB，二进制文件过滤

### 缓存事件

每轮对话 finish 后推送：

```json
{
  "event": "cache_stats",
  "data": {
    "hitRate": 0.92,
    "hits": 23,
    "misses": 2,
    "fingerprint": "a1b2c3d4...",
    "historyLen": 18,
    "mountedFiles": 3,
    "verified": true
  }
}
```

---

## 🛡️ 三级权限沙盒

| 等级 | 文件读取 | 文件写入 | Shell 执行 | 适用场景 |
| --- | --- | --- | --- | --- |
| `ReadOnly` | ✅ | ❌ | ❌ | 代码审查 / 解释 |
| `WorkspaceWrite`（默认） | ✅ | ✅ | ❌ | 日常开发 |
| `FullAccess` | ✅ | ✅ | ✅ | 高危操作（需二次确认） |

- 高危操作（commit / branch delete / shell）强制走审批弹窗
- 审批超时 5 分钟自动驳回
- 所有操作留存本地审计日志

---

## 🎨 设计规范

| 元素 | 规格 |
| --- | --- |
| 窗口圆角 | 12px |
| 面板 / 卡片圆角 | 8px |
| 按钮圆角 | 4px |
| 主强调色 | Emerald `#10B981` |
| 动画缓动 | `cubic-bezier(0.16, 1, 0.3, 1)` 200ms |
| 背景 | Windows 11 Mica 原生毛玻璃（禁用 CSS backdrop-filter） |
| 布局 | 三栏：左侧导航 + 中央对话 + 右侧变更/代办/RAG |

---

## 🔒 安全红线

- ✅ 所有文件操作经 `tools.rs` 边界校验（`ensure_within` 防路径穿越）
- ✅ API Key 本地存储，不明文输出
- ✅ 删除/覆盖/Shell 高危操作强制可视化审批
- ✅ 缓存前缀区不可修改，仅在尾部追加

---

## 📚 参考项目致谢

本项目借鉴以下优秀开源项目的设计理念：

| 项目 | 仓库 | 借鉴点 |
| --- | --- | --- |
| Reasonix | [esengine/deepseek-reasonix](https://github.com/esengine/deepseek-reasonix) | 字节稳定前缀缓存、R1 工具提取、工具调用修复 |
| DeepSeekAgents | [MoYeRanQianZhi/DeepSeekAgents](https://github.com/MoYeRanQianZhi/DeepSeekAgents) | 标准化任务面板、多模型切换、工具封装 |
| Aider | [paul-gauthier/aider](https://github.com/paul-gauthier/aider) | @文件挂载、/斜杠指令、Hunk Diff、Git Commit |
| Continue.dev | [continuedev/continue](https://github.com/continuedev/continue) | 代办生命周期、代码悬浮工具栏、消息交互 |
| ArcDesk | — | 抽屉式设置、三级权限可视化、多模型卡片 |
| deepseek-tui-desktop | — | 窗口分栏、Mica 透明、主题自定义 |

---

## 📖 文档

- [ARCHITECTURE.md](./ARCHITECTURE.md) — **项目架构与交接文档（主要）**
- [API.md](./API.md) — 完整 API 端点速查
- [AGENT_ROADMAP.md](./AGENT_ROADMAP.md) — Agent 能力路线图

---

## 📄 License

MIT License — 详见 [LICENSE](./LICENSE)

---

<div align="center">

**🐋 CodeWhale** — DeepSeek 原生工程级 AI 编程 Agent

Made with Rust + React + ❤️

</div>
