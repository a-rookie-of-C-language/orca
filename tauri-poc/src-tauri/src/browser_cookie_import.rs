use serde_json::{json, Value};
use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::webview::WebviewBuilder;
use tauri::{AppHandle, Manager, Url, WebviewUrl};

use crate::browser_webview::{call_browser_devtools_protocol, store_identifier};

const MAX_FILE_BYTES: u64 = 10 * 1024 * 1024;
const MAX_COOKIE_ENTRIES: usize = 10_000;
static NEXT_IMPORT_WEBVIEW_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone)]
pub(crate) struct ImportCookie {
    pub(crate) name: String,
    pub(crate) value: String,
    pub(crate) domain: String,
    pub(crate) path: String,
    pub(crate) secure: bool,
    pub(crate) http_only: bool,
    pub(crate) same_site: Option<&'static str>,
    pub(crate) expires: Option<f64>,
    pub(crate) partition_key: Option<Value>,
}

pub async fn import_cookies_from_file(
    app: &AppHandle,
    partition: &str,
    path: &Path,
) -> Result<Value, String> {
    let metadata =
        fs::metadata(path).map_err(|_| "Could not read the selected file.".to_owned())?;
    if metadata.len() > MAX_FILE_BYTES {
        return Ok(json!({
            "ok": false,
            "reason": "Cookie file is too large."
        }));
    }
    let contents =
        fs::read_to_string(path).map_err(|_| "Could not read the selected file.".to_owned())?;
    let parsed: Value =
        serde_json::from_str(&contents).map_err(|_| "File is not valid JSON.".to_owned())?;
    let entries = parsed
        .as_array()
        .ok_or_else(|| "Expected a JSON array of cookie objects.".to_owned())?;
    if entries.is_empty() {
        return Ok(json!({ "ok": false, "reason": "Cookie file is empty." }));
    }
    if entries.len() > MAX_COOKIE_ENTRIES {
        return Ok(json!({
            "ok": false,
            "reason": "Cookie file contains too many entries."
        }));
    }

    let mut cookies = Vec::with_capacity(entries.len());
    let mut skipped = 0_usize;
    for entry in entries {
        match parse_cookie(entry) {
            Some(cookie) => cookies.push(cookie),
            None => skipped += 1,
        }
    }
    if cookies.is_empty() {
        return Ok(json!({
            "ok": false,
            "reason": format!("No valid cookies found. {skipped} entries were skipped due to missing or invalid fields.")
        }));
    }

    let webview = create_hidden_import_webview(app, partition)?;
    let result = import_into_webview(&webview, &cookies, entries.len(), skipped).await;
    let close_result = webview.close().map_err(|error| error.to_string());
    if let Err(error) = close_result {
        if result.is_ok() {
            return Err(format!("Cookie import cleanup failed: {error}"));
        }
    }
    result
}

pub async fn clear_default_cookies(app: &AppHandle, partition: &str) -> Result<bool, String> {
    let webview = create_hidden_import_webview(app, partition)?;
    let result = call_browser_devtools_protocol(
        webview.clone(),
        "Network.clearBrowserCookies",
        "{}".to_owned(),
    )
    .await;
    let _ = webview.close();
    match result {
        Ok(response) if response.get("error").is_none() => Ok(true),
        Ok(response) => Err(devtools_error(&response)),
        Err(error) => Err(error),
    }
}

fn create_hidden_import_webview(
    app: &AppHandle,
    partition: &str,
) -> Result<tauri::Webview<tauri::Wry>, String> {
    let main_window = app
        .get_window("main")
        .ok_or_else(|| "main window is unavailable".to_owned())?;
    let id = NEXT_IMPORT_WEBVIEW_ID.fetch_add(1, Ordering::Relaxed);
    let label = format!("orca-browser-cookie-import-{id}");
    let url = Url::parse("about:blank").map_err(|error| error.to_string())?;
    let builder = WebviewBuilder::new(label, WebviewUrl::External(url))
        .focused(false)
        .transparent(false)
        .data_store_identifier(store_identifier(partition));
    let webview = main_window
        .add_child(
            builder,
            tauri::LogicalPosition::new(0.0, 0.0),
            tauri::LogicalSize::new(1.0, 1.0),
        )
        .map_err(|error| error.to_string())?;
    webview.hide().map_err(|error| error.to_string())?;
    Ok(webview)
}

