// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod image;
mod network;

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{
    CustomMenuItem, Manager, State, SystemTray, SystemTrayEvent, SystemTrayMenu,
    SystemTrayMenuItem, WindowEvent,
};

const SINGLE_INSTANCE_PORT: u16 = 39123;

// ✅ 是否"关闭窗口时隐藏到托盘"（默认 true）
struct CloseToTrayFlag(Arc<AtomicBool>);

#[tauri::command]
fn set_close_to_tray(state: State<CloseToTrayFlag>, enabled: bool) {
    state.0.store(enabled, Ordering::Relaxed);
}

fn build_tray() -> SystemTray {
    let show = CustomMenuItem::new("show".to_string(), "显示主窗口");
    let quit = CustomMenuItem::new("quit".to_string(), "退出 X-Spider");
    let menu = SystemTrayMenu::new()
        .add_item(show)
        .add_native_item(SystemTrayMenuItem::Separator)
        .add_item(quit);
    SystemTray::new().with_menu(menu)
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

    let close_to_tray = Arc::new(AtomicBool::new(true));

    tauri::Builder::default()
        // .plugin(tauri_plugin_window_state::Builder::default().build())
        .manage(CloseToTrayFlag(close_to_tray))
        .system_tray(build_tray())
        .on_system_tray_event(|app, event| match event {
            SystemTrayEvent::LeftClick { .. } => {
                show_main_window(app);
            }
            SystemTrayEvent::DoubleClick { .. } => {
                show_main_window(app);
            }
            SystemTrayEvent::MenuItemClick { id, .. } => match id.as_str() {
                "show" => {
                    show_main_window(app);
                }
                "quit" => {
                    app.exit(0);
                }
                _ => {}
            },
            _ => {}
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let state = window.app_handle().state::<CloseToTrayFlag>();
                let close_to_tray = state.0.load(Ordering::Relaxed);
                if close_to_tray {
                    // 隐藏到托盘，不退出
                    api.prevent_close();
                    let _ = window.hide();
                }
                // close_to_tray = false 时，不拦截，正常退出应用
            }
        })
        .invoke_handler(tauri::generate_handler![
          network::network_fetch,
          network::network_get_system_proxy_url,
          image::generate_thumbnail,
          set_close_to_tray,
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
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}