using System.Collections.ObjectModel;
using System.IO;

namespace CodeWhale.Models;

/// <summary>
/// 文件树节点。同时作为 TreeView 数据源与上下文文件集合元素。
/// 文件夹节点支持懒加载子项（由 <see cref="ViewModels.FileTreeViewModel"/> 触发）。
/// </summary>
public sealed class FileNode
{
    /// <summary>显示名称（不含父路径）。</summary>
    public string Name { get; }

    /// <summary>绝对路径。</summary>
    public string FullPath { get; }

    /// <summary>是否为文件夹。</summary>
    public bool IsFolder { get; }

    /// <summary>子节点集合。文件夹专属，文件节点保持空集合。</summary>
    public ObservableCollection<FileNode> Children { get; } = new();

    /// <summary>是否已完成首次子项加载（懒加载标记，避免重复扫描）。</summary>
    public bool HasLoadedChildren { get; set; }

    /// <summary>
    /// Segoe MDL2 Assets 图标字形，根据是否文件夹及扩展名自动选择。
    /// </summary>
    public string IconGlyph => IsFolder ? "\uE8B7" : GetFileIconGlyph(Name);

    public FileNode(string name, string fullPath, bool isFolder)
    {
        Name = name;
        FullPath = fullPath;
        IsFolder = isFolder;
    }

    private static string GetFileIconGlyph(string name)
    {
        var ext = Path.GetExtension(name).ToLowerInvariant();
        return ext switch
        {
            ".cs" or ".csproj" or ".sln" => "\uE943",   // 代码
            ".rs" => "\uE943",
            ".py" => "\uE943",
            ".ts" or ".tsx" or ".js" or ".jsx" => "\uE943",
            ".json" => "\uE8F1",                          // 数据
            ".xml" or ".xaml" => "\uE8F1",
            ".toml" or ".yaml" or ".yml" => "\uE8F1",
            ".md" or ".txt" => "\uE8A5",                  // 文档
            ".png" or ".jpg" or ".jpeg" or ".gif" or ".bmp" or ".svg" => "\uEB9F", // 图片
            _ => "\uE7C3"                                  // 通用文件
        };
    }
}
