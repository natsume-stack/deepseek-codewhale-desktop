//! 文件系统路由层: 文件树 / 文件 CRUD / 重命名 / 在资源管理器打开
//! 仅做路由 + 文件 IO，不触碰 Agent/DeepSeek 内核。

use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

use crate::config::IGNORED_DIRS;
use crate::error::AppError;
use crate::state::SharedState;

/// 文件树节点（前端 TreeView 直接消费的结构）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileNodeDto {
    pub name: String,
    pub path: String,
    pub is_folder: bool,
    pub children: Option<Vec<FileNodeDto>>,
    pub size: Option<u64>,
    pub modified: Option<String>,
}

/// 文件树查询参数：?depth=N 控制递归深度（默认 1=仅根层；-1=无限）。
#[derive(Debug, Deserialize)]
pub struct TreeQuery {
    #[serde(default = "default_depth")]
    pub depth: i32,
}

fn default_depth() -> i32 {
    1
}

/// GET /api/project/tree?depth=N
/// 返回当前项目根目录的文件树结构。
pub async fn get_tree(
    State(state): State<SharedState>,
    Query(q): Query<TreeQuery>,
) -> Result<Json<Value>, AppError> {
    let root = state
        .project_root()
        .await
        .ok_or_else(|| AppError::BadRequest("尚未加载项目目录".into()))?;

    let node = build_tree(&root, q.depth)
        .map_err(|e| AppError::BadRequest(format!("读取文件树失败: {}: {e}", root.display())))?;

    Ok(Json(json!({
        "root": root.display().to_string(),
        "tree": node,
    })))
}

/// 递归构建文件树。depth=0 仅返回当前节点；depth>0 递归 N 层；depth<0 无限递归（限制 5 层兜底）。
fn build_tree(path: &Path, depth: i32) -> std::io::Result<FileNodeDto> {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();

    let metadata = path.metadata().ok();
    let is_folder = path.is_dir();

    let children = if is_folder && depth != 0 {
        let next_depth = if depth > 0 { depth - 1 } else { -1 };
        let max_recurse = 5; // 兜底防无限递归
        let effective_depth = if depth < 0 { max_recurse } else { next_depth };

        match std::fs::read_dir(path) {
            Ok(entries) => {
                let mut nodes: Vec<FileNodeDto> = entries
                    .filter_map(|e| e.ok())
                    .filter_map(|e| {
                        let p = e.path();
                        // 过滤常见噪声目录
                        if let Some(name) = p.file_name().and_then(|n| n.to_str()) {
                            if IGNORED_DIRS.contains(&name) {
                                return None;
                            }
                        }
                        build_tree(&p, effective_depth).ok()
                    })
                    .collect();
                // 文件夹优先，再按名称排序
                nodes.sort_by(|a, b| match (a.is_folder, b.is_folder) {
                    (true, false) => std::cmp::Ordering::Less,
                    (false, true) => std::cmp::Ordering::Greater,
                    _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
                });
                Some(nodes)
            }
            Err(_) => None,
        }
    } else {
        None
    };

    Ok(FileNodeDto {
        name,
        path: path.to_string_lossy().to_string(),
        is_folder,
        children,
        size: metadata.as_ref().map(|m| m.len()),
        modified: metadata
            .as_ref()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| format!("{}", d.as_secs())),
    })
}

/// 新建文件/文件夹请求体。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateFileBody {
    /// 父目录绝对路径。若为空则使用项目根。
    pub parent_path: Option<String>,
    /// 名称（文件名或文件夹名）。
    pub name: String,
    /// true=创建文件夹, false=创建文件。
    pub is_folder: bool,
    /// 文件初始内容（仅 is_folder=false 时生效）。
    pub content: Option<String>,
}

/// POST /api/files
pub async fn create_file(
    State(state): State<SharedState>,
    Json(body): Json<CreateFileBody>,
) -> Result<(StatusCode, Json<Value>), AppError> {
    let root = state
        .project_root()
        .await
        .ok_or_else(|| AppError::BadRequest("尚未加载项目目录".into()))?;
    // 写操作权限闸门：需 can_write（WorkspaceWrite / FullAccess）
    let cfg = state.permission_config().await;
    if !cfg.level.can_write() {
        return Err(AppError::Forbidden("当前权限等级禁止创建文件/目录".into()));
    }

    let parent = body
        .parent_path
        .as_ref()
        .map(PathBuf::from)
        .unwrap_or_else(|| root.clone());
    validate_within_root(&parent, &root)?;

    let target = parent.join(&body.name);
    if target.exists() {
        return Err(AppError::BadRequest(format!(
            "已存在同名项: {}",
            target.display()
        )));
    }

    if body.is_folder {
        tokio::fs::create_dir_all(&target)
            .await
            .map_err(|e| AppError::BadRequest(format!("创建文件夹失败: {e}")))?;
    } else {
        // 确保父目录存在
        if let Some(p) = target.parent() {
            tokio::fs::create_dir_all(p)
                .await
                .map_err(|e| AppError::BadRequest(format!("创建父目录失败: {e}")))?;
        }
        tokio::fs::write(&target, body.content.as_deref().unwrap_or(""))
            .await
            .map_err(|e| AppError::BadRequest(format!("创建文件失败: {e}")))?;
    }

    tracing::info!(
        "已创建 {}: {}",
        if body.is_folder { "目录" } else { "文件" },
        target.display()
    );

    Ok((
        StatusCode::CREATED,
        Json(json!({
            "path": target.to_string_lossy(),
            "name": body.name,
            "isFolder": body.is_folder,
        })),
    ))
}

