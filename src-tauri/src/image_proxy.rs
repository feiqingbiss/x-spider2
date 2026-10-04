use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use std::time::{Duration, SystemTime};

#[derive(serde::Deserialize)]
struct SettingsFile {
    state: Option<SettingsState>,
}

#[derive(serde::Deserialize)]
struct SettingsState {
    proxy: Option<ProxyConfig>,
}

#[derive(serde::Deserialize)]
struct ProxyConfig {
    enable: bool,
    url: String,
}

fn get_cache_dir() -> Result<PathBuf, String> {
    let base = std::env::var("LOCALAPPDATA")
        .map(PathBuf::from)
        .map_err(|_| "无法获取 LOCALAPPDATA")?;
    let dir = base.join("x-spider").join("image-cache");
    if !dir.exists() {
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    Ok(dir)
}

fn get_proxy_url() -> Option<String> {
    let appdata = std::env::var("APPDATA").ok()?;
    let path = PathBuf::from(appdata).join("x-spider").join("settings.json");
    let content = fs::read_to_string(path).ok()?;
    let settings: SettingsFile = serde_json::from_str(&content).ok()?;
    let state = settings.state?;
    let proxy = state.proxy?;
    if proxy.enable && !proxy.url.is_empty() {
        Some(proxy.url)
    } else {
        None
    }
}

async fn fetch_image(url: &str) -> Result<Vec<u8>, String> {
    let mut builder =
        reqwest::Client::builder().timeout(std::time::Duration::from_secs(30));

    if let Some(proxy_url) = get_proxy_url() {
        let proxy = reqwest::Proxy::all(&proxy_url).map_err(|e| e.to_string())?;
        builder = builder.proxy(proxy);
    }

    let client = builder.build().map_err(|e| e.to_string())?;
    let resp = client
        .get(url)
        .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)")
        .header("Referer", "https://x.com/")
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }

    resp.bytes()
        .await
        .map_err(|e| e.to_string())
        .map(|b| b.to_vec())
}

/// 走软件内配置的代理下载图片并缓存到 %LOCALAPPDATA%\x-spider\image-cache
/// 返回本地缓存文件的绝对路径。
#[tauri::command]
pub async fn download_image_to_cache(url: String) -> Result<String, String> {
    let cache_dir = get_cache_dir()?;
    let mut hasher = DefaultHasher::new();
    url.hash(&mut hasher);
    let hash = hasher.finish();
    // ✅ 使用 .jpg 后缀，方便识别，前端 convertFileSrc 也能正确识别 MIME
    let file_name = format!("{:x}.jpg", hash);
    let file_path = cache_dir.join(&file_name);

    // 缓存命中：触发一次读取刷新 atime，直接返回路径
    if file_path.exists() {
        let _ = fs::read(&file_path);
        return Ok(file_path.to_string_lossy().to_string());
    }

    // 缓存未命中：走代理下载并写入缓存
    let bytes = fetch_image(&url).await?;
    fs::write(&file_path, &bytes).map_err(|e| e.to_string())?;
    Ok(file_path.to_string_lossy().to_string())
}

/// 清理超过 max_age_days 天未被访问的图片缓存。
/// 判断依据优先级：accessed 时间 > modified 时间。
/// 同时会清理历史遗留的 .bin 后缀缓存文件。
/// 返回被删除的文件数量。
pub fn cleanup_old_cache(max_age_days: u64) -> Result<usize, String> {
    let cache_dir = get_cache_dir()?;
    let now = SystemTime::now();
    let max_age = Duration::from_secs(max_age_days * 24 * 3600);

    let mut deleted = 0usize;
    let entries = match fs::read_dir(&cache_dir) {
        Ok(e) => e,
        Err(_) => return Ok(0),
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }

        let metadata = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };

        // 优先使用 accessed 时间；若不可用，则回退到 modified
        let last_used = metadata.accessed().or_else(|_| metadata.modified());

        let last_used = match last_used {
            Ok(t) => t,
            Err(_) => continue,
        };

        let elapsed = match now.duration_since(last_used) {
            Ok(d) => d,
            Err(_) => continue, // 时间在未来，跳过
        };

        // 超过 max_age 的 .jpg 或遗留的 .bin 都清理
        let is_cache_file = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e == "jpg" || e == "bin")
            .unwrap_or(false);

        if is_cache_file && elapsed > max_age {
            if fs::remove_file(&path).is_ok() {
                deleted += 1;
            }
        }
    }

    Ok(deleted)
}