use aes::Aes128;
use aes_gcm::{aead::Aead, Aes256Gcm, KeyInit, Nonce};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use cbc::cipher::{block_padding::Pkcs7, BlockDecryptMut, KeyIvInit};
use pbkdf2::pbkdf2_hmac;
use rusqlite::{types::ValueRef, Connection, OpenFlags};
use serde_json::{json, Value};
use sha1::Sha1;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::AppHandle;

use crate::browser_cookie_import::ImportCookie;
use crate::browser_session_detection::{browser_cookie_path, DetectedBrowser};
use crate::browser_webview::{call_browser_devtools_protocol, store_identifier};

const MAX_SOURCE_BYTES: u64 = 512 * 1024 * 1024;
const CHROMIUM_EPOCH_OFFSET: i64 = 11_644_473_600;
const PBKDF2_SALT: &[u8] = b"saltysalt";

#[derive(Debug, Default)]
struct ImportCounts {
    total: usize,
    imported: usize,
    skipped: usize,
    google_skipped: usize,
    partition_skipped: usize,
    decrypt_failed: usize,
    app_bound_failed: usize,
}

#[derive(Debug, Clone)]
enum SqlValue {
    Null,
    Integer(i64),
    Real(f64),
    Text(String),
    Blob(Vec<u8>),
}

#[derive(Debug, Clone)]
struct SourceRow {
    values: HashMap<String, SqlValue>,
}

#[derive(Debug, Clone)]
enum DecryptionKey {
    Aes256Gcm(Vec<u8>),
    Aes128Cbc { v10: Vec<u8>, v11: Option<Vec<u8>> },
}

pub async fn import_cookies_from_browser(
    app: &AppHandle,
    partition: &str,
    browser: &DetectedBrowser,
    profile_directory: Option<&str>,
) -> Result<Value, String> {
    if browser.family == "safari" {
        return Ok(json!({
            "ok": false,
            "reason": "Safari cookie import is not supported on this Tauri build."
        }));
    }
    let path = browser_cookie_path(browser, profile_directory)
        .ok_or_else(|| format!("No cookies database found for {}.", browser.label))?;
    let rows = read_source_rows(&path, browser.family.as_str())?;
    if rows.is_empty() {
        return Ok(
            json!({ "ok": false, "reason": format!("No cookies found in {}.", browser.label) }),
        );
    }

    let mut counts = ImportCounts {
        total: rows.len(),
        ..Default::default()
    };
    let key = load_decryption_key(browser, &path);
    let mut candidates = Vec::new();
    let mut unreadable_families = HashSet::new();
    let mut domains = HashSet::new();

    for row in &rows {
        let domain_column = if browser.family == "firefox" {
            "host"
        } else {
            "host_key"
        };
        let domain = match row.text(domain_column) {
            Some(value) => value,
            None => {
                counts.skipped += 1;
                continue;
            }
        };
        let name = row.text("name").unwrap_or_default();
        if is_google_source_bound_cookie(&name, &domain) || is_non_transplantable_domain(&domain) {
            counts.google_skipped += 1;
            counts.skipped += 1;
            continue;
        }
        let Some(domain) = normalize_domain(&domain) else {
            counts.skipped += 1;
            continue;
        };
        if browser.family != "firefox" {
            if let Some(reason) = unreadable_partition(row) {
                let _ = reason;
                counts.partition_skipped += 1;
                counts.skipped += 1;
                if let Some(family) = registrable_family(&domain) {
                    unreadable_families.insert(family);
                }
                continue;
            }
        }
        let cookie = if browser.family == "firefox" {
            parse_firefox_row(row, &domain)
        } else {
            decrypt_row(row, key.as_ref(), &domain, &mut counts)
        };
        let Some(cookie) = cookie else {
            counts.skipped += 1;
            continue;
        };
        candidates.push(cookie);
    }

    let mut cookies = Vec::new();
    for cookie in candidates {
        let family = registrable_family(&cookie.domain);
        if family
            .as_ref()
            .is_some_and(|family| unreadable_families.contains(family))
        {
            counts.partition_skipped += 1;
            counts.skipped += 1;
            continue;
        }
        domains.insert(cookie.domain.clone());
        cookies.push(cookie);
    }

    if cookies.is_empty() {
        return Ok(json!({
            "ok": false,
            "reason": format!("No readable cookies found in {}.", browser.label),
            "summary": summary(&counts, &domains)
        }));
    }

    let webview = create_hidden_import_webview(app, partition)?;
    let result = import_into_webview(&webview, &cookies, &mut counts, &domains).await;
    let _ = webview.close();
    result
}

