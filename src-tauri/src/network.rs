use std::collections::HashMap;
use reqwest::Method;
use serde_json::Value;

#[derive(Default, serde::Serialize)]
pub struct Response {
  status: u16,
  headers: HashMap<String, Vec<String>>,
  body: Value,
}

#[tauri::command]
pub async fn network_fetch(
  method: String,
  url: String,
  body: String,
  enable_proxy: bool,
  proxy_url: String,
  response_type: String,
  headers: HashMap<String, String>,
) -> Result<Response, String> {
  let map_reqwest_err = |err: reqwest::Error| err.to_string();
  // Convert method string into Method
  let method: Method = match method.to_uppercase().as_str() {
    "GET" => Ok(Method::GET),
    "POST" => Ok(Method::POST),
    "PATCH" => Ok(Method::PATCH),
    "PUT" => Ok(Method::PUT),
    "DELETE" => Ok(Method::DELETE),
    "HEAD" => Ok(Method::HEAD),
    _ => Err("Invalid method".to_string()),
  }?;

  // Build client
  let client = {
    let mut b = reqwest::Client::builder();

    // ✅ 优化：删除了 danger_accept_invalid_certs(true)。
    // 使用 rustls-tls 后，证书验证不再依赖 Windows Schannel，无需再跳过校验。

    // Auto set proxy settings
    if enable_proxy {
      if proxy_url.is_empty() {
        // Use system proxy, do nothing
      } else {
        // Use custom proxy url
        let proxy_http = reqwest::Proxy::http(proxy_url.clone())
          .map_err(|_| "Failed to set proxy url".to_string())?;
        let proxy_https = reqwest::Proxy::https(proxy_url.clone())
          .map_err(|_| "Failed to set proxy url".to_string())?;
        b = b.proxy(proxy_http).proxy(proxy_https);
      }
    } else {
      // No proxy
      b = b.no_proxy();
    }

    b.build()
      .map_err(|_| "Failed to build reqwest client".to_string())
  }?;

  // Build request
  let request = {
    let mut req = client.request(method.clone(), url);
    for (k, v) in headers {
      req = req.header(k, v);
    }

    if !matches!(method, Method::GET) {
      req = req.body(body);
    }

    req
  };

  // Send request
  let response = request.send().await.map_err(map_reqwest_err)?;

  // Extract some info
  let status = response.status().as_u16();
  let resp_headers = {
    let reqwest_headers = response.headers();
    let mut h: HashMap<String, Vec<String>> =
      HashMap::with_capacity(reqwest_headers.len());

    for (k, v) in reqwest_headers {
      let v = v.to_str();
      if v.is_err() {
        continue;
      }

      let v = v.unwrap().to_string();
      h.entry(k.to_string())
        .and_modify(|arr: &mut Vec<String>| arr.push(v.clone()))
        .or_insert_with(|| vec![v]);
    }

    h
  };

  // Load response body
  let body: Value = {
    match response_type.as_str() {
      "json" => response.json().await.map_err(map_reqwest_err),
      "text" => response
        .text()
        .await
        .map_err(map_reqwest_err)
        .map(Value::String),
      "binary" => {
        let bytes = response.bytes().await.map_err(map_reqwest_err)?;
        serde_json::to_value(bytes.to_vec()).map_err(|err| err.to_string())
      }
      _ => Err("Unsupported response type".to_string()),
    }
  }?;

  Ok(Response {
    status,
    body,
    headers: resp_headers,
  })
}

#[tauri::command]
pub async fn network_get_system_proxy_url() -> Result<HashMap<String, String>, ()> {
  // 说明：当前版本未实现系统代理的读取，返回空 Map。
  // 前端在 proxy.useSystem = true 时会把空字符串传给 reqwest，
  // reqwest 会走它自己的环境变量（HTTPS_PROXY 等）逻辑。
  // 如果将来要实现真正的系统代理读取，可以在这里接入平台 API。
  let mapped_proxies: HashMap<String, String> = HashMap::new();
  Ok(mapped_proxies)
}