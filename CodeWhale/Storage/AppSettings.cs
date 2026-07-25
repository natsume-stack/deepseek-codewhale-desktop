namespace CodeWhale.Storage;

/// <summary>
/// 应用配置根模型，对应 config.json 的完整结构。
/// 按业务域拆分为嵌套类，承载所有持久化字段。
/// 字段命名与 Rust 后端 /api/* 契约保持一致，便于控制器直接映射。
/// </summary>
public sealed class AppSettings
{
    /// <summary>API 与后端服务相关配置。</summary>
    public ApiSettings Api { get; set; } = new();

    /// <summary>最近打开的项目路径记录。</summary>
    public ProjectSettings Project { get; set; } = new();

    /// <summary>模型默认推理参数（与后端 /api/params 契约对齐）。</summary>
    public ModelSettings Model { get; set; } = new();

    /// <summary>窗口尺寸与布局状态。</summary>
    public WindowSettings Window { get; set; } = new();

    /// <summary>
    /// API 密钥与后端服务地址。
    /// </summary>
    public sealed class ApiSettings
    {
        /// <summary>DeepSeek API 密钥，明文存储于本地配置（后续可扩展为加密存储）。</summary>
        public string ApiKey { get; set; } = string.Empty;

        /// <summary>CodeWhale Rust 后端服务地址，默认本机 8787 端口。</summary>
        public string BackendUrl { get; set; } = "http://127.0.0.1:8787";
    }

    /// <summary>
    /// 上一次打开的项目目录记录。
    /// </summary>
    public sealed class ProjectSettings
    {
        /// <summary>上一次打开的项目目录绝对路径；首次启动为空字符串。</summary>
        public string LastProjectDirectory { get; set; } = string.Empty;
    }

    /// <summary>
    /// 模型默认推理参数。字段命名与 Rust 后端 InferenceDefaults 一致。
    /// </summary>
    public sealed class ModelSettings
    {
        /// <summary>DeepSeek 模型名称（如 deepseek-chat / deepseek-reasoner）。</summary>
        public string Model { get; set; } = "deepseek-chat";

        /// <summary>推理强度档位，对应后端 reasoningEffort 字段。</summary>
        public ReasoningEffort ReasoningEffort { get; set; } = ReasoningEffort.Medium;

        /// <summary>是否启用响应缓存，对应后端 cacheEnabled 字段。</summary>
        public bool CacheEnabled { get; set; } = true;

        /// <summary>上下文窗口保留的最近消息条数，对应后端 contextLength 字段。</summary>
        public int ContextLength { get; set; } = 20;
    }

    /// <summary>
    /// 窗口尺寸与三栏布局状态。
    /// </summary>
    public sealed class WindowSettings
    {
        /// <summary>窗口宽度（像素）。</summary>
        public double Width { get; set; } = 1280;

        /// <summary>窗口高度（像素）。</summary>
        public double Height { get; set; } = 800;

        /// <summary>窗口是否最大化。</summary>
        public bool IsMaximized { get; set; } = false;

        /// <summary>左侧导航栏展开宽度（像素）。</summary>
        public double LeftPaneWidth { get; set; } = 300;

        /// <summary>右侧辅助面板宽度（像素）。</summary>
        public double RightPaneWidth { get; set; } = 340;
    }
}

/// <summary>
/// 推理强度档位。与 Rust 后端 ReasoningEffort 枚举一一对应，
/// JSON 序列化为 lowercase 字符串（minimal/low/medium/high）。
/// </summary>
public enum ReasoningEffort
{
    /// <summary>极低：快速回复，无深度推理。</summary>
    Minimal,

    /// <summary>低：轻度推理。</summary>
    Low,

    /// <summary>中等：默认平衡档位。</summary>
    Medium,

    /// <summary>高：深度推理，适合复杂任务。</summary>
    High
}
