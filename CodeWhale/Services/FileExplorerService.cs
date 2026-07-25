using System.IO;
using System.Linq;
using CodeWhale.Models;

namespace CodeWhale.Services;

/// <summary>
/// 基于 <see cref="Directory"/> 的目录扫描实现。
/// 递归由调用方按需触发（懒加载展开），本服务只负责单层枚举。
/// </summary>
public sealed class FileExplorerService : IFileExplorerService
{
    private static readonly string[] DefaultIgnored =
    {
        ".git", "node_modules", "bin", "obj", ".vs", ".idea",
        ".gradle", "build", "dist", ".next", ".nuxt", "__pycache__",
        ".venv", "venv", "env", "target", ".DS_Store", "Thumbs.db"
    };

    public HashSet<string> IgnoredEntries { get; } =
        new(DefaultIgnored, StringComparer.OrdinalIgnoreCase);

    public Task<IReadOnlyList<FileNode>> EnumerateEntriesAsync(string parentPath, CancellationToken ct = default)
    {
        return Task.Run<IReadOnlyList<FileNode>>(() =>
        {
            var result = new List<FileNode>();

            IEnumerable<string> dirs;
            IEnumerable<string> files;
            try
            {
                dirs = Directory.EnumerateDirectories(parentPath);
                files = Directory.EnumerateFiles(parentPath);
            }
            catch (UnauthorizedAccessException) { return result; }
            catch (DirectoryNotFoundException) { return result; }
            catch (IOException) { return result; }

            // 文件夹优先，各自按名称排序
            foreach (var d in dirs.OrderBy(p => Path.GetFileName(p), StringComparer.OrdinalIgnoreCase))
            {
                ct.ThrowIfCancellationRequested();
                var name = Path.GetFileName(d);
                if (IgnoredEntries.Contains(name)) continue;
                result.Add(new FileNode(name, d, isFolder: true));
            }

            foreach (var f in files.OrderBy(p => Path.GetFileName(p), StringComparer.OrdinalIgnoreCase))
            {
                ct.ThrowIfCancellationRequested();
                var name = Path.GetFileName(f);
                if (IgnoredEntries.Contains(name)) continue;
                result.Add(new FileNode(name, f, isFolder: false));
            }

            return result;
        }, ct);
    }
}
