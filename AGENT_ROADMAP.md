# CodeWhale 工程级 Agent 落地路线图

> 对标 OpenAI Codex++，适配 DeepSeek V4 原生能力，遵循底层通信规范与 Diff 协议。
> 本文档按 **P0 核心刚需 → P1 赋能增强 → P2 视觉打磨** 划分，每项含功能逻辑、底层适配、界面联动、风险、开发顺序。

---

## 一、现状基线（已具备能力）

| 层 | 已有能力 | 文件位置 |
|---|---|---|
| 后端 | DeepSeek 流式 SSE（content + reasoning 双流）、system_prompt 注入、session 持久化 | `src/deepseek.rs` `src/routes/chat.rs` |
| 后端 | 文件读写 / Git / Shell 工具，已含 `ensure_within` 越界校验 | `src/tools.rs` `src/routes/tools.rs` |
| 后端 | Diff 注册表（按文件粒度，apply/reject/revert） | `src/routes/diffs.rs` |
| 后端 | DeepSeek 原生参数：reasoning_effort / cache_enabled / context_length | `src/config.rs` `src/routes/params.rs` |
| 前端 | 三栏布局（SideNav 240px \| Chat \| RightPanel 多 Tab）、Mica 透明窗口 | `frontend/src/App.tsx` `WorkArea.tsx` |
| 前端 | 右侧多 Tab（变更 / 代办 / GitHub 占位）、代码块应用修改 | `RightPanel.tsx` `MarkdownLite.tsx` |
| 前端 | 会话列表（圆润苹果风）、设置页（卡片式 + ParamsPanel 嵌入） | `SideNav.tsx` `SettingsPage.tsx` |

---

## 二、P0 核心刚需（兼容底层、释放 DeepSeek 能力、安全基线）

### P0-1 Agent 系统提示固化

**功能逻辑**
将《角色定义》规范固化为后端默认 system prompt，所有对话首轮自动注入，约束 Agent 输出带文件路径的增量代码、走 Diff 协议、不直接执行系统调用。用户自定义 system_prompt 优先级高于默认。

**底层适配**
- `src/deepseek.rs`：新增 `DEFAULT_AGENT_SYSTEM_PROMPT` 常量，封装规范全文（代码块头部路径标注、增量修改、工作区上下文、权限约束、输出流程）。
- `src/routes/chat.rs`：`start_chat` 中若 `req.system_prompt` 为空，则注入 `DEFAULT_AGENT_SYSTEM_PROMPT`；非空则拼接默认提示 + 用户自定义。
- `src/config.rs`：新增 `agent_system_prompt` 配置项（config.toml），允许覆盖默认。

**界面联动**
无独立界面，影响所有对话行为。底部状态条已有 effort/ctx/cache 显示，无需改动。

**风险**
- 默认 prompt 过长会占用上下文窗口：建议控制在 800 token 以内，聚焦强制约束。
- DeepSeek 不同模型对 system prompt 遵从度差异：需 A/B 测试 deepseek-chat vs deepseek-reasoner。

**开发顺序**：① 写定 prompt 常量 → ② chat.rs 注入逻辑 → ③ config.toml 暴露覆盖项 → ④ 实测对话输出规范性。

---

### P0-2 代码块路径绑定 + Diff 生成闭环

**功能逻辑**
Agent 输出的代码块**必须头部标注完整文件路径**（` ```lang:path/to/file `），前端解析后自动注册到右侧「变更」面板生成 Diff，支持单条/整块选择性应用，每条变更溯源至对应对话消息。

**底层适配**
- 前端 `MarkdownLite.tsx`：已支持 ```lang:path 语法解析。需增强：解析后自动调用 `useDiffStore.register`，无需用户手动点「应用修改」（保留手动应用按钮作为兜底）。
- `src/routes/diffs.rs`：`register` 接口增加 `sourceMessageId` 字段，绑定来源消息，支持回滚指引。
- Diff 数据模型从「文件粒度」升级为「hunk 粒度」：`DiffEntry` 增加 `hunks: Vec<Hunk>`，每个 hunk 独立 apply/reject。

**界面联动**
- 右侧「变更」Tab：每条 Diff 展开为多 hunk 行，每行独立 ✓/✗ 按钮。
- Diff 详情头部显示「来源：会话 s1 · 消息 #3」，点击跳转对话定位。
- 应用全部按钮保留，新增「应用此文件」「应用此 hunk」二级操作。

