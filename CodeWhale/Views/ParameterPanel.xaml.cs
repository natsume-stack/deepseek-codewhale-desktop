using System;
using System.Linq;
using CodeWhale.Storage;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;

namespace CodeWhale.Views;

/// <summary>
/// 右侧参数控制面板。承载 API 密钥、后端地址、模型选择、推理强度、缓存开关、
/// 上下文长度与会话重置功能。
///
/// 职责边界（与 ChatPanel、FileTreeView 一致）：
/// - 仅负责 UI 渲染与输入事件抛出；
/// - 不直接调用 ApiClient（由外部 ChatController 订阅事件并下发后端）；
/// - 本地持久化通过 <see cref="AppConfig"/> 完成，不在面板内做 IO 之外的副作用。
///
/// 外部控制器通过下列事件接收用户意图：
/// <list type="bullet">
/// <item><see cref="BackendUrlChanged"/>：后端地址变更（需重建 ApiClient）。</item>
/// <item><see cref="DeepSeekConfigChanged"/>：API Key / 模型 / BaseUrl 变更（需 PUT /api/config/deepseek）。</item>
/// <item><see cref="InferenceParamsChanged"/>：推理参数变更（需 PUT /api/params）。</item>
/// <item><see cref="TestConnectionRequested"/>：用户点击"测试连接"（需 POST /api/config/deepseek/test）。</item>
/// <item><see cref="ResetSessionRequested"/>：用户点击"重置会话"（需 POST /api/sessions/:id/reset）。</item>
/// </list>
/// </summary>
public sealed partial class ParameterPanel : UserControl
{
    /// <summary>后端地址变更。参数为新的 URL 字符串。</summary>
    public event EventHandler<string>? BackendUrlChanged;

    /// <summary>DeepSeek 配置（API Key / 模型）变更。</summary>
    public event EventHandler<DeepSeekConfigChangeEventArgs>? DeepSeekConfigChanged;

    /// <summary>推理参数（强度 / 缓存 / 上下文长度）变更。</summary>
    public event EventHandler<InferenceParamsChangeEventArgs>? InferenceParamsChanged;

    /// <summary>用户点击"测试连接"。</summary>
    public event EventHandler<EventArgs>? TestConnectionRequested;

    /// <summary>用户点击"重置当前会话"。</summary>
    public event EventHandler<EventArgs>? ResetSessionRequested;

    private bool _isLoading;

    public ParameterPanel()
    {
        InitializeComponent();
    }

    /// <summary>面板加载时从 AppConfig 回填所有字段。</summary>
    private void ParameterPanel_Loaded(object sender, RoutedEventArgs e)
    {
        LoadFromConfig();

        BackendUrlBox.TextChanged += (_, _) => OnBackendUrlChanged();
        ApiKeyBox.PasswordChanged += (_, _) => OnDeepSeekConfigChanged();
        ModelSelector.SelectionChanged += (_, _) => OnDeepSeekConfigChanged();
        ReasoningEffortSelector.SelectionChanged += (_, _) => OnInferenceParamsChanged();
        CacheToggle.Toggled += (_, _) => OnInferenceParamsChanged();
        ContextLengthBox.ValueChanged += (_, _) => OnInferenceParamsChanged();
    }

    /// <summary>从 AppConfig 当前配置回填全部 UI 字段（不触发变更事件）。</summary>
    public void LoadFromConfig()
    {
        _isLoading = true;
        try
        {
            var cfg = AppConfig.Current;
            BackendUrlBox.Text = cfg.Api.BackendUrl;
            ApiKeyBox.Password = cfg.Api.ApiKey;

            var model = cfg.Model.Model;
            var idx = ModelSelector.Items.IndexOf(model);
            ModelSelector.SelectedIndex = idx >= 0 ? idx : 0;

            SelectReasoningEffort(cfg.Model.ReasoningEffort);
            CacheToggle.IsOn = cfg.Model.CacheEnabled;
            ContextLengthBox.Value = cfg.Model.ContextLength;
        }
        finally
        {
            _isLoading = false;
        }
    }

    /// <summary>由外部控制器调用：更新后端连接状态指示器。</summary>
    /// <param name="online">后端是否在线。</param>
    /// <param name="message">展示给用户的状态文本（如版本号、错误信息）。</param>
    public void SetBackendStatus(bool online, string? message = null)
    {
        DispatcherQueue.TryEnqueue(() =>
        {
            StatusDot.Fill = new SolidColorBrush(
                online ? Microsoft.UI.Colors.DarkGreen : Microsoft.UI.Colors.Crimson);
            StatusText.Text = online
                ? (message ?? "后端在线")
                : (message ?? "后端离线");
            StatusRing.IsActive = false;
        });
    }

