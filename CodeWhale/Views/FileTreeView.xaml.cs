using System;
using System.Collections.Generic;
using System.Collections.Specialized;
using System.ComponentModel;
using System.IO;
using System.Linq;
using System.Runtime.CompilerServices;
using System.Threading.Tasks;
using CodeWhale.Models;
using CodeWhale.Services;
using CodeWhale.ViewModels;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Windows.ApplicationModel.DataTransfer;
using Windows.Storage.Pickers;
using WinRT.Interop;

namespace CodeWhale.Views;

/// <summary>
/// 左侧项目文件树控件。对外仅暴露事件，不与中央/右侧面板强耦合。
/// </summary>
public sealed partial class FileTreeView : UserControl, INotifyPropertyChanged
{
    /// <summary>根目录变更（打开/清除项目）。参数为新的绝对路径，或 null。</summary>
    public event EventHandler<string?>? RootDirectoryChanged;

    /// <summary>用户点击选中某个文件（文件夹不触发）。</summary>
    public event EventHandler<FileNode>? FileSelected;

    /// <summary>上下文文件集合发生变化。参数为当前上下文快照。</summary>
    public event EventHandler<IReadOnlyList<FileNode>>? ContextFilesChanged;

    public FileTreeViewModel ViewModel { get; }

    /// <summary>底部上下文面板可见性（有上下文文件时显示）。</summary>
    public Visibility ContextPanelVisibility =>
        ViewModel.ContextFiles.Count > 0 ? Visibility.Visible : Visibility.Collapsed;

    public FileTreeView()
    {
        ViewModel = new FileTreeViewModel(new FileExplorerService());
        InitializeComponent();
        ViewModel.ContextFiles.CollectionChanged += OnContextFilesChanged;
    }

    private async void FileTreeView_Loaded(object sender, RoutedEventArgs e)
    {
        var path = await ViewModel.LoadPersistedRootPathAsync();
        if (!string.IsNullOrWhiteSpace(path) && Directory.Exists(path))
        {
            await ViewModel.SetRootAsync(path);
            UpdateChrome();
            RootDirectoryChanged?.Invoke(this, path);
        }
    }

    private async void OpenFolder_Click(object sender, RoutedEventArgs e)
    {
        var picker = new FolderPicker
        {
            SuggestedStartLocation = PickerLocationId.ComputerFolder,
            ViewMode = PickerViewMode.List
        };
        picker.FileTypeFilter.Add("*");

        // unpackaged / WinUI 3 桌面应用需要显式关联窗口句柄
        var hwnd = WindowNative.GetWindowHandle(App.MainWindow);
        InitializeWithWindow.Initialize(picker, hwnd);

        var folder = await picker.PickSingleFolderAsync();
        if (folder is null) return;

        await ViewModel.SetRootAsync(folder.Path);
        UpdateChrome();
        RootDirectoryChanged?.Invoke(this, folder.Path);
    }

    private async void Refresh_Click(object sender, RoutedEventArgs e)
        => await ViewModel.RefreshAsync(null);

    /// <summary>新建文件：弹出输入对话框，在根目录或选中文件夹下创建。</summary>
    private async void NewFile_Click(object sender, RoutedEventArgs e)
    {
        var name = await PromptForName("新建文件", "输入文件名（如 newfile.cs）");
        if (string.IsNullOrWhiteSpace(name)) return;

        var targetDir = ResolveTargetDirectory();
        if (targetDir is null) return;

        try
        {
            var fullPath = Path.Combine(targetDir, name);
            File.Create(fullPath).Dispose();
            await ViewModel.RefreshAsync(null);
        }
        catch (Exception ex)
        {
            await ShowErrorAsync("创建文件失败", ex.Message);
        }
    }

    /// <summary>新建文件夹：弹出输入对话框，在根目录或选中文件夹下创建。</summary>
    private async void NewFolder_Click(object sender, RoutedEventArgs e)
    {
        var name = await PromptForName("新建文件夹", "输入文件夹名");
        if (string.IsNullOrWhiteSpace(name)) return;

        var targetDir = ResolveTargetDirectory();
        if (targetDir is null) return;

        try
        {
            var fullPath = Path.Combine(targetDir, name);
            Directory.CreateDirectory(fullPath);
            await ViewModel.RefreshAsync(null);
        }
        catch (Exception ex)
        {
            await ShowErrorAsync("创建文件夹失败", ex.Message);
        }
    }

    /// <summary>根据当前选中节点解析新建操作的目标目录。</summary>
    private string? ResolveTargetDirectory()
    {
        if (Tree.SelectedNode?.Content is FileNode selected)
        {
            return selected.IsFolder ? selected.FullPath : Path.GetDirectoryName(selected.FullPath);
        }
        return ViewModel.RootPath;
    }