**风险**
- hunk 级数据模型迁移：需向后兼容已存储的文件级 Diff，建议 `hunks` 字段可选，空则按整文件处理。
- 自动注册可能产生噪声 Diff：建议加「预览模式」开关，默认手动确认。

**开发顺序**：① diffs.rs 增加 sourceMessageId → ② DiffEntry 升级 hunks → ③ 前端自动注册 + hunk 级 UI → ④ 溯源跳转。

---

### P0-3 增量 Diff 逐块接受/拒绝

**功能逻辑**
拒绝整文件覆盖，按 hunk 粒度操作；拒绝则本地零变更（借鉴 Codex++「丢掉则本地不变」）。支持并排/上下单行视图切换、变更历史溯源。

**底层适配**
- `src/lib/diff.rs`（新增）：基于 Myers 算法生成 hunk 列表，每 hunk 含 `{oldStart, oldLines, newStart, newLines, content}`。
- `src/routes/diffs.rs`：新增 `POST /api/diffs/:id/hunks/:idx/apply` 与 `reject` 接口；`applyAll` 改为遍历选中 hunk。
- `DiffViewer.tsx`：增加 `viewMode: 'split' | 'inline'` prop，并排/单行切换。

**界面联动**
- Diff 详情顶部增加视图切换 toggle（⇆ 并排 / ⇅ 单行）。
- 每个 hunk 行：左侧绿/红背景标识增删，右侧 ✓ 应用 / ✗ 拒绝按钮。
- 历史区显示已拒绝/已回滚 hunk，灰显。

**风险**
- 部分 hunk 应用可能导致文件不一致：需在 apply 前校验 hunk 上下文是否仍匹配（SHA 校验）。
- 并排视图在窄面板下可读性差：右栏最小宽度建议 360px。

**开发顺序**：① diff.rs Myers 实现 → ② hunk 级 API → ③ DiffViewer 视图切换 → ④ 一致性校验。

---

### P0-4 工作区上下文自动识别

**功能逻辑**
自动识别激活工作目录，过滤 `node_modules`/`build`/`target`/`.git` 等忽略目录；依托客户端本地文件读取接口获取源码，不绕过客户端直接读写磁盘。

**底层适配**
- `src/config.rs`：新增 `IGNORED_DIRS` 常量与 `.codewhaleignore` 文件解析（兼容 `.gitignore`）。
- `src/routes/files.rs`：文件树遍历已存在，增加忽略目录过滤。
- `src/tools.rs`：`read_file`/`write_file` 已有 `ensure_within`，增加 `ensure_not_ignored` 校验。

**界面联动**
- 左侧文件树面板：忽略目录不展示（或灰显折叠）。
- @文件挂载选择器：仅展示可读文件。

**风险**
- 大型项目文件树加载慢：需异步分页加载 + 缓存。
- `.codewhaleignore` 与 `.gitignore` 冲突：优先级 gitignore > codewhaleignore > 默认。

**开发顺序**：① IGNORED_DIRS 常量 → ② files.rs 过滤 → ③ codewhaleignore 解析 → ④ 文件树性能优化。

---

### P0-5 斜杠指令菜单

**功能逻辑**
输入框 `/` 唤起浮层菜单：`/refactor /test /fix /explain /docs /task /commit`。选中后注入对应指令模板到消息，后端识别指令并调整 system prompt 或工具调用策略。

**底层适配**
- 前端 `ChatPanel.tsx`：输入框监听 `/` 字符，渲染 `SlashMenu` popover；指令定义表 `frontend/src/lib/slashCommands.ts`。
- `src/routes/chat.rs`：解析消息首部 `/command`，路由到对应处理器（如 `/commit` → 调用 git diff 生成 commit 消息）。
- 每条指令对应一个 system prompt 片段，叠加到默认 Agent prompt 之上。

**界面联动**
- 输入框上方 popover：指令列表 + 描述 + 快捷键提示。
- 选中指令后输入框显示 `/refactor ` 前缀，光标定位参数位。

**风险**
- 指令与普通对话混用：需明确 `/` 仅在行首触发。
- 自定义指令扩展：预留 `frontend/src/lib/slashCommands.ts` 数组，后续支持插件注入。

