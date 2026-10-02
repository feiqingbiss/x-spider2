// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod image;
mod network;

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use tauri::Manager;

// 单实例锁使用本地回环端口
const SINGLE_INSTANCE_PORT: u16 = 39123;

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

    tauri::Builder::default()
        // 窗口状态记忆（位置、大小）
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
          network::network_fetch,
          network::network_get_system_proxy_url,
          image::generate_thumbnail,
        ])
        .setup(|app| {
            // 单实例监听
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
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}