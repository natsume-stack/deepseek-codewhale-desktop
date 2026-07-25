using System;
using CodeWhale.Models;
using CodeWhale.Services;
using CodeWhale.Storage;
using Microsoft.UI;
using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Input;
using WinRT.Interop;

namespace CodeWhale;

/// <summary>
/// 主窗口：自绘标题栏 + 三栏布局外壳。
///
/// 职责：
/// <list type="bullet">
/// <item>自绘标题栏（ExtendsContentIntoTitleBar + SetTitleBar），承载 Logo / 项目名 / 模型 chip；</item>
/// <item>承载 <see cref="FileTreeView"/> / <see cref="Views.ChatPanel"/> / <see cref="Views.ParameterPanel"/>；</item>
/// <item>创建并持有 <see cref="ChatController"/>，把三栏事件桥接到后端 API；</item>
/// <item>从 <see cref="AppConfig"/> 恢复窗口尺寸与左右栏宽度；</item>
/// <item>设置窗口最小尺寸，防止缩放过小破坏布局；</item>
/// <item>窗口关闭时持久化全部配置（窗口尺寸、栏宽、参数、项目路径）。</item>
/// </list>
/// </summary>
public sealed partial class MainWindow : Window
{
    /// <summary>窗口最小宽度（像素），保证三栏都能正常显示。</summary>
    private const int MinWindowWidth = 960;

    /// <summary>窗口最小高度（像素），保证标题栏 + 输入栏 + 消息流可见。</summary>
    private const int MinWindowHeight = 600;

    /// <summary>左栏最小宽度（像素）。</summary>
    private const double MinLeftPaneWidth = 200;

    /// <summary>右栏最小宽度（像素）。</summary>
    private const double MinRightPaneWidth = 240;

    /// <summary>左栏最大宽度（像素）。</summary>
    private const double MaxLeftPaneWidth = 520;

    /// <summary>右栏最大宽度（像素）。</summary>
    private const double MaxRightPaneWidth = 560;

    /// <summary>对话控制器。由 <see cref="App"/> 启动时触发异步初始化。</summary>
    public ChatController Controller { get; }

    /// <summary>左侧栏折叠状态（True=折叠到 0 宽）。</summary>
    public bool IsLeftPaneCollapsed { get; private set; }

    /// <summary>右侧栏折叠状态（True=折叠到 0 宽）。</summary>
    public bool IsRightPaneCollapsed { get; private set; }

    /// <summary>折叠前的左栏宽度，用于恢复。</summary>
    private double _leftPaneWidthBackup = 280;

    /// <summary>折叠前的右栏宽度，用于恢复。</summary>
    private double _rightPaneWidthBackup = 320;

    /// <summary>拖拽中：记录起始 X 坐标和起始栏宽。</summary>
    private bool _isDraggingLeftSplitter;
    private bool _isDraggingRightSplitter;
    private double _dragStartX;
    private double _dragStartPaneWidth;

    public MainWindow()
    {
        InitializeComponent();
        Title = "CodeWhale";

        // 1. 自绘标题栏：把客户区延伸到标题栏区域
        ExtendsContentIntoTitleBar = true;
        SetTitleBar(TitleBarDragRegion);

        // 2. 创建控制器，订阅三栏事件
        Controller = new ChatController(ChatPanelView, FileTree, ParamsPanel);

        // 3. 恢复窗口尺寸与栏宽
        RestoreLayout();

        // 4. 文件树轻量联动（更新标题栏项目名）
        FileTree.RootDirectoryChanged += OnRootDirectoryChanged;
        FileTree.FileSelected += OnFileSelected;

        // 5. 窗口尺寸变更监听（用于最小尺寸约束）
        SizeChanged += OnWindowSizeChanged;

        // 6. 分隔条拖拽：调整左右栏宽度
        SetupSplitterDrag(LeftSplitter, isLeft: true);
        SetupSplitterDrag(RightSplitter, isLeft: false);
    }