**开发顺序**：① 指令定义表 → ② SlashMenu 组件 → ③ chat.rs 指令路由 → ④ /commit /task 等高价值指令实现。

---

### P0-6 @文件挂载

**功能逻辑**
输入框 `@` 唤起文件选择器，挂载源码到上下文；对话顶部展示已挂载文件标签，支持手动增删。

**底层适配**
- 前端 `ChatPanel.tsx`：监听 `@`，渲染 `FilePickerPopover`（基于文件树 store）。
- `frontend/src/stores/chat.ts`：新增 `attachedFiles: string[]`，发送时拼接到消息体或单独字段。
- `src/routes/chat.rs`：`ChatRequestBody` 增加 `attached_files: Vec<String>`，后端读取文件内容注入到 user message 前部（带路径标注）。

**界面联动**
- 对话顶部（消息流上方）：文件标签 chip 行，每个 chip 显示文件名 + ✕ 删除。
- @唤起时 popover 展示最近挂载 + 搜索框 + 文件树。

**风险**
- 大文件挂载撑爆上下文：单文件限制 50KB，超限提示截断。
- 二进制文件：过滤非文本文件，仅允许挂载文本类。

**开发顺序**：① FilePickerPopover → ② chat store attachedFiles → ③ chat.rs 注入逻辑 → ④ 大小限制 + 截断提示。

---

### P0-7 代办任务自动推送

**功能逻辑**
收到大型复杂需求，Agent 主动拆分为颗粒化可验收子任务，推送至代办面板；任务绑定来源会话，支持 待处理/进行中/已完成 三态；代码实现完成后主动提示勾选。

**底层适配**
- `src/routes/todos.rs`（新增）：CRUD 接口 `GET/POST/PUT/DELETE /api/todos`，数据模型 `{id, sessionId, text, status, source, createdAt}`。
- `src/state.rs`：新增 `TodoStore`（内存 + 持久化到 TiDB 或本地 sqlite）。
- Agent system prompt 增加：「复杂需求先输出 `<todo>` 标签块，每行一个子任务」，后端解析后写入 TodoStore。
- SSE 新增事件 `event: todo` 推送新增代办。

**界面联动**
- 右侧「代办」Tab：任务列表（已有 mock），对接真实 API；完成时代办点变灰。
- 对话中代办创建处显示「已加入代办」内联提示。
- 任务勾选后，对话对应消息显示 ✓ 完成标记。

**风险**
- 任务拆解质量依赖模型：DeepSeek 对复杂需求拆解能力需验证，可能产生过细/过粗任务。
- 任务与代码变更绑定：建议任务关联 DiffEntry，完成时校验是否已应用。

**开发顺序**：① todos.rs 数据模型 + API → ② TodoStore → ③ system prompt 增加拆解指令 + SSE 推送 → ④ 前端代办 Tab 对接 → ⑤ 任务-Diff 关联。

---

### P0-8 三级权限沙盒 + 审批弹窗

**功能逻辑**
三级权限：【仅读取工作区 / 读写文件 / 允许 Shell 执行】，deny > write > read 优先级；Agent 发起文件变更/终端命令时弹出可视化审批弹窗，展示将要执行的文件/命令清单，可逐项批准/拒绝/批准全部。

**底层适配**
- `src/config.rs`：新增 `PermissionLevel { ReadOnly, WorkspaceWrite, FullAccess }`，存 config.toml。
- `src/routes/tools.rs`：所有写操作/Shell 前插入权限检查中间件；`WorkspaceWrite` 拒绝 Shell，`ReadOnly` 拒绝所有写。
- `src/routes/approvals.rs`（新增）：`POST /api/approvals/request`（Agent 提交操作清单）→ `POST /api/approvals/:id/decide`（用户批准/拒绝）。
- SSE 新增 `event: approval_request` 推送审批弹窗。

**界面联动**
- 全局 `ApprovalDialog`（DialogHost 内）：左 diff 预览 / 右命令文本，底部「拒绝 / 批准此项 / 批准全部」。
- 设置页新增「权限安全」卡片：三段式开关（绿/黄/红），高危项风险文案 + 二次确认。

