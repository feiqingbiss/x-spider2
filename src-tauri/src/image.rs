use base64::Engine;
use image::{GenericImageView, ImageFormat};
use std::fs;
use std::io::Cursor;

// 缩略图最大边长（像素）。400 在 144px 显示尺寸下足够清晰
const THUMB_MAX_SIZE: u32 = 400;
// JPEG 质量（1-100）。80 在体积和清晰度之间比较平衡
const JPEG_QUALITY: u8 = 80;

/// 读取本地图片，生成 400px 缩略图，返回 data URL 字符串。
/// 前端可直接把它塞进 `<img src="...">`。
#[tauri::command]
pub async fn generate_thumbnail(path: String) -> Result<String, String> {
    // 放到阻塞线程池里执行，避免卡住 tokio 的异步线程
    tauri::async_runtime::spawn_blocking(move || generate_thumbnail_sync(path))
        .await
        .map_err(|e| format!("任务执行失败: {}", e))?
}

fn generate_thumbnail_sync(path: String) -> Result<String, String> {
    // 1. 读取原文件
    let bytes = fs::read(&path).map_err(|e| format!("读取文件失败: {}", e))?;

    // 2. 解码图片（支持 JPEG/PNG/WebP/GIF 等常见格式）
    let img = image::load_from_memory(&bytes)
        .map_err(|e| format!("解码图片失败: {}", e))?;

    // 3. 等比缩放到最长边不超过 THUMB_MAX_SIZE
    let (w, h) = img.dimensions();
    if w == 0 || h == 0 {
        return Err("图片尺寸无效".to_string());
    }
    let (nw, nh) = if w >= h {
        let nh = (h * THUMB_MAX_SIZE / w).max(1);
        (THUMB_MAX_SIZE, nh)
    } else {
        let nw = (w * THUMB_MAX_SIZE / h).max(1);
        (nw, THUMB_MAX_SIZE)
    };

    let thumb = if w <= THUMB_MAX_SIZE && h <= THUMB_MAX_SIZE {
        // 原图已经很小了，直接用，不再缩放
        img
    } else {
        img.resize(nw, nh, image::imageops::FilterType::Lanczos3)
    };

    // 4. 编码成 JPEG，质量 80
    let mut buf: Vec<u8> = Vec::new();
    let mut cursor = Cursor::new(&mut buf);
    let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(
        &mut cursor,
        JPEG_QUALITY,
    );
    encoder
        .encode_image(&thumb)
        .map_err(|e| format!("编码失败: {}", e))?;

    // 5. 转成 data URL
    let b64 = base64::engine::general_purpose::STANDARD.encode(&buf);
    Ok(format!("data:image/jpeg;base64,{}", b64))
}