    /// <summary>为分隔条注册拖拽事件，实现栏宽调整。</summary>
    private void SetupSplitterDrag(UIElement splitter, bool isLeft)
    {
        splitter.PointerPressed += (s, e) =>
        {
            // 折叠状态不响应拖拽
            if ((isLeft && IsLeftPaneCollapsed) || (!isLeft && IsRightPaneCollapsed))
                return;

            splitter.CapturePointer(e.Pointer);
            _dragStartX = e.GetCurrentPoint(splitter).Position.X;
            _dragStartPaneWidth = isLeft
                ? (LeftColumn.Width.IsAbsolute ? LeftColumn.Width.Value : 280)
                : (RightColumn.Width.IsAbsolute ? RightColumn.Width.Value : 320);

            if (isLeft) _isDraggingLeftSplitter = true;
            else _isDraggingRightSplitter = true;

            e.Handled = true;
        };

        splitter.PointerMoved += (s, e) =>
        {
            if (e.GetCurrentPoint(splitter).Properties.IsLeftButtonPressed == false) return;
            var isDragging = isLeft ? _isDraggingLeftSplitter : _isDraggingRightSplitter;
            if (!isDragging) return;

            var currentX = e.GetCurrentPoint(splitter).Position.X;
            var delta = currentX - _dragStartX;

            if (isLeft)
            {
                // 左分隔条：向右拖 → 加宽左栏
                var newWidth = _dragStartPaneWidth + delta;
                newWidth = Math.Clamp(newWidth, MinLeftPaneWidth, MaxLeftPaneWidth);
                LeftColumn.Width = new GridLength(newWidth);
            }
            else
            {
                // 右分隔条：向左拖 → 加宽右栏（坐标系反向）
                var newWidth = _dragStartPaneWidth - delta;
                newWidth = Math.Clamp(newWidth, MinRightPaneWidth, MaxRightPaneWidth);
                RightColumn.Width = new GridLength(newWidth);
            }

            e.Handled = true;
        };

        splitter.PointerReleased += (s, e) =>
        {
            if (isLeft) _isDraggingLeftSplitter = false;
            else _isDraggingRightSplitter = false;
            splitter.ReleasePointerCapture(e.Pointer);
            e.Handled = true;
        };
    }

    /// <summary>从 AppConfig 恢复窗口尺寸、最大化状态与左右栏宽度。</summary>
    private void RestoreLayout()
    {
        try
        {
            var win = AppConfig.Current.Window;

            var leftW = win.LeftPaneWidth > 0 ? win.LeftPaneWidth : 280;
            var rightW = win.RightPaneWidth > 0 ? win.RightPaneWidth : 320;
            LeftColumn.Width = new GridLength(leftW);
            RightColumn.Width = new GridLength(rightW);
            _leftPaneWidthBackup = leftW;
            _rightPaneWidthBackup = rightW;

            // 获取窗口句柄并设置尺寸
            var hwnd = WindowNative.GetWindowHandle(this);
            if (AppWindow.GetFromWindowId(Win32Interop.GetWindowIdFromWindow(hwnd)) is { } appWindow)
            {
                var width = (int)Math.Max(MinWindowWidth, win.Width);
                var height = (int)Math.Max(MinWindowHeight, win.Height);
                appWindow.Resize(new Windows.Graphics.SizeInt32 { Width = width, Height = height });

                if (win.IsMaximized && appWindow.Presenter is OverlappedPresenter presenter)
                {
                    presenter.Maximize();
                }
            }
        }
        catch
        {
            // 恢复失败使用默认尺寸，不阻断启动
        }
    }

    /// <summary>窗口尺寸变更：约束最小尺寸，防止缩放过小破坏布局。</summary>
    private void OnWindowSizeChanged(object sender, WindowSizeChangedEventArgs args)
    {
        if (args.Size.Width < MinWindowWidth || args.Size.Height < MinWindowHeight)
        {
            var hwnd = WindowNative.GetWindowHandle(this);
            if (AppWindow.GetFromWindowId(Win32Interop.GetWindowIdFromWindow(hwnd)) is { } appWindow)
            {
                appWindow.Resize(new Windows.Graphics.SizeInt32
                {
                    Width = Math.Max(MinWindowWidth, (int)args.Size.Width),
                    Height = Math.Max(MinWindowHeight, (int)args.Size.Height)
                });
            }
            args.Handled = true;
        }
    }