**风险**
- 权限检查性能：每次工具调用前查权限，建议内存缓存当前等级。
- FullAccess 模式误操作：强制二次确认 + 操作日志可回溯（写入 `~/.codewhale/audit.log`）。
- 审批阻塞流式：Agent 等待审批时 SSE 保持连接，超时（5min）自动拒绝。

**开发顺序**：① PermissionLevel 配置 → ② tools.rs 权限中间件 → ③ approvals.rs API + SSE → ④ ApprovalDialog → ⑤ 设置页权限卡片 → ⑥ 审计日志。

---

## 三、P1 赋能增强（借鉴主流 Agent 特性）

### P1-1 GitHub 面板（借鉴 Aider Git 集成）

**功能逻辑**
读取仓库本地 Git 状态，生成规范语义化 commit 信息；解析 Issue/PR，输出代码评审意见；根据 issue 编号生成修复方案，提供分支创建/合并建议。

**底层适配**
- `src/routes/github.rs`（新增）：`GET /api/git/status` `GET /api/git/diff` `POST /api/git/commit` `GET /api/github/issues`（需 OAuth token 配置）。
- `src/tools.rs`：git 命令封装已有，扩展 `git_status` `git_log` `git_diff_staged`。
- Agent system prompt 增加 commit 消息生成指令（Conventional Commits 规范）。

**界面联动**
- 右侧「GitHub」Tab（已有占位）：对接真实数据；PR/Issue 列表 + 状态徽标。
- 顶部「连接 GitHub」按钮 → OAuth 授权流程。

**风险**
- GitHub OAuth 需后端服务，Serverless 场景下建议用 PAT（Personal Access Token）配置替代。
- 私有仓库权限：需最小化 token scope（repo:read）。

**开发顺序**：① git status/diff API → ② commit 消息生成 → ③ GitHub PAT 配置 → ④ Issue/PR 拉取 → ⑤ 评审意见输出。

---

### P1-2 代码 RAG 检索

**功能逻辑**
自动项目索引，优先召回相关源码片段，控制上下文长度避免窗口溢出。

**底层适配**
- `src/rag/`（新增模块）：项目索引器（walk dir + chunk + embed），嵌入模型走 DeepSeek embedding API 或本地 all-MiniLM。
- 向量存储：本地 `sqlite-vss`（与「全状态入 TiDB」约束冲突，建议 RAG 索引存本地 sqlite，元数据入 TiDB）。
- `src/routes/chat.rs`：user message 发送前，先 RAG 检索 top-K 片段注入上下文。

**界面联动**
- 对话顶部显示「已召回 N 个相关片段」chip，点击展开片段列表。
- 设置页「模型参数」增加 RAG 开关 + top-K 配置。

**风险**
- 索引构建成本：大型项目首次索引慢，需后台任务 + 进度条。
- 向量存储选型：TiDB Serverless 不支持向量检索，本地 sqlite-vss 与 Serverless 部署冲突，需权衡。

**开发顺序**：① 索引器 + chunk 策略 → ② embedding 集成 → ③ sqlite-vss 存储 → ④ 检索注入 → ⑤ 索引增量更新。

---

### P1-3 多对话标签并行

**功能逻辑**
支持多对话标签，并行运行多个开发任务，Ctrl+T 新建。

**底层适配**
- `frontend/src/stores/chat.ts`：从单 session 改为 `sessions: Map<id, ChatSession>`，每标签独立 SSE 流。
- `src/routes/chat.rs`：session 已支持多会话，无需改动；并发限流由 DeepSeek API 处理。

**界面联动**
- ChatPanel 上方 Tab 栏：会话标签 + ✕ 关闭 + ＋ 新建。
- 标签右键菜单：关闭其他 / 关闭右侧 / 重命名。

**风险**
- 多 SSE 并发内存：每流独立 buffer，需限制最大并发数（建议 5）。
- 标签状态丢失：刷新后恢复，需持久化打开的标签列表。

**开发顺序**：① chat store 多 session 化 → ② Tab 栏 UI → ③ 标签持久化 → ④ 并发限流。

---

### P1-4 多模型卡片管理

**功能逻辑**
由单一模型下拉升级为多模型卡片管理，支持保存多组 API 地址/密钥，快速切换不同服务商模型。

**底层适配**
- `src/config.rs`：`DeepSeekConfig` 改为 `ModelProfile { id, name, baseUrl, apiKey, model }`，`Vec<ModelProfile>`。
- `src/routes/config_api.rs`：增加 `GET/POST/PUT/DELETE /api/profiles`。
- config.toml 增加 `[[profiles]]` 数组。