async fn import_into_webview(
    webview: &tauri::Webview<tauri::Wry>,
    cookies: &[ImportCookie],
    total_entries: usize,
    initially_skipped: usize,
) -> Result<Value, String> {
    let existing = get_all_cookies(webview).await?;
    let domains: Vec<&str> = cookies
        .iter()
        .map(|cookie| cookie.domain.as_str())
        .collect();
    let previous: Vec<&Value> = existing
        .iter()
        .filter(|cookie| {
            cookie
                .get("domain")
                .and_then(Value::as_str)
                .is_some_and(|domain| {
                    domains
                        .iter()
                        .any(|imported| domains_overlap(domain, imported))
                })
        })
        .collect();

    let mut deleted = Vec::new();
    for cookie in &previous {
        if let Err(error) = delete_cookie(webview, cookie).await {
            let _ = restore_cookies(webview, &deleted).await;
            return Ok(json!({
                "ok": false,
                "reason": format!("Could not safely replace cookies for the imported sites: {error}")
            }));
        }
        deleted.push(*cookie);
    }

    let set_result = call_browser_devtools_protocol(
        webview.clone(),
        "Network.setCookies",
        json!({ "cookies": cookies.iter().map(cookie_parameters).collect::<Vec<_>>() }).to_string(),
    )
    .await;
    if let Err(error) = set_result.and_then(|response| {
        if response.get("error").is_some() {
            Err(devtools_error(&response))
        } else {
            Ok(response)
        }
    }) {
        // Restore the exact coordinates that were removed before reporting failure.
        let _ = restore_cookies(webview, &deleted).await;
        return Ok(json!({
            "ok": false,
            "reason": format!("Could not safely replace cookies for the imported sites: {error}")
        }));
    }

    let mut imported_domains: Vec<String> =
        cookies.iter().map(|cookie| cookie.domain.clone()).collect();
    imported_domains.sort();
    imported_domains.dedup();
    Ok(json!({
        "ok": true,
        "profileId": "",
        "summary": {
            "totalCookies": total_entries,
            "importedCookies": cookies.len(),
            "skippedCookies": initially_skipped,
            "domains": imported_domains
        }
    }))
}

