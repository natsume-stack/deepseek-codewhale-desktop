using System.Text.Json.Serialization;
using CodeWhale.Storage;

namespace CodeWhale.Services.Api.Models;

/// <summary>
/// /ping 与 /health 响应体。
/// </summary>
public sealed class HealthResponse
{
    [JsonPropertyName("status")]
    public string Status { get; set; } = string.Empty;

    [JsonPropertyName("service")]
    public string Service { get; set; } = string.Empty;

    [JsonPropertyName("version")]
    public string Version { get; set; } = string.Empty;

    [JsonPropertyName("deepseekConfigured")]
    public bool DeepseekConfigured { get; set; }

    [JsonPropertyName("projectLoaded")]
    public bool ProjectLoaded { get; set; }

    [JsonPropertyName("projectRoot")]
    public string? ProjectRoot { get; set; }

    [JsonPropertyName("timestamp")]
    public string Timestamp { get; set; } = string.Empty;
}

/// <summary>
/// POST /api/chat 请求体。所有字段均使用 camelCase 与后端对齐。
/// </summary>
public sealed class ChatRequest
{
    [JsonPropertyName("message")]
    public string Message { get; set; } = string.Empty;

    [JsonPropertyName("sessionId")]
    public string? SessionId { get; set; }

    [JsonPropertyName("systemPrompt")]
    public string? SystemPrompt { get; set; }

    [JsonPropertyName("maxTokens")]
    public uint? MaxTokens { get; set; }

    [JsonPropertyName("temperature")]
    public float? Temperature { get; set; }

    [JsonPropertyName("reasoningEffort")]
    public ReasoningEffort? ReasoningEffort { get; set; }

    [JsonPropertyName("cacheEnabled")]
    public bool? CacheEnabled { get; set; }

    [JsonPropertyName("contextLength")]
    public int? ContextLength { get; set; }
}

/// <summary>
/// POST /api/chat/stop 请求体。
/// </summary>
public sealed class ChatStopRequest
{
    [JsonPropertyName("sessionId")]
    public string SessionId { get; set; } = string.Empty;
}

/// <summary>
/// POST /api/chat/stop 响应体。
/// </summary>
public sealed class ChatStopResponse
{
    [JsonPropertyName("sessionId")]
    public string SessionId { get; set; } = string.Empty;

    [JsonPropertyName("aborted")]
    public bool Aborted { get; set; }
}

// ───────────────────────── SSE 流式事件 ─────────────────────────

/// <summary>
/// /api/chat SSE 流事件的抽象基类。具体子类对应 event 字段：
/// session / delta / reasoning / finish / error / done。
/// </summary>
public abstract class ChatStreamEvent
{
    /// <summary>事件类型名（与 SSE event: 字段一致）。</summary>
    public abstract string Kind { get; }
}

/// <summary>会话已建立/复用。首个事件，携带会话 ID。</summary>
public sealed class SessionStreamEvent : ChatStreamEvent
{
    public override string Kind => "session";
    [JsonPropertyName("sessionId")]
    public string SessionId { get; set; } = string.Empty;
}

/// <summary>助手回复增量文本。</summary>
public sealed class DeltaStreamEvent : ChatStreamEvent
{
    public override string Kind => "delta";
    [JsonPropertyName("content")]
    public string Content { get; set; } = string.Empty;
}

/// <summary>推理过程增量（仅 deepseek-reasoner）。</summary>
public sealed class ReasoningStreamEvent : ChatStreamEvent
{
    public override string Kind => "reasoning";
    [JsonPropertyName("content")]
    public string Content { get; set; } = string.Empty;
}

/// <summary>本轮生成结束。</summary>
public sealed class FinishStreamEvent : ChatStreamEvent
{
    public override string Kind => "finish";
    [JsonPropertyName("finishReason")]
    public string FinishReason { get; set; } = string.Empty;
}

/// <summary>推理过程或后端发生错误。</summary>
public sealed class ErrorStreamEvent : ChatStreamEvent
{
    public override string Kind => "error";
    [JsonPropertyName("message")]
    public string Message { get; set; } = string.Empty;
}