**界面联动**
- 设置页「模型&API」改为卡片列表：每张卡片含名称/baseUrl/模型/密钥（掩码）/编辑/删除/设为默认。
- 底部状态条模型名点击 → 快速切换 popover。

**风险**
- 密钥存储安全：DPAPI 加密（Windows）/ 明文（其他平台），需风险提示。
- 切换模型时正在进行的会话：建议仅影响下一轮，当前流不中断。

**开发顺序**：① ModelProfile 数据模型 → ② profiles API → ③ 设置页卡片 UI → ④ 状态条快速切换 → ⑤ DPAPI 加密。

---

### P1-5 代码块 hover 工具栏 + 消息操作

**功能逻辑**
代码块悬浮工具栏（复制、运行、单独提问、应用修改）；单条消息支持重试、删除、折叠。

**底层适配**
- `MarkdownLite.tsx`：代码块 hover 显示工具栏，「运行」调用 tools.rs shell 执行（走权限审批）。
- `src/routes/chat.ts`：新增 `POST /api/sessions/:id/messages/:idx/retry`（重新生成指定消息）。
- `src/session.rs`：消息删除/折叠标记持久化。

**界面联动**
- 代码块右上角浮起工具栏（hover 显示）。
- 消息 hover 显示右侧操作按钮（重试 ↻ / 删除 🗑 / 折叠 ▾）。

**风险**
- 重试消息需截断后续历史：删除原消息及其后所有消息，重新生成。
- 代码运行安全：必须走权限审批，禁止 FullAccess 外自动执行。

**开发顺序**：① 代码块工具栏 → ② 消息重试 API → ③ 消息删除/折叠 → ④ 运行按钮接审批。

---

### P1-6 代码沙箱执行闭环

**功能逻辑**
输出可运行代码、捕获报错，基于异常堆栈自动迭代修复。

**底层适配**
- `src/routes/sandbox.rs`（新增）：`POST /api/sandbox/run`，执行代码（走权限），捕获 stdout/stderr/exit_code。
- 多语言支持：Rust（cargo script）/ Go（go run）/ Python（python3）/ TS（tsx）/ Shell。
- Agent system prompt 增加：「运行报错时，自动分析堆栈，输出修复 Diff」。

**界面联动**
- 底部终端面板（P2）展示运行输出。
- 报错时对话自动追加「检测到错误，正在生成修复方案」消息。

**风险**
- 沙箱安全：Windows 下 PowerShell 沙盒能力弱，建议 Docker 容器化（与 Serverless 冲突，权衡）。
- 资源限制：CPU/内存/超时需硬限制。

**开发顺序**：① sandbox.rs 执行器 → ② 多语言 runner → ③ 报错自动修复 prompt → ④ 资源限制。

---

### P1-7 插件系统入口

**功能逻辑**
识别插件指令，调用客户端插件系统拓展 Lint、格式化、第三方工具能力。

**底层适配**
- `src/plugins/`（新增）：插件清单 `plugins.toml`，每插件定义 `{id, name, command, type}`。
- `src/routes/tools.rs`：扩展工具协议，支持动态注册插件命令。
- 前端 `SideNav.tsx`：「插件」入口已占位，对接插件管理页。

**界面联动**
- 设置页「插件」卡片：启用/禁用/配置。
- 斜杠指令菜单支持插件注入的 `/plugin:xxx` 指令。

**风险**
- 插件安全：第三方插件命令执行需审批。
- 协议设计：需抽象工具协议层，避免硬编码每家服务商。

**开发顺序**：① 插件清单格式 → ② 工具协议抽象 → ③ 插件管理 UI → ④ 示例插件（prettier/eslint）。

---

## 四、P2 长期 UI / 体验打磨

### P2-1 内置终端面板
底部可折叠终端，`Cmd+J` 切换，打通「编码→执行→报错修复」闭环。需 `portable-pty` 或 Tauri shell 扩展，Windows conpty 兼容性测试。

### P2-2 设置页重构
全局侧边常驻导航 + 右侧抽屉式面板（不覆盖主对话）；顶部配置搜索框；卡片式分组；所有配置项附带 Tooltip；配置导入导出/重置。

