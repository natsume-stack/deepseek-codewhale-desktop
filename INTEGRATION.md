# CodeWhale 模块整合说明

## 一、模块职责矩阵

| 模块 | 命名空间 | 主要文件 | 职责 | 依赖 |
| --- | --- | --- | --- | --- |
| **A 主窗口** | `CodeWhale` | `App.xaml.cs`、`MainWindow.xaml(.cs)` | 三栏布局外壳、Mica 背景、窗口尺寸持久化、控制器装配 | Storage、Services、Views |
| **B Rust 后端** | `codewhale_server` | `src/main.rs`、`src/routes/*` | DeepSeek 流式代理、会话管理、项目根加载、文件/Shell 工具 | DeepSeek API |
| **C ApiClient** | `CodeWhale.Services.Api` | `CodeWhaleApiClient.cs`、`ICodeWhaleApiClient.cs`、`SseReader.cs`、`Models/ApiModels.cs` | Rust 后端 HTTP 客户端、SSE 解析、统一异常体系 | Storage（ReasoningEffort 枚举） |
| **D 参数面板** | `CodeWhale.Views` | `ParameterPanel.xaml(.cs)` | API Key、模型、推理强度、缓存、上下文长度、会话重置 UI | Storage（AppConfig） |
| **E 文件树** | `CodeWhale.Views`、`CodeWhale.ViewModels`、`CodeWhale.Services` | `FileTreeView.xaml(.cs)`、`FileTreeViewModel.cs`、`FileExplorerService.cs`、`IFileExplorerService.cs`、`Models/FileNode.cs` | 目录选择、懒加载扫描、上下文文件管理 | Models、Storage |
| **F 对话面板** | `CodeWhale.Views`、`CodeWhale.Views.Controls` | `ChatPanel.xaml(.cs)`、`ChatInputBar.xaml(.cs)`、`MessageBubble.xaml(.cs)`、`CodeBlockView.xaml(.cs)`、`DiffPreviewView.xaml(.cs)` | 消息流渲染、流式增量、代码高亮、Diff 预览与审批 | Models |
| **G 持久化** | `CodeWhale.Storage` | `AppConfig.cs`、`AppSettings.cs` | JSON 原子写入、损坏备份、MSIX/解包双模式路径 | 无（最底层） |
| **控制器** | `CodeWhale.Services` | `ChatController.cs` | UI 事件 ↔ ApiClient 桥接、状态管理、异常归一 | Api、Views、Models、Storage |

## 二、数据契约一致性

### 2.1 持久化模型（AppSettings）↔ 后端契约

| 字段 | AppSettings 路径 | 后端对应 | 对齐方式 |
| --- | --- | --- | --- |
| API Key | `Api.ApiKey` | `PUT /api/config/deepseek { apiKey }` | ChatController 转发 |
| 后端地址 | `Api.BackendUrl` | （客户端自身） | 默认 `http://127.0.0.1:8787` |
| 模型 | `Model.Model` | `PUT /api/config/deepseek { model }` | ChatController 转发 |
| 推理强度 | `Model.ReasoningEffort` | `PUT /api/params { reasoningEffort }` | 枚举 lowercase 序列化 |
| 缓存开关 | `Model.CacheEnabled` | `PUT /api/params { cacheEnabled }` | ChatController 转发 |
| 上下文长度 | `Model.ContextLength` | `PUT /api/params { contextLength }` | ChatController 转发 |
| 上次项目目录 | `Project.LastProjectDirectory` | `POST /api/project/load { path }` | FileTreeViewModel 持久化，ChatController 同步后端 |
| 窗口尺寸 | `Window.Width/Height/IsMaximized` | — | MainWindow 关闭时保存 |
| 左栏宽度 | `Window.LeftPaneWidth` | — | MainWindow 关闭时保存 |
| 右栏宽度 | `Window.RightPaneWidth` | — | MainWindow 关闭时保存 |

### 2.2 ApiClient 请求/响应 ↔ Rust 后端接口

ApiClient 19 个方法与 Rust `src/routes/mod.rs` 路由表**一一对应**，字段命名统一 camelCase：

