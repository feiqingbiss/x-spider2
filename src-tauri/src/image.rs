use image::GenericImageView;
use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;

// 缩略图最大边长
const THUMB_MAX_SIZE: u32 = 400;
// JPEG 质量
const JPEG_QUALITY: u8 = 80;

fn get_save_dir_base() -> Option<String> {
    let appdata = std::env::var("APPDATA").ok()?;
    let path = PathBuf::from(appdata).join("x-spider").join("settings.json");
    let content = fs::read_to_string(path).ok()?;
    let json: serde_json::Value = serde_json::from_str(&content).ok()?;
    let base = json.get("state")?.get("download")?.get("saveDirBase")?.as_str()?;
    if base.is_empty() { None } else { Some(base.to_string()) }
}

fn get_default_download_dir() -> Option<PathBuf> {
    let user_profile = std::env::var("USERPROFILE").ok()?;
    Some(PathBuf::from(user_profile).join("Downloads"))
}

/// ✅ 修改：本地缩略图存到 <下载目录>/.x-spider-cache/local
fn get_thumb_cache_dir() -> Result<PathBuf, String> {
    let base_dir: PathBuf = if let Some(save_dir) = get_save_dir_base() {
        PathBuf::from(save_dir)
    } else if let Some(default_download) = get_default_download_dir() {
        default_download
    } else {
        let local = std::env::var("LOCALAPPDATA")
            .map(PathBuf::from)
            .map_err(|_| "无法获取缓存目录")?;
        local.join("x-spider")
    };

    let dir = base_dir.join(".x-spider-cache").join("local");
    if !dir.exists() {
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    Ok(dir)
}

#[tauri::command]
pub async fn generate_thumbnail(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || generate_thumbnail_sync(path))
        .await
        .map_err(|e| format!("任务执行失败: {}", e))?
}

fn generate_thumbnail_sync(path: String) -> Result<String, String> {
    let cache_dir = get_thumb_cache_dir()?;

    let mut hasher = DefaultHasher::new();
    path.hash(&mut hasher);
    let hash = hasher.finish();
    let thumb_path = cache_dir.join(format!("{:x}.jpg", hash));

    if thumb_path.exists() {
        return Ok(thumb_path.to_string_lossy().to_string());
    }

    let bytes = fs::read(&path).map_err(|e| format!("读取文件失败: {}", e))?;
    let img = image::load_from_memory(&bytes).map_err(|e| format!("解码图片失败: {}", e))?;

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
        img
    } else {
        img.resize(nw, nh, image::imageops::FilterType::Lanczos3)
    };

    let mut out = fs::File::create(&thumb_path).map_err(|e| e.to_string())?;
    let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, JPEG_QUALITY);
    encoder
        .encode_image(&thumb)
        .map_err(|e| format!("编码失败: {}", e))?;

    Ok(thumb_path.to_string_lossy().to_string())
}