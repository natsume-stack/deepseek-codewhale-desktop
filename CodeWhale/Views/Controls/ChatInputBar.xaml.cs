using System;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;

namespace CodeWhale.Views.Controls;

/// <summary>
/// 底部输入栏。提供文本输入、发送与停止按钮。
/// 仅抛出 <see cref="SendRequested"/> / <see cref="StopRequested"/> 事件，
/// 不直接发起任何网络请求（由外部控制器 + ApiClient 处理）。
/// </summary>
public sealed partial class ChatInputBar : UserControl
{
    /// <summary>用户点击发送或按 Enter 时触发，参数为输入文本。</summary>
    public event EventHandler<string>? SendRequested;

    /// <summary>用户点击停止时触发。</summary>
    public event EventHandler<EventArgs>? StopRequested;

    /// <summary>
    /// 是否有任务运行中。为 true 时显示停止按钮、禁用发送按钮。
    /// </summary>
    public bool IsRunning
    {
        get => _isRunning;
        set
        {
            _isRunning = value;
            StopButton.Visibility = value ? Visibility.Visible : Visibility.Collapsed;
            SendButton.IsEnabled = !value;
        }
    }
    private bool _isRunning;

    public ChatInputBar()
    {
        InitializeComponent();
    }

    /// <summary>聚焦输入框。</summary>
    public void FocusInput() => InputBox.Focus(FocusState.Programmatic);

    /// <summary>清空输入框。</summary>
    public void Clear() => InputBox.Text = string.Empty;

    private void SendButton_Click(object sender, RoutedEventArgs e) => RaiseSend();

    private void InputBox_KeyDown(object sender, KeyRoutedEventArgs e)
    {
        // Enter 发送；Shift+Enter / Ctrl+Enter 换行
        if (e.Key == Windows.System.VirtualKey.Enter)
        {
            var down = Microsoft.UI.Input.InputKeyboardSource.GetKeyStateForCurrentThread(Windows.System.VirtualKey.Shift);
            bool shift = down.HasFlag(Windows.UI.Core.CoreVirtualKeyStates.Down);
            if (!shift)
            {
                e.Handled = true;
                RaiseSend();
            }
        }
    }

    private void RaiseSend()
    {
        if (IsRunning) return;
        var text = InputBox.Text;
        if (string.IsNullOrWhiteSpace(text)) return;
        SendRequested?.Invoke(this, text);
        InputBox.Text = string.Empty;
    }

    private void StopButton_Click(object sender, RoutedEventArgs e)
        => StopRequested?.Invoke(this, EventArgs.Empty);
}
