namespace CodeWhale.Models;

/// <summary>
/// 消息角色，用于区分气泡样式与渲染位置。
/// </summary>
public enum MessageRole
{
    /// <summary>用户输入。</summary>
    User,

    /// <summary>Agent 回复（支持流式增量）。</summary>
    Assistant,

    /// <summary>工具调用日志条目。</summary>
    Tool,

    /// <summary>系统提示/错误信息。</summary>
    System
}
