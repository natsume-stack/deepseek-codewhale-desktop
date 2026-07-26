# CodeWhale Server · HTTP API 文档

独立 Rust 后端服务，封装 DeepSeek 调用、会话管理与本地工具执行，对 Tauri + React 桌面端提供 REST + SSE 接口。

- **Base URL**: `http://127.0.0.1:8787`
- **Content-Type**: `application/json`（除 `/api/chat` 为 `text/event-stream`）
- **鉴权**: 本地服务，暂无鉴权；如需暴露公网请自行加反向代理 + Token。
- **错误格式**: `{"error": <http_code>, "message": "<描述>"}`

---

## 1. 健康检测

### `GET /ping`
返回服务存活状态与配置就绪情况。

**响应**
```json
{
  "status": "ok",
  "service": "codewhale-server",
  "version": "0.1.0",
  "deepseekConfigured": true,
  "projectLoaded": true,
  "projectRoot": "C:\\code\\my-app",
  "timestamp": "2026-07-25T08:00:00+00:00"
}
```
> 别名 `GET /health` 等价。桌面端启动时轮询此接口判断后端是否在线。

---

## 2. 对话（SSE 流式）

### `POST /api/chat`
发起一轮对话。响应为 Server-Sent Events 流。

**请求**
```json
{
  "message": "用 Rust 写一个快速排序并解释",
  "sessionId": "0c1f...（可选，缺省则新建会话）",
  "systemPrompt": "你是一名资深 Rust 工程师（可选）",
  "maxTokens": 4096,
  "temperature": 0.7,
  "reasoningEffort": "medium",
  "cacheEnabled": true,
  "contextLength": 20
}
```
| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| message | string | 是 | 用户本轮输入 |
| sessionId | string | 否 | 复用会话；为空则新建 |
| systemPrompt | string | 否 | 注入到历史首部的 system 消息 |
| maxTokens | int | 否 | 单轮最大输出 token |
| temperature | float | 否 | 采样温度 |
| reasoningEffort | `minimal`\|`low`\|`medium`\|`high` | 否 | 覆盖推理强度（透传 DeepSeek） |
| cacheEnabled | bool | 否 | 覆盖缓存开关 |
| contextLength | int | 否 | 覆盖历史消息裁剪条数 |

**响应（SSE 事件流）**
```
event: session
data: {"sessionId":"0c1f3a2b-..."}

event: reasoning
data: {"content":"先考虑分治..."}

event: delta
data: {"content":"fn quicksort"}

event: delta
data: {"content":"(arr: &mut [i32])"}

event: finish
data: {"finishReason":"stop"}

event: done
data: {"sessionId":"0c1f3a2b-..."}
```
| event | data | 说明 |
|---|---|---|
| `session` | `{"sessionId"}` | 流起始，返回会话 ID |
| `delta` | `{"content"}` | 正文增量 |
| `reasoning` | `{"content"}` | 推理增量（仅 deepseek-reasoner） |
| `finish` | `{"finishReason"}` | DeepSeek 通知本轮结束 |
| `error` | `{"message"}` | 流内错误（Key 失效、上游 5xx 等） |
| `done` | `{"sessionId"}` | 流终止，assistant 内容已落地 |

> 客户端断连后，后台任务会取消 DeepSeek 流并复位会话状态，不会卡死。

### `POST /api/chat/stop`
中断指定会话当前正在进行的推理。

**请求**
```json
{ "sessionId": "0c1f3a2b-..." }
```
**响应**
```json
{ "sessionId": "0c1f3a2b-...", "aborted": true }
```
`aborted=false` 表示当前无运行中的任务。

---

## 3. 会话管理

### `GET /api/sessions`
列出全部会话（按创建时间倒序）。

**响应**
```json
{
  "sessions": [
    {
      "id": "0c1f3a2b-...",
      "messages": [
        { "role": "user", "content": "你好" },
        { "role": "assistant", "content": "你好！有什么可以帮你？" }
      ],
      "projectRoot": "C:\\code\\my-app",
      "createdAt": "2026-07-25T08:00:00+00:00",
      "updatedAt": "2026-07-25T08:05:00+00:00",
      "running": false
    }
  ],
  "count": 1
}
```

### `POST /api/sessions`
新建空会话（若已加载项目目录，自动绑定）。

