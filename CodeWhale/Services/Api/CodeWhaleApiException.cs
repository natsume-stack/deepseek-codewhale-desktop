using System.Net;

namespace CodeWhale.Services.Api;

/// <summary>
/// CodeWhale 客户端所有异常的基类。调用方只需捕获本类型即可统一处理，
/// 或按需细化到 <see cref="CodeWhaleConnectionException"/> / <see cref="CodeWhaleTimeoutException"/>
/// / <see cref="CodeWhaleApiException"/> / <see cref="CodeWhaleCanceledException"/>。
/// </summary>
public abstract class CodeWhaleException : Exception
{
    protected CodeWhaleException(string message) : base(message) { }
    protected CodeWhaleException(string message, Exception innerException) : base(message, innerException) { }
}

/// <summary>
/// 网络层故障：服务未启动、连接被拒绝、DNS 解析失败、连接被重置等。
/// 通常对应 <see cref="HttpRequestException"/>，HTTP 状态码不可用。
/// </summary>
public sealed class CodeWhaleConnectionException : CodeWhaleException
{
    /// <summary>原始网络异常（HttpRequestException / SocketException 等）。</summary>
    public Exception? InnerNetworkException { get; }

    public CodeWhaleConnectionException(string message, Exception? inner = null)
        : base(message, inner ?? new Exception(message))
    {
        InnerNetworkException = inner;
    }

    /// <summary>返回是否疑似服务未启动（连接被拒绝）。</summary>
    public bool LikelyServiceNotStarted =>
        InnerNetworkException is HttpRequestException hre &&
        hre.InnerException is System.Net.Sockets.SocketException se &&
        (se.SocketErrorCode == System.Net.Sockets.SocketError.ConnectionRefused ||
         se.SocketErrorCode == System.Net.Sockets.SocketError.HostNotFound);
}

/// <summary>
/// 请求超时：达到 <see cref="CodeWhaleClientOptions.Timeout"/> 或服务端处理过慢。
/// 区分于 <see cref="CodeWhaleCanceledException"/>——超时由内部 Timer 触发。
/// </summary>
public sealed class CodeWhaleTimeoutException : CodeWhaleException
{
    public TimeSpan Timeout { get; }

    public CodeWhaleTimeoutException(TimeSpan timeout, Exception? inner = null)
        : base($"请求在 {timeout.TotalSeconds:F1}s 后超时。请确认 CodeWhale 后端服务在线且模型可用。", inner)
    {
        Timeout = timeout;
    }
}

/// <summary>
/// 服务端返回非 2xx 状态码。已成功与服务器通信，但业务报错（4xx/5xx）。
/// 携带 HTTP 状态码、请求路径与原始响应体文本。
/// 后端错误体统一为 {"error": &lt;int&gt;, "message": "..."}。
/// </summary>
public sealed class CodeWhaleApiException : CodeWhaleException
{
    /// <summary>HTTP 状态码。</summary>
    public HttpStatusCode StatusCode { get; }

    /// <summary>请求的相对路径，便于日志定位。</summary>
    public string RequestPath { get; }

    /// <summary>从响应体解析出的错误消息（若可解析）。</summary>
    public string? ServerMessage { get; }

    /// <summary>原始响应体文本，便于排查非标准错误。</summary>
    public string? RawBody { get; }

    public CodeWhaleApiException(HttpStatusCode statusCode, string requestPath, string? serverMessage, string? rawBody)
        : base(BuildMessage(statusCode, requestPath, serverMessage, rawBody))
    {
        StatusCode = statusCode;
        RequestPath = requestPath;
        ServerMessage = serverMessage;
        RawBody = rawBody;
    }

    private static string BuildMessage(HttpStatusCode code, string path, string? msg, string? raw) =>
        !string.IsNullOrEmpty(msg)
            ? $"CodeWhale API {(int)code} {code} @ {path}: {msg}"
            : $"CodeWhale API {(int)code} {code} @ {path}{(string.IsNullOrEmpty(raw) ? "" : $" — {raw}")}";
}

/// <summary>
/// 请求被取消（调用方通过 <see cref="CancellationToken"/> 触发，常用于中断 AI 任务）。
/// 这是正常的中断路径，UI 层通常应静默处理而非报错。
/// </summary>
public sealed class CodeWhaleCanceledException : CodeWhaleException
{
    public CodeWhaleCanceledException(OperationCanceledException inner)
        : base("请求已被取消（用于中断 AI 任务）。", inner) { }
}