/// <summary>SSE 流结束标志。</summary>
public sealed class DoneStreamEvent : ChatStreamEvent
{
    public override string Kind => "done";
    [JsonPropertyName("sessionId")]
    public string SessionId { get; set; } = string.Empty;
}

// ───────────────────────── 会话管理 ─────────────────────────

/// <summary>
/// 单条会话消息（来自后端 Session.messages[]）。
/// </summary>
public sealed class SessionMessage
{
    [JsonPropertyName("role")]
    public string Role { get; set; } = string.Empty;

    [JsonPropertyName("content")]
    public string Content { get; set; } = string.Empty;
}

/// <summary>
/// 会话详情。对应 GET/POST /api/sessions、GET /api/sessions/:id 响应。
/// </summary>
public sealed class SessionInfo
{
    [JsonPropertyName("id")]
    public string Id { get; set; } = string.Empty;

    [JsonPropertyName("messages")]
    public List<SessionMessage> Messages { get; set; } = new();

    [JsonPropertyName("projectRoot")]
    public string? ProjectRoot { get; set; }

    [JsonPropertyName("createdAt")]
    public DateTimeOffset CreatedAt { get; set; }

    [JsonPropertyName("updatedAt")]
    public DateTimeOffset UpdatedAt { get; set; }

    [JsonPropertyName("running")]
    public bool Running { get; set; }
}

/// <summary>GET /api/sessions 响应。</summary>
public sealed class SessionListResponse
{
    [JsonPropertyName("sessions")]
    public List<SessionInfo> Sessions { get; set; } = new();

    [JsonPropertyName("count")]
    public int Count { get; set; }
}

/// <summary>DELETE /api/sessions/:id 响应。</summary>
public sealed class SessionDeleteResponse
{
    [JsonPropertyName("sessionId")]
    public string SessionId { get; set; } = string.Empty;

    [JsonPropertyName("deleted")]
    public bool Deleted { get; set; }
}

/// <summary>POST /api/sessions/:id/reset 响应。</summary>
public sealed class SessionResetResponse
{
    [JsonPropertyName("sessionId")]
    public string SessionId { get; set; } = string.Empty;

    [JsonPropertyName("reset")]
    public bool Reset { get; set; }
}

// ───────────────────────── 推理参数 ─────────────────────────

/// <summary>
/// GET/PUT /api/params 响应。与 Rust InferenceDefaults 一致。
/// </summary>
public sealed class InferenceParams
{
    [JsonPropertyName("reasoningEffort")]
    public ReasoningEffort ReasoningEffort { get; set; } = ReasoningEffort.Medium;

    [JsonPropertyName("cacheEnabled")]
    public bool CacheEnabled { get; set; } = true;

    [JsonPropertyName("contextLength")]
    public int ContextLength { get; set; } = 20;
}

/// <summary>PUT /api/params 请求体。所有字段可选，仅更新提供的字段。</summary>
public sealed class UpdateParamsRequest
{
    [JsonPropertyName("reasoningEffort")]
    public ReasoningEffort? ReasoningEffort { get; set; }

    [JsonPropertyName("cacheEnabled")]
    public bool? CacheEnabled { get; set; }

    [JsonPropertyName("contextLength")]
    public int? ContextLength { get; set; }
}

// ───────────────────────── 项目管理 ─────────────────────────

/// <summary>POST /api/project/load 请求体。</summary>
public sealed class ProjectLoadRequest
{
    [JsonPropertyName("path")]
    public string Path { get; set; } = string.Empty;
}

/// <summary>POST /api/project/load 响应。</summary>
public sealed class ProjectLoadResponse
{
    [JsonPropertyName("path")]
    public string Path { get; set; } = string.Empty;

    [JsonPropertyName("loaded")]
    public bool Loaded { get; set; }
}

/// <summary>GET /api/project 响应。</summary>
public sealed class ProjectState
{
    [JsonPropertyName("path")]
    public string? Path { get; set; }

    [JsonPropertyName("loaded")]
    public bool Loaded { get; set; }
}

