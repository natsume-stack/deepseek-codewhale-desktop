using System;

namespace CodeWhale.Models;

/// <summary>
/// 工具调用日志条目。描述一次工具调用的名称、入参、结果与执行状态。
/// </summary>
public sealed class ToolCallLog
{
    public string Id { get; } = Guid.NewGuid().ToString("N");

    /// <summary>工具名称，例如 <c>read_file</c>、<c>apply_patch</c>。</summary>
    public string ToolName { get; set; } = string.Empty;

    /// <summary>调用入参（通常是 JSON 文本，UI 以代码块形式呈现）。</summary>
    public string? Arguments { get; set; }

    /// <summary>调用结果。流式场景下可能为空，调用结束后回填。</summary>
    public string? Result { get; set; }

    /// <summary>执行状态。</summary>
    public ToolCallStatus Status { get; set; } = ToolCallStatus.Running;

    public DateTimeOffset Timestamp { get; set; } = DateTimeOffset.Now;
}

public enum ToolCallStatus
{
    Running,
    Succeeded,
    Failed
}
