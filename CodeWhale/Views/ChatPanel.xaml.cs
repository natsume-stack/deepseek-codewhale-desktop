using System;
using System.Collections.ObjectModel;
using CodeWhale.Models;
using CodeWhale.Views.Controls;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace CodeWhale.Views;

/// <summary>
/// 中央对话面板。聚合消息流、流式渲染、代码变更预览与底部输入栏。
///
/// 职责边界（遵循任务约束）：
/// - 仅负责 UI 渲染与输入事件抛出；
/// - 不发起任何 HTTP/网络请求（由外部控制器 + ApiClient 完成）；
/// - 不操作左侧文件树与右侧参数面板的内部状态。
///
/// 外部控制器通过 <see cref="MessageSendRequested"/> / <see cref="TaskStopRequested"/>
/// 接收用户意图，通过 Append*/Add* 系列方法把流式数据推回 UI。
/// </summary>
public sealed partial class ChatPanel : UserControl
{
    /// <summary>全部消息（供外部只读访问）。</summary>
    public ObservableCollection<ChatMessage> Messages { get; } = new();

    /// <summary>用户请求发送消息。</summary>
    public event EventHandler<string>? MessageSendRequested;

    /// <summary>用户请求停止当前任务。</summary>
    public event EventHandler<EventArgs>? TaskStopRequested;

    /// <summary>用户对某次代码变更作出审批决定。</summary>
    public event EventHandler<DiffApprovalEventArgs>? DiffApprovalRequested;

    private ChatMessage? _streamingMessage;
    private MessageBubble? _streamingBubble;

    public ChatPanel()
    {
        InitializeComponent();
        Messages.CollectionChanged += (_, _) => UpdateEmptyState();
    }

    private void ChatPanel_Loaded(object sender, RoutedEventArgs e)
    {
        InputBar.SendRequested += (_, text) => MessageSendRequested?.Invoke(this, text);
        InputBar.StopRequested += (_, _) => TaskStopRequested?.Invoke(this, EventArgs.Empty);
        UpdateEmptyState();
    }

    // ───────────────────────── 外部推送 API ─────────────────────────

    /// <summary>追加一条用户消息并立即渲染。</summary>
    public ChatMessage AddUserMessage(string text)
    {
        var msg = new ChatMessage { Role = MessageRole.User, Content = text };
        AddMessage(msg);
        return msg;
    }

    /// <summary>追加一条系统消息。</summary>
    public ChatMessage AddSystemMessage(string text)
    {
        var msg = new ChatMessage { Role = MessageRole.System, Content = text };
        AddMessage(msg);
        return msg;
    }

    /// <summary>开始一条助手流式消息（IsStreaming=true）。若已有进行中的流，先结束它。</summary>
    public ChatMessage BeginAssistantStream()
    {
        if (_streamingMessage is not null) EndAssistantStream();

        var msg = new ChatMessage { Role = MessageRole.Assistant, IsStreaming = true };
        _streamingMessage = msg;
        _streamingBubble = AddMessage(msg);
        return msg;
    }

    /// <summary>向当前流式助手消息追加文本增量。</summary>
    public void AppendAssistantStreamChunk(string chunk)
    {
        if (string.IsNullOrEmpty(chunk)) return;
        EnsureStreamingMessage();
        _streamingMessage!.Content += chunk;
        _streamingBubble?.Render();
        ScrollToBottomIfNear();
    }

    /// <summary>向当前流式助手消息附加一次工具调用日志。</summary>
    public void AddToolCall(ToolCallLog log)
    {
        EnsureStreamingMessage();
        _streamingMessage!.ToolCalls.Add(log);
        _streamingBubble?.Render();
        ScrollToBottomIfNear();
    }

    /// <summary>向当前流式助手消息附加一份代码变更预览（待审批）。</summary>
    public void AddDiff(CodeDiff diff)
    {
        EnsureStreamingMessage();
        _streamingMessage!.Diffs.Add(diff);
        _streamingBubble?.Render();
        ScrollToBottomIfNear();
    }

    /// <summary>结束当前流式助手消息。</summary>
    public void EndAssistantStream()
    {
        if (_streamingMessage is null) return;
        _streamingMessage.IsStreaming = false;
        _streamingBubble?.Render();
        _streamingMessage = null;
        _streamingBubble = null;
    }

    /// <summary>设置任务运行状态（控制输入栏的发送/停止按钮）。</summary>
    public void SetRunning(bool running) => InputBar.IsRunning = running;

    /// <summary>更新顶栏 Token 计数 chip。</summary>
    public void UpdateTokenCount(int totalTokens)
    {
        TokenCountChip.Text = totalTokens > 0 ? $"{totalTokens} tokens" : "0 tokens";
    }

    /// <summary>显示 Diff 预览面板并绑定指定变更。</summary>
    public void ShowDiff(CodeDiff diff)
    {
        DiffPreview.Diff = diff;
        DiffPanelContainer.Visibility = Visibility.Visible;
    }

    /// <summary>隐藏 Diff 预览面板。</summary>
    public void HideDiff()
    {
        DiffPanelContainer.Visibility = Visibility.Collapsed;
        DiffPreview.Diff = null;
    }

    /// <summary>清空全部消息。</summary>
    public void Clear()
    {
        EndAssistantStream();
        Messages.Clear();
        MessagesPanel.Children.Clear();
        HideDiff();
        UpdateEmptyState();
        UpdateTokenCount(0);
    }

    // ───────────────────────── 内部实现 ─────────────────────────

    private MessageBubble AddMessage(ChatMessage msg)
    {
        Messages.Add(msg);
        var bubble = new MessageBubble();
        bubble.Bind(msg);
        bubble.DiffApprovalRequested += (_, e) => DiffApprovalRequested?.Invoke(this, e);
        MessagesPanel.Children.Add(bubble);
        ScrollToBottom();
        return bubble;
    }

    private void EnsureStreamingMessage()
    {
        if (_streamingMessage is null) BeginAssistantStream();
    }

    private void ScrollToBottom()
    {
        // 等待布局完成后再滚动
        DispatcherQueue.TryEnqueue(() =>
        {
            MessagesScroll.UpdateLayout();
            MessagesScroll.ChangeView(null, MessagesScroll.ScrollableHeight, null);
        });
    }

    private void ScrollToBottomIfNear()
    {
        DispatcherQueue.TryEnqueue(() =>
        {
            MessagesScroll.UpdateLayout();
            bool nearBottom = MessagesScroll.ScrollableHeight - MessagesScroll.VerticalOffset <= 120;
            if (nearBottom)
            {
                MessagesScroll.ChangeView(null, MessagesScroll.ScrollableHeight, null);
            }
        });
    }

    private void UpdateEmptyState()
    {
        EmptyState.Visibility = Messages.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
    }

    private void ClearButton_Click(object sender, RoutedEventArgs e) => Clear();

    /// <summary>关闭 Diff 预览面板。</summary>
    private void CloseDiffButton_Click(object sender, RoutedEventArgs e) => HideDiff();
}
