using System;
using CodeWhale.Models;
using Microsoft.UI;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Windows.UI;

namespace CodeWhale.Views.Controls;

/// <summary>
/// 代码变更预览控件。展示文件 Diff（增删改行着色）并提供“批准/拒绝”审批按钮。
/// 审批结果通过 <see cref="ApprovalRequested"/> 事件抛出，由外部控制器决定是否落盘。
/// </summary>
public sealed partial class DiffPreviewView : UserControl
{
    public static readonly DependencyProperty DiffProperty =
        DependencyProperty.Register(nameof(Diff), typeof(CodeDiff), typeof(DiffPreviewView),
            new PropertyMetadata(null, OnDiffChanged));

    /// <summary>当前绑定的代码变更。</summary>
    public CodeDiff Diff
    {
        get => (CodeDiff)GetValue(DiffProperty);
        set => SetValue(DiffProperty, value);
    }

    /// <summary>用户点击批准/拒绝时触发。UI 不直接落盘，仅抛出事件。</summary>
    public event EventHandler<DiffApprovalEventArgs>? ApprovalRequested;

    public DiffPreviewView()
    {
        InitializeComponent();
    }

    private static void OnDiffChanged(DependencyObject d, DependencyPropertyChangedEventArgs e)
        => ((DiffPreviewView)d).Render();

    private void Render()
    {
        LinesPanel.Children.Clear();
        var diff = Diff;
        if (diff is null)
        {
            FilePathText.Text = string.Empty;
            SummaryText.Text = string.Empty;
            StatusText.Text = string.Empty;
            return;
        }

        FilePathText.Text = diff.FilePath;
        SummaryText.Text = diff.Summary ?? string.Empty;
        UpdateStatus();

        foreach (var line in diff.Lines)
        {
            LinesPanel.Children.Add(BuildLine(line));
        }
    }

    private UIElement BuildLine(DiffLine line)
    {
        var (bg, fg, sign) = line.Type switch
        {
            DiffLineType.Added   => (ColorFrom("#1E3A1E"), ColorFrom("#4EC9B0"), "+"),
            DiffLineType.Removed => (ColorFrom("#3A1E1E"), ColorFrom("#F48771"), "-"),
            DiffLineType.Header  => (ColorFrom("#0F2C4A"), ColorFrom("#569CD6"), "@@"),
            _                    => (Colors.Transparent, ColorFrom("#D4D4D4"), " ")
        };

        var oldNum = line.OldLineNumber > 0 ? line.OldLineNumber.ToString() : string.Empty;
        var newNum = line.NewLineNumber > 0 ? line.NewLineNumber.ToString() : string.Empty;

        var grid = new Grid();
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(56) });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(56) });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(22) });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });

        // 行背景
        var bgBorder = new Border { Background = new SolidColorBrush(bg) };
        Grid.SetColumnSpan(bgBorder, 4);
        grid.Children.Add(bgBorder);

        var oldTb = MakeLineText(oldNum, fg, alignRight: true);
        Grid.SetColumn(oldTb, 0);
        grid.Children.Add(oldTb);

        var newTb = MakeLineText(newNum, fg, alignRight: true);
        Grid.SetColumn(newTb, 1);
        grid.Children.Add(newTb);

        var signTb = MakeLineText(sign, fg, alignRight: false);
        Grid.SetColumn(signTb, 2);
        grid.Children.Add(signTb);

        var contentTb = MakeLineText(line.Content, fg, alignRight: false);
        Grid.SetColumn(contentTb, 3);
        grid.Children.Add(contentTb);

        return grid;
    }

    private static TextBlock MakeLineText(string text, Color fg, bool alignRight)
    {
        return new TextBlock
        {
            Text = text,
            Foreground = new SolidColorBrush(fg),
            FontFamily = new FontFamily("Cascadia Code, Consolas"),
            FontSize = 12,
            Padding = alignRight ? new Thickness(0, 0, 8, 0) : new Thickness(8, 0, 0, 0),
            VerticalAlignment = VerticalAlignment.Center,
            HorizontalAlignment = alignRight ? HorizontalAlignment.Right : HorizontalAlignment.Left,
            TextAlignment = alignRight ? TextAlignment.Right : TextAlignment.Left,
            TextWrapping = TextWrapping.NoWrap
        };
    }

    private void UpdateStatus()
    {
        var diff = Diff;
        if (diff is null) { StatusText.Text = string.Empty; return; }

        switch (diff.Approval)
        {
            case DiffApprovalState.Pending:
                StatusText.Text = "待审批";
                ApproveButton.IsEnabled = true;
                RejectButton.IsEnabled = true;
                break;
            case DiffApprovalState.Approved:
                StatusText.Text = "已批准";
                ApproveButton.IsEnabled = false;
                RejectButton.IsEnabled = false;
                break;
            case DiffApprovalState.Rejected:
                StatusText.Text = "已拒绝";
                ApproveButton.IsEnabled = false;
                RejectButton.IsEnabled = false;
                break;
        }
    }

    private void ApproveButton_Click(object sender, RoutedEventArgs e)
    {
        var diff = Diff;
        if (diff is null) return;
        diff.Approval = DiffApprovalState.Approved;
        UpdateStatus();
        ApprovalRequested?.Invoke(this, new DiffApprovalEventArgs(diff, isApproved: true));
    }

    private void RejectButton_Click(object sender, RoutedEventArgs e)
    {
        var diff = Diff;
        if (diff is null) return;
        diff.Approval = DiffApprovalState.Rejected;
        UpdateStatus();
        ApprovalRequested?.Invoke(this, new DiffApprovalEventArgs(diff, isApproved: false));
    }

    private static Color ColorFrom(string hex)
    {
        var h = hex.StartsWith("#") ? hex.Substring(1) : hex;
        byte r = Convert.ToByte(h.Substring(0, 2), 16);
        byte g = Convert.ToByte(h.Substring(2, 2), 16);
        byte b = Convert.ToByte(h.Substring(4, 2), 16);
        byte a = h.Length >= 8 ? Convert.ToByte(h.Substring(6, 2), 16) : (byte)255;
        return Color.FromArgb(a, r, g, b);
    }
}

/// <summary>审批事件参数。</summary>
public sealed class DiffApprovalEventArgs : EventArgs
{
    public DiffApprovalEventArgs(CodeDiff diff, bool isApproved)
    {
        Diff = diff;
        IsApproved = isApproved;
    }

    /// <summary>被审批的代码变更。</summary>
    public CodeDiff Diff { get; }

    /// <summary>true 表示批准，false 表示拒绝。</summary>
    public bool IsApproved { get; }
}
