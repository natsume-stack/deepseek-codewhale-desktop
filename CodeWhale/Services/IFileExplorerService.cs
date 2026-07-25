using CodeWhale.Models;

namespace CodeWhale.Services;

/// <summary>
/// 文件浏览服务抽象。负责单层目录枚举，由 <see cref="FileExplorerService"/> 实现。
/// 懒加载策略下，调用方按需展开文件夹时调用 <see cref="EnumerateEntriesAsync"/>。
/// </summary>
public interface IFileExplorerService
{
    /// <summary>需忽略的目录/文件名集合（不区分大小写）。</summary>
    HashSet<string> IgnoredEntries { get; }

    /// <summary>
    /// 枚举指定目录下的直接子项（文件夹优先，各自按名称排序）。
    /// 权限不足或目录不存在时返回空列表，不抛异常。
    /// </summary>
    /// <param name="parentPath">要枚举的父目录绝对路径。</param>
    /// <param name="ct">取消令牌。</param>
    /// <returns>子项节点只读列表。</returns>
    Task<IReadOnlyList<FileNode>> EnumerateEntriesAsync(string parentPath, CancellationToken ct = default);
}