**响应**: 同上单个 session 对象。

### `GET /api/sessions/{id}`
获取单个会话详情。`404` 时返回 `{"error":400,"message":"会话不存在: ..."}`。

### `DELETE /api/sessions/{id}`
删除会话。
```json
{ "sessionId": "0c1f3a2b-...", "deleted": true }
```

### `POST /api/sessions/{id}/reset`
重置上下文：清空消息历史，保留会话 ID 与项目根。
```json
{ "sessionId": "0c1f3a2b-...", "reset": true }
```

---

## 4. 推理参数动态配置

### `GET /api/params`
获取当前推理默认参数。
```json
{
  "reasoningEffort": "medium",
  "cacheEnabled": true,
  "contextLength": 20
}
```

### `PUT /api/params`
更新参数（任意子集，写入后落盘）。
```json
{ "reasoningEffort": "high", "contextLength": 30 }
```
**响应**: 更新后的完整对象（同 GET）。`contextLength=0` 返回 400。

---

## 5. 本地项目目录

### `POST /api/project/load`
加载本地项目目录（后续工具调用均限制在该目录内）。
```json
{ "path": "C:\\Users\\Natsume\\Desktop\\my-app" }
```
**响应**
```json
{ "path": "C:\\Users\\Natsume\\Desktop\\my-app", "loaded": true }
```

### `GET /api/project`
```json
{ "path": "C:\\Users\\Natsume\\Desktop\\my-app", "loaded": true }
```
未加载时 `{"path":null,"loaded":false}`。

---

## 6. 内置工具

> 所有工具端点均要求先 `POST /api/project/load`，否则返回 400。
> 路径参数均相对于项目根；越界访问返回 400。

### `POST /api/tools/file/read`
```json
{ "path": "src/main.rs" }
```
**响应**
```json
{
  "path": "src/main.rs",
  "content": "fn main() { ... }",
  "bytes": 128
}
```

### `POST /api/tools/file/write`
```json
{
  "path": "src/lib.rs",
  "content": "pub fn add(a: i32, b: i32) -> i32 { a + b }",
  "createDirs": true
}
```
**响应**
```json
{ "path": "src/lib.rs", "bytes": 48, "created": true }
```

### `POST /api/tools/git`
```json
{ "args": ["status", "--short"] }
```
**响应**
```json
{
  "exitCode": 0,
  "stdout": " M src/main.rs\n",
  "stderr": "",
  "success": true
}
```

### `POST /api/tools/shell`
跨平台：Windows 走 `cmd /C`，Unix 走 `sh -c`。工作目录为项目根。
```json
{ "command": "cargo build --release", "timeoutSecs": 120 }
```
**响应**
```json
{
  "exitCode": 0,
  "stdout": "...",
  "stderr": "",
  "success": true
}
```
超时返回 422 `{"error":422,"message":"工具执行失败: cmd 执行超时 (>120s)"}`。

---

## 7. DeepSeek 配置（API Key 持久化）

### `GET /api/config/deepseek`
```json
{
  "configured": true,
  "apiKeyMasked": "sk-************************abcd",
  "baseUrl": "https://api.deepseek.com/v1",
  "model": "deepseek-chat"
}
```

### `PUT /api/config/deepseek`
写入后立即落盘到 `~/.codewhale-server/config.toml`。任意子集即可。
```json
{ "apiKey": "sk-xxxxxxxxxxxxxxxx", "model": "deepseek-chat" }
```
**响应**: 同 GET（`configured=true`，返回脱敏 Key）。

### `POST /api/config/deepseek/test`
用当前 Key 探测 DeepSeek（`GET {baseUrl}/models`）。
```json
{ "ok": true, "model": "deepseek-chat", "baseUrl": "https://api.deepseek.com/v1" }
```
失败返回 502 `{"error":502,"message":"DeepSeek API 错误: 401 {...}"}`。

---

## 端点速查

