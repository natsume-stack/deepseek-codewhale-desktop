using System.Net.Http.Headers;
using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading;
using CodeWhale.Services.Api.Models;
using CodeWhale.Storage;

namespace CodeWhale.Services.Api;

/// <summary>
/// CodeWhale Rust 后端 HTTP 客户端实现。
/// 对接 /api/* 端点（chat/sessions/params/project/tools/config）与 /ping、/health。
/// 所有异常统一归一为 <see cref="CodeWhaleException"/> 体系，便于 UI 层捕获。
/// </summary>
public sealed class CodeWhaleApiClient : ICodeWhaleApiClient
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.Never,
        // 全局枚举转换器：将 ReasoningEffort 序列化为 lowercase（minimal/low/medium/high），
        // 与 Rust 后端 #[serde(rename_all = "lowercase")] 对齐。
        Converters = { new JsonStringEnumConverter(JsonNamingPolicy.CamelCase) }
    };

    private readonly HttpClient _http;
    private readonly bool _ownsHttp;
    private readonly CodeWhaleClientOptions _options;

    /// <summary>使用默认配置构造客户端（基地址 127.0.0.1:8787）。</summary>
    public CodeWhaleApiClient() : this(new CodeWhaleClientOptions()) { }

    /// <summary>使用指定配置构造客户端。</summary>
    public CodeWhaleApiClient(CodeWhaleClientOptions options) : this(options, CreateHttp(options)) { _ownsHttp = true; }

    /// <summary>使用外部传入的 HttpClient 构造（便于 DI/测试）。</summary>
    public CodeWhaleApiClient(CodeWhaleClientOptions options, HttpClient http)
    {
        _options = options;
        _http = http;
        _ownsHttp = false;
    }

    /// <inheritdoc/>
    public CodeWhaleClientOptions Options => _options;

    // ────────────────────────── 健康检测 ──────────────────────────

    /// <inheritdoc/>
    public async Task<HealthResponse> GetHealthAsync(CancellationToken ct = default)
        => await GetAsync<HealthResponse>("/ping", ct).ConfigureAwait(false);

    // ────────────────────────── 对话（SSE） ──────────────────────────

    /// <inheritdoc/>
    public async IAsyncEnumerable<ChatStreamEvent> StreamChatAsync(
        ChatRequest request,
        [EnumeratorCancellation] CancellationToken ct = default)
    {
        var payload = JsonSerializer.Serialize(request, JsonOptions);
        using var req = new HttpRequestMessage(HttpMethod.Post, "/api/chat")
        {
            Content = new StringContent(payload, Encoding.UTF8, "application/json")
        };

        HttpResponseMessage response;
        try
        {
            // ResponseHeadersRead：仅读取响应头即返回，流式读取 body
            response = await _http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, ct)
                .ConfigureAwait(false);
        }
        catch (OperationCanceledException ex) when (ex.CancellationToken == ct)
        {
            throw new CodeWhaleCanceledException(ex);
        }
        catch (TaskCanceledException ex) when (ex.GetBaseException() is TimeoutException)
        {
            throw new CodeWhaleTimeoutException(_options.Timeout, ex);
        }
        catch (HttpRequestException ex)
        {
            throw new CodeWhaleConnectionException("无法连接 CodeWhale 后端服务，请确认已启动 codewhale-server。", ex);
        }

        try
        {
            response.EnsureSuccessStatusCode();
        }
        catch (HttpRequestException ex)
        {
            var body = await TryReadBodyAsync(response, ct).ConfigureAwait(false);
            throw new CodeWhaleApiException(response.StatusCode, "/api/chat", ExtractMessage(body), body);
        }

        // 读取 SSE 流
        await using var stream = await response.Content.ReadAsStreamAsync(ct).ConfigureAwait(false);
        using var sse = new SseReader(stream, ownsStream: false);

        while (true)
        {
            SseEvent? ev;
            try
            {
                ev = await sse.ReadAsync(ct).ConfigureAwait(false);
            }
            catch (OperationCanceledException ex)
            {
                throw new CodeWhaleCanceledException(ex);
            }

            if (ev is null) yield break;
            if (ev.IsKeepAlive) continue;
            if (string.IsNullOrEmpty(ev.Data)) continue;

            var mapped = MapSseEvent(ev.Event ?? "message", ev.Data);
            if (mapped is not null) yield return mapped;
            if (mapped is DoneStreamEvent or ErrorStreamEvent) yield break;
        }
    }

    /// <inheritdoc/>
    public async Task<ChatStopResponse> StopChatAsync(string sessionId, CancellationToken ct = default)
        => await PostAsync<ChatStopResponse>("/api/chat/stop", new { sessionId }, ct).ConfigureAwait(false);

    // ────────────────────────── 会话管理 ──────────────────────────

    /// <inheritdoc/>
    public async Task<SessionListResponse> ListSessionsAsync(CancellationToken ct = default)
        => await GetAsync<SessionListResponse>("/api/sessions", ct).ConfigureAwait(false);

    /// <inheritdoc/>
    public async Task<SessionInfo> CreateSessionAsync(CancellationToken ct = default)
        => await PostAsync<SessionInfo>("/api/sessions", body: null, ct).ConfigureAwait(false);

    /// <inheritdoc/>
    public async Task<SessionInfo> GetSessionAsync(string sessionId, CancellationToken ct = default)
        => await GetAsync<SessionInfo>($"/api/sessions/{Uri.EscapeDataString(sessionId)}", ct).ConfigureAwait(false);

    /// <inheritdoc/>
    public async Task<SessionDeleteResponse> DeleteSessionAsync(string sessionId, CancellationToken ct = default)
        => await DeleteAsync<SessionDeleteResponse>($"/api/sessions/{Uri.EscapeDataString(sessionId)}", ct).ConfigureAwait(false);

    /// <inheritdoc/>
    public async Task<SessionResetResponse> ResetSessionAsync(string sessionId, CancellationToken ct = default)
        => await PostAsync<SessionResetResponse>($"/api/sessions/{Uri.EscapeDataString(sessionId)}/reset", body: null, ct).ConfigureAwait(false);

    // ────────────────────────── 推理参数 ──────────────────────────

    /// <inheritdoc/>
    public async Task<InferenceParams> GetParamsAsync(CancellationToken ct = default)
        => await GetAsync<InferenceParams>("/api/params", ct).ConfigureAwait(false);

    /// <inheritdoc/>
    public async Task<InferenceParams> UpdateParamsAsync(UpdateParamsRequest request, CancellationToken ct = default)
        => await PutAsync<InferenceParams>("/api/params", request, ct).ConfigureAwait(false);

    // ────────────────────────── 项目管理 ──────────────────────────

    /// <inheritdoc/>
    public async Task<ProjectLoadResponse> LoadProjectAsync(string path, CancellationToken ct = default)
        => await PostAsync<ProjectLoadResponse>("/api/project/load", new ProjectLoadRequest { Path = path }, ct).ConfigureAwait(false);

    /// <inheritdoc/>
    public async Task<ProjectState> GetProjectAsync(CancellationToken ct = default)
        => await GetAsync<ProjectState>("/api/project", ct).ConfigureAwait(false);

    // ────────────────────────── DeepSeek 配置 ──────────────────────────

    /// <inheritdoc/>
    public async Task<DeepSeekConfigResponse> GetDeepSeekConfigAsync(CancellationToken ct = default)
        => await GetAsync<DeepSeekConfigResponse>("/api/config/deepseek", ct).ConfigureAwait(false);

    /// <inheritdoc/>
    public async Task<DeepSeekConfigResponse> SetDeepSeekConfigAsync(SetDeepSeekRequest request, CancellationToken ct = default)
        => await PutAsync<DeepSeekConfigResponse>("/api/config/deepseek", request, ct).ConfigureAwait(false);

    /// <inheritdoc/>
    public async Task<DeepSeekTestResponse> TestDeepSeekAsync(CancellationToken ct = default)
        => await PostAsync<DeepSeekTestResponse>("/api/config/deepseek/test", body: null, ct).ConfigureAwait(false);

    // ────────────────────────── 工具调用 ──────────────────────────

    /// <inheritdoc/>
    public async Task<FileReadResponse> ReadFileAsync(string path, CancellationToken ct = default)
        => await PostAsync<FileReadResponse>("/api/tools/file/read", new FileReadRequest { Path = path }, ct).ConfigureAwait(false);

    /// <inheritdoc/>
    public async Task<FileWriteResponse> WriteFileAsync(string path, string content, bool? createDirs = null, CancellationToken ct = default)
        => await PostAsync<FileWriteResponse>("/api/tools/file/write", new FileWriteRequest { Path = path, Content = content, CreateDirs = createDirs }, ct).ConfigureAwait(false);

    /// <inheritdoc/>
    public async Task<ToolExecResponse> RunGitAsync(IReadOnlyList<string> args, CancellationToken ct = default)
        => await PostAsync<ToolExecResponse>("/api/tools/git", new GitToolRequest { Args = args.ToList() }, ct).ConfigureAwait(false);

    /// <inheritdoc/>
    public async Task<ToolExecResponse> RunShellAsync(string command, int? timeoutSecs = null, CancellationToken ct = default)
        => await PostAsync<ToolExecResponse>("/api/tools/shell", new ShellToolRequest { Command = command, TimeoutSecs = timeoutSecs }, ct).ConfigureAwait(false);

    // ────────────────────────── 通用 HTTP 工具方法 ──────────────────────────

    private async Task<T> GetAsync<T>(string path, CancellationToken ct)
    {
        using var req = new HttpRequestMessage(HttpMethod.Get, path);
        return await SendAsync<T>(req, path, ct).ConfigureAwait(false);
    }

    private async Task<T> PostAsync<T>(string path, object? body, CancellationToken ct)
    {
        using var req = new HttpRequestMessage(HttpMethod.Post, path);
        if (body is not null)
        {
            req.Content = new StringContent(JsonSerializer.Serialize(body, body.GetType(), JsonOptions), Encoding.UTF8, "application/json");
        }
        return await SendAsync<T>(req, path, ct).ConfigureAwait(false);
    }

    private async Task<T> PutAsync<T>(string path, object body, CancellationToken ct)
    {
        using var req = new HttpRequestMessage(HttpMethod.Put, path);
        req.Content = new StringContent(JsonSerializer.Serialize(body, body.GetType(), JsonOptions), Encoding.UTF8, "application/json");
        return await SendAsync<T>(req, path, ct).ConfigureAwait(false);
    }

    private async Task<T> DeleteAsync<T>(string path, CancellationToken ct)
    {
        using var req = new HttpRequestMessage(HttpMethod.Delete, path);
        return await SendAsync<T>(req, path, ct).ConfigureAwait(false);
    }

    private async Task<T> SendAsync<T>(HttpRequestMessage req, string path, CancellationToken ct)
    {
        HttpResponseMessage response;
        try
        {
            response = await _http.SendAsync(req, ct).ConfigureAwait(false);
        }
        catch (OperationCanceledException ex) when (ex.CancellationToken == ct)
        {
            throw new CodeWhaleCanceledException(ex);
        }
        catch (TaskCanceledException ex)
        {
            // HttpClient 超时通过 TaskCanceledException 表现
            if (ex.InnerException is TimeoutException)
            {
                throw new CodeWhaleTimeoutException(_options.Timeout, ex);
            }
            throw new CodeWhaleCanceledException(ex);
        }
        catch (HttpRequestException ex)
        {
            throw new CodeWhaleConnectionException("无法连接 CodeWhale 后端服务，请确认已启动 codewhale-server。", ex);
        }

        try
        {
            if (!response.IsSuccessStatusCode)
            {
                var body = await TryReadBodyAsync(response, ct).ConfigureAwait(false);
                throw new CodeWhaleApiException(response.StatusCode, path, ExtractMessage(body), body);
            }

            var json = await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
            return JsonSerializer.Deserialize<T>(json, JsonOptions)
                   ?? throw new CodeWhaleApiException(response.StatusCode, path, "响应体反序列化为 null", json);
        }
        finally
        {
            response.Dispose();
        }
    }

    private static async Task<string?> TryReadBodyAsync(HttpResponseMessage response, CancellationToken ct)
    {
        try
        {
            return await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
        }
        catch
        {
            return null;
        }
    }

    private static string? ExtractMessage(string? body)
    {
        if (string.IsNullOrEmpty(body)) return null;
        try
        {
            var err = JsonSerializer.Deserialize<ErrorResponse>(body, JsonOptions);
            return err?.Message;
        }
        catch
        {
            return null;
        }
    }

    private static ChatStreamEvent? MapSseEvent(string eventName, string data)
    {
        try
        {
            return eventName switch
            {
                "session" => JsonSerializer.Deserialize<SessionStreamEvent>(data, JsonOptions),
                "delta" => JsonSerializer.Deserialize<DeltaStreamEvent>(data, JsonOptions),
                "reasoning" => JsonSerializer.Deserialize<ReasoningStreamEvent>(data, JsonOptions),
                "finish" => JsonSerializer.Deserialize<FinishStreamEvent>(data, JsonOptions),
                "error" => JsonSerializer.Deserialize<ErrorStreamEvent>(data, JsonOptions),
                "done" => JsonSerializer.Deserialize<DoneStreamEvent>(data, JsonOptions),
                _ => null
            };
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private static HttpClient CreateHttp(CodeWhaleClientOptions options)
    {
        var http = new HttpClient
        {
            BaseAddress = options.BaseAddress,
            Timeout = options.Timeout
        };
        if (!string.IsNullOrEmpty(options.UserAgent))
        {
            http.DefaultRequestHeaders.UserAgent.ParseAdd(options.UserAgent);
        }
        http.DefaultRequestHeaders.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        http.DefaultRequestHeaders.Accept.Add(new MediaTypeWithQualityHeaderValue("text/event-stream"));
        return http;
    }

    public void Dispose()
    {
        if (_ownsHttp) _http.Dispose();
    }
}
