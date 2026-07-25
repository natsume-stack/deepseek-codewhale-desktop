# CodeWhale 已知风险清单与规避方案

> 本文档汇总项目当前已知风险点、影响范围、规避方案与剩余未解决项，
> 供上线评估与后续迭代参考。

---

## 一、风险等级说明

| 等级 | 含义 | 处置原则 |
| --- | --- | --- |
| 🔴 高 | 影响核心功能或数据安全 | 必须在交付前修复或提供降级路径 |
| 🟡 中 | 影响体验或部分场景不可用 | 提供规避方案，下版本优化 |
| 🟢 低 | 边界场景或潜在隐患 | 记录跟踪，按需处理 |

---

## 二、网络与后端依赖类

### R-01 🟡 后端服务未启动时前端进入「孤岛模式」

- **现象**：用户先开前端未开后端，右侧面板显示「后端未启动（127.0.0.1:8787）」，
  但左侧文件树、参数面板仍可操作，发送对话时弹出系统提示。
- **影响**：用户可正常浏览本地项目、配置参数；但所有 AI 功能不可用。
- **规避**：`ChatController.InitializeAsync` 先探测后端连通性，所有 `CodeWhaleConnectionException`
  被统一捕获并以友好提示呈现，不崩溃；用户启动后端后点击「测试连接」即可恢复。
- **代码位置**：[CodeWhale/Services/ChatController.cs](./CodeWhale/Services/ChatController.cs) `ProbeBackendAsync`

### R-02 🟡 DeepSeek API Key 无效或额度耗尽

- **现象**：发送对话时后端返回 401/403/429，前端显示「API 密钥无效或未配置」或具体业务错误。
- **影响**：当前轮次失败，会话上下文未污染。
- **规避**：`OnMessageSendRequested` 在发起前拦截空 Key；运行时 401 通过
  `CodeWhaleApiException.StatusCode` 单独给出密钥提示，引导用户更新。
