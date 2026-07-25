using System;
using System.Collections.Generic;
using System.Text;
using CodeWhale.Models;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;

namespace CodeWhale.Views.Controls;

/// <summary>
/// 单条消息气泡。按角色区分样式，解析正文中的 ``` 代码围栏渲染代码块，
/// 展示工具调用日志与代码变更预览。<see cref="Render"/> 由外部（ChatPanel）在内容变化后调用。
/// </summary>
public sealed partial class MessageBubble : UserControl
{
    /// <summary>当前绑定的消息。</summary>
    public ChatMessage? Message { get; private set; }

    /// <summary>审批事件转发（来自内嵌的 DiffPreviewView）。</summary>
    public event EventHandler<DiffApprovalEventArgs>? DiffApprovalRequested;

    public MessageBubble()
    {
        InitializeComponent();
    }

    /// <summary>绑定消息并首次渲染。</summary>
    public void Bind(ChatMessage message)
    {
        Message = message;
        Render();
    }

    /// <summary>重新渲染整条消息（流式增量后调用）。</summary>
    public void Render()
    {
        var msg = Message;
        if (msg is null) return;

        ApplyRoleStyle(msg.Role);
        RoleText.Text = RoleLabel(msg.Role);
        TimeText.Text = msg.Timestamp.ToString("HH:mm");

        RenderContent(msg.Content);
        RenderToolCalls(msg);
        RenderDiffs(msg);

        StreamingIndicator.Visibility = msg.IsStreaming ? Visibility.Visible : Visibility.Collapsed;
    }

    private void ApplyRoleStyle(MessageRole role)
    {
        Bubble.HorizontalAlignment = role switch
        {
            MessageRole.User => HorizontalAlignment.Right,
            MessageRole.System => HorizontalAlignment.Center,
            _ => HorizontalAlignment.Left
        };
        Bubble.MaxWidth = role == MessageRole.System ? 560 : 760;
    }

    private static string RoleLabel(MessageRole role) => role switch
    {
        MessageRole.User => "你",
        MessageRole.Assistant => "助手",
        MessageRole.Tool => "工具调用",
        MessageRole.System => "系统",
        _ => "消息"
    };

    /// <summary>
    /// 解析正文：按 ``` 围栏切分为文本段与代码段，依次加入 ContentPanel。
    /// 未闭合的代码块（流式中）按代码段渲染。
    /// </summary>
    private void RenderContent(string content)
    {
        ContentPanel.Children.Clear();
        if (string.IsNullOrEmpty(content)) return;

        var segments = ParseContent(content);
        foreach (var seg in segments)
        {
            if (seg.IsCode)
            {
                ContentPanel.Children.Add(new CodeBlockView
                {
                    Code = seg.Text,
                    Language = seg.Language ?? "text",
                    Margin = new Thickness(0, 2, 0, 2)
                });
            }
            else
            {
                var text = seg.Text.TrimEnd('\r', '\n');
                if (string.IsNullOrEmpty(text)) continue;
                ContentPanel.Children.Add(new TextBlock
                {
                    Text = text,
                    TextWrapping = TextWrapping.Wrap,
                    IsTextSelectionEnabled = true,
                    Foreground = (Brush)Application.Current.Resources["TextFillColorPrimaryBrush"]
                });
            }
        }
    }

    private static IReadOnlyList<ContentSegment> ParseContent(string content)
    {
        var result = new List<ContentSegment>();
        var buffer = new StringBuilder();
        bool inCode = false;
        string? lang = null;

        foreach (var rawLine in content.Split('\n'))
        {
            var line = rawLine.TrimEnd('\r');
            if (line.StartsWith("```"))
            {
                if (inCode)
                {
                    result.Add(new ContentSegment(true, buffer.ToString(), lang));
                    buffer.Clear();
                    inCode = false;
                    lang = null;
                }
                else
                {
                    if (buffer.Length > 0)
                    {
                        result.Add(new ContentSegment(false, buffer.ToString(), null));
                        buffer.Clear();
                    }
                    inCode = true;
                    lang = line.Substring(3).Trim();
                    if (string.IsNullOrEmpty(lang)) lang = "text";
                }
                continue;
            }
            buffer.AppendLine(line);
        }

        if (buffer.Length > 0)
        {
            result.Add(new ContentSegment(inCode, buffer.ToString(), inCode ? lang : null));
        }
        return result;
    }

