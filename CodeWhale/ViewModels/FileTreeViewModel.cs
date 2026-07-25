using System.Collections.ObjectModel;
using System.ComponentModel;
using System.IO;
using System.Runtime.CompilerServices;
using CodeWhale.Models;
using CodeWhale.Services;
using CodeWhale.Storage;

namespace CodeWhale.ViewModels;

/// <summary>
/// 文件树视图模型。负责加载/刷新目录、维护上下文文件集合。
/// 路径持久化复用 <see cref="AppConfig"/>；不直接依赖 UI 控件。
/// </summary>
public sealed class FileTreeViewModel : INotifyPropertyChanged
{
    private readonly IFileExplorerService _explorer;

    /// <summary>根级节点（项目根目录的直接子项）。</summary>
    public ObservableCollection<FileNode> RootNodes { get; } = new();

    /// <summary>已加入 AI 上下文的文件集合。</summary>
    public ObservableCollection<FileNode> ContextFiles { get; } = new();

    private string? _rootPath;
    /// <summary>当前项目根目录绝对路径。</summary>
    public string? RootPath
    {
        get => _rootPath;
        private set { if (_rootPath != value) { _rootPath = value; OnPropertyChanged(); } }
    }

    public FileTreeViewModel(IFileExplorerService explorer)
    {
        _explorer = explorer;
    }

    /// <summary>读取持久化的根目录路径（不自动加载树）。</summary>
    public Task<string?> LoadPersistedRootPathAsync(CancellationToken ct = default)
    {
        return Task.Run<string?>(() =>
        {
            var dir = AppConfig.Current.Project.LastProjectDirectory;
            return string.IsNullOrWhiteSpace(dir) ? null : dir;
        }, ct);
    }

    /// <summary>
    /// 设置新的项目根目录：清空树与上下文、持久化路径、加载顶层节点。
    /// </summary>
    public async Task SetRootAsync(string path, CancellationToken ct = default)
    {
        RootNodes.Clear();
        ContextFiles.Clear();
        RootPath = path;

        PersistRootPath(path);

        var entries = await _explorer.EnumerateEntriesAsync(path, ct);
        foreach (var n in entries) RootNodes.Add(n);
    }

    /// <summary>
    /// 懒加载某个文件夹节点的子项（仅在首次展开时调用）。
    /// </summary>
    public async Task LoadChildrenAsync(FileNode node, CancellationToken ct = default)
    {
        if (!node.IsFolder || node.HasLoadedChildren) return;

        var entries = await _explorer.EnumerateEntriesAsync(node.FullPath, ct);
        node.Children.Clear();
        foreach (var c in entries) node.Children.Add(c);
        node.HasLoadedChildren = true;
    }

    /// <summary>
    /// 刷新目录。target 为 null 时刷新整棵树（重新加载根）；
    /// 否则刷新指定文件夹节点（保留其位置，重载其子项）。
    /// </summary>
    public async Task RefreshAsync(FileNode? target, CancellationToken ct = default)
    {
        if (target is null)
        {
            if (string.IsNullOrEmpty(RootPath) || !Directory.Exists(RootPath)) return;
            await SetRootAsync(RootPath, ct);
            return;
        }

        if (!target.IsFolder) return;
        target.HasLoadedChildren = false;
        await LoadChildrenAsync(target, ct);
    }

    /// <summary>把文件节点加入上下文集合（去重；文件夹忽略）。</summary>
    public bool AddToContext(FileNode node)
    {
        if (node.IsFolder) return false;
        if (ContextFiles.Contains(node)) return false;
        ContextFiles.Add(node);
        return true;
    }

    /// <summary>从上下文集合中移除。</summary>
    public bool RemoveFromContext(FileNode node) => ContextFiles.Remove(node);

    private static void PersistRootPath(string? path)
    {
        try
        {
            AppConfig.Current.Project.LastProjectDirectory = path ?? string.Empty;
            AppConfig.Save();
        }
        catch
        {
            // 持久化失败不应阻断树加载
        }
    }

    public event PropertyChangedEventHandler? PropertyChanged;
    private void OnPropertyChanged([CallerMemberName] string? p = null)
        => PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(p));
}
