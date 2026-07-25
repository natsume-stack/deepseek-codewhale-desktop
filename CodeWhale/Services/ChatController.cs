using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using CodeWhale.Models;
using CodeWhale.Services.Api;
using CodeWhale.Services.Api.Models;
using CodeWhale.Storage;
using CodeWhale.Views;
using CodeWhale.Views.Controls;
using Microsoft.UI.Xaml;

namespace CodeWhale.Services;

/// <summary>
/// 对话控制器：UI 事件与 CodeWhale 后端 API 之间的桥接层。
///
/// 职责：
/// <list type="bullet">
/// <item>订阅 <see cref="ChatPanel"/> / <see cref="FileTreeView"/> / <see cref="ParameterPanel"/> 事件；</item>
/// <item>通过 <see cref="ICodeWhaleApiClient"/> 调用 Rust 后端 /api/* 接口；</item>
/// <item>把 SSE 流式事件增量推送回 <see cref="ChatPanel"/> 渲染；</item>
/// <item>统一异常处理：后端不可达、密钥无效、配置损坏等场景在 UI 上展示友好提示，不崩溃；</item>
/// <item>维护当前会话 ID 与推理取消令牌，支持中断任务。</item>
/// </list>
///
/// 不直接持有窗口或 UI 控件引用（除通过构造函数注入的三个面板），
/// 不实现文件 IO（持久化统一由 <see cref="AppConfig"/> 完成）。
/// </summary>
public sealed class ChatController : IDisposable
{
    private readonly ChatPanel _chat;
    private readonly FileTreeView _fileTree;
    private readonly ParameterPanel _params;
    private ICodeWhaleApiClient _client;
    private bool _ownsClient;

    private string? _currentSessionId;
    private CancellationTokenSource? _chatCts;
    private bool _running;
    private bool _disposed;

    public ChatController(ChatPanel chat, FileTreeView fileTree, ParameterPanel parameterPanel)
    {
        _chat = chat;
        _fileTree = fileTree;
        _params = parameterPanel;

        var options = new CodeWhaleClientOptions(AppConfig.Current.Api.BackendUrl);
        _client = new CodeWhaleApiClient(options);
        _ownsClient = true;

        WireEvents();
    }

    /// <summary>订阅三个面板的全部事件。</summary>
    private void WireEvents()
    {
        _chat.MessageSendRequested += OnMessageSendRequested;
        _chat.TaskStopRequested += OnTaskStopRequested;
        _chat.DiffApprovalRequested += OnDiffApprovalRequested;

        _fileTree.RootDirectoryChanged += OnRootDirectoryChanged;

        _params.BackendUrlChanged += OnBackendUrlChanged;
        _params.DeepSeekConfigChanged += OnDeepSeekConfigChanged;
        _params.InferenceParamsChanged += OnInferenceParamsChanged;
        _params.TestConnectionRequested += OnTestConnectionRequested;
        _params.ResetSessionRequested += OnResetSessionRequested;
    }

    // ────────────────────────── 启动初始化 ──────────────────────────

    /// <summary>
    /// 启动时探测后端连通性并同步配置到后端。失败不抛异常，仅更新 UI 状态。
    /// </summary>
    public async Task InitializeAsync()
    {
        await ProbeBackendAsync();
        // 启动时把本地缓存的 DeepSeek 配置推送到后端（若用户曾输入 API Key）
        await TrySyncDeepSeekConfigAsync();
        await TrySyncInferenceParamsAsync();
    }

    /// <summary>探测后端健康状态，更新右侧面板的连接指示器。</summary>
    public async Task ProbeBackendAsync()
    {
        try
        {
            var health = await _client.GetHealthAsync();
            _params.SetBackendStatus(true, $"在线 · {health.Service} v{health.Version}");
        }
        catch (CodeWhaleConnectionException)
        {
            _params.SetBackendStatus(false, "后端未启动（127.0.0.1:8787）");
        }
        catch (CodeWhaleException ex)
        {
            _params.SetBackendStatus(false, ex.Message);
        }
    }

    // ────────────────────────── 对话发送（SSE 流式） ──────────────────────────

