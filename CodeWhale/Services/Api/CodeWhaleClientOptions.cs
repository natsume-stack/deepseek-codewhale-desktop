namespace CodeWhale.Services.Api;

/// <summary>
/// CodeWhale 后端客户端配置。所有字段均可通过构造函数或属性设置。
/// 服务地址默认指向本地 Rust 后端 127.0.0.1:8787。
/// </summary>
public sealed class CodeWhaleClientOptions
{
    /// <summary>
    /// 后端基地址，默认 <c>http://127.0.0.1:8787</c>。
    /// 不要以斜杠结尾；客户端会自动拼接 <c>/api/*</c> 路径。
    /// </summary>
    public Uri BaseAddress { get; set; } = new Uri("http://127.0.0.1:8787");

    /// <summary>
    /// 全局请求超时（针对非流式请求），默认 30 秒。
    /// SSE 事件流读取不受此值约束，由调用方通过 <see cref="CancellationToken"/> 控制。
    /// </summary>
    public TimeSpan Timeout { get; set; } = TimeSpan.FromSeconds(30);

    /// <summary>
    /// 请求头中附加的 User-Agent，便于服务端日志识别客户端类型。
    /// </summary>
    public string UserAgent { get; set; } = "CodeWhale-WinUI3-Client/1.0";

    /// <summary>使用默认值构造配置。</summary>
    public CodeWhaleClientOptions() { }

    /// <summary>快捷构造：指定基地址。</summary>
    public CodeWhaleClientOptions(string baseAddress)
    {
        BaseAddress = new Uri(baseAddress.TrimEnd('/'));
    }
}