    private void RenderToolCalls(ChatMessage msg)
    {
        ToolCallsPanel.Children.Clear();
        foreach (var call in msg.ToolCalls)
        {
            ToolCallsPanel.Children.Add(BuildToolCall(call));
        }
    }

    private UIElement BuildToolCall(ToolCallLog call)
    {
        var expander = new Expander
        {
            HorizontalAlignment = HorizontalAlignment.Stretch,
            HorizontalContentAlignment = HorizontalAlignment.Stretch,
            IsExpanded = call.Status != ToolCallStatus.Succeeded,
            Header = BuildToolCallHeader(call)
        };

        var body = new StackPanel { Spacing = 8 };
        if (!string.IsNullOrEmpty(call.Arguments))
        {
            body.Children.Add(new TextBlock
            {
                Text = "入参",
                Style = (Style)Application.Current.Resources["CaptionTextBlockStyle"],
                Foreground = (Brush)Application.Current.Resources["TextFillColorSecondaryBrush"]
            });
            body.Children.Add(new CodeBlockView { Code = call.Arguments, Language = "json" });
        }
        if (!string.IsNullOrEmpty(call.Result))
        {
            body.Children.Add(new TextBlock
            {
                Text = "结果",
                Style = (Style)Application.Current.Resources["CaptionTextBlockStyle"],
                Foreground = (Brush)Application.Current.Resources["TextFillColorSecondaryBrush"]
            });
            body.Children.Add(new CodeBlockView { Code = call.Result, Language = "text" });
        }
        if (call.Status == ToolCallStatus.Running && string.IsNullOrEmpty(call.Result))
        {
            body.Children.Add(new TextBlock
            {
                Text = "执行中…",
                Style = (Style)Application.Current.Resources["CaptionTextBlockStyle"],
                Foreground = (Brush)Application.Current.Resources["TextFillColorSecondaryBrush"]
            });
        }
        expander.Content = body;
        return expander;
    }

    private UIElement BuildToolCallHeader(ToolCallLog call)
    {
        var panel = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8 };
        panel.Children.Add(new TextBlock
        {
            Text = call.ToolName,
            FontFamily = new FontFamily("Cascadia Code, Consolas"),
            FontWeight = Microsoft.UI.Text.FontWeights.SemiBold
        });

        var status = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 4 };
        switch (call.Status)
        {
            case ToolCallStatus.Running:
                status.Children.Add(new ProgressRing { Width = 12, Height = 12, IsActive = true });
                status.Children.Add(new TextBlock { Text = "运行中", FontSize = 11, Foreground = (Brush)Application.Current.Resources["TextFillColorSecondaryBrush"] });
                break;
            case ToolCallStatus.Succeeded:
                status.Children.Add(new FontIcon { Glyph = "\uE73E", FontSize = 12, Foreground = new SolidColorBrush(Windows.UI.Color.FromArgb(255, 16, 124, 16)) });
                status.Children.Add(new TextBlock { Text = "成功", FontSize = 11, Foreground = (Brush)Application.Current.Resources["TextFillColorSecondaryBrush"] });
                break;
            case ToolCallStatus.Failed:
                status.Children.Add(new FontIcon { Glyph = "\uE711", FontSize = 12, Foreground = new SolidColorBrush(Windows.UI.Color.FromArgb(255, 197, 15, 31)) });
                status.Children.Add(new TextBlock { Text = "失败", FontSize = 11, Foreground = (Brush)Application.Current.Resources["TextFillColorSecondaryBrush"] });
                break;
        }
        panel.Children.Add(status);
        return panel;
    }

    private void RenderDiffs(ChatMessage msg)
    {
        DiffsPanel.Children.Clear();
        foreach (var diff in msg.Diffs)
        {
            var view = new DiffPreviewView { Diff = diff };
            view.ApprovalRequested += (s, e) => DiffApprovalRequested?.Invoke(this, e);
            DiffsPanel.Children.Add(view);
        }
    }

    private readonly struct ContentSegment
    {
        public ContentSegment(bool isCode, string text, string? language)
        { IsCode = isCode; Text = text; Language = language; }
        public bool IsCode { get; }
        public string Text { get; }
        public string? Language { get; }
    }
}