/// 删除文件/文件夹查询参数：?path=<绝对路径>
#[derive(Debug, Deserialize)]
pub struct DeleteQuery {
    pub path: String,
}

/// DELETE /api/files?path=...
pub async fn delete_file(
    State(state): State<SharedState>,
    Query(q): Query<DeleteQuery>,
) -> Result<Json<Value>, AppError> {
    let root = state
        .project_root()
        .await
        .ok_or_else(|| AppError::BadRequest("尚未加载项目目录".into()))?;
    // 写操作权限闸门：删除视为高危写操作，需 can_write
    let cfg = state.permission_config().await;
    if !cfg.level.can_write() {
        return Err(AppError::Forbidden("当前权限等级禁止删除文件/目录".into()));
    }
    let target = PathBuf::from(&q.path);
    validate_within_root(&target, &root)?;

    if !target.exists() {
        return Err(AppError::BadRequest(format!(
            "目标不存在: {}",
            target.display()
        )));
    }

    if target.is_dir() {
        tokio::fs::remove_dir_all(&target)
            .await
            .map_err(|e| AppError::BadRequest(format!("删除文件夹失败: {e}")))?;
    } else {
        tokio::fs::remove_file(&target)
            .await
            .map_err(|e| AppError::BadRequest(format!("删除文件失败: {e}")))?;
    }

    tracing::info!("已删除: {}", target.display());
    Ok(Json(json!({ "deleted": true, "path": q.path })))
}

/// 重命名请求体。
#[derive(Debug, Deserialize)]
pub struct RenameBody {
    pub from: String,
    pub to: String,
}

/// PATCH /api/files/rename
pub async fn rename_file(
    State(state): State<SharedState>,
    Json(body): Json<RenameBody>,
) -> Result<Json<Value>, AppError> {
    let root = state
        .project_root()
        .await
        .ok_or_else(|| AppError::BadRequest("尚未加载项目目录".into()))?;
    // 写操作权限闸门：重命名视为写操作，需 can_write
    let cfg = state.permission_config().await;
    if !cfg.level.can_write() {
        return Err(AppError::Forbidden(
            "当前权限等级禁止重命名文件/目录".into(),
        ));
    }
    let src = PathBuf::from(&body.from);
    validate_within_root(&src, &root)?;

    let dst = PathBuf::from(&body.to);
    validate_within_root(&dst, &root)?;

    if dst.exists() {
        return Err(AppError::BadRequest(format!(
            "目标已存在: {}",
            dst.display()
        )));
    }

    tokio::fs::rename(&src, &dst)
        .await
        .map_err(|e| AppError::BadRequest(format!("重命名失败: {e}")))?;

    tracing::info!("重命名: {} -> {}", src.display(), dst.display());
    Ok(Json(json!({
        "from": body.from,
        "to": body.to,
    })))
}

/// 在系统资源管理器中打开指定路径。
#[derive(Debug, Deserialize)]
pub struct RevealBody {
    pub path: String,
}

/// POST /api/files/reveal
pub async fn reveal_in_explorer(
    State(state): State<SharedState>,
    Json(body): Json<RevealBody>,
) -> Result<Json<Value>, AppError> {
    let root = state
        .project_root()
        .await
        .ok_or_else(|| AppError::BadRequest("尚未加载项目目录".into()))?;
    let target = PathBuf::from(&body.path);
    validate_within_root(&target, &root)?;

    // Windows: explorer.exe /select,"path"
    #[cfg(target_os = "windows")]
    {
        use std::process::Command;
        let _ = Command::new("explorer.exe")
            .arg(format!("/select,{}", target.display()))
            .spawn();
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = root;
        let _ = &target;
    }

    Ok(Json(json!({ "revealed": true, "path": body.path })))
}

/// 读取单个文件内容（用于前端预览）。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadFileBody {
    pub path: String,
    #[serde(default = "default_max_bytes")]
    pub max_bytes: u64,
}

fn default_max_bytes() -> u64 {
    512 * 1024 // 512KB
}

/// POST /api/files/read
pub async fn read_file(
    State(state): State<SharedState>,
    Json(body): Json<ReadFileBody>,
) -> Result<Json<Value>, AppError> {
    let root = state
        .project_root()
        .await
        .ok_or_else(|| AppError::BadRequest("尚未加载项目目录".into()))?;
    let target = PathBuf::from(&body.path);
    validate_within_root(&target, &root)?;

    if !target.exists() {
        return Err(AppError::BadRequest(format!(
            "文件不存在: {}",
            target.display()
        )));
    }
    if target.is_dir() {
        return Err(AppError::BadRequest("目标是目录，无法读取".into()));
    }

    let metadata = tokio::fs::metadata(&target)
        .await
        .map_err(|e| AppError::BadRequest(format!("读取元数据失败: {e}")))?;
    if metadata.len() > body.max_bytes {
        return Err(AppError::BadRequest(format!(
            "文件过大: {} bytes (上限 {})",
            metadata.len(),
            body.max_bytes
        )));
    }

    let content = tokio::fs::read_to_string(&target)
        .await
        .map_err(|e| AppError::BadRequest(format!("读取文件失败: {e}")))?;

    Ok(Json(json!({
        "path": body.path,
        "content": content,
        "size": metadata.len(),
        "language": detect_language(&target),
    })))
}

