use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;

use crate::browser_cookie_import::{clear_default_cookies, import_cookies_from_file};
use crate::browser_cookie_source_import::import_cookies_from_browser;
use crate::browser_session_detection::{detect_installed_browsers, DetectedBrowser};

const DEFAULT_PARTITION: &str = "persist:orca-browser";
const SESSION_PARTITION_PREFIX: &str = "persist:orca-browser-session-";
const METADATA_FILE_NAME: &str = "browser-session-meta.json";

static NEXT_PROFILE_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSessionProfileSource {
    pub browser_family: String,
    pub profile_name: Option<String>,
    pub imported_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSessionProfile {
    pub id: String,
    pub scope: String,
    pub partition: String,
    pub label: String,
    pub source: Option<BrowserSessionProfileSource>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedBrowserSessionState {
    #[serde(default)]
    profiles: Vec<BrowserSessionProfile>,
}

#[derive(Debug)]
pub struct BrowserSessionState {
    metadata_path: Option<PathBuf>,
    profiles: Mutex<Vec<BrowserSessionProfile>>,
}

impl BrowserSessionState {
    pub fn from_app(app: &AppHandle) -> Self {
        let metadata_path = app
            .path()
            .app_data_dir()
            .ok()
            .map(|directory| directory.join(METADATA_FILE_NAME));
        Self::new(metadata_path)
    }

    pub fn new(metadata_path: Option<PathBuf>) -> Self {
        Self {
            profiles: Mutex::new(load_profiles(metadata_path.as_deref())),
            metadata_path,
        }
    }

    fn snapshot(&self) -> Vec<BrowserSessionProfile> {
        self.profiles
            .lock()
            .map(|profiles| profiles.clone())
            .unwrap_or_else(|_| vec![default_profile()])
    }

    fn persist(&self, profiles: &[BrowserSessionProfile]) {
        let Some(path) = self.metadata_path.as_ref() else {
            return;
        };
        let Some(parent) = path.parent() else {
            return;
        };
        if fs::create_dir_all(parent).is_err() {
            return;
        }
        let state = PersistedBrowserSessionState {
            profiles: profiles
                .iter()
                .filter(|profile| profile.id != "default")
                .cloned()
                .collect(),
        };
        let Ok(contents) = serde_json::to_vec_pretty(&state) else {
            return;
        };
        let temporary_path = path.with_extension("json.tmp");
        if fs::write(&temporary_path, contents).is_ok() {
            let _ = fs::rename(&temporary_path, path);
        }
    }

    pub fn list(&self) -> Vec<BrowserSessionProfile> {
        self.snapshot()
    }

    pub fn create(&self, scope: String, label: String) -> Option<BrowserSessionProfile> {
        if scope != "isolated" && scope != "imported" {
            return None;
        }
        let label = label.trim();
        if label.is_empty() || label.len() > 200 {
            return None;
        }
        let id = new_profile_id();
        let profile = BrowserSessionProfile {
            id: id.clone(),
            scope,
            partition: format!("{SESSION_PARTITION_PREFIX}{id}"),
            label: label.to_owned(),
            source: None,
        };
        let Ok(mut profiles) = self.profiles.lock() else {
            return None;
        };
        profiles.push(profile.clone());
        self.persist(&profiles);
        Some(profile)
    }

    pub fn delete(&self, profile_id: &str) -> bool {
        if profile_id == "default" {
            return false;
        }
        let Ok(mut profiles) = self.profiles.lock() else {
            return false;
        };
        let original_len = profiles.len();
        profiles.retain(|profile| profile.id != profile_id);
        if profiles.len() == original_len {
            return false;
        }
        self.persist(&profiles);
        true
    }

    pub fn resolve_partition(&self, profile_id: Option<&str>) -> String {
        let profiles = self.snapshot();
        profile_id
            .and_then(|id| profiles.iter().find(|profile| profile.id == id))
            .map(|profile| profile.partition.clone())
            .unwrap_or_else(|| DEFAULT_PARTITION.to_owned())
    }

    pub fn profile_partition(&self, profile_id: &str) -> Option<String> {
        self.snapshot()
            .into_iter()
            .find(|profile| profile.id == profile_id)
            .map(|profile| profile.partition)
    }

    pub fn update_source(&self, profile_id: &str, source: BrowserSessionProfileSource) -> bool {
        let Ok(mut profiles) = self.profiles.lock() else {
            return false;
        };
        let Some(profile) = profiles.iter_mut().find(|profile| profile.id == profile_id) else {
            return false;
        };
        profile.source = Some(source);
        self.persist(&profiles);
        true
    }
}

fn default_profile() -> BrowserSessionProfile {
    BrowserSessionProfile {
        id: "default".to_owned(),
        scope: "default".to_owned(),
        partition: DEFAULT_PARTITION.to_owned(),
        label: "Default".to_owned(),
        source: None,
    }
}

fn load_profiles(path: Option<&std::path::Path>) -> Vec<BrowserSessionProfile> {
    let mut profiles = vec![default_profile()];
    let Some(path) = path else {
        return profiles;
    };
    let Ok(contents) = fs::read(path) else {
        return profiles;
    };
    let Ok(state) = serde_json::from_slice::<PersistedBrowserSessionState>(&contents) else {
        return profiles;
    };
    for profile in state.profiles {
        if profile.id != "default"
            && (profile.scope == "isolated" || profile.scope == "imported")
            && profile.partition.starts_with(SESSION_PARTITION_PREFIX)
            && !profiles.iter().any(|existing| existing.id == profile.id)
        {
            profiles.push(profile);
        }
    }
    profiles
}

fn new_profile_id() -> String {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let counter = NEXT_PROFILE_ID.fetch_add(1, Ordering::Relaxed);
    format!("{timestamp:032x}-{counter:016x}")
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSessionCreateArgs {
    pub scope: String,
    pub label: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSessionProfileIdArgs {
    pub profile_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSessionResolveArgs {
    pub profile_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSessionImportArgs {
    pub profile_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSessionImportFromBrowserArgs {
    pub profile_id: String,
    pub browser_family: String,
    pub browser_profile: Option<String>,
}

#[tauri::command]
pub fn poc_browser_session_list_profiles(
    state: State<BrowserSessionState>,
) -> Vec<BrowserSessionProfile> {
    state.list()
}

#[tauri::command]
pub fn poc_browser_session_create_profile(
    state: State<BrowserSessionState>,
    args: BrowserSessionCreateArgs,
) -> Option<BrowserSessionProfile> {
    state.create(args.scope, args.label)
}

#[tauri::command]
pub fn poc_browser_session_delete_profile(
    state: State<BrowserSessionState>,
    args: BrowserSessionProfileIdArgs,
) -> bool {
    state.delete(&args.profile_id)
}

#[tauri::command]
pub fn poc_browser_session_resolve_partition(
    state: State<BrowserSessionState>,
    args: BrowserSessionResolveArgs,
) -> String {
    state.resolve_partition(args.profile_id.as_deref())
}

#[tauri::command]
pub fn poc_browser_session_detect_browsers() -> Vec<DetectedBrowser> {
    detect_installed_browsers()
}

#[tauri::command]
pub async fn poc_browser_session_import_cookies(
    app: AppHandle,
    state: State<'_, BrowserSessionState>,
    args: BrowserSessionImportArgs,
) -> Result<serde_json::Value, String> {
    let Some(partition) = state.profile_partition(&args.profile_id) else {
        return Ok(serde_json::json!({
            "ok": false,
            "reason": "Session profile not found."
        }));
    };
    let Some(path) = app
        .dialog()
        .file()
        .set_title("Import Cookies")
        .add_filter("Cookie Files", &["json"])
        .add_filter("All Files", &["*"])
        .blocking_pick_file()
    else {
        return Ok(serde_json::json!({ "ok": false, "reason": "canceled" }));
    };
    let path = path.into_path().map_err(|error| error.to_string())?;
    let mut result = import_cookies_from_file(&app, &partition, &path).await?;
    if result.get("ok").and_then(serde_json::Value::as_bool) == Some(true) {
        let _ = state.update_source(
            &args.profile_id,
            BrowserSessionProfileSource {
                browser_family: "manual".to_owned(),
                profile_name: None,
                imported_at: now_ms(),
            },
        );
        if let Some(object) = result.as_object_mut() {
            object.insert(
                "profileId".to_owned(),
                serde_json::Value::String(args.profile_id),
            );
        }
    }
    Ok(result)
}

#[tauri::command]
pub async fn poc_browser_session_import_from_browser(
    app: AppHandle,
    state: State<'_, BrowserSessionState>,
    args: BrowserSessionImportFromBrowserArgs,
) -> Result<serde_json::Value, String> {
    let Some(partition) = state.profile_partition(&args.profile_id) else {
        return Ok(serde_json::json!({
            "ok": false,
            "reason": "Session profile not found."
        }));
    };
    let browser = detect_installed_browsers()
        .into_iter()
        .find(|browser| browser.family == args.browser_family);
    let Some(browser) = browser else {
        return Ok(serde_json::json!({
            "ok": false,
            "reason": format!("Browser family {} is not available.", args.browser_family)
        }));
    };
    if let Some(profile) = args.browser_profile.as_deref() {
        if !browser
            .profiles
            .iter()
            .any(|candidate| candidate.directory == profile)
        {
            return Ok(serde_json::json!({
                "ok": false,
                "reason": format!("Browser profile {profile} is not available.")
            }));
        }
    }
    let mut result =
        import_cookies_from_browser(&app, &partition, &browser, args.browser_profile.as_deref())
            .await?;
    if result.get("ok").and_then(serde_json::Value::as_bool) == Some(true) {
        let _ = state.update_source(
            &args.profile_id,
            BrowserSessionProfileSource {
                browser_family: browser.family,
                profile_name: args.browser_profile,
                imported_at: now_ms(),
            },
        );
        if let Some(object) = result.as_object_mut() {
            object.insert(
                "profileId".to_owned(),
                serde_json::Value::String(args.profile_id),
            );
        }
    }
    Ok(result)
}

#[tauri::command]
pub async fn poc_browser_session_clear_default_cookies(app: AppHandle) -> Result<bool, String> {
    clear_default_cookies(&app, DEFAULT_PARTITION).await
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::{BrowserSessionState, DEFAULT_PARTITION};
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temporary_metadata_path() -> std::path::PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock")
            .as_nanos();
        std::env::temp_dir().join(format!("orca-tauri-browser-session-{suffix}.json"))
    }

    #[test]
    fn creates_and_reloads_isolated_profiles() {
        let path = temporary_metadata_path();
        let state = BrowserSessionState::new(Some(path.clone()));
        let profile = state
            .create("isolated".to_owned(), "Work".to_owned())
            .expect("profile should be created");
        assert_eq!(
            state.resolve_partition(Some(&profile.id)),
            profile.partition
        );

        let reloaded = BrowserSessionState::new(Some(path.clone()));
        assert_eq!(reloaded.list().len(), 2);
        assert_eq!(reloaded.list()[1], profile);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn rejects_invalid_scopes_and_cannot_delete_default() {
        let state = BrowserSessionState::new(None);
        assert!(state
            .create("default".to_owned(), "Nope".to_owned())
            .is_none());
        assert!(!state.delete("default"));
        assert_eq!(state.resolve_partition(Some("missing")), DEFAULT_PARTITION);
    }
}
