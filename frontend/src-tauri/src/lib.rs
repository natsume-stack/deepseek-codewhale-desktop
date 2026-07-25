//! CodeWhale Desktop - Tauri 应用主入口
//!
//! 职责：
//!   1. 启动 sidecar `codewhale-server`（即 Rust HTTP 后端），监听 127.0.0.1:8787
//!   2. 等待后端就绪后加载前端窗口
//!   3. 应用退出时回收 sidecar 子进程
//!   4. 配置窗口 Mica 材质（Windows 11 云母亚克力）
//!
//! 前端通过 fetch('http://127.0.0.1:8787/api/...') 直接访问后端。

use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::Manager;
use tauri_plugin_shell::{process::CommandEvent, ShellExt};

const BACKEND_READY_DEADLINE_SECS: u64 = 15;
const BACKEND_POLL_INTERVAL_MS: u64 = 200;

/// 探测后端端口是否可达
fn probe_backend() -> bool {
    std::net::TcpStream::connect_timeout(
        &"127.0.0.1:8787".parse().unwrap(),
        Duration::from_millis(300),
    )
    .is_ok()
}

#[tauri::command]
fn backend_health_check() -> bool {
    probe_backend()
}

/// 最小化主窗口
#[tauri::command]
fn min(window: tauri::Window) {
    let _ = window.minimize();
}

/// 最大化/还原主窗口
#[tauri::command]
fn max(window: tauri::Window) -> bool {
    if window.is_maximized().unwrap_or(false) {
        let _ = window.unmaximize();
        false
    } else {
        let _ = window.maximize();
        true
    }
}

/// 关闭主窗口
#[tauri::command]
fn close(window: tauri::Window) {
    let _ = window.close();
}

/// 查询主窗口是否已最大化
#[tauri::command]
fn is_maximized(window: tauri::Window) -> bool {
    window.is_maximized().unwrap_or(false)
}

/// 包装 CommandChild 以便在窗口销毁时取回所有权并 kill
/// （CommandChild::kill 需要 self，但 State<T> 只能拿到 &T，
///  用 Mutex<Option<CommandChild>> 包装后可 take 出来）
type ChildSlot = Mutex<Option<tauri_plugin_shell::process::CommandChild>>;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            backend_health_check,
            min,
            max,
            close,
            is_maximized
        ])
        .setup(|app| {
            // === 启动 sidecar 后端 ===
            // 注：Mica 材质已由 tauri.conf.json 中 windowEffects 声明，运行时自动应用，
            // 此处无需再调用 set_effects（避免引入 tauri-utils 类型依赖）。

            let shell = app.shell();
            let sidecar = match shell.sidecar("codewhale-server") {
                Ok(cmd) => cmd,
                Err(e) => {
                    eprintln!("[codewhale-desktop] 启动 sidecar 失败: {e}");
                    return Ok(());
                }
            };

            let (mut rx, child) = sidecar.spawn().map_err(|e| {
                eprintln!("[codewhale-desktop] sidecar.spawn 失败: {e}");
                e
            })?;

            // 后台转发 sidecar stdout/stderr
            tauri::async_runtime::spawn(async move {
                while let Some(event) = rx.recv().await {
                    match event {
                        CommandEvent::Stdout(line) => {
                            println!("[backend] {}", String::from_utf8_lossy(&line).trim_end());
                        }
                        CommandEvent::Stderr(line) => {
                            eprintln!("[backend] {}", String::from_utf8_lossy(&line).trim_end());
                        }
                        CommandEvent::Terminated(p) => {
                            eprintln!(
                                "[backend] sidecar terminated: code={:?}, signal={:?}",
                                p.code, p.signal
                            );
                            break;
                        }
                        _ => {}
                    }
                }
            });

            // 等待后端 /ping 就绪
            let started = Instant::now();
            let mut ready = false;
            while started.elapsed() < Duration::from_secs(BACKEND_READY_DEADLINE_SECS) {
                if probe_backend() {
                    ready = true;
                    break;
                }
                std::thread::sleep(Duration::from_millis(BACKEND_POLL_INTERVAL_MS));
            }
            if ready {
                println!(
                    "[codewhale-desktop] 后端就绪 ({}ms)",
                    started.elapsed().as_millis()
                );
            } else {
                eprintln!(
                    "[codewhale-desktop] 警告：后端在 {}s 内未就绪",
                    BACKEND_READY_DEADLINE_SECS
                );
            }

            app.manage(ChildSlot::new(Some(child)));
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                // 从 Mutex<Option<CommandChild>> 中 take 出 child 并 kill
                if let Some(slot) = window.app_handle().try_state::<ChildSlot>() {
                    if let Some(owned) = slot.lock().unwrap().take() {
                        let _ = owned.kill();
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