/// 写入文件内容（前端编辑后保存）。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteFileBody {
    pub path: String,
    pub content: String,
    /// true=创建备份文件（.bak）
    #[serde(default)]
    pub create_backup: bool,
}

/// POST /api/files/write
pub async fn write_file(
    State(state): State<SharedState>,
    Json(body): Json<WriteFileBody>,
) -> Result<Json<Value>, AppError> {
    let root = state
        .project_root()
        .await
        .ok_or_else(|| AppError::BadRequest("尚未加载项目目录".into()))?;
    // 写操作权限闸门：写入视为写操作，需 can_write
    let cfg = state.permission_config().await;
    if !cfg.level.can_write() {
        return Err(AppError::Forbidden("当前权限等级禁止写入文件".into()));
    }
    let target = PathBuf::from(&body.path);
    validate_within_root(&target, &root)?;

    if body.create_backup && target.exists() {
        let backup = target.with_extension(format!(
            "{}.bak",
            target.extension().and_then(|e| e.to_str()).unwrap_or("")
        ));
        let _ = tokio::fs::copy(&target, &backup).await;
    }

    // 确保父目录存在
    if let Some(p) = target.parent() {
        tokio::fs::create_dir_all(p)
            .await
            .map_err(|e| AppError::BadRequest(format!("创建父目录失败: {e}")))?;
    }

    tokio::fs::write(&target, &body.content)
        .await
        .map_err(|e| AppError::BadRequest(format!("写入文件失败: {e}")))?;

    tracing::info!("已写入: {}", target.display());
    Ok(Json(json!({
        "path": body.path,
        "written": true,
        "bytes": body.content.len(),
    })))
}

/// 根据扩展名推断语言标识（供前端语法高亮）。
fn detect_language(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .as_deref()
    {
        Some("rs") => "rust",
        Some("ts" | "tsx") => "typescript",
        Some("js" | "jsx" | "mjs" | "cjs") => "javascript",
        Some("cs") => "csharp",
        Some("py") => "python",
        Some("go") => "go",
        Some("java") => "java",
        Some("kt") => "kotlin",
        Some("cpp" | "cc" | "cxx" | "hpp" | "h") => "cpp",
        Some("c") => "c",
        Some("json") => "json",
        Some("toml") => "toml",
        Some("yaml" | "yml") => "yaml",
        Some("md" | "markdown") => "markdown",
        Some("html" | "htm") => "html",
        Some("css" | "scss" | "sass") => "css",
        Some("sql") => "sql",
        Some("sh" | "bash") => "shell",
        Some("xml") => "xml",
        _ => "text",
    }
}

/// 校验目标路径必须位于项目根之内，防止路径穿越攻击。
/// 目标文件可能尚不存在（重命名目的地、新建文件等），此时校验其父目录。
fn validate_within_root(target: &Path, root: &Path) -> Result<(), AppError> {
    let canonical_root = root
        .canonicalize()
        .map_err(|e| AppError::BadRequest(format!("项目根无效: {e}")))?;

    let check_path: PathBuf = if target.exists() {
        target
            .canonicalize()
            .map_err(|e| AppError::BadRequest(format!("路径无效: {e}")))?
    } else if let Some(parent) = target.parent() {
        if parent.exists() {
            parent
                .canonicalize()
                .map_err(|e| AppError::BadRequest(format!("父目录无效: {e}")))?
                .join(target.file_name().unwrap_or_default())
        } else {
            // 父目录也不存在，逐级向上查找第一个存在的祖先
            let mut ancestor = parent;
            while !ancestor.exists() {
                ancestor = match ancestor.parent() {
                    Some(p) => p,
                    None => return Err(AppError::BadRequest("路径无效: 无法定位祖先目录".into())),
                };
            }
            let canonical_ancestor = ancestor
                .canonicalize()
                .map_err(|e| AppError::BadRequest(format!("祖先目录无效: {e}")))?;
            // 校验祖先在根内
            if !canonical_ancestor.starts_with(&canonical_root) {
                return Err(AppError::BadRequest(format!(
                    "路径越界: {} 不在项目根 {} 之内",
                    target.display(),
                    canonical_root.display()
                )));
            }
            return Ok(());
        }
    } else {
        canonical_root.clone()
    };

    if !check_path.starts_with(&canonical_root) {
        return Err(AppError::BadRequest(format!(
            "路径越界: {} 不在项目根 {} 之内",
            target.display(),
            canonical_root.display()
        )));
    }
    Ok(())
}