    private async void OnMessageSendRequested(object? sender, string text)
    {
        if (_running) return;
        if (string.IsNullOrWhiteSpace(text)) return;

        // 拦截：API Key 为空时不发起请求
        if (string.IsNullOrWhiteSpace(AppConfig.Current.Api.ApiKey))
        {
            _chat.AddSystemMessage("请先在右侧面板填写 DeepSeek API 密钥。");
            return;
        }

        SetRunning(true);
        _chatCts = new CancellationTokenSource();
        var ct = _chatCts.Token;

        _chat.AddUserMessage(text);
        _chat.BeginAssistantStream();

        try
        {
            var req = new ChatRequest
            {
                Message = text,
                SessionId = _currentSessionId,
                // 覆盖本轮推理参数（与右侧面板一致）
                ReasoningEffort = AppConfig.Current.Model.ReasoningEffort,
                CacheEnabled = AppConfig.Current.Model.CacheEnabled,
                ContextLength = AppConfig.Current.Model.ContextLength
            };

            await foreach (var ev in _client.StreamChatAsync(req, ct).ConfigureAwait(false))
            {
                switch (ev)
                {
                    case SessionStreamEvent session:
                        _currentSessionId = session.SessionId;
                        break;
                    case DeltaStreamEvent delta:
                        _chat.AppendAssistantStreamChunk(delta.Content);
                        break;
                    case ReasoningStreamEvent reasoning:
                        // deepseek-reasoner 推理过程：以引用块形式追加
                        _chat.AppendAssistantStreamChunk($"\n> _{reasoning.Content}_\n");
                        break;
                    case FinishStreamEvent:
                        // 流结束信号，继续等待 done
                        break;
                    case ErrorStreamEvent err:
                        _chat.EndAssistantStream();
                        _chat.AddSystemMessage($"后端返回错误：{err.Message}");
                        break;
                    case DoneStreamEvent:
                        _chat.EndAssistantStream();
                        break;
                }
            }
        }
        catch (CodeWhaleCanceledException)
        {
            _chat.EndAssistantStream();
            _chat.AddSystemMessage("已中断当前任务。");
        }
        catch (CodeWhaleConnectionException)
        {
            _chat.EndAssistantStream();
            _chat.AddSystemMessage("无法连接 CodeWhale 后端服务，请确认 codewhale-server 已启动（默认端口 8787）。");
        }
        catch (CodeWhaleApiException ex)
        {
            _chat.EndAssistantStream();
            var hint = ex.StatusCode == System.Net.HttpStatusCode.Unauthorized
                ? "API 密钥无效或未配置，请在右侧面板检查。"
                : ex.ServerMessage ?? ex.Message;
            _chat.AddSystemMessage($"请求失败（{(int)ex.StatusCode}）：{hint}");
        }
        catch (CodeWhaleException ex)
        {
            _chat.EndAssistantStream();
            _chat.AddSystemMessage($"发生错误：{ex.Message}");
        }
        catch (OperationCanceledException)
        {
            _chat.EndAssistantStream();
        }
        catch (Exception ex)
        {
            _chat.EndAssistantStream();
            _chat.AddSystemMessage($"未知错误：{ex.Message}");
        }
        finally
        {
            SetRunning(false);
            _chatCts?.Dispose();
            _chatCts = null;
        }
    }

    private async void OnTaskStopRequested(object? sender, EventArgs e)
    {
        // 本地立即取消 SSE 读取
        try { _chatCts?.Cancel(); } catch { /* 已释放 */ }

        // 通知后端中断当前轮次（双保险：后端任务也会因流断开自动取消）
        if (!string.IsNullOrEmpty(_currentSessionId))
        {
            try { await _client.StopChatAsync(_currentSessionId); }
            catch (CodeWhaleException) { /* 中断失败不影响 UI */ }
        }
    }

    // ────────────────────────── 代码 Diff 审批 ──────────────────────────

    private async void OnDiffApprovalRequested(object? sender, DiffApprovalEventArgs e)
    {
        if (!e.IsApproved) return;
        if (string.IsNullOrEmpty(e.Diff.FilePath)) return;

        // 批准变更：通过后端 /api/tools/file/write 落盘
        // 注意：当前 Rust 后端的 /api/chat 是纯文本流，不产生结构化 Diff。
        // 此处为前向兼容：若未来 Agent 输出结构化变更，审批通过即写入文件。
        try
        {
            var content = string.Join("\n", e.Diff.Lines
                .Where(l => l.Type != DiffLineType.Removed && l.Type != DiffLineType.Header)
                .Select(l => l.Content));
            await _client.WriteFileAsync(e.Diff.FilePath, content);
            _chat.AddSystemMessage($"已应用变更到 {e.Diff.FilePath}");
        }
        catch (CodeWhaleException ex)
        {
            _chat.AddSystemMessage($"应用变更失败：{ex.Message}");
        }
    }

    // ────────────────────────── 项目目录加载 ──────────────────────────

    private async void OnRootDirectoryChanged(object? sender, string? path)
    {
        if (string.IsNullOrEmpty(path)) return;
        try
        {
            await _client.LoadProjectAsync(path);
        }
        catch (CodeWhaleConnectionException)
        {
            // 后端未启动：仅本地持久化已由 FileTreeViewModel 完成，不报错
        }
        catch (CodeWhaleException ex)
        {
            _chat.AddSystemMessage($"后端加载项目失败：{ex.Message}");
        }
    }

    // ────────────────────────── 参数面板事件 ──────────────────────────

    private void OnBackendUrlChanged(object? sender, string url)
    {
        // 重建 ApiClient（更换基地址）
        if (_ownsClient) _client.Dispose();
        var options = new CodeWhaleClientOptions(url);
        _client = new CodeWhaleApiClient(options);
        _ownsClient = true;
        _ = ProbeBackendAsync();
    }

    private async void OnDeepSeekConfigChanged(object? sender, DeepSeekConfigChangeEventArgs e)
    {
        await TrySyncDeepSeekConfigAsync(e.ApiKey, e.Model);
    }

    private async void OnInferenceParamsChanged(object? sender, InferenceParamsChangeEventArgs e)
    {
        await TrySyncInferenceParamsAsync(e.ReasoningEffort, e.CacheEnabled, e.ContextLength);
    }

    private async void OnTestConnectionRequested(object? sender, EventArgs e)
    {
        try
        {
            // 先探测后端健康
            await _client.GetHealthAsync();
            // 再探测 DeepSeek API 连通性
            await _client.TestDeepSeekAsync();
            _params.SetBackendStatus(true, "连接正常，DeepSeek API 可达");
        }
        catch (CodeWhaleConnectionException)
        {
            _params.SetBackendStatus(false, "后端未启动（127.0.0.1:8787）");
        }
        catch (CodeWhaleException ex)
        {
            // ServerMessage 仅 CodeWhaleApiException 拥有，其它异常类型退回 Message
            var msg = (ex as CodeWhaleApiException)?.ServerMessage ?? ex.Message;
            _params.SetBackendStatus(false, msg);
        }
    }

    private async void OnResetSessionRequested(object? sender, EventArgs e)
    {
        if (string.IsNullOrEmpty(_currentSessionId))
        {
            _chat.AddSystemMessage("当前无活动会话，无需重置。");
            return;
        }
        try
        {
            await _client.ResetSessionAsync(_currentSessionId);
            _chat.Clear();
            _chat.AddSystemMessage("会话上下文已重置。");
        }
        catch (CodeWhaleException ex)
        {
            _chat.AddSystemMessage($"重置会话失败：{ex.Message}");
        }
    }

    // ────────────────────────── 后端同步辅助 ──────────────────────────

    private async Task TrySyncDeepSeekConfigAsync(string? apiKey = null, string? model = null)
    {
        var key = apiKey ?? AppConfig.Current.Api.ApiKey;
        if (string.IsNullOrWhiteSpace(key)) return;

        try
        {
            var req = new SetDeepSeekRequest { ApiKey = key };
            if (!string.IsNullOrEmpty(model)) req.Model = model;
            await _client.SetDeepSeekConfigAsync(req);
        }
        catch (CodeWhaleConnectionException) { /* 后端未启动，静默 */ }
        catch (CodeWhaleException) { /* 业务错误，不阻断 UI */ }
    }

    private async Task TrySyncInferenceParamsAsync(
        ReasoningEffort? effort = null, bool? cache = null, int? ctx = null)
    {
        try
        {
            var req = new UpdateParamsRequest
            {
                ReasoningEffort = effort,
                CacheEnabled = cache,
                ContextLength = ctx
            };
            // 至少有一个字段才发送
            if (effort is null && cache is null && ctx is null)
            {
                req.ReasoningEffort = AppConfig.Current.Model.ReasoningEffort;
                req.CacheEnabled = AppConfig.Current.Model.CacheEnabled;
                req.ContextLength = AppConfig.Current.Model.ContextLength;
            }
            await _client.UpdateParamsAsync(req);
        }
        catch (CodeWhaleConnectionException) { /* 后端未启动，静默 */ }
        catch (CodeWhaleException) { /* 业务错误，不阻断 UI */ }
    }

    // ────────────────────────── 状态管理 ──────────────────────────

    private void SetRunning(bool running)
    {
        _running = running;
        _chat.SetRunning(running);
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        try { _chatCts?.Cancel(); } catch { }
        _chatCts?.Dispose();
        if (_ownsClient) _client.Dispose();
    }
}