fn read_source_rows(path: &Path, family: &str) -> Result<Vec<SourceRow>, String> {
    let metadata =
        fs::metadata(path).map_err(|_| "Could not read browser cookies database.".to_owned())?;
    if metadata.len() > MAX_SOURCE_BYTES {
        return Err("Browser cookies database is too large.".to_owned());
    }
    let snapshot = snapshot_database(path)?;
    let connection = Connection::open_with_flags(&snapshot, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|_| {
            format!("Could not open {family} cookies database. Close the browser and try again.")
        })?;
    let table = if family == "firefox" {
        "moz_cookies"
    } else {
        "cookies"
    };
    let mut statement = connection
        .prepare(&format!("SELECT * FROM {table} ORDER BY rowid"))
        .map_err(|_| format!("Could not read {family} cookies database."))?;
    let names = statement
        .column_names()
        .iter()
        .map(|name| (*name).to_owned())
        .collect::<Vec<_>>();
    let rows = statement
        .query_map([], |row| {
            let mut values = HashMap::new();
            for (index, name) in names.iter().enumerate() {
                let value = match row.get_ref(index)? {
                    ValueRef::Null => SqlValue::Null,
                    ValueRef::Integer(value) => SqlValue::Integer(value),
                    ValueRef::Real(value) => SqlValue::Real(value),
                    ValueRef::Text(value) => {
                        SqlValue::Text(String::from_utf8_lossy(value).into_owned())
                    }
                    ValueRef::Blob(value) => SqlValue::Blob(value.to_vec()),
                };
                values.insert(name.clone(), value);
            }
            Ok(SourceRow { values })
        })
        .map_err(|_| format!("Could not query {family} cookies database."))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| format!("Could not read {family} cookies database."))?;
    let _ = fs::remove_file(&snapshot);
    Ok(rows)
}

fn snapshot_database(path: &Path) -> Result<PathBuf, String> {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_nanos())
        .unwrap_or_default();
    let directory = std::env::temp_dir().join(format!("orca-cookie-source-{stamp}"));
    fs::create_dir_all(&directory)
        .map_err(|_| "Could not create a temporary cookie snapshot.".to_owned())?;
    let snapshot = directory.join("Cookies");
    if let Err(error) = fs::copy(path, &snapshot) {
        let _ = fs::remove_dir_all(&directory);
        return Err(format!("Could not copy browser cookies database: {error}"));
    }
    for suffix in ["-wal", "-shm"] {
        let source = PathBuf::from(format!("{}{}", path.display(), suffix));
        if source.is_file() {
            let _ = fs::copy(
                source,
                PathBuf::from(format!("{}{}", snapshot.display(), suffix)),
            );
        }
    }
    Ok(snapshot)
}

async fn import_into_webview(
    webview: &tauri::Webview<tauri::Wry>,
    cookies: &[ImportCookie],
    counts: &mut ImportCounts,
    domains: &HashSet<String>,
) -> Result<Value, String> {
    let existing = get_all_cookies(webview).await?;
    let mut deleted = Vec::new();
    for cookie in existing.iter().filter(|cookie| {
        cookie
            .get("domain")
            .and_then(Value::as_str)
            .is_some_and(|domain| {
                domains
                    .iter()
                    .any(|imported| domains_overlap(domain, imported))
            })
    }) {
        if let Err(error) = delete_cookie(webview, cookie).await {
            let _ = restore_cookies(webview, &deleted).await;
            return Ok(
                json!({ "ok": false, "reason": format!("Could not safely replace cookies for the imported sites: {error}") }),
            );
        }
        deleted.push(cookie);
    }
    let response = call_browser_devtools_protocol(
        webview.clone(),
        "Network.setCookies",
        json!({ "cookies": cookies.iter().map(cookie_parameters).collect::<Vec<_>>() }).to_string(),
    )
    .await?;
    if response.get("error").is_some() {
        let _ = restore_cookies(webview, &deleted).await;
        return Ok(json!({ "ok": false, "reason": devtools_error(&response) }));
    }
    counts.imported = cookies.len();
    Ok(json!({ "ok": true, "profileId": "", "summary": summary(counts, domains) }))
}