### 基础端点

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/ping` | 健康检测 |
| POST | `/api/chat` | 发起对话（SSE） |
| POST | `/api/chat/stop` | 中断对话 |
| GET / POST | `/api/sessions` | 列表 / 新建 |
| GET / DELETE | `/api/sessions/{id}` | 详情 / 删除 |
| POST | `/api/sessions/{id}/reset` | 重置上下文 |
| GET / PUT | `/api/params` | 读取 / 更新推理参数 |
| POST | `/api/project/load` | 加载项目目录 |
| GET | `/api/project` | 查询项目目录 |
| GET | `/api/project/tree` | 获取文件树 |
| POST | `/api/tools/file/read` | 读文件 |
| POST | `/api/tools/file/write` | 写文件 |
| POST | `/api/tools/git` | Git 命令 |
| POST | `/api/tools/shell` | Shell 命令 |
| GET / PUT | `/api/config/deepseek` | 读取 / 写入 Key |
| POST | `/api/config/deepseek/test` | 探测 Key 有效性 |

### 文件系统

| 方法 | 路径 | 用途 |
|---|---|---|
| POST | `/api/files` | 创建文件 |
| POST | `/api/files/read` | 读取文件 |
| POST | `/api/files/write` | 写入文件 |
| PATCH | `/api/files/rename` | 重命名文件 |
| POST | `/api/files/reveal` | 在资源管理器显示 |
| DELETE | `/api/files` | 删除文件 |

### Diff 管理

| 方法 | 路径 | 用途 |
|---|---|---|
| POST | `/api/diffs` | 注册 Diff |
| POST | `/api/diffs/apply-all` | 应用全部 Diff |
| POST | `/api/diffs/:id/apply` | 应用单个 Diff |
| POST | `/api/diffs/:id/reject` | 拒绝单个 Diff |
| POST | `/api/diffs/:id/revert` | 还原单个 Diff |
| POST | `/api/diffs/:id/hunks/:hunk_index/apply` | 应用单个 Hunk |
| POST | `/api/diffs/:id/hunks/:hunk_index/reject` | 拒绝单个 Hunk |
| GET | `/api/diffs/:session_id` | 列出会话 Diff |

### 代办任务

| 方法 | 路径 | 用途 |
|---|---|---|
| GET / POST | `/api/todos` | 列表 / 创建 |
| GET / DELETE | `/api/todos/:id` | 详情 / 删除 |
| POST | `/api/todos/:id/status` | 更新状态 |
| GET | `/api/todos/session/:session_id` | 列出会话代办 |

### 审批

| 方法 | 路径 | 用途 |
|---|---|---|
| GET / POST | `/api/approvals` | 列表 / 创建 |
| GET | `/api/approvals/pending` | 列出待审批 |
| GET | `/api/approvals/:id` | 获取详情 |
| POST | `/api/approvals/:id/decide` | 批准/拒绝 |

### 配置（完整）

| 方法 | 路径 | 用途 |
|---|---|---|
| GET / PUT | `/api/config/permission` | 权限配置 |
| GET / PUT | `/api/config/model-profiles` | 多模型档案 |
| POST | `/api/config/profiles` | 添加 Profile |
| PUT / DELETE | `/api/config/profiles/:id` | 更新/删除 Profile |
| POST | `/api/config/profiles/:id/active` | 设为激活 |
| GET / PUT | `/api/config/rag` | RAG 配置 |
| GET / PUT | `/api/config/formatter` | 格式化配置 |
| GET / PUT | `/api/config/cache` | 缓存配置 |
| POST | `/api/config/cache/clear-session` | 清除会话缓存 |
| POST | `/api/config/cache/clear-memory` | 清除项目记忆 |
| GET | `/api/config/cache/stats` | 缓存统计 |
| GET / PUT | `/api/config/appearance` | 外观配置 |
| GET / PUT / POST | `/api/config/shortcuts` | 快捷键 |
| GET / PUT | `/api/config/security` | 安全配置 |
| GET | `/api/config/security/export-audit` | 导出审计日志 |
| GET | `/api/model-profiles` | 模型档案列表 |

### Skill 技能

| 方法 | 路径 | 用途 |
|---|---|---|
| GET / POST | `/api/skills` | 列表 / 创建 |
| GET / DELETE | `/api/skills/:id` | 详情 / 删除 |
| PUT | `/api/skills/:id/toggle` | 切换启用/禁用 |
| PUT | `/api/skills/:id/enabled` | 设置启用状态 |
| POST | `/api/skills/:id/export` | 导出技能 |
| GET | `/api/skills/config` | 获取技能配置 |
| POST | `/api/skills/find` | 模糊匹配技能 |
| POST | `/api/skills/import` | 导入技能包 |
| POST | `/api/skills/default-permission` | 设置默认权限 |
| GET / PUT | `/api/skills/agents-md` | 管理 AGENTS.md |

### MCP 插件

| 方法 | 路径 | 用途 |
|---|---|---|
| GET / POST | `/api/mcp` | 列表 / 注册 |
| DELETE | `/api/mcp/:id` | 删除插件 |
| PUT | `/api/mcp/:id/toggle` | 切换启用/禁用 |
| POST | `/api/mcp/:id/enabled` | 设置启用状态 |
| POST | `/api/mcp/:id/connect` | 连接插件 |
| POST | `/api/mcp/:id/disconnect` | 断开插件 |
| GET / POST | `/api/mcp/services` | MCP 服务列表 |
| POST | `/api/mcp/global-enabled` | 全局启用开关 |
| GET / PUT | `/api/mcp/high-risk/switch` | 高危插件开关 |
| POST | `/api/mcp/call` | 调用插件工具 |

### Git/GitHub 联动

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/git/status` | Git 状态 |
| POST | `/api/git/diff` | Git Diff |
| POST | `/api/git/commit` | Git Commit |
| POST | `/api/git/branch` | Git 分支操作 |
| POST | `/api/git/pr-review` | PR 评审 |
| GET | `/api/git/log` | Git 日志 |