// ───────────────────────── DeepSeek 配置 ─────────────────────────

/// <summary>GET/PUT /api/config/deepseek 响应。</summary>
public sealed class DeepSeekConfigResponse
{
    [JsonPropertyName("configured")]
    public bool Configured { get; set; }

    [JsonPropertyName("apiKeyMasked")]
    public string ApiKeyMasked { get; set; } = string.Empty;

    [JsonPropertyName("baseUrl")]
    public string BaseUrl { get; set; } = string.Empty;

    [JsonPropertyName("model")]
    public string Model { get; set; } = string.Empty;
}

/// <summary>PUT /api/config/deepseek 请求体。所有字段可选。</summary>
public sealed class SetDeepSeekRequest
{
    [JsonPropertyName("apiKey")]
    public string? ApiKey { get; set; }

    [JsonPropertyName("baseUrl")]
    public string? BaseUrl { get; set; }

    [JsonPropertyName("model")]
    public string? Model { get; set; }
}

/// <summary>POST /api/config/deepseek/test 响应。</summary>
public sealed class DeepSeekTestResponse
{
    [JsonPropertyName("ok")]
    public bool Ok { get; set; }

    [JsonPropertyName("model")]
    public string Model { get; set; } = string.Empty;

    [JsonPropertyName("baseUrl")]
    public string BaseUrl { get; set; } = string.Empty;
}

// ───────────────────────── 工具调用 ─────────────────────────

/// <summary>POST /api/tools/file/read 请求体。</summary>
public sealed class FileReadRequest
{
    [JsonPropertyName("path")]
    public string Path { get; set; } = string.Empty;
}

/// <summary>POST /api/tools/file/read 响应。</summary>
public sealed class FileReadResponse
{
    [JsonPropertyName("path")]
    public string Path { get; set; } = string.Empty;

    [JsonPropertyName("content")]
    public string Content { get; set; } = string.Empty;

    [JsonPropertyName("bytes")]
    public long Bytes { get; set; }
}

/// <summary>POST /api/tools/file/write 请求体。</summary>
public sealed class FileWriteRequest
{
    [JsonPropertyName("path")]
    public string Path { get; set; } = string.Empty;

    [JsonPropertyName("content")]
    public string Content { get; set; } = string.Empty;

    [JsonPropertyName("createDirs")]
    public bool? CreateDirs { get; set; }
}

/// <summary>POST /api/tools/file/write 响应。</summary>
public sealed class FileWriteResponse
{
    [JsonPropertyName("path")]
    public string Path { get; set; } = string.Empty;

    [JsonPropertyName("bytes")]
    public long Bytes { get; set; }

    [JsonPropertyName("created")]
    public bool Created { get; set; }
}

/// <summary>POST /api/tools/git 请求体。</summary>
public sealed class GitToolRequest
{
    [JsonPropertyName("args")]
    public List<string> Args { get; set; } = new();
}

/// <summary>POST /api/tools/shell 请求体。</summary>
public sealed class ShellToolRequest
{
    [JsonPropertyName("command")]
    public string Command { get; set; } = string.Empty;

    [JsonPropertyName("timeoutSecs")]
    public int? TimeoutSecs { get; set; }
}

/// <summary>git/shell 工具执行响应。</summary>
public sealed class ToolExecResponse
{
    [JsonPropertyName("exitCode")]
    public int ExitCode { get; set; }

    [JsonPropertyName("stdout")]
    public string Stdout { get; set; } = string.Empty;

    [JsonPropertyName("stderr")]
    public string Stderr { get; set; } = string.Empty;

    [JsonPropertyName("success")]
    public bool Success { get; set; }
}

// ───────────────────────── 错误响应 ─────────────────────────

/// <summary>
/// 后端统一错误响应体：{"error": &lt;int&gt;, "message": "..."}。
/// </summary>
internal sealed class ErrorResponse
{
    [JsonPropertyName("error")]
    public int Error { get; set; }

    [JsonPropertyName("message")]
    public string Message { get; set; } = string.Empty;
}