fn decrypt_row(
    row: &SourceRow,
    key: Option<&DecryptionKey>,
    domain: &str,
    counts: &mut ImportCounts,
) -> Option<ImportCookie> {
    let value = match row.values.get("encrypted_value") {
        Some(SqlValue::Blob(value)) if !value.is_empty() => {
            if value.starts_with(b"v20") {
                counts.decrypt_failed += 1;
                counts.app_bound_failed += 1;
                return None;
            }
            let Some(key) = key else {
                counts.decrypt_failed += 1;
                return None;
            };
            let Some(value) = decrypt_value(value, key, domain) else {
                counts.decrypt_failed += 1;
                return None;
            };
            value
        }
        Some(SqlValue::Blob(value)) => value.clone(),
        Some(SqlValue::Text(value)) => value.as_bytes().to_vec(),
        _ => row
            .blob("value")
            .or_else(|| row.text("value").map(|value| value.into_bytes()))
            .unwrap_or_default(),
    };
    let path = row
        .text("path")
        .filter(|value| value.starts_with('/') && !value.contains('\0'))
        .unwrap_or_else(|| "/".to_owned());
    let secure = row.integer("is_secure").unwrap_or_default() != 0;
    let http_only = row.integer("is_httponly").unwrap_or_default() != 0;
    let expires = row
        .integer("expires_utc")
        .map(|value| chromium_timestamp_to_unix(value))
        .filter(|value| *value > 0)
        .map(|value| value as f64);
    let same_site = match row.integer("samesite").unwrap_or(-1) {
        0 => Some("None"),
        1 => Some("Lax"),
        2 => Some("Strict"),
        _ => None,
    };
    let value = String::from_utf8(value).ok()?;
    let mut cookie = ImportCookie {
        name: row.text("name")?,
        value,
        domain: domain.to_owned(),
        path,
        secure,
        http_only,
        same_site,
        expires,
        partition_key: None,
    };
    cookie.partition_key = partition_key(row);
    Some(cookie)
}

fn parse_firefox_row(row: &SourceRow, domain: &str) -> Option<ImportCookie> {
    let value = row.text("value").or_else(|| {
        row.blob("value")
            .and_then(|value| String::from_utf8(value).ok())
    })?;
    let path = row
        .text("path")
        .filter(|value| value.starts_with('/') && !value.contains('\0'))
        .unwrap_or_else(|| "/".to_owned());
    let same_site = match row.integer("sameSite").unwrap_or(-1) {
        0 => Some("None"),
        1 => Some("Lax"),
        2 => Some("Strict"),
        _ => None,
    };
    Some(ImportCookie {
        name: row.text("name")?,
        value,
        domain: domain.to_owned(),
        path,
        secure: row.integer("isSecure").unwrap_or_default() != 0,
        http_only: row.integer("isHttpOnly").unwrap_or_default() != 0,
        same_site,
        expires: row
            .integer("expiry")
            .filter(|value| *value > 0)
            .map(|value| value as f64),
        partition_key: None,
    })
}