### RAG 检索

| 方法 | 路径 | 用途 |
|---|---|---|
| GET / POST | `/api/rag/index` | 获取/构建索引 |
| POST | `/api/rag/recall` | RAG 召回 |
| DELETE | `/api/rag/clear` | 清除索引 |

### 代码沙箱

| 方法 | 路径 | 用途 |
|---|---|---|
| POST | `/api/sandbox/exec` | 沙箱执行代码 |
| GET | `/api/sandbox/languages` | 支持的语言列表 |
| POST | `/api/sandbox/format` | 代码格式化 |

---

## 编译与启动

### 前置：安装 Rust（≥ 1.88）
```powershell
# Windows (PowerShell)
winget install Rustlang.Rustup
# 或访问 https://www.rust-lang.org/tools/install
```
```bash
# Linux / macOS
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

### 编译
```powershell
# Debug
cargo build
# Release（推荐）
cargo build --release
```

### 运行
```powershell
# 方式 1：启动脚本（Windows）
.\start.ps1              # debug 运行
.\start.ps1 -Build       # release 编译
.\start.ps1 -Release     # 运行 release 二进制
.\start.ps1 -Port 9000   # 指定端口
```
```bash
# 方式 2：启动脚本（Linux/macOS）
./start.sh               # debug 运行
./start.sh --build       # release 编译
./start.sh --release     # 运行 release 二进制
```
```powershell
# 方式 3：直接 cargo
cargo run
cargo run --release
```

### 配置
1. 复制 `.env.example` 为 `.env` 填入 Key，或
2. 启动后调用 `PUT /api/config/deepseek` 写入 Key（自动落盘 `~/.codewhale-server/config.toml`），或
3. 直接编辑 `config.example.toml` 复制到配置目录。

### 验证
```powershell
curl http://127.0.0.1:8787/ping
curl -X PUT http://127.0.0.1:8787/api/config/deepseek -H "Content-Type: application/json" -d '{\"apiKey\":\"sk-xxx\"}'
curl http://127.0.0.1:8787/api/config/deepseek
```

---

## 项目结构
```
src/
├── main.rs              # 服务入口
├── config.rs            # 配置 + Key 持久化
├── state.rs             # 共享状态
├── error.rs             # 统一错误
├── deepseek.rs          # DeepSeek 流式客户端
├── session.rs           # 会话 + 中断令牌
├── tools.rs             # 文件/Git/Shell 工具
└── routes/
    ├── mod.rs           # 路由聚合 + CORS
    ├── health.rs        # /ping
    ├── chat.rs          # 对话 SSE
    ├── session.rs       # 会话 CRUD
    ├── params.rs        # 推理参数
    ├── project.rs       # 项目目录
    ├── tools.rs         # 工具端点
    └── config_api.rs    # DeepSeek 配置
```