async fn get_all_cookies(webview: &tauri::Webview<tauri::Wry>) -> Result<Vec<Value>, String> {
    let response =
        call_browser_devtools_protocol(webview.clone(), "Network.getAllCookies", "{}".to_owned())
            .await?;
    if response.get("error").is_some() {
        return Err(devtools_error(&response));
    }
    Ok(response
        .get("result")
        .and_then(|result| result.get("cookies"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default())
}

async fn delete_cookie(webview: &tauri::Webview<tauri::Wry>, cookie: &Value) -> Result<(), String> {
    let mut parameters = json!({
        "name": cookie.get("name").and_then(Value::as_str).unwrap_or_default(),
        "domain": cookie.get("domain").and_then(Value::as_str).unwrap_or_default(),
        "path": cookie.get("path").and_then(Value::as_str).unwrap_or("/")
    });
    if let Some(partition_key) = cookie.get("partitionKey") {
        parameters["partitionKey"] = partition_key.clone();
    }
    let response = call_browser_devtools_protocol(
        webview.clone(),
        "Network.deleteCookies",
        parameters.to_string(),
    )
    .await?;
    if response.get("error").is_some() {
        return Err(devtools_error(&response));
    }
    Ok(())
}

async fn restore_cookies(
    webview: &tauri::Webview<tauri::Wry>,
    cookies: &[&Value],
) -> Result<(), String> {
    if cookies.is_empty() {
        return Ok(());
    }
    let response = call_browser_devtools_protocol(
        webview.clone(),
        "Network.setCookies",
        json!({ "cookies": cookies }).to_string(),
    )
    .await?;
    if response.get("error").is_some() {
        return Err(devtools_error(&response));
    }
    Ok(())
}

fn cookie_parameters(cookie: &ImportCookie) -> Value {
    let mut value = json!({
        "name": cookie.name,
        "value": cookie.value,
        "domain": cookie.domain,
        "path": cookie.path,
        "secure": cookie.secure,
        "httpOnly": cookie.http_only
    });
    if let Some(same_site) = cookie.same_site {
        value["sameSite"] = Value::String(same_site.to_owned());
    }
    if let Some(expires) = cookie.expires {
        value["expires"] = json!(expires);
    }
    if let Some(partition_key) = &cookie.partition_key {
        value["partitionKey"] = partition_key.clone();
    }
    value
}

fn parse_cookie(value: &Value) -> Option<ImportCookie> {
    let object = value.as_object()?;
    let name = object.get("name")?.as_str()?.trim().to_owned();
    let cookie_value = object.get("value")?.as_str()?.to_owned();
    let raw_domain = object.get("domain")?.as_str()?.trim();
    let domain = normalize_domain(raw_domain)?;
    let path = object
        .get("path")
        .and_then(Value::as_str)
        .filter(|path| path.starts_with('/') && !path.contains('\0'))
        .unwrap_or("/")
        .to_owned();
    let secure = bool_value(object.get("secure"));
    let http_only = bool_value(object.get("httpOnly"));
    let same_site = match object
        .get("sameSite")
        .and_then(Value::as_str)
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("lax") => Some("Lax"),
        Some("strict") => Some("Strict"),
        Some("none") | Some("no_restriction") => Some("None"),
        _ => None,
    };
    let expires = object
        .get("expirationDate")
        .or_else(|| object.get("expires"))
        .and_then(Value::as_f64)
        .filter(|expires| expires.is_finite() && *expires > 0.0);
    if name.is_empty() || name.len() > 4096 || cookie_value.len() > 4096 {
        return None;
    }
    Some(ImportCookie {
        name,
        value: cookie_value,
        domain,
        path,
        secure,
        http_only,
        same_site,
        expires,
        partition_key: None,
    })
}

fn normalize_domain(raw: &str) -> Option<String> {
    let candidate = raw.trim().trim_start_matches('.').to_ascii_lowercase();
    if candidate.is_empty()
        || candidate.len() > 253
        || candidate.contains(['/', '\\', '@', '?', '#', '%'])
    {
        return None;
    }
    let url = Url::parse(&format!("https://{candidate}/")).ok()?;
    if url.host_str()? != candidate || url.port().is_some() {
        return None;
    }
    Some(candidate)
}

fn bool_value(value: Option<&Value>) -> bool {
    value.is_some_and(|value| value.as_bool() == Some(true) || value.as_i64() == Some(1))
}

fn domains_overlap(left: &str, right: &str) -> bool {
    let left = left.trim_start_matches('.').to_ascii_lowercase();
    let right = right.trim_start_matches('.').to_ascii_lowercase();
    left == right || left.ends_with(&format!(".{right}")) || right.ends_with(&format!(".{left}"))
}

fn devtools_error(response: &Value) -> String {
    response
        .get("error")
        .and_then(|error| error.get("message"))
        .and_then(Value::as_str)
        .unwrap_or("Browser cookie operation failed.")
        .to_owned()
}

#[cfg(test)]
mod tests {
    use super::{domains_overlap, normalize_domain, parse_cookie};
    use serde_json::json;

    #[test]
    fn validates_json_cookie_fields_and_normalizes_domains() {
        let cookie = parse_cookie(&json!({
            "domain": ".Example.com",
            "name": "sid",
            "value": "abc",
            "path": "/account",
            "secure": true,
            "httpOnly": 1,
            "sameSite": "lax",
            "expirationDate": 1234.5
        }))
        .expect("cookie should be valid");
        assert_eq!(cookie.domain, "example.com");
        assert_eq!(cookie.path, "/account");
        assert!(cookie.secure);
        assert!(cookie.http_only);
        assert_eq!(cookie.same_site, Some("Lax"));
        assert_eq!(cookie.expires, Some(1234.5));
    }

    #[test]
    fn rejects_unsafe_cookie_domains_and_defaults_invalid_paths() {
        assert!(normalize_domain("example.com/path").is_none());
        assert!(normalize_domain("example.com:443").is_none());
        assert!(parse_cookie(&json!({
            "domain": "example.com",
            "name": "sid",
            "value": "abc",
            "path": "account"
        }))
        .is_some());
        assert!(parse_cookie(&json!({
            "domain": "example.com",
            "name": "sid",
            "value": "abc",
            "path": "/account\u{0000}"
        }))
        .is_some());
    }

    #[test]
    fn replacement_scope_covers_parent_and_child_domains() {
        assert!(domains_overlap(".example.com", "login.example.com"));
        assert!(domains_overlap("login.example.com", "example.com"));
        assert!(!domains_overlap("example.com", "example.net"));
    }
}
