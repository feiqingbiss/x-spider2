use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use tauri::http::{Request, Response};

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

// 并发下载限制
static ACTIVE_DOWNLOADS: AtomicUsize = AtomicUsize::new(0);
const MAX_CONCURRENT_DOWNLOADS: usize = 6;

fn get_cache_dir() -> Result<PathBuf, String> {
    // 使用 %LOCALAPPDATA%\x-spider\image-cache
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

async fn download_image(url: &str) -> Result<Vec<u8>, String> {
    // URL 哈希作为缓存文件名
    let mut hasher = DefaultHasher::new();
    url.hash(&mut hasher);
    let hash = hasher.finish();
    let file_name = format!("{:x}.bin", hash);

    let cache_dir = get_cache_dir()?;
    let file_path = cache_dir.join(&file_name);

    // 缓存命中直接返回
    if file_path.exists() {
        return fs::read(&file_path).map_err(|e| e.to_string());
    }

    // 构建 Client，配置代理
    let mut builder = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30));

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

    let bytes = resp.bytes().await.map_err(|e| e.to_string())?.to_vec();

    // 写入缓存（失败不影响本次返回）
    let _ = fs::write(&file_path, &bytes);

    Ok(bytes)
}

/// 构造一个带状态码和 Content-Type 的 Tauri Response
fn make_response(status: u16, content_type: Option<&str>, body: Vec<u8>) -> Response {
    let mut response = Response::new(body);
    response.status = status;
    if let Some(ct) = content_type {
        response
            .headers
            .insert("Content-Type".to_string(), ct.to_string());
    }
    response
}

/// 处理自定义协议 xsimg://localhost/?url=<encoded_url>
/// Tauri 1.x 要求返回 Result<Response, Box<dyn Error>>
pub fn handle_xsimg_protocol(
    request: &Request,
) -> Result<Response, Box<dyn std::error::Error>> {
    // Tauri 1.x 的 request.uri() 返回 &str，需要手动解析 query
    let uri = request.uri();
    let query = uri.find('?').map(|i| &uri[i + 1..]).unwrap_or("");

    // 提取 url 参数
    let encoded_url = query.split('&').find_map(|pair| {
        let mut parts = pair.splitn(2, '=');
        let key = parts.next()?;
        let value = parts.next()?;
        if key == "url" {
            Some(value.to_string())
        } else {
            None
        }
    });

    let encoded_url = match encoded_url {
        Some(u) => u,
        None => {
            return Ok(make_response(400, None, Vec::new()));
        }
    };

    let url = match percent_decode(&encoded_url) {
        Some(u) => u,
        None => {
            return Ok(make_response(400, None, Vec::new()));
        }
    };

    // 并发限制：超过上限直接返回 503，让前端显示占位图
    if ACTIVE_DOWNLOADS.load(Ordering::Relaxed) >= MAX_CONCURRENT_DOWNLOADS {
        return Ok(make_response(503, None, Vec::new()));
    }

    ACTIVE_DOWNLOADS.fetch_add(1, Ordering::Relaxed);
    let result = tauri::async_runtime::block_on(download_image(&url));
    ACTIVE_DOWNLOADS.fetch_sub(1, Ordering::Relaxed);

    match result {
        Ok(bytes) => Ok(make_response(200, Some("image/jpeg"), bytes)),
        Err(_) => Ok(make_response(404, None, Vec::new())),
    }
}

/// 极简 percent-decode，用于解析 query 中的 url 参数
fn percent_decode(input: &str) -> Option<String> {
    let mut result = Vec::new();
    let mut bytes = input.bytes();
    while let Some(b) = bytes.next() {
        if b == b'%' {
            let h = bytes.next()?;
            let l = bytes.next()?;
            let hex = [h, l];
            let s = std::str::from_utf8(&hex).ok()?;
            let n = u8::from_str_radix(s, 16).ok()?;
            result.push(n);
        } else {
            result.push(b);
        }
    }
    String::from_utf8(result).ok()
}