fn decrypt_value(encrypted: &[u8], key: &DecryptionKey, host_key: &str) -> Option<Vec<u8>> {
    if encrypted.len() < 3 {
        return None;
    }
    let version = &encrypted[..3];
    let payload = &encrypted[3..];
    let mut plaintext = match key {
        DecryptionKey::Aes256Gcm(key) => {
            if payload.len() < 28 {
                return None;
            }
            Aes256Gcm::new_from_slice(key)
                .ok()?
                .decrypt(Nonce::from_slice(&payload[..12]), &payload[12..])
                .ok()?
        }
        DecryptionKey::Aes128Cbc { v10, v11 } => {
            let key = if version == b"v10" {
                v10
            } else if version == b"v11" {
                v11.as_ref()?
            } else {
                return None;
            };
            let mut buffer = payload.to_vec();
            cbc::Decryptor::<Aes128>::new_from_slices(key, b"                ")
                .ok()?
                .decrypt_padded_mut::<Pkcs7>(&mut buffer)
                .ok()?
                .to_vec()
        }
    };
    let host_hash = Sha256::digest(host_key.as_bytes());
    if plaintext.len() >= 32 && plaintext[..32] == host_hash[..] {
        plaintext.drain(..32);
    } else if plaintext.len() > 32
        && plaintext[..32]
            .iter()
            .filter(|byte| **byte < 0x20 || **byte > 0x7e)
            .count()
            >= 8
    {
        plaintext.drain(..32);
    }
    Some(plaintext)
}

fn load_decryption_key(browser: &DetectedBrowser, cookie_path: &Path) -> Option<DecryptionKey> {
    if browser.family == "firefox" {
        return None;
    }
    let profile_directory = cookie_path.parent()?;
    let profile_directory =
        if profile_directory.file_name().and_then(|name| name.to_str()) == Some("Network") {
            profile_directory.parent()?
        } else {
            profile_directory
        };
    let root = profile_directory.parent()?;
    let local_state = root.join("Local State");
    let value: Value = serde_json::from_slice(&fs::read(local_state).ok()?).ok()?;
    let encoded = value.get("os_crypt")?.get("encrypted_key")?.as_str()?;
    let encoded = BASE64.decode(encoded).ok()?;
    if encoded.starts_with(b"DPAPI") {
        #[cfg(windows)]
        {
            return decrypt_windows_master_key(&encoded[5..]).map(DecryptionKey::Aes256Gcm);
        }
        #[cfg(not(windows))]
        {
            return None;
        }
    }
    let mut v10 = [0_u8; 16];
    pbkdf2_hmac::<Sha1>(b"peanuts", PBKDF2_SALT, 1, &mut v10);
    Some(DecryptionKey::Aes128Cbc {
        v10: v10.to_vec(),
        v11: None,
    })
}

#[cfg(windows)]
fn decrypt_windows_master_key(encrypted: &[u8]) -> Option<Vec<u8>> {
    use std::ptr::null_mut;
    use std::slice;
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{CryptUnprotectData, CRYPT_INTEGER_BLOB};
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    let input = CRYPT_INTEGER_BLOB {
        cbData: encrypted.len() as u32,
        pbData: encrypted.as_ptr() as *mut u8,
    };
    let ok = unsafe {
        CryptUnprotectData(
            &input,
            null_mut(),
            null_mut(),
            null_mut(),
            null_mut(),
            0,
            &mut output,
        )
    };
    if ok == 0 || output.pbData.is_null() {
        return None;
    }
    let value = unsafe { slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
    unsafe {
        let _ = LocalFree(output.pbData as _);
    }
    Some(value)
}

fn partition_key(row: &SourceRow) -> Option<Value> {
    let site = row.text("top_frame_site_key")?;
    if site.is_empty() {
        return None;
    }
    if !site.starts_with("http://") && !site.starts_with("https://") {
        return None;
    }
    let ancestor = row.integer("has_cross_site_ancestor")?;
    if ancestor != 0 && ancestor != 1 {
        return None;
    }
    Some(json!({ "topLevelSite": site, "hasCrossSiteAncestor": ancestor == 1 }))
}

fn unreadable_partition(row: &SourceRow) -> Option<&'static str> {
    let site = row.values.get("top_frame_site_key")?;
    match site {
        SqlValue::Text(value) if value.is_empty() => None,
        SqlValue::Text(value) if value.starts_with("http://") || value.starts_with("https://") => {
            match row.integer("has_cross_site_ancestor") {
                Some(0) | Some(1) => None,
                _ => Some("missing ancestor flag"),
            }
        }
        _ => Some("invalid partition site"),
    }
}

