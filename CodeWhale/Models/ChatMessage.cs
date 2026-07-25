using System;
using System.Collections.ObjectModel;

namespace CodeWhale.Models;

/// <summary>
/// 一条对话消息。承载文本内容、工具调用日志、关联代码变更预览。
/// UI 只读该模型进行渲染；流式场景下由外部控制器增量更新 <see cref="Content"/>。
/// </summary>
public sealed class ChatMessage
{
    public string Id { get; } = Guid.NewGuid().ToString("N");

    public MessageRole Role { get; set; } = MessageRole.Assistant;

    /// <summary>消息正文（Markdown 风格，UI 解析 ``` 代码围栏）。</summary>
    public string Content { get; set; } = string.Empty;

    public DateTimeOffset Timestamp { get; set; } = DateTimeOffset.Now;

    /// <summary>是否处于流式接收中。为 true 时气泡末尾展示光标动画。</summary>
    public bool IsStreaming { get; set; }

    /// <summary>该消息关联的工具调用日志。</summary>
    public ObservableCollection<ToolCallLog> ToolCalls { get; } = new();

    /// <summary>该消息触发的代码变更预览（待审批）。</summary>
    public ObservableCollection<CodeDiff> Diffs { get; } = new();
}