- **代码位置**：[CodeWhale/Services/ChatController.cs](./CodeWhale/Services/ChatController.cs#L112) `OnMessageSendRequested`

### R-03 🟢 SSE 流式连接中途断开

- **现象**：推理过程中网络抖动或后端重启，SSE 流被截断。
- **影响**：当前 AI 回复不完整，但已完成部分已渲染。
- **规避**：`SseReader` 按行解析，遇到 EOF 自动结束枚举；`finally` 块保证 `SetRunning(false)`，
  UI 不卡死。用户可重新发送请求继续。
- **代码位置**：[CodeWhale/Services/Api/SseReader.cs](./CodeWhale/Services/Api/SseReader.cs)

### R-04 🟢 后端 long-running 任务超时

- **现象**：复杂推理超过 `CodeWhaleClientOptions.Timeout`（默认 100s）。
- **影响**：触发 `CodeWhaleTimeoutException`，当前轮次中止。
- **规避**：用户可点击「停止」主动中断；或调高 `CodeWhaleClientOptions.Timeout` 常量。
  流式接口实际不会触发整体超时（响应头立即返回，仅 body 持续推送）。

---

## 三、本地配置与持久化类

### R-05 🟡 配置文件损坏（JSON 解析失败）

- **现象**：用户手工编辑 `config.json` 出错或文件被截断。
- **影响**：原配置不可用。
- **规避**：`AppConfig.LoadInternal` 捕获 `JsonException`，将原文件重命名为
  `config.json.corrupt` 备份，回退到默认配置保证程序正常启动。
- **代码位置**：[CodeWhale/Storage/AppConfig.cs](./CodeWhale/Storage/AppConfig.cs#L108) `LoadInternal` → `TryBackupCorruptFile`

### R-06 🟡 配置目录权限不足

- **现象**：MSIX 沙箱或企业策略限制 `%LocalAppData%` 写入。
- **影响**：配置无法持久化，每次启动回退默认。
- **规避**：MSIX 模式使用 `ApplicationData.Current.LocalFolder`（沙箱内可写）；
  解包模式回退到 `%LocalAppData%\CodeWhale\`。`Save` 失败抛出由调用方静默捕获，
  不阻断 UI。
- **代码位置**：[CodeWhale/Storage/AppConfig.cs](./CodeWhale/Storage/AppConfig.cs#L170) `GetConfigDirectory`

### R-07 🟢 写入过程崩溃导致配置损坏

- **现象**：`File.WriteAllText` 过程中进程被杀。
- **影响**：原配置可能丢失。
- **规避**：`SaveInternal` 采用「临时文件 + `File.Move` 原子替换」写入，
  `config.json.tmp` 写完整后才替换 `config.json`，原文件要么完整旧版要么完整新版。
- **代码位置**：[CodeWhale/Storage/AppConfig.cs](./CodeWhale/Storage/AppConfig.cs#L129) `SaveInternal`

---

## 四、UI 与系统兼容类

### R-08 🟡 Windows 10 系统下 Mica 材质不可用

- **现象**：在 Windows 10 或系统关闭透明效果时，窗口背景为纯色。
- **影响**：仅视觉降级，功能不受影响。
- **规避**：`App.ApplyMicaBackdrop` 调用 `MicaBackdrop.IsSupported()` 检测，
  不支持时静默保持默认背景，不抛异常。
- **代码位置**：[CodeWhale/App.xaml.cs](./CodeWhale/App.xaml.cs#L56) `ApplyMicaBackdrop`

### R-09 🟢 深浅色主题切换渲染抖动

- **现象**：系统切换深浅色瞬间，控件颜色短暂不一致。
- **影响**：视觉闪烁，无功能影响。
- **规避**：所有 XAML 控件使用 `{ThemeResource ...}` 而非 `{StaticResource ...}`，
  系统主题变化时自动重画；`ThemeResource` 由 WinUI3 渲染管线保证一致性。
- **代码位置**：全部 XAML 文件均使用 `ThemeResource`

### R-10 🟢 大型仓库文件树加载卡顿

- **现象**：打开含数万文件的仓库时首次扫描耗时较长。
- **影响**：UI 短暂无响应（文件树扫描在后台线程，但首次填充 UI 会延迟）。
- **规避**：`FileExplorerService` 采用懒加载——仅扫描根目录，子目录在节点展开时按需读取。
  `FileTreeViewModel.RootNodes` 仅持有顶层节点，深层节点延迟到 `Tree_Expanding` 触发。
- **代码位置**：[CodeWhale/Services/FileExplorerService.cs](./CodeWhale/Services/FileExplorerService.cs) + [CodeWhale/Views/FileTreeView.xaml.cs](./CodeWhale/Views/FileTreeView.xaml.cs) `Tree_Expanding`

### R-11 🟢 超长对话内存占用增长

- **现象**：长时间会话累积大量消息气泡与代码块，内存缓慢增长。
- **影响**：极端长会话下窗口滚动卡顿。
- **规避**：
  - `ChatPanel` 使用 `ItemsRepeater` + 虚拟化（XAML 默认开启）
  - `MessageBubble.Render` 在流式增量时复用 `Inlines`，不重复创建控件树
  - 用户可点「重置会话」清空上下文与 UI
- **建议**：后续可引入「仅保留最近 N 条消息」自动截断策略

---

## 五、并发与状态管理类

### R-12 🟡 频繁切换项目目录导致后端状态错乱

- **现象**：用户连续点击「打开项目」选择不同目录。
- **影响**：后端 `/api/project/load` 多次调用，最后一次胜出。
- **规避**：`OnRootDirectoryChanged` 同步执行，每次调用前文件树先清空旧节点；
  后端 `state.rs` 使用 `Mutex<AppState>` 串行化写入，保证一致性。
- **代码位置**：[CodeWhale/Services/ChatController.cs](./CodeWhale/Services/ChatController.cs#L243) `OnRootDirectoryChanged`

### R-13 🟡 反复启停 AI 任务时 CancellationToken 释放

- **现象**：用户连续点击「发送 → 停止 → 发送」。
- **影响**：旧 CTS 未释放可能内存泄漏。
- **规避**：`OnMessageSendRequested` 的 `finally` 块保证 `_chatCts?.Dispose()`，
  每轮新建 CTS；`OnTaskStopRequested` 先 `Cancel()` 再由 `finally` 释放。
- **代码位置**：[CodeWhale/Services/ChatController.cs](./CodeWhale/Services/ChatController.cs#L196) `finally`

### R-14 🟢 ApiClient 重建时旧实例 Dispose 时机

- **现象**：用户修改后端地址触发 ApiClient 重建。
- **影响**：旧 client 持有的 `HttpClient` 可能正在请求中。
- **规避**：`OnBackendUrlChanged` 中 `if (_ownsClient) _client.Dispose()`，
  `HttpClient.Dispose` 不会中断正在飞行的请求，仅释放连接池；
  旧请求自然完成或超时，新请求走新 client。
- **代码位置**：[CodeWhale/Services/ChatController.cs](./CodeWhale/Services/ChatController.cs#L262) `OnBackendUrlChanged`

---

## 六、安全类

### R-15 🔴 API Key 明文存储于本地配置

- **现象**：DeepSeek API Key 以明文 JSON 保存在 `%LocalAppData%\CodeWhale\config.json`。
- **影响**：本机其他进程或用户可读取。
- **规避**：
  - 当前仅本机访问（MSIX 沙箱模式下其他应用无法读取 LocalFolder）
  - **建议增强**：使用 `Windows.Security.Cryptography.DataProtection` DPAPI 加密存储
  - 临时方案：限制本机账户权限，不在共享机器上使用
- **优先级**：企业部署前必须加密

### R-16 🟡 后端监听仅 127.0.0.1，不可远程访问

- **现象**：`config.toml` 默认 `host = "127.0.0.1"`。
- **影响**：仅本机前端可访问，无法跨机器部署。
- **规避**：当前为安全默认；如需远程访问，修改 `host = "0.0.0.0"` 并配置防火墙，
  **强烈建议**同时启用 HTTPS 与 API Key 鉴权（当前后端无鉴权）。

### R-17 🟡 Shell/Git 工具执行无白名单限制

- **现象**：后端 `/api/tools/shell` 与 `/api/tools/git` 接受任意命令。
- **影响**：恶意提示词可能诱导 AI 执行危险命令（如 `rm -rf`）。
- **规避**：
  - 前端 `ChatController` 当前不直接调用 Shell 工具，仅通过 `/api/chat` 间接触发
  - **建议增强**：后端 `tools::shell` 增加命令白名单（`git status`/`git diff`/`cargo check` 等），
    拒绝危险关键词（`rm`/`del`/`format`/`>`）
  - 用户侧：仅在受信任项目中使用，定期备份仓库
- **优先级**：v0.2 必须实现

---

## 七、功能边界类

### R-18 🟡 代码 Diff 审批为前向兼容占位

- **现象**：当前 `/api/chat` 返回纯文本流，不产生结构化 Diff；`DiffPreviewView` UI 完整但仅作占位。
- **影响**：审批按钮可用但实际写入基于 AI 输出的代码块文本。
- **规避**：`OnDiffApprovalRequested` 在批准时通过 `/api/tools/file/write` 落盘，
  当前以「移除 `-` 行 + 保留其他行」粗略生成最终内容；
  未来 Agent 输出结构化 Diff 后此路径自动激活。
- **代码位置**：[CodeWhale/Services/ChatController.cs](./CodeWhale/Services/ChatController.cs#L219) `OnDiffApprovalRequested`

### R-19 🟢 单窗口单会话

- **现象**：前端仅支持一个主窗口、一个活动会话。
- **影响**：无法并行处理多个项目。
- **规避**：当前为设计取舍（对标 Claude Code Desktop 单实例）；
  多会话能力需引入窗口管理器与 sessionId 切换 UI，列入 v0.3 路线图。

### R-20 🟢 无撤销/回滚机制

- **现象**：批准代码变更后无「撤销」按钮。
- **影响**：误操作需手工 `git checkout` 回滚。
- **规避**：建议用户在受 Git 管理的项目中使用，批准前用 Git 提交工作区；
  v0.2 计划引入「批准前自动 stash 工作区」机制。

---

## 八、性能与资源类

### R-21 🟡 DeepSeek API 限流（RPM/TPM）

- **现象**：高频请求触发 429 Too Many Requests。
- **影响**：当前轮次失败。
- **规避**：
  - 后端未实现自动重试（避免雪崩）
  - 用户侧控制发送频率，复杂任务拆分为少量大轮次
  - **建议增强**：后端 `deepseek.rs` 增加 429 指数退避重试（最多 3 次）
- **优先级**：v0.2

### R-22 🟢 流式渲染大量增量导致 UI 抖动

- **现象**：AI 高速输出时 `MessageBubble.Render` 频繁重建 `Inlines`。
- **影响**：低端设备滚动卡顿。
- **规避**：`CodeBlockView.Render` 仅在 `Code` 属性变化时重画；
  `MessageBubble.Render` 复用 `ContentPanel` 容器。建议增强：节流到 50ms 增量合并。

### R-23 🟢 后端单进程单线程 SSE

- **现象**：axum 默认 tokio 多线程，但 DeepSeek API 调用为阻塞式 await。
- **影响**：单后端可同时服务多 SSE 连接，但 DeepSeek API 限流会串行化。
- **规避**：当前单用户场景足够；多用户场景需引入任务队列。

---

## 九、部署与分发类

### R-24 🟡 自包含 exe 体积较大

- **现象**：单文件 exe 约 150MB（含 Windows App SDK 运行时）。
- **影响**：分发下载耗时。
- **规避**：使用 MSIX 安装包模式（依赖系统运行时，体积 ~10MB），
  或开启 `EnableCompressionInSingleFile`（已配置）。
- **代码位置**：[BUILD.md](./BUILD.md) 第 5.1.3 节

### R-25 🟢 后端 exe 需独立分发

- **现象**：MSIX 包仅含前端，后端 `codewhale-server.exe` 需另行分发。
- **影响**：用户需手动启动后端。
- **规避**：
  - 提供 `start.ps1` 一键启动脚本
  - **建议增强**：将后端 exe 嵌入 MSIX 资源，前端启动时自动拉起后端子进程
- **优先级**：v0.2

---

## 十、剩余未解决项汇总

| ID | 等级 | 项 | 计划版本 |
| --- | --- | --- | --- |
| R-15 | 🔴 | API Key 加密存储（DPAPI） | v0.2（企业部署前必须） |
| R-17 | 🟡 | Shell/Git 工具命令白名单 | v0.2 |
| R-21 | 🟡 | DeepSeek 429 自动重试 | v0.2 |
| R-25 | 🟢 | 后端进程由前端自动拉起 | v0.2 |
| R-19 | 🟢 | 多窗口多会话 | v0.3 |
| R-20 | 🟢 | 代码变更撤销机制 | v0.3 |
| R-22 | 🟢 | 流式渲染节流 | v0.3 |

---

## 十一、风险验收结论

- **🔴 高风险**：1 项（R-15 API Key 明文），仅在「企业部署/共享机器」场景需在上线前修复，
  单用户个人开发场景可接受。
- **🟡 中风险**：12 项，全部已提供降级路径或规避方案，不阻断当前交付。
- **🟢 低风险**：12 项，跟踪记录，按版本迭代处理。

整体风险等级：**可交付**，建议企业场景先处理 R-15。
