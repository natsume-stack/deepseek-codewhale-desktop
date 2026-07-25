# CodeWhale 编译、启动与打包手册

> 本文档覆盖 Rust 后端编译、WinUI3 前端编译、前后端正确启动顺序、MSIX 打包独立 exe 流程，
> 以及针对 DeepSeek V4-Flash 大项目开发的性能调优建议。

---

## 一、编译环境要求

### 1.1 必装组件

| 组件 | 版本 | 用途 | 获取方式 |
| --- | --- | --- | --- |
| Visual Studio 2022 | 17.8+ | WinUI3 前端编译、MSIX 打包 | https://visualstudio.microsoft.com/zh-hans/vs/ |
| .NET SDK | 8.0.x | C# 编译运行时 | https://dotnet.microsoft.com/download/dotnet/8.0 |
| Windows App SDK 工作负载 | 1.5+ | WinUI3 框架支持 | VS Installer →「.NET 桌面开发」+「Windows 应用程序开发 (C#)」 |
| Windows SDK Build Tools | 10.0.26100+ | 应用清单编译 | 随工作负载安装 |
| Rust 工具链 | 1.88+（stable） | 后端 codewhale-server 编译 | https://www.rust-lang.org/tools/install |
| 操作系统 | Windows 10 1809+ 运行；Windows 11 21H2+ 完整 Mica 材质 | — | — |

### 1.2 Visual Studio 工作负载勾选

在 VS Installer 中至少勾选：

- **.NET 桌面开发**（包含 MSBuild、.NET SDK）
- **Windows 应用程序开发 (C#)**（包含 Windows App SDK、MSIX 工具）
- **通用 Windows 平台开发**（可选，便于调试 Windows App SDK 元数据）

### 1.3 Rust 工具链初始化

```powershell
# 安装 rustup（默认 stable 工具链）
winget install Rustlang.Rustup
# 或访问 https://www.rust-lang.org/tools/install 下载 rustup-init.exe

# 验证
rustc --version    # 需要 1.88+
cargo --version
```

### 1.4 验证环境

```powershell
dotnet --version            # 8.0.x
cargo --version             # cargo 1.88+
rustc --version             # rustc 1.88+
# Visual Studio 2022 → 帮助 → 关于，确认已安装 Windows App SDK 1.5+
```

---

## 二、Rust 后端编译

### 2.1 Debug 编译（开发调试）

```powershell
cd c:\Users\Natsume\Desktop\deepseektui-desktop
cargo run                                    # 编译并运行（debug）
# 或仅编译不运行
cargo build
```

产物：`target\debug\codewhale-server.exe`

### 2.2 Release 编译（性能测试/部署）

```powershell
cd c:\Users\Natsume\Desktop\deepseektui-desktop
cargo build --release
```

产物：`target\release\codewhale-server.exe`

`Cargo.toml` 中 `[profile.release]` 已配置：
- `opt-level = 3`（最高优化）
- `lto = "thin"`（链接时优化）
- `codegen-units = 1`（最大化优化空间）
- `strip = true`（剥离符号，缩小体积）

### 2.3 使用启动脚本

仓库提供 `start.ps1`：

```powershell
# 首次：release 编译后运行
.\start.ps1 -Build -Release

# 常用：debug 运行
.\start.ps1

# 指定端口
.\start.ps1 -Port 9000
```

### 2.4 配置文件

后端按以下优先级读取配置（高 → 低）：

1. `~/.codewhale-server/config.toml`（`%APPDATA%\codewhale-server\config.toml`）
2. 环境变量（`CODEWHALE_SERVER__PORT` 等，参见 `.env.example`）
3. 内置默认值（`127.0.0.1:8787`，无 API Key）

首次启动无需配置文件，由前端通过 `PUT /api/config/deepseek` 推送 API Key 后自动生成。
配置示例见 `config.example.toml`。

### 2.5 验证后端启动

```powershell
# 健康检查
curl http://127.0.0.1:8787/ping
# 期望: {"service":"codewhale-server","version":"0.1.0","status":"ok"}
```

---

## 三、WinUI3 前端编译

### 3.1 命令行编译（推荐 CI 用）

```powershell
cd c:\Users\Natsume\Desktop\deepseektui-desktop\CodeWhale

# 还原 NuGet 包
dotnet restore

# Debug 编译并运行
dotnet run -c Debug -p:Platform=x64

# Release 编译（不运行）
dotnet build -c Release -p:Platform=x64
```

### 3.2 Visual Studio 编译

1. 双击 `CodeWhale.sln` 打开
2. 顶部选择 `Debug` 或 `Release` + `x64`（推荐）或 `x86`/`ARM64`
3. 按 `F5` 调试运行，或 `Ctrl+F5` 直接运行

### 3.3 目标平台说明

| 平台 | 适用 | 备注 |
| --- | --- | --- |
| x64 | 主流 64 位 Windows | 默认推荐 |
| x86 | 32 位 Windows / 兼容场景 | — |
| ARM64 | Surface Pro X 等 ARM 设备 | 需安装 ARM64 工具链 |

### 3.4 关键 csproj 配置

```xml
<TargetFramework>net8.0-windows10.0.19041.0</TargetFramework>
<TargetPlatformMinVersion>10.0.17763.0</TargetPlatformMinVersion>
<UseWinUI>true</UseWinUI>
<WindowsPackageType>None</WindowsPackageType>               <!-- 解包运行模式 -->
<WindowsAppSDKSelfContained>true</WindowsAppSDKSelfContained> <!-- 自包含部署 -->
<RuntimeIdentifiers>win-x86;win-x64;win-arm64</RuntimeIdentifiers>
```

---

## 四、前后端正确启动顺序

> **核心原则：先后端，后前端。** 前端启动时会探测后端连通性，未启动不崩溃，
> 但功能受限（无法发送对话、加载项目）。

### 4.1 完整启动流程

```powershell
# ────── 步骤 1：启动 Rust 后端 ──────
cd c:\Users\Natsume\Desktop\deepseektui-desktop
cargo run --release --bin codewhale-server
# 看到 "listening on http://127.0.0.1:8787" 即成功

# ────── 步骤 2：（新窗口）启动 WinUI 前端 ──────
cd c:\Users\Natsume\Desktop\deepseektui-desktop\CodeWhale
dotnet run -c Debug -p:Platform=x64
```

### 4.2 首次使用流程

1. 前端启动后，右侧「后端连接」面板显示「在线 · codewhale-server v0.1.0」
2. 在右侧「DeepSeek 配置」中填入 API Key（`sk-...`）
3. 点击「测试连接」，确认「连接正常，DeepSeek API 可达」
4. 左侧「打开项目」选择本地代码仓库
5. 中央输入开发需求，Enter 发送

### 4.3 关闭顺序

- 直接关闭前端窗口：自动持久化全部配置（窗口尺寸、栏宽、参数、项目路径）
- 后端可通过 `Ctrl+C` 终止；后端状态在内存中，无重要持久化数据

---

## 五、MSIX 打包独立 exe 流程

> 本项目 csproj 当前配置为 `WindowsPackageType=None`（解包运行模式），
> 同时支持两种发布方式：**自包含单文件 exe**（最简）和 **MSIX 安装包**（企业部署）。

### 5.1 方式一：自包含单文件 exe（推荐，脱离开发环境）

#### 5.1.1 修改 csproj 启用 MSIX 工具（可选）

如需 MSIX 打包，将 csproj 中两行改为：

```xml
<EnableMsixTooling>true</EnableMsixTooling>
<WindowsPackageType>MSIX</WindowsPackageType>
```

并在 `Package.appxmanifest` 中配置发布者、版本、能力。

#### 5.1.2 自包含发布（无需 MSIX，最常用）

```powershell
cd c:\Users\Natsume\Desktop\deepseektui-desktop\CodeWhale

# 发布自包含 exe（不依赖目标机器 .NET 运行时）
dotnet publish -c Release -r win-x64 -p:Platform=x64 --self-contained true

# 产物路径
# bin\x64\Release\net8.0-windows10.0.19041.0\win-x64\publish\
```

将整个 `publish\` 目录拷贝到目标 Win11 机器，双击 `CodeWhale.exe` 即可运行。

#### 5.1.3 单文件打包（进一步精简）

```powershell
dotnet publish -c Release -r win-x64 -p:Platform=x64 --self-contained true `
  -p:PublishSingleFile=true `
  -p:IncludeNativeLibrariesForSelfExtract=true `
  -p:EnableCompressionInSingleFile=true
```

产物为单个 `CodeWhale.exe`（约 150MB，包含 Windows App SDK 运行时）。

### 5.2 方式二：MSIX 安装包

#### 5.2.1 配置 Package.appxmanifest

编辑 `CodeWhale\Package.appxmanifest`：

```xml
<Identity Name="CodeWhale"
          Publisher="CN=YourName"
          Version="0.1.0.0" />
```

#### 5.2.2 使用 VS 打包

1. VS 打开 `CodeWhale.sln`
2. 解决方案右键 → **发布** → **MSIX 打包**（或使用「Windows 应用程序打包」项目）
3. 选择 `Release | x64`，生成 `.msix` 安装包
4. 分发 `.msix` 到目标机器，双击安装

#### 5.2.3 命令行打包

```powershell
# 安装 MSIX 工具
dotnet tool install -g msix-sdk-tk

# 生成 MSIX 包
msix pack -d CodeWhale\bin\x64\Release\net8.0-windows10.0.19041.0\win-x64\publish\ -o CodeWhale-0.1.0.msix
```

### 5.3 后端 exe 携带

无论哪种前端打包方式，Rust 后端 `codewhale-server.exe` 需独立分发：

```powershell
# Release 编译产物
c:\Users\Natsume\Desktop\deepseektui-desktop\target\release\codewhale-server.exe
```

部署时建议：
- 前后端放在同一目录，附带 `start.ps1` 一键启动
- 或注册 Windows 服务/启动项自动拉起后端

---

## 六、DeepSeek V4-Flash 性能优化建议

### 6.1 缓存命中率提升方案

| 优化项 | 做法 | 收益 |
| --- | --- | --- |
| **稳定系统提示词** | 把项目规范、技术栈、命名约定固化为前缀，避免每轮变动 | DeepSeek 上下文缓存命中，token 计费降 50%+ |
| **上下文文件复用** | 通过左侧文件树「加入上下文」固定同一批文件，避免轮次间漂移 | 缓存前缀稳定 |
| **关闭无关缓存** | 临时调试场景关闭 `cacheEnabled`，避免冷热混用 | 计费透明 |
| **会话长连接** | 不频繁「重置会话」，复用 sessionId 让后端累积上下文 | 后端无需重建 system prompt |
| **批量相似需求** | 同一会话内连续提问，而非分散多次启动 | 首次冷启动后全程热缓存 |

### 6.2 大项目上下文调优

- **按需加入上下文**：文件树默认不把整个仓库载入模型，仅「加入上下文」的文件参与推理
- **上下文长度**：右侧面板「上下文长度（轮次）」建议 `20`，超长会话调至 `50`，但需关注 token 成本
- **分模块提问**：复杂需求拆分为「读 A 文件 → 修改 A → 读 B → 修改 B」多轮，避免一次性吞入大仓库

### 6.3 多 Agent 并行任务调优

CodeWhale 后端的 `/api/tools/*`（file/git/shell）为同步执行，并行性体现在：

- **流式不阻塞**：SSE 增量推送，前端边收边渲染，不等完整响应
- **停止即时**：点击「停止」立即 `CancellationToken.Cancel` + 后端 `/api/chat/stop` 双保险
- **会话隔离**：多会话通过 `sessionId` 隔离，互不影响（当前前端单窗口单会话）
- **推理强度档位**：
  - `minimal`/`low`：快速问答、简单改动
  - `medium`（默认）：日常开发
  - `high`：复杂重构、跨文件改动
  - 极高场景建议显式拆分任务，避免单轮 token 爆炸

### 6.4 后端资源调优

`Cargo.toml` 已启用 `lto=thin` + `codegen-units=1` + `strip=true`，
进一步优化可在 `config.toml` 调整：

```toml
[inference]
contextLength = 20              # 默认 20 轮，按需调整
cacheEnabled = true             # 默认开启，缓存命中率稳定时勿关
```

---

## 七、常见编译问题排查

### 7.1 WinUI 前端

| 错误 | 原因 | 解决 |
| --- | --- | --- |
| `MSB4019: 未找到 Microsoft.WindowsAppSDK.props` | 未安装 Windows App SDK 工作负载 | VS Installer 勾选「Windows 应用程序开发 (C#)」 |
| `NETSDK1082: 找不到 Microsoft.WindowsAppSDK 1.5.x` | NuGet 还原失败 | `dotnet restore` 或清空 `bin/obj` 后重试 |
| `MC1000: 未知的 Type 'MicaBackdrop'` | Windows App SDK 版本过低 | 升级 csproj 中 `Microsoft.WindowsAppSDK` 至 1.5+ |
| 启动后无 Mica 背景 | Windows 10 或系统透明效果关闭 | 程序自动降级，无需处理 |
| `0x80070005 拒绝访问` 解包运行 | 目录权限不足 | 改用 `publish\` 子目录或 MSIX 安装 |

### 7.2 Rust 后端

| 错误 | 原因 | 解决 |
| --- | --- | --- |
| `error: linker 'link.exe' not found` | 未安装 VS C++ 工具链 | VS Installer 勾选「使用 C++ 的桌面开发」 |
| `error[E0463]: can't find crate for 'ring'` | 缺少 ring 编译依赖 | 安装 `mingw-w64` 或确认使用 MSVC 工具链 |
| 端口被占用 `Address already in use` | 8787 已被占用 | `.\start.ps1 -Port 9000` 或结束占用进程 |
| DeepSeek API 401 | API Key 无效 | 前端右侧面板更新 Key 后「测试连接」 |

---

## 八、交付清单

- ✅ `CodeWhale.sln` — 单解决方案，包含前后端项目
- ✅ `CodeWhale/CodeWhale.csproj` — WinUI3 项目（net8.0-windows10.0.19041）
- ✅ `Cargo.toml` — Rust 后端（codewhale-server）
- ✅ `start.ps1` / `start.sh` — 后端启动脚本
- ✅ `config.example.toml` / `.env.example` — 后端配置示例
- ✅ `CodeWhale/Package.appxmanifest` — MSIX 清单
- ✅ `CodeWhale/app.manifest` — DPI/权限清单
- ✅ `CodeWhale/Properties/launchSettings.json` — 调试启动设置
