using System.IO;
using System.Text.Json;

namespace CodeWhale.Storage;

/// <summary>
/// 应用本地持久化服务。
/// 负责程序所有配置的读写，使用 JSON 文件存储于应用本地目录。
/// 纯工具类，不引用任何 UI 控件，可由任意模块调用。
/// </summary>
public static class AppConfig
{
    private const string ConfigFileName = "config.json";
    private const string TempFileName = "config.json.tmp";
    private const string CorruptBackupSuffix = ".corrupt";
    private const string FallbackDirName = "CodeWhale";

    private static readonly object _sync = new();
    private static readonly JsonSerializerOptions _jsonOptions = new()
    {
        WriteIndented = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase
    };

    private static AppSettings? _current;

    /// <summary>
    /// 当前内存中的配置实例（全局只读访问）。
    /// 首次访问时自动从磁盘懒加载；修改后需调用 <see cref="Save()"/> 持久化。
    /// </summary>
    public static AppSettings Current
    {
        get
        {
            lock (_sync)
            {
                _current ??= LoadInternal();
                return _current;
            }
        }
    }

    /// <summary>
    /// 从磁盘加载配置并刷新内存缓存。
    /// 文件不存在、损坏或权限不足时返回默认配置，保证应用可启动。
    /// </summary>
    /// <returns>已加载的配置实例。</returns>
    public static AppSettings Load()
    {
        lock (_sync)
        {
            _current = LoadInternal();
            return _current;
        }
    }

    /// <summary>
    /// 将当前配置持久化到磁盘。
    /// 采用“临时文件 + 原子替换”写入，避免写入过程中崩溃导致配置损坏。
    /// </summary>
    /// <exception cref="UnauthorizedAccessException">目标目录无写入权限。</exception>
    /// <exception cref="IOException">磁盘 I/O 错误。</exception>
    public static void Save()
    {
        lock (_sync)
        {
            var snapshot = _current ?? new AppSettings();
            SaveInternal(snapshot);
        }
    }

    /// <summary>
    /// 重置为默认配置并持久化。
    /// </summary>
    public static void Reset()
    {
        lock (_sync)
        {
            _current = new AppSettings();
            SaveInternal(_current);
        }
    }

    /// <summary>
    /// 实际加载逻辑：读取并反序列化配置文件。
    /// 文件不存在、为空、损坏或权限不足时回退到默认配置。
    /// </summary>
    private static AppSettings LoadInternal()
    {
        var path = GetConfigFilePath();

        try
        {
            if (!File.Exists(path))
            {
                return new AppSettings();
            }

            var json = File.ReadAllText(path);
            if (string.IsNullOrWhiteSpace(json))
            {
                return new AppSettings();
            }

            var settings = JsonSerializer.Deserialize<AppSettings>(json, _jsonOptions);
            return settings ?? new AppSettings();
        }
        catch (JsonException)
        {
            // 文件损坏（JSON 解析失败）：备份后回退到默认配置
            TryBackupCorruptFile(path);
            return new AppSettings();
        }
        catch (UnauthorizedAccessException)
        {
            // 权限不足：静默回退到默认配置，保证应用可启动
            return new AppSettings();
        }
        catch (IOException)
        {
            // 其他 I/O 异常（文件被占用、磁盘错误等）：静默回退
            return new AppSettings();
        }
    }

    /// <summary>
    /// 实际写入逻辑：原子写入临时文件后替换原文件。
    /// </summary>
    private static void SaveInternal(AppSettings settings)
    {
        var dir = GetConfigDirectory();
        Directory.CreateDirectory(dir);

        var path = Path.Combine(dir, ConfigFileName);
        var tempPath = Path.Combine(dir, TempFileName);

        try
        {
            var json = JsonSerializer.Serialize(settings, _jsonOptions);
            // 原子写入：先写临时文件再替换原文件，避免半写入状态导致配置损坏
            File.WriteAllText(tempPath, json);
            File.Move(tempPath, path, overwrite: true);
        }
        catch (UnauthorizedAccessException)
        {
            // 权限不足：清理临时文件后向上抛出，由调用方提示用户
            TryDeleteFile(tempPath);
            throw;
        }
        catch (IOException)
        {
            // I/O 错误：清理临时文件后向上抛出
            TryDeleteFile(tempPath);
            throw;
        }
    }

    /// <summary>
    /// 获取配置文件完整路径。
    /// MSIX 打包模式取应用沙箱 LocalFolder；解包调试运行回退到 %LocalAppData%\CodeWhale\config.json。
    /// </summary>
    private static string GetConfigFilePath()
    {
        return Path.Combine(GetConfigDirectory(), ConfigFileName);
    }

    /// <summary>
    /// 获取配置文件所在目录。
    /// </summary>
    private static string GetConfigDirectory()
    {
        try
        {
            // MSIX 打包模式：使用应用沙箱内的 LocalFolder
            return Windows.Storage.ApplicationData.Current.LocalFolder.Path;
        }
        catch
        {
            // 解包调试运行：ApplicationData.Current 不可用，回退到 %LocalAppData%\CodeWhale
            var dir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                FallbackDirName);
            Directory.CreateDirectory(dir);
            return dir;
        }
    }

    /// <summary>
    /// 将损坏的配置文件重命名为 .corrupt 备份，便于人工排查。
    /// </summary>
    private static void TryBackupCorruptFile(string path)
    {
        try
        {
            var backup = path + CorruptBackupSuffix;
            if (File.Exists(backup))
            {
                File.Delete(backup);
            }
            File.Move(path, backup);
        }
        catch
        {
            // 备份失败不影响回退流程
        }
    }

    /// <summary>
    /// 尝试删除指定文件，失败时忽略。
    /// </summary>
    private static void TryDeleteFile(string path)
    {
        try
        {
            if (File.Exists(path))
            {
                File.Delete(path);
            }
        }
        catch
        {
            // 清理失败忽略
        }
    }
}