    private void Tree_ItemInvoked(TreeView sender, TreeViewItemInvokedEventArgs e)
    {
        if (e.InvokedItem is FileNode node && !node.IsFolder)
        {
            FileSelected?.Invoke(this, node);
        }
    }

    private async void Tree_Expanding(TreeView sender, TreeViewExpandingEventArgs args)
    {
        if (args.Node.Content is FileNode node && node.IsFolder && !node.HasLoadedChildren)
        {
            await ViewModel.LoadChildrenAsync(node);
        }
    }

    private void Tree_RightTapped(object sender, RightTappedRoutedEventArgs e)
    {
        var node = ResolveNode(e.OriginalSource);
        var menu = new MenuFlyout();

        // 通用：复制路径
        var copyPathItem = new MenuFlyoutItem
        {
            Text = "复制路径",
            Icon = new FontIcon { Glyph = "\uE8C8" }
        };
        copyPathItem.Click += (_, _) => CopyToClipboard(node?.FullPath ?? ViewModel.RootPath);
        menu.Items.Add(copyPathItem);

        if (node is null)
        {
            // 空白处：仅新建
            if (ViewModel.RootPath is not null)
            {
                menu.Items.Add(new MenuFlyoutSeparator());
                AddNewItem(menu);
            }
        }
        else if (node.IsFolder)
        {
            menu.Items.Add(new MenuFlyoutSeparator());

            // 文件夹：新建 / 刷新 / 删除 / 重命名
            AddNewItem(menu);

            var refreshItem = new MenuFlyoutItem
            {
                Text = "刷新目录",
                Icon = new FontIcon { Glyph = "\uE72C" }
            };
            refreshItem.Click += async (_, _) => await ViewModel.RefreshAsync(node);
            menu.Items.Add(refreshItem);

            var renameItem = new MenuFlyoutItem
            {
                Text = "重命名",
                Icon = new FontIcon { Glyph = "\uE8AC" }
            };
            renameItem.Click += async (_, _) => await RenameNodeAsync(node);
            menu.Items.Add(renameItem);

            var deleteItem = new MenuFlyoutItem
            {
                Text = "删除",
                Icon = new FontIcon { Glyph = "\uE74D" }
            };
            deleteItem.Click += async (_, _) => await DeleteNodeAsync(node);
            menu.Items.Add(deleteItem);
        }
        else
        {
            menu.Items.Add(new MenuFlyoutSeparator());

            // 文件：加入上下文 / 重命名 / 删除
            var alreadyInContext = ViewModel.ContextFiles.Contains(node);
            var addCtx = new MenuFlyoutItem
            {
                Text = alreadyInContext ? "已在上下文中" : "加入上下文",
                Icon = new FontIcon { Glyph = "\uE748" },
                IsEnabled = !alreadyInContext
            };
            addCtx.Click += (_, _) => ViewModel.AddToContext(node);
            menu.Items.Add(addCtx);

            var renameItem = new MenuFlyoutItem
            {
                Text = "重命名",
                Icon = new FontIcon { Glyph = "\uE8AC" }
            };
            renameItem.Click += async (_, _) => await RenameNodeAsync(node);
            menu.Items.Add(renameItem);

            var deleteItem = new MenuFlyoutItem
            {
                Text = "删除",
                Icon = new FontIcon { Glyph = "\uE74D" }
            };
            deleteItem.Click += async (_, _) => await DeleteNodeAsync(node);
            menu.Items.Add(deleteItem);
        }

        menu.ShowAt(Tree, e.GetPosition(Tree));
        e.Handled = true;
    }

    /// <summary>向菜单添加"新建文件 / 新建文件夹"子项。</summary>
    private void AddNewItem(MenuFlyout menu)
    {
        var newFileItem = new MenuFlyoutItem
        {
            Text = "新建文件",
            Icon = new FontIcon { Glyph = "\uE7C3" }
        };
        newFileItem.Click += async (_, _) => await InvokeAsync(NewFile_Click);
        menu.Items.Add(newFileItem);

        var newFolderItem = new MenuFlyoutItem
        {
            Text = "新建文件夹",
            Icon = new FontIcon { Glyph = "\uE8DA" }
        };
        newFolderItem.Click += async (_, _) => await InvokeAsync(NewFolder_Click);
        menu.Items.Add(newFolderItem);
    }

    private static async Task InvokeAsync(RoutedEventHandler handler)
    {
        // MenuFlyoutItem.Click 在主线程触发，直接调度即可
        await Task.CompletedTask;
        handler?.Invoke(null, new RoutedEventArgs());
    }