impl SourceRow {
    fn text(&self, key: &str) -> Option<String> {
        match self.values.get(key)? {
            SqlValue::Text(value) => Some(value.clone()),
            _ => None,
        }
    }
    fn blob(&self, key: &str) -> Option<Vec<u8>> {
        match self.values.get(key)? {
            SqlValue::Blob(value) => Some(value.clone()),
            _ => None,
        }
    }
    fn integer(&self, key: &str) -> Option<i64> {
        match self.values.get(key)? {
            SqlValue::Integer(value) => Some(*value),
            SqlValue::Real(value) if value.is_finite() => Some(*value as i64),
            _ => None,
        }
    }
}

fn create_hidden_import_webview(
    app: &AppHandle,
    partition: &str,
) -> Result<tauri::Webview<tauri::Wry>, String> {
    use std::sync::atomic::{AtomicU64, Ordering};
    use tauri::webview::WebviewBuilder;
    use tauri::{Manager, Url, WebviewUrl};
    static NEXT_ID: AtomicU64 = AtomicU64::new(1);
    let window = app
        .get_window("main")
        .ok_or_else(|| "main window is unavailable".to_owned())?;
    let label = format!(
        "orca-browser-source-import-{}",
        NEXT_ID.fetch_add(1, Ordering::Relaxed)
    );
    let webview = window
        .add_child(
            WebviewBuilder::new(
                label,
                WebviewUrl::External(Url::parse("about:blank").map_err(|error| error.to_string())?),
            )
            .focused(false)
            .data_store_identifier(store_identifier(partition)),
            tauri::LogicalPosition::new(0.0, 0.0),
            tauri::LogicalSize::new(1.0, 1.0),
        )
        .map_err(|error| error.to_string())?;
    webview.hide().map_err(|error| error.to_string())?;
    Ok(webview)
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
    let mut parameters = json!({ "name": cookie.get("name").and_then(Value::as_str).unwrap_or_default(), "domain": cookie.get("domain").and_then(Value::as_str).unwrap_or_default(), "path": cookie.get("path").and_then(Value::as_str).unwrap_or("/") });
    if let Some(partition) = cookie.get("partitionKey") {
        parameters["partitionKey"] = partition.clone();
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
    let mut value = json!({ "name": cookie.name, "value": cookie.value, "domain": cookie.domain, "path": cookie.path, "secure": cookie.secure, "httpOnly": cookie.http_only });
    if let Some(same_site) = cookie.same_site {
        value["sameSite"] = Value::String(same_site.to_owned());
    }
    if let Some(expires) = cookie.expires {
        value["expires"] = json!(expires);
    }
    if let Some(partition) = &cookie.partition_key {
        value["partitionKey"] = partition.clone();
    }
    value
}
fn summary(counts: &ImportCounts, domains: &HashSet<String>) -> Value {
    let mut domains = domains.iter().cloned().collect::<Vec<_>>();
    domains.sort();
    let mut summary = json!({ "totalCookies": counts.total, "importedCookies": counts.imported, "skippedCookies": counts.skipped, "domains": domains });
    if counts.google_skipped > 0 {
        summary["googleCookiesSkipped"] = json!(counts.google_skipped);
    }
    if counts.partition_skipped > 0 {
        summary["partitionSkippedCookies"] = json!(counts.partition_skipped);
    }
    if counts.decrypt_failed > 0 {
        let reason = if counts.app_bound_failed == counts.decrypt_failed {
            "app-bound-encryption"
        } else {
            "unknown"
        };
        summary["warning"] = json!({
            "code": "cookies-undecryptable",
            "failedCookies": counts.decrypt_failed,
            "otherFailedCookies": counts.decrypt_failed.saturating_sub(counts.app_bound_failed),
            "reason": reason
        });
    }
    summary
}
fn chromium_timestamp_to_unix(value: i64) -> i64 {
    if value <= 0 {
        0
    } else {
        value / 1_000_000 - CHROMIUM_EPOCH_OFFSET
    }
}
fn normalize_domain(value: &str) -> Option<String> {
    let value = value.trim().trim_start_matches('.').to_ascii_lowercase();
    if value.is_empty() || value.len() > 253 || value.contains(['/', '\\', '@', '?', '#', '%']) {
        return None;
    }
    let url = url::Url::parse(&format!("https://{value}/")).ok()?;
    (url.host_str()? == value && url.port().is_none()).then_some(value)
}
fn registrable_family(domain: &str) -> Option<String> {
    let labels = domain.split('.').collect::<Vec<_>>();
    if labels.len() < 2 {
        return Some(domain.to_owned());
    }
    Some(format!(
        "{}.{}",
        labels[labels.len() - 2],
        labels[labels.len() - 1]
    ))
}
fn is_non_transplantable_domain(domain: &str) -> bool {
    let domain = domain.trim_start_matches('.').to_ascii_lowercase();
    domain == "google.com" || domain.ends_with(".google.com")
}
fn is_google_source_bound_cookie(name: &str, domain: &str) -> bool {
    matches!(
        name,
        "SIDCC" | "__Secure-1PSIDCC" | "__Secure-3PSIDCC" | "__Secure-STRP" | "AEC"
    ) && is_non_transplantable_domain(domain)
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
    use super::{
        chromium_timestamp_to_unix, is_google_source_bound_cookie, is_non_transplantable_domain,
        normalize_domain, partition_key, summary, unreadable_partition, ImportCounts, SourceRow,
        SqlValue,
    };
    use serde_json::json;
    use std::collections::{HashMap, HashSet};

    #[test]
    fn converts_chromium_timestamps_without_underflow() {
        assert_eq!(chromium_timestamp_to_unix(0), 0);
        assert_eq!(chromium_timestamp_to_unix(11_644_473_600_000_000), 0);
        assert_eq!(chromium_timestamp_to_unix(11_644_473_601_000_000), 1);
    }

    #[test]
    fn normalizes_domains_and_rejects_path_text() {
        assert_eq!(
            normalize_domain(".Example.COM"),
            Some("example.com".to_owned())
        );
        assert_eq!(normalize_domain("example.com/path"), None);
        assert_eq!(normalize_domain(""), None);
    }

    #[test]
    fn excludes_google_domains_and_source_bound_cookies() {
        assert!(is_non_transplantable_domain(".google.com"));
        assert!(is_google_source_bound_cookie(
            "SIDCC",
            "accounts.google.com"
        ));
        assert!(!is_google_source_bound_cookie("SID", "example.com"));
    }

    #[test]
    fn rejects_unreadable_partitions_without_downgrading_them() {
        let mut values = HashMap::new();
        values.insert(
            "top_frame_site_key".to_owned(),
            SqlValue::Text("https://example.com".to_owned()),
        );
        let row = SourceRow { values };
        assert_eq!(unreadable_partition(&row), Some("missing ancestor flag"));
        assert_eq!(partition_key(&row), None);
    }

    #[test]
    fn preserves_partition_identity_when_the_source_is_readable() {
        let mut values = HashMap::new();
        values.insert(
            "top_frame_site_key".to_owned(),
            SqlValue::Text("https://example.com".to_owned()),
        );
        values.insert("has_cross_site_ancestor".to_owned(), SqlValue::Integer(1));
        let row = SourceRow { values };
        assert_eq!(unreadable_partition(&row), None);
        assert_eq!(
            partition_key(&row),
            Some(json!({
                "topLevelSite": "https://example.com",
                "hasCrossSiteAncestor": true
            }))
        );
    }

    #[test]
    fn reports_app_bound_decryption_skips_in_summary() {
        let counts = ImportCounts {
            total: 2,
            skipped: 2,
            decrypt_failed: 2,
            app_bound_failed: 2,
            ..Default::default()
        };
        let summary = summary(&counts, &HashSet::new());
        assert_eq!(summary["skippedCookies"], 2);
        assert_eq!(summary["warning"]["reason"], "app-bound-encryption");
    }
}