### P2-3 主题自定义
亮/暗/跟随系统；强调色、背景色、前景色可自定义；代码高亮主题配置；主题可分享（社区冷启动抓手）。

### P2-4 多语言格式化
读取项目配置（rustfmt/goimports/prettier/black）自动格式化 Agent 输出代码。

### P2-5 平滑过渡动效
面板切换、消息载入、Tab 切换动效统一；加载/空/错误状态页规范化。

### P2-6 IDE 联动预留
未来对接 Neovim/VS Code，缓冲区代码互通（LSP 协议预留）。

### P2-7 快捷键完整配置页
全局快捷键体系（Cmd+K 命令面板 / Cmd+J 终端 / Cmd+, 设置 / Ctrl+T 新建标签），设置页可自定义。

---

## 五、开发先后顺序（建议执行路径）

```
第一迭代（P0 安全 + 闭环基线，2-3 周）
  P0-1 Agent 系统提示固化   ← 一切基础，最先做
  P0-8 三级权限 + 审批弹窗   ← 安全基线，与 P0-1 同步
  P0-2 代码块路径绑定闭环   ← 依赖 P0-1 的输出规范
  P0-3 增量 Diff 逐块       ← 依赖 P0-2 的数据模型
  P0-7 代办自动推送         ← 依赖 P0-1 的拆解指令

第二迭代（P0 交互基线，1-2 周）
  P0-5 斜杠指令菜单
  P0-6 @文件挂载
  P0-4 工作区上下文过滤

第三迭代（P1 高价值赋能，3-4 周）
  P1-1 GitHub 面板          ← Git 集成价值高
  P1-4 多模型卡片管理       ← 多服务商需求普遍
  P1-5 代码块工具栏 + 消息操作
  P1-3 多对话标签并行

第四迭代（P1 深度能力，4-6 周）
  P1-2 代码 RAG 检索        ← 索引成本高，需评估
  P1-6 代码沙箱闭环         ← 安全复杂度高
  P1-7 插件系统             ← 协议设计先行

第五迭代（P2 视觉打磨，滚动推进）
  P2-2 设置页重构 → P2-1 内置终端 → P2-7 快捷键 → 其余
```

---

## 六、潜在技术与设计风险（全局）

| 风险 | 影响 | 缓解 |
|---|---|---|
| DeepSeek 并发限流 | 多标签/沙箱并行触发 429 | 客户端请求队列 + 指数退避 |
| TiDB Serverless 不支持向量检索 | RAG 索引无处存放 | 本地 sqlite-vss，元数据入 TiDB |
| Windows 沙箱能力弱 | 沙箱执行不安全 | Docker 容器化或 conpty + 权限白名单 |
| hunk 级 Diff 一致性 | 部分 apply 导致文件损坏 | apply 前 SHA 校验上下文 |
| MCP 生态碎片化 | 插件协议难统一 | 抽象 ToolProvider trait，按类型分发 |
| FullAccess 误操作 | 系统文件损坏 | 强制二次确认 + 审计日志 + 操作回滚 |
| system prompt 占用上下文 | 有效窗口缩小 | prompt 控制在 800 token 内，支持精简模式 |
| Mica 与抽屉式设置 z-index | 视觉层级冲突 | 抽屉复用 work-surface 板块，DialogHost 顶层 |

---

## 七、验收标准（每项 P0 完成后需通过）

1. **P0-1**：任意对话，Agent 输出代码块均带文件路径，无路径时弹提示。
2. **P0-2**：代码块输出后 5 秒内右侧变更 Tab 出现对应条目，溯源可跳转。
3. **P0-3**：多 hunk Diff 可独立 apply/reject，拒绝后本地无变更，SHA 校验生效。
4. **P0-4**：文件树不展示 node_modules 等，`.codewhaleignore` 生效。
5. **P0-5**：输入 `/` 弹出菜单，`/commit` 能生成 Conventional Commit 消息。
6. **P0-6**：`@` 唤起文件选择，挂载后对话顶部显示 chip，发送时上下文含文件内容。
7. **P0-7**：复杂需求输出 `<todo>` 块后，代办 Tab 自动出现任务，可勾选。
8. **P0-8**：Agent 发起写操作时弹出审批弹窗，ReadOnly 模式下所有写被拒，审计日志可查。
