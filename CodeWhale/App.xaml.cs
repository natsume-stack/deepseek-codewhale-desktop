using System;
using CodeWhale.Services;
using CodeWhale.Storage;
using Microsoft.UI.Composition.SystemBackdrops;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Media;

namespace CodeWhale;

/// <summary>
/// 应用程序入口。
/// 负责：加载本地配置 → 创建主窗口 → 应用 Mica/Acrylic 系统原生毛玻璃 → 初始化对话控制器。
/// </summary>
public partial class App : Application
{
    /// <summary>主窗口引用。供需要窗口句柄的 WinRT API（如 FolderPicker）使用。</summary>
    public static MainWindow MainWindow { get; private set; } = null!;

    /// <summary>对话控制器（桥接 UI 与后端 API）。生命周期跟随主窗口。</summary>
    public static ChatController? Controller { get; private set; }

    /// <summary>当前系统背景材质类型。供 UI 层在材质不可用时切换兜底配色。</summary>
    public static BackdropKind ActiveBackdrop { get; private set; } = BackdropKind.None;

    public App()
    {
        InitializeComponent();
    }

    protected override void OnLaunched(LaunchActivatedEventArgs args)
    {
        // 1. 加载本地配置（损坏时 AppConfig 内部自动回退默认值）
        try
        {
            AppConfig.Load();
        }
        catch
        {
            // AppConfig.Load 已对 IO 异常做容错，此处兜底防止极少数边界场景崩溃
        }

        // 2. 创建主窗口
        MainWindow = new MainWindow();

        // 3. 应用系统原生毛玻璃（Mica 主背景）。失败时自动降级到纯色。
        ApplySystemBackdrop();

        // 4. 初始化对话控制器（订阅 UI 事件、创建 ApiClient）
        //    MainWindow 在构造时已完成布局与 Controller 装配，此处仅触发异步初始化
        Controller = MainWindow.Controller;
        _ = Controller.InitializeAsync();

        // 5. 激活窗口
        MainWindow.Activate();
    }

    /// <summary>
    /// 应用系统原生背景材质。优先级：MicaBaseAlt &gt; DesktopAcrylicThin &gt; 纯色。
    /// Windows 11 22H2+ 支持 Mica；低版本自动降级。
    /// 用户在系统设置中关闭"透明效果"时，Mica/Acrylic 会由系统自动回退为纯色，无需额外判断。
    /// </summary>
    private void ApplySystemBackdrop()
    {
        try
        {
            // 1. 优先 Mica（Windows 11 22H2+，WinApp SDK 1.5+ 内置）
            //    MicaController.IsSupported() 是判断当前系统是否可用的官方 API
            if (MicaController.IsSupported())
            {
                MainWindow.SystemBackdrop = new MicaBackdrop
                {
                    // BaseAlt 比 Base 略亮，更接近 Codex 桌面端的中性灰
                    Kind = MicaKind.BaseAlt
                };
                ActiveBackdrop = BackdropKind.Mica;
                return;
            }
        }
        catch
        {
            // MicaController.IsSupported 偶发抛 COMException，吞掉后兜底
        }

        try
        {
            // 2. 次选 DesktopAcrylic（Win11 22000+ / Win10 19041+ 限量支持）
            if (DesktopAcrylicController.IsSupported())
            {
                MainWindow.SystemBackdrop = new DesktopAcrylicBackdrop();
                ActiveBackdrop = BackdropKind.Acrylic;
                return;
            }
        }
        catch
        {
            // 兜底纯色
        }

        // 3. 全部不可用：保持默认背景（纯色）
        ActiveBackdrop = BackdropKind.None;
    }
}

/// <summary>
/// 当前生效的系统背景材质种类。供 UI 层判断是否需要兜底配色。
/// </summary>
public enum BackdropKind
{
    /// <summary>未启用任何系统毛玻璃（系统关闭透明效果或版本过低）。</summary>
    None,

    /// <summary>Mica 云母（Windows 11 22H2+，主背景）。</summary>
    Mica,

    /// <summary>Desktop Acrylic 亚克力（兜底材质，Win10/Win11 通用）。</summary>
    Acrylic
}
