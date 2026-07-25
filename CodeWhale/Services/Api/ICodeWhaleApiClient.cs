using CodeWhale.Services.Api.Models;
using CodeWhale.Storage;

namespace CodeWhale.Services.Api;

/// <summary>
/// CodeWhale Rust 后端 API 客户端契约。
/// 对应 src/routes/ 下挂载的 /api/* 与 /ping、/health 端点。
/// </summary>
public interface ICodeWhaleApiClient : IDisposable
{
    /// <summary>当前配置（基地址、超时等）。运行时可读写。</summary>
    CodeWhaleClientOptions Options { get; }

    // ────────── 健康检测 ──────────

    /// <summary>GET /ping 或 /health。返回后端服务状态。</summary>
    Task<HealthResponse> GetHealthAsync(CancellationToken ct = default);

    // ────────── 对话（SSE 流式） ──────────

    /// <summary>
    /// POST /api/chat。返回 SSE 事件流，调用方按需迭代消费。
    /// 流结束（done 事件或 EOF）后迭代器自动终止；调用方取消令牌可中断。
    /// </summary>
    /// <param name="request">对话请求体。</param>
    /// <param name="ct">取消令牌：用于中断 AI 任务长连接。</param>
    /// <returns>SSE 事件异步枚举（session → delta* → finish → done，或 error）。</returns>
    IAsyncEnumerable<ChatStreamEvent> StreamChatAsync(ChatRequest request, CancellationToken ct = default);

    /// <summary>POST /api/chat/stop。中断指定会话的当前推理轮次。</summary>
    Task<ChatStopResponse> StopChatAsync(string sessionId, CancellationToken ct = default);

    // ────────── 会话管理 ──────────

    /// <summary>GET /api/sessions。列出全部会话。</summary>
    Task<SessionListResponse> ListSessionsAsync(CancellationToken ct = default);

    /// <summary>POST /api/sessions。新建空会话。</summary>
    Task<SessionInfo> CreateSessionAsync(CancellationToken ct = default);

    /// <summary>GET /api/sessions/:id。获取会话详情。</summary>
    Task<SessionInfo> GetSessionAsync(string sessionId, CancellationToken ct = default);

    /// <summary>DELETE /api/sessions/:id。删除会话。</summary>
    Task<SessionDeleteResponse> DeleteSessionAsync(string sessionId, CancellationToken ct = default);

    /// <summary>POST /api/sessions/:id/reset。清空会话消息历史。</summary>
    Task<SessionResetResponse> ResetSessionAsync(string sessionId, CancellationToken ct = default);

    // ────────── 推理参数 ──────────

    /// <summary>GET /api/params。读取当前推理参数。</summary>
    Task<InferenceParams> GetParamsAsync(CancellationToken ct = default);

    /// <summary>PUT /api/params。更新推理参数（仅提供的字段）。</summary>
    Task<InferenceParams> UpdateParamsAsync(UpdateParamsRequest request, CancellationToken ct = default);

    // ────────── 项目管理 ──────────

    /// <summary>POST /api/project/load。设置后端工作的项目根目录。</summary>
    Task<ProjectLoadResponse> LoadProjectAsync(string path, CancellationToken ct = default);

    /// <summary>GET /api/project。查询当前加载的项目。</summary>
    Task<ProjectState> GetProjectAsync(CancellationToken ct = default);

    // ────────── DeepSeek 配置 ──────────

    /// <summary>GET /api/config/deepseek。读取 DeepSeek 配置（API Key 脱敏）。</summary>
    Task<DeepSeekConfigResponse> GetDeepSeekConfigAsync(CancellationToken ct = default);

    /// <summary>PUT /api/config/deepseek。更新 DeepSeek 配置并落盘到 config.toml。</summary>
    Task<DeepSeekConfigResponse> SetDeepSeekConfigAsync(SetDeepSeekRequest request, CancellationToken ct = default);

    /// <summary>POST /api/config/deepseek/test。探测 DeepSeek API 连通性。</summary>
    Task<DeepSeekTestResponse> TestDeepSeekAsync(CancellationToken ct = default);

    // ────────── 工具调用 ──────────

    /// <summary>POST /api/tools/file/read。读取项目内文件。</summary>
    Task<FileReadResponse> ReadFileAsync(string path, CancellationToken ct = default);

    /// <summary>POST /api/tools/file/write。写入项目内文件。</summary>
    Task<FileWriteResponse> WriteFileAsync(string path, string content, bool? createDirs = null, CancellationToken ct = default);

    /// <summary>POST /api/tools/git。在项目根执行 git 命令。</summary>
    Task<ToolExecResponse> RunGitAsync(IReadOnlyList<string> args, CancellationToken ct = default);

    /// <summary>POST /api/tools/shell。在项目根执行 shell 命令。</summary>
    Task<ToolExecResponse> RunShellAsync(string command, int? timeoutSecs = null, CancellationToken ct = default);
}