    /// <summary>左分隔条双击：折叠/展开左栏。</summary>
    private void LeftSplitter_DoubleTapped(object sender, DoubleTappedRoutedEventArgs e)
    {
        ToggleLeftPane();
        e.Handled = true;
    }

    /// <summary>右分隔条双击：折叠/展开右栏。</summary>
    private void RightSplitter_DoubleTapped(object sender, DoubleTappedRoutedEventArgs e)
    {
        ToggleRightPane();
        e.Handled = true;
    }

    /// <summary>切换左栏折叠状态。</summary>
    public void ToggleLeftPane()
    {
        if (IsLeftPaneCollapsed)
        {
            LeftColumn.Width = new GridLength(_leftPaneWidthBackup);
            LeftSplitterColumn.Width = new GridLength(6);
            IsLeftPaneCollapsed = false;
        }
        else
        {
            _leftPaneWidthBackup = LeftColumn.Width.IsAbsolute ? LeftColumn.Width.Value : 280;
            LeftColumn.Width = new GridLength(0);
            LeftSplitterColumn.Width = new GridLength(0);
            IsLeftPaneCollapsed = true;
        }
    }

    /// <summary>切换右栏折叠状态。</summary>
    public void ToggleRightPane()
    {
        if (IsRightPaneCollapsed)
        {
            RightColumn.Width = new GridLength(_rightPaneWidthBackup);
            RightSplitterColumn.Width = new GridLength(6);
            IsRightPaneCollapsed = false;
        }
        else
        {
            _rightPaneWidthBackup = RightColumn.Width.IsAbsolute ? RightColumn.Width.Value : 320;
            RightColumn.Width = new GridLength(0);
            RightSplitterColumn.Width = new GridLength(0);
            IsRightPaneCollapsed = true;
        }
    }

    /// <summary>更新标题栏的项目名显示。</summary>
    public void UpdateTitleProjectName(string? projectPath)
    {
        TitleProjectName.Text = string.IsNullOrEmpty(projectPath)
            ? "未打开项目"
            : System.IO.Path.GetFileName(projectPath.TrimEnd(System.IO.Path.DirectorySeparatorChar));
    }

    /// <summary>更新标题栏的模型标识 chip。</summary>
    public void UpdateTitleModelChip(string modelName)
    {
        TitleModelChip.Text = string.IsNullOrEmpty(modelName) ? "deepseek-chat" : modelName;
    }

    private void OnRootDirectoryChanged(object? sender, string? path)
    {
        UpdateTitleProjectName(path);
    }

    private void OnFileSelected(object? sender, FileNode node)
    {
        // 文件选中事件：当前仅由文件树内部处理，主窗口不额外动作
    }

    /// <summary>窗口关闭：持久化窗口尺寸、栏宽与全部配置。</summary>
    private void MainWindow_Closed(object sender, WindowEventArgs args)
    {
        try
        {
            var win = AppConfig.Current.Window;

            // 读取当前栏宽（折叠状态时保留备份值）
            win.LeftPaneWidth = IsLeftPaneCollapsed ? _leftPaneWidthBackup :
                (LeftColumn.Width.IsAbsolute ? LeftColumn.Width.Value : 280);
            win.RightPaneWidth = IsRightPaneCollapsed ? _rightPaneWidthBackup :
                (RightColumn.Width.IsAbsolute ? RightColumn.Width.Value : 320);

            // 读取窗口尺寸与最大化状态
            var hwnd = WindowNative.GetWindowHandle(this);
            if (AppWindow.GetFromWindowId(Win32Interop.GetWindowIdFromWindow(hwnd)) is { } appWindow)
            {
                var size = appWindow.Size;
                win.Width = size.Width;
                win.Height = size.Height;
                win.IsMaximized = appWindow.Presenter is OverlappedPresenter p && p.State == OverlappedPresenterState.Maximized;
            }

            AppConfig.Save();
        }
        catch
        {
            // 持久化失败不阻断关闭
        }
        finally
        {
            Controller?.Dispose();
        }
    }
}
