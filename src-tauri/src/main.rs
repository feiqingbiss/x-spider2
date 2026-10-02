// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod image;
mod network;

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use tauri::Manager;

const SINGLE_INSTANCE_PORT: u16 = 39123;

// ✅ 杀掉所有 aria2c 子进程
// Windows: taskkill /F /IM，用 CREATE_NO_WINDOW 避免弹黑窗
// Unix:    pkill -f
#[cfg(target_os = "windows")]
fn kill_aria2c() {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;

    // Tauri sidecar 在 Windows 上的进程名可能是：
    //   1. aria2c.exe
    //   2. aria2c-x86_64-pc-windows-msvc.exe（带平台三元组后缀）
    // 两个都试，忽略错误。
    for name in &["aria2c.exe", "aria2c-x86_64-pc-windows-msvc.exe"] {
        let _ = std::process::Command::new("taskkill")
            .args(&["/F", "/IM", name])
            .creation_flags(CREATE_NO_WINDOW)
            .output();
    }
}

#[cfg(not(target_os = "windows"))]
fn kill_aria2c() {
    let _ = std::process::Command::new("pkill")
        .args(&["-f", "aria2c"])
        .output();
}

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn main() {
    // ============ 单实例检测 ============
    if let Ok(mut stream) = TcpStream::connect(("127.0.0.1", SINGLE_INSTANCE_PORT)) {
        // 已有实例在运行 → 让它显示窗口，自己退出。
        // 注意：不杀 aria2c，避免打断已有实例正在进行的下载。
        let _ = stream.write_all(b"show");
        let _ = stream.flush();
        std::process::exit(0);
    }

    // ✅ 没有其他实例 → 清理上次异常退出可能残留的 aria2c
    kill_aria2c();

    // ============ 构建应用 ============
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
          network::network_fetch,
          network::network_get_system_proxy_url,
          image::generate_thumbnail,
        ])
        .setup(|app| {
            // 单实例监听：收到第二个实例的 "show" 信号 → 显示主窗口
            let handle = app.handle();
            std::thread::spawn(move || {
                if let Ok(listener) = TcpListener::bind(("127.0.0.1", SINGLE_INSTANCE_PORT)) {
                    for stream in listener.incoming() {
                        let Ok(mut s) = stream else { continue };
                        let mut buf = [0u8; 16];
                        let _ = s.read(&mut buf);
                        show_main_window(&handle);
                    }
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    // ============ 运行 + 退出清理 ============
    app.run(|_app_handle, event| {
        match event {
            // 用户点关闭 / 安装程序发 WM_CLOSE 时触发
            tauri::RunEvent::ExitRequested { .. } => {
                kill_aria2c();
            }
            // 应用退出前的最后一刻（兜底）
            tauri::RunEvent::Exit => {
                kill_aria2c();
            }
            _ => {}
        }
    });
}