    /// <summary>重命名节点：弹出输入框预填原名，提交后执行文件系统重命名。</summary>
    private async Task RenameNodeAsync(FileNode node)
    {
        var newName = await PromptForName("重命名", "输入新名称", defaultText: node.Name);
        if (string.IsNullOrWhiteSpace(newName) || newName == node.Name) return;

        try
        {
            var dir = Path.GetDirectoryName(node.FullPath);
            var newPath = Path.Combine(dir!, newName);
            if (node.IsFolder) Directory.Move(node.FullPath, newPath);
            else File.Move(node.FullPath, newPath);
            await ViewModel.RefreshAsync(null);
        }
        catch (Exception ex)
        {
            await ShowErrorAsync("重命名失败", ex.Message);
        }
    }

    /// <summary>删除节点：文件直接删，文件夹递归删。</summary>
    private async Task DeleteNodeAsync(FileNode node)
    {
        var confirm = await ConfirmAsync("确认删除", $"确定删除 {node.Name}？此操作不可撤销。");
        if (!confirm) return;

        try
        {
            if (node.IsFolder) Directory.Delete(node.FullPath, recursive: true);
            else File.Delete(node.FullPath);
            await ViewModel.RefreshAsync(null);
        }
        catch (Exception ex)
        {
            await ShowErrorAsync("删除失败", ex.Message);
        }
    }

    /// <summary>复制文本到系统剪贴板。</summary>
    private static void CopyToClipboard(string text)
    {
        var package = new DataPackage();
        package.SetText(text);
        Clipboard.SetContent(package);
    }

    /// <summary>弹出输入对话框获取名称。</summary>
    private async Task<string?> PromptForName(string title, string prompt, string? defaultText = null)
    {
        var input = new TextBox
        {
            PlaceholderText = prompt,
            Text = defaultText ?? string.Empty,
            AcceptsReturn = false
        };
        // WinUI3 TextBox 无 SelectAllOnFocus 属性，用 GotFocus 事件手动全选
        input.GotFocus += (_, _) => input.SelectAll();

        var dialog = new ContentDialog
        {
            Title = title,
            Content = input,
            PrimaryButtonText = "确定",
            CloseButtonText = "取消",
            XamlRoot = this.XamlRoot
        };

        var result = await dialog.ShowAsync();
        return result == ContentDialogResult.Primary ? input.Text.Trim() : null;
    }

    /// <summary>弹出确认对话框。</summary>
    private async Task<bool> ConfirmAsync(string title, string content)
    {
        var dialog = new ContentDialog
        {
            Title = title,
            Content = new TextBlock { Text = content, TextWrapping = TextWrapping.Wrap },
            PrimaryButtonText = "确定",
            CloseButtonText = "取消",
            XamlRoot = this.XamlRoot
        };
        return await dialog.ShowAsync() == ContentDialogResult.Primary;
    }

    /// <summary>弹出错误提示对话框。</summary>
    private async Task ShowErrorAsync(string title, string content)
    {
        var dialog = new ContentDialog
        {
            Title = title,
            Content = new TextBlock { Text = content, TextWrapping = TextWrapping.Wrap },
            CloseButtonText = "知道了",
            XamlRoot = this.XamlRoot
        };
        await dialog.ShowAsync();
    }

    private void RemoveContext_Click(object sender, RoutedEventArgs e)
    {
        if (sender is Button b && b.Tag is FileNode node)
        {
            ViewModel.RemoveFromContext(node);
        }
    }

    private void OnContextFilesChanged(object? sender, NotifyCollectionChangedEventArgs e)
    {
        ContextCount.Text = ViewModel.ContextFiles.Count.ToString();
        OnPropertyChanged(nameof(ContextPanelVisibility));
        ContextFilesChanged?.Invoke(this, ViewModel.ContextFiles.ToList());
    }

    /// <summary>更新顶部 Header 项目名与按钮启用状态。</summary>
    private void UpdateChrome()
    {
        var hasRoot = !string.IsNullOrWhiteSpace(ViewModel.RootPath);
        ProjectNameText.Text = hasRoot
            ? Path.GetFileName(ViewModel.RootPath.TrimEnd(Path.DirectorySeparatorChar))
            : "未打开项目";
        RefreshButton.IsEnabled = hasRoot;
        NewFileButton.IsEnabled = hasRoot;
        NewFolderButton.IsEnabled = hasRoot;
        EmptyState.Visibility = hasRoot ? Visibility.Collapsed : Visibility.Visible;
    }

    /// <summary>从右键命中点向上查找 TreeViewItem，取其绑定的 FileNode。</summary>
    private static FileNode? ResolveNode(object? source)
    {
        var element = source as DependencyObject;
        while (element is not null and not TreeViewItem)
        {
            element = VisualTreeHelper.GetParent(element);
        }
        return (element as TreeViewItem)?.DataContext as FileNode;
    }

    public event PropertyChangedEventHandler? PropertyChanged;
    private void OnPropertyChanged([CallerMemberName] string? p = null)
        => PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(p));
}
