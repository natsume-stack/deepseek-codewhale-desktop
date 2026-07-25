using System.IO;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace CodeWhale.Services.Api;

/// <summary>
/// 极简 SSE（Server-Sent Events）解析器。从底层流读取 <c>text/event-stream</c>，
/// 按 <c>\n\n</c> 分隔事件块，提取 <c>event:</c> 与 <c>data:</c> 字段。
/// 不依赖 System.Net.ServerSentEvents，兼容 .NET 6+ 与 WinUI3。
/// </summary>
/// <remarks>
/// 解析规则遵循 W3C SSE 规范子集：
/// <list type="bullet">
/// <item><c>event:</c>、<c>data:</c>、<c>id:</c>、<c>retry:</c> 行按冒号后去一空格取值。</item>
/// <item>多个 <c>data:</c> 行以 <c>\n</c> 拼接。</item>
/// <item>以 <c>:</c> 开头的行是注释（如 keepalive），跳过但触发事件块结束。</item>
/// <item>空行标志一个事件块结束。</item>
/// </list>
/// </remarks>
public sealed class SseReader : IDisposable
{
    private readonly StreamReader _reader;
    private readonly bool _ownsStream;

    /// <param name="stream">底层网络流（建议来自 <c>HttpCompletionOption.ResponseHeadersRead</c>）。</param>
    /// <param name="ownsStream">是否在 Dispose 时一并关闭底层流。</param>
    public SseReader(Stream stream, bool ownsStream = true)
        : this(new StreamReader(stream, new UTF8Encoding(encoderShouldEmitUTF8Identifier: false)), ownsStream)
    {
    }

    public SseReader(StreamReader reader, bool ownsStream = false)
    {
        _reader = reader;
        _ownsStream = ownsStream;
    }

    /// <summary>读取下一条 SSE 事件。流结束时返回 null。</summary>
    /// <param name="cancellationToken">用于中断 AI 任务长连接读取。</param>
    public async Task<SseEvent?> ReadAsync(CancellationToken cancellationToken = default)
    {
        string? eventName = null;
        var dataBuilder = new StringBuilder();
        string? eventId = null;
        bool hasData = false;
        bool hasAnyField = false;

        while (true)
        {
            string? line;
            try
            {
                line = await _reader.ReadLineAsync(cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                throw;
            }

            if (line == null)
            {
                if (hasAnyField && hasData)
                {
                    return new SseEvent(eventName, dataBuilder.ToString(), eventId);
                }
                return null;
            }

            if (line.Length == 0)
            {
                if (hasAnyField)
                {
                    if (hasData || eventName is not null)
                    {
                        return new SseEvent(eventName, hasData ? dataBuilder.ToString() : null, eventId);
                    }
                    eventName = null;
                    dataBuilder.Clear();
                    eventId = null;
                    hasData = false;
                    hasAnyField = false;
                    continue;
                }
                continue;
            }

            hasAnyField = true;

            if (line[0] == ':')
            {
                continue;
            }

            int colon = line.IndexOf(':');
            string field;
            string value;
            if (colon < 0)
            {
                field = line;
                value = string.Empty;
            }
            else
            {
                field = line.Substring(0, colon);
                int valueStart = colon + 1;
                if (valueStart < line.Length && line[valueStart] == ' ')
                {
                    valueStart++;
                }
                value = line.Substring(valueStart);
            }

            switch (field)
            {
                case "event":
                    eventName = value;
                    break;
                case "data":
                    if (hasData) dataBuilder.Append('\n');
                    dataBuilder.Append(value);
                    hasData = true;
                    break;
                case "id":
                    eventId = value;
                    break;
                case "retry":
                    break;
                default:
                    break;
            }
        }
    }

    public void Dispose()
    {
        _reader.Dispose();
        if (_ownsStream)
        {
            try { _reader.BaseStream?.Dispose(); } catch { /* 忽略双重释放 */ }
        }
    }
}

/// <summary>单条 SSE 事件。Data 可能为 null（注释/心跳块）。</summary>
public sealed class SseEvent
{
    /// <summary>事件名（<c>event:</c> 字段）。未指定时为 null，按 SSE 规范视为 "message"。</summary>
    public string? Event { get; }

    /// <summary>数据负载（多个 <c>data:</c> 行以 <c>\n</c> 拼接）。注释块时为 null。</summary>
    public string? Data { get; }

    /// <summary>事件 ID（<c>id:</c> 字段），可用于 Last-Event-ID 重连。</summary>
    public string? Id { get; }

    public SseEvent(string? @event, string? data, string? id)
    {
        Event = @event;
        Data = data;
        Id = id;
    }

    /// <summary>是否为 keepalive 心跳块（无 event 且无 data）。</summary>
    public bool IsKeepAlive => Event is null && Data is null;
}
