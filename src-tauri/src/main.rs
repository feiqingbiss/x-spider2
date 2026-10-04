// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod image;
mod network;
mod image_proxy;

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use tauri::Manager;

const SINGLE_INSTANCE_PORT: u16 = 39123;

// 图片缓存保留天数（超过自动清理）
const IMAGE_CACHE_MAX_AGE_DAYS: u64 = 90;

#[cfg(target_os = "windows")]
fn kill_aria2c() {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;

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
    // 单实例检查
    if let Ok(mut stream) = TcpStream::connect(("127.0.0.1", SINGLE_INSTANCE_PORT)) {
        let _ = stream.write_all(b"show");
        let _ = stream.flush();
        std::process::exit(0);
    }

    // 清理上次异常退出的残留 aria2c
    kill_aria2c();

    // 后台异步清理过期图片缓存（不阻塞启动）
    std::thread::spawn(|| {
        // 稍作延迟，避免和启动时的其他 I/O 抢占资源
        std::thread::sleep(std::time::Duration::from_secs(3));
        match image_proxy::cleanup_old_cache(IMAGE_CACHE_MAX_AGE_DAYS) {
            Ok(0) => {}
            Ok(n) => {
                eprintln!(
                    "[Cache] 已清理 {} 个超过 {} 天的图片缓存",
                    n, IMAGE_CACHE_MAX_AGE_DAYS
                );
            }
            Err(e) => {
                eprintln!("[Cache] 清理图片缓存失败: {}", e);
            }
        }
    });

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
          network::network_fetch,
          image::generate_thumbnail,
          image_proxy::download_image_to_cache,
        ])
        .setup(|app| {
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

    app.run(|_app_handle, event| match event {
        tauri::RunEvent::ExitRequested { .. } => {
            kill_aria2c();
        }
        tauri::RunEvent::Exit => {
            kill_aria2c();
        }
        _ => {}
    });
}