    /// <summary>显示"检测中"状态（用户点击测试连接时调用）。</summary>
    public void SetCheckingStatus()
    {
        DispatcherQueue.TryEnqueue(() =>
        {
            StatusRing.IsActive = true;
            StatusText.Text = "正在检测后端…";
        });
    }

    private void OnBackendUrlChanged()
    {
        if (_isLoading) return;
        var url = BackendUrlBox.Text?.Trim() ?? string.Empty;
        if (string.IsNullOrEmpty(url)) return;

        // 持久化到本地
        try
        {
            AppConfig.Current.Api.BackendUrl = url;
            AppConfig.Save();
        }
        catch { /* 持久化失败不阻断 UI */ }

        BackendUrlChanged?.Invoke(this, url);
    }

    private void OnDeepSeekConfigChanged()
    {
        if (_isLoading) return;

        var apiKey = ApiKeyBox.Password ?? string.Empty;
        var model = ModelSelector.SelectedItem as string ?? "deepseek-chat";

        try
        {
            AppConfig.Current.Api.ApiKey = apiKey;
            AppConfig.Current.Model.Model = model;
            AppConfig.Save();
        }
        catch { /* 持久化失败不阻断 UI */ }

        DeepSeekConfigChanged?.Invoke(this, new DeepSeekConfigChangeEventArgs(apiKey, model));
    }

    private void OnInferenceParamsChanged()
    {
        if (_isLoading) return;

        var effort = GetSelectedReasoningEffort();
        var cache = CacheToggle.IsOn;
        var ctx = (int)Math.Max(1, ContextLengthBox.Value);

        try
        {
            AppConfig.Current.Model.ReasoningEffort = effort;
            AppConfig.Current.Model.CacheEnabled = cache;
            AppConfig.Current.Model.ContextLength = ctx;
            AppConfig.Save();
        }
        catch { /* 持久化失败不阻断 UI */ }

        InferenceParamsChanged?.Invoke(this, new InferenceParamsChangeEventArgs(effort, cache, ctx));
    }

    private void SelectReasoningEffort(ReasoningEffort effort)
    {
        for (int i = 0; i < ReasoningEffortSelector.Items.Count; i++)
        {
            if (ReasoningEffortSelector.Items[i] is RadioButton rb && rb.Tag is string s
                && Enum.TryParse<ReasoningEffort>(s, out var re) && re == effort)
            {
                ReasoningEffortSelector.SelectedIndex = i;
                return;
            }
        }
        ReasoningEffortSelector.SelectedIndex = 2; // 默认 Medium
    }

    private ReasoningEffort GetSelectedReasoningEffort()
    {
        if (ReasoningEffortSelector.SelectedItem is RadioButton rb && rb.Tag is string s
            && Enum.TryParse<ReasoningEffort>(s, out var re))
        {
            return re;
        }
        return ReasoningEffort.Medium;
    }

    private void TestConnection_Click(object sender, RoutedEventArgs e)
    {
        SetCheckingStatus();
        TestConnectionRequested?.Invoke(this, EventArgs.Empty);
    }

    private void ResetSession_Click(object sender, RoutedEventArgs e)
        => ResetSessionRequested?.Invoke(this, EventArgs.Empty);
}

/// <summary>DeepSeek 配置变更事件参数。</summary>
public sealed class DeepSeekConfigChangeEventArgs : EventArgs
{
    public DeepSeekConfigChangeEventArgs(string apiKey, string model)
    {
        ApiKey = apiKey;
        Model = model;
    }

    /// <summary>用户输入的 API 密钥（可能为空）。</summary>
    public string ApiKey { get; }

    /// <summary>选择的模型名（deepseek-chat / deepseek-reasoner）。</summary>
    public string Model { get; }
}

/// <summary>推理参数变更事件参数。</summary>
public sealed class InferenceParamsChangeEventArgs : EventArgs
{
    public InferenceParamsChangeEventArgs(ReasoningEffort effort, bool cacheEnabled, int contextLength)
    {
        ReasoningEffort = effort;
        CacheEnabled = cacheEnabled;
        ContextLength = contextLength;
    }

    public ReasoningEffort ReasoningEffort { get; }
    public bool CacheEnabled { get; }
    public int ContextLength { get; }
}
