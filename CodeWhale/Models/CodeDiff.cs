using System.Collections.ObjectModel;

namespace CodeWhale.Models;

/// <summary>
/// 代码变更预览模型。表示对一个文件的 Diff 变更及其审批状态。
/// </summary>
public sealed class CodeDiff
{
    public string Id { get; } = System.Guid.NewGuid().ToString("N");

    /// <summary>受影响的文件路径。</summary>
    public string FilePath { get; set; } = string.Empty;

    /// <summary>文件语言标识（用于行内高亮），如 <c>csharp</c>、<c>python</c>。可为空。</summary>
    public string? Language { get; set; }

    /// <summary>变更类型摘要，用于审批栏展示。</summary>
    public string? Summary { get; set; }

    /// <summary>Diff 行集合。</summary>
    public ObservableCollection<DiffLine> Lines { get; } = new();

    /// <summary>当前审批状态。UI 仅修改此字段，最终是否落盘由外部控制器决定。</summary>
    public DiffApprovalState Approval { get; set; } = DiffApprovalState.Pending;
}

/// <summary>单行 Diff。</summary>
public sealed class DiffLine
{
    public DiffLineType Type { get; set; }

    /// <summary>原文件行号；新增行使用 -1。</summary>
    public int OldLineNumber { get; set; }

    /// <summary>新文件行号；删除行使用 -1。</summary>
    public int NewLineNumber { get; set; }

    /// <summary>行内容（不含前缀 +、-、空格）。</summary>
    public string Content { get; set; } = string.Empty;
}

public enum DiffLineType
{
    Context,
    Added,
    Removed,
    Header
}

public enum DiffApprovalState
{
    Pending,
    Approved,
    Rejected
}