| ApiClient 方法 | HTTP | 路径 | 后端处理函数 |
| --- | --- | --- | --- |
| `GetHealthAsync` | GET | `/ping` | `health::ping` |
| `StreamChatAsync` | POST (SSE) | `/api/chat` | `chat::start_chat` |
| `StopChatAsync` | POST | `/api/chat/stop` | `chat::stop_chat` |
| `ListSessionsAsync` | GET | `/api/sessions` | `session::list_sessions` |
| `CreateSessionAsync` | POST | `/api/sessions` | `session::create_session` |
| `GetSessionAsync` | GET | `/api/sessions/:id` | `session::get_session` |
| `DeleteSessionAsync` | DELETE | `/api/sessions/:id` | `session::delete_session` |
| `ResetSessionAsync` | POST | `/api/sessions/:id/reset` | `session::reset_session` |
| `GetParamsAsync` | GET | `/api/params` | `params::get_params` |
| `UpdateParamsAsync` | PUT | `/api/params` | `params::update_params` |
| `LoadProjectAsync` | POST | `/api/project/load` | `project::load_project` |
| `GetProjectAsync` | GET | `/api/project` | `project::get_project` |
| `GetDeepSeekConfigAsync` | GET | `/api/config/deepseek` | `config_api::get_deepseek` |
| `SetDeepSeekConfigAsync` | PUT | `/api/config/deepseek` | `config_api::set_deepseek` |
| `TestDeepSeekAsync` | POST | `/api/config/deepseek/test` | `config_api::test_deepseek` |
| `ReadFileAsync` | POST | `/api/tools/file/read` | `tools::file_read` |
| `WriteFileAsync` | POST | `/api/tools/file/write` | `tools::file_write` |
| `RunGitAsync` | POST | `/api/tools/git` | `tools::git` |
| `RunShellAsync` | POST | `/api/tools/shell` | `tools::shell` |

SSE 事件名对齐：`session` → `delta` → `reasoning` → `finish` → `error` → `done`，
对应 `ChatStreamEvent` 子类 `SessionStreamEvent`/`DeltaStreamEvent`/`ReasoningStreamEvent`/`FinishStreamEvent`/`ErrorStreamEvent`/`DoneStreamEvent`。

## 三、事件回调拓扑

```
FileTreeView
  ├─ RootDirectoryChanged ──────► ChatController.OnRootDirectoryChanged
  │                                 └─► ApiClient.LoadProjectAsync
  ├─ FileSelected ──────────────► MainWindow (轻量提示，保留钩子)
  └─ ContextFilesChanged ───────► MainWindow (上下文计数)

ChatPanel
  ├─ MessageSendRequested ──────► ChatController.OnMessageSendRequested
  │                                 └─► ApiClient.StreamChatAsync (SSE)
  │                                       └─► ChatPanel.AppendAssistantStreamChunk (回推)
  ├─ TaskStopRequested ─────────► ChatController.OnTaskStopRequested
  │                                 └─► CancellationToken.Cancel + ApiClient.StopChatAsync
  └─ DiffApprovalRequested ─────► ChatController.OnDiffApprovalRequested
                                    └─► ApiClient.WriteFileAsync (批准时)

ParameterPanel
  ├─ BackendUrlChanged ─────────► ChatController.OnBackendUrlChanged
  │                                 └─► 重建 ApiClient + ProbeBackendAsync
  ├─ DeepSeekConfigChanged ─────► ChatController.OnDeepSeekConfigChanged
  │                                 └─► ApiClient.SetDeepSeekConfigAsync
  ├─ InferenceParamsChanged ────► ChatController.OnInferenceParamsChanged
  │                                 └─► ApiClient.UpdateParamsAsync
  ├─ TestConnectionRequested ───► ChatController.OnTestConnectionRequested
  │                                 └─► ApiClient.GetHealthAsync + TestDeepSeekAsync
  └─ ResetSessionRequested ─────► ChatController.OnResetSessionRequested
                                    └─► ApiClient.ResetSessionAsync

App.OnLaunched
  ├─► AppConfig.Load()
  ├─► new MainWindow()
  ├─► ApplyMicaBackdrop()
  └─► Controller.InitializeAsync()
        ├─► ProbeBackendAsync (更新连接状态)
        ├─► TrySyncDeepSeekConfigAsync (推送本地缓存 Key)
        └─► TrySyncInferenceParamsAsync (推送本地参数)

MainWindow.Closed
  └─► AppConfig.Save() (窗口尺寸 + 栏宽 + 全部配置)
```

## 四、约束遵循情况

| 约束 | 遵循 | 说明 |
| --- | --- | --- |
| 持久化模块 G 零 UI 引用 | ✓ | `Storage/` 仅引用 `System.IO`、`System.Text.Json`、`Windows.Storage` |
| 文件树/参数面板/对话面板仅依赖 ApiClient、AppConfig | ✓ | 三面板均不直接 HTTP 调用，不直接 IO 读写 |
| 模块间无直接硬调用，依靠事件回调解耦 | ✓ | FileTreeView/ChatPanel/ParameterPanel 仅暴露事件，由 ChatController 订阅 |
| 界面逻辑不重复实现 HTTP 请求 | ✓ | 唯一 HTTP 入口为 `CodeWhaleApiClient`，仅由 `ChatController` 调用 |
| 界面逻辑不重复实现本地 IO 读写 | ✓ | 唯一配置 IO 入口为 `AppConfig`；`FileExplorerService` 仅枚举用户项目目录（职责边界） |
| 全部代码启用可空类型 | ✓ | `<Nullable>enable</Nullable>` |
| file-scoped 命名空间 | ✓ | 项目内全部 `namespace X;` |
| 中文 XML 注释 | ✓ | 全部公共成员均有 `/// <summary>` 中文注释 |
| 无废弃调试打印 | ✓ | 无 `Debug.WriteLine`、`Console.WriteLine`、`#if DEBUG` 残留 |
