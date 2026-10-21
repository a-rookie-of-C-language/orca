use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, State};

const IDENTITY_FILE_NAME: &str = "browser-identity-mode.json";
const IDENTITY_VERSION: u32 = 1;
const DEFAULT_MODE: BrowserUserAgentMode = BrowserUserAgentMode::Clean;
const MAX_USER_AGENT_BYTES: usize = 4096;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum BrowserUserAgentMode {
    Clean,
    Native,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserIdentitySnapshot {
    state: &'static str,
    applied_mode: BrowserUserAgentMode,
    configured_mode: Option<BrowserUserAgentMode>,
    explicit_selection: Option<bool>,
    migration_notice_pending: Option<bool>,
    restart_required: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserIdentityMigrationNotice {
    degraded: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserIdentityStatus {
    identity: BrowserIdentitySnapshot,
    migration_notice: Option<BrowserIdentityMigrationNotice>,
}

#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum BrowserIdentitySetResult {
    Ok {
        ok: bool,
        identity: BrowserIdentitySnapshot,
    },
    Failed {
        ok: bool,
        error: BrowserIdentityError,
        identity: BrowserIdentitySnapshot,
    },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserIdentityError {
    code: &'static str,
    message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedBrowserIdentity {
    version: u32,
    mode: BrowserUserAgentMode,
    explicit_selection: bool,
    migration_notice_pending: bool,
}

#[derive(Debug, Clone)]
struct BrowserIdentityRecord {
    snapshot: BrowserIdentitySnapshot,
    migration_notice: Option<BrowserIdentityMigrationNotice>,
}

#[derive(Debug)]
pub struct BrowserIdentityState {
    metadata_path: Option<PathBuf>,
    record: Mutex<BrowserIdentityRecord>,
    renderer_user_agent: Mutex<Option<String>>,
}

impl BrowserIdentityState {
    pub fn from_app(app: &AppHandle) -> Self {
        let metadata_path = app
            .path()
            .app_data_dir()
            .ok()
            .map(|directory| directory.join(IDENTITY_FILE_NAME));
        Self::new(metadata_path)
    }

    pub fn new(metadata_path: Option<PathBuf>) -> Self {
        Self {
            record: Mutex::new(load_record(metadata_path.as_deref())),
            metadata_path,
            renderer_user_agent: Mutex::new(None),
        }
    }

    fn status(&self) -> BrowserIdentityStatus {
        let Ok(record) = self.record.lock() else {
            return status_from_record(&default_record());
        };
        BrowserIdentityStatus {
            identity: record.snapshot.clone(),
            migration_notice: record.migration_notice.clone(),
        }
    }

    fn browser_user_agent(&self) -> Option<String> {
        let user_agent = self.renderer_user_agent.lock().ok()?.clone()?;
        let record = self.record.lock().ok()?;
        Some(match record.snapshot.applied_mode {
            BrowserUserAgentMode::Native => user_agent,
            BrowserUserAgentMode::Clean => clean_user_agent(&user_agent),
        })
    }

    fn set_renderer_user_agent(&self, user_agent: String) -> bool {
        if user_agent.is_empty() || user_agent.len() > MAX_USER_AGENT_BYTES {
            return false;
        }
        let Ok(mut stored) = self.renderer_user_agent.lock() else {
            return false;
        };
        *stored = Some(user_agent);
        true
    }

    fn set(&self, mode: BrowserUserAgentMode, reset: bool) -> BrowserIdentitySetResult {
        let Ok(mut record) = self.record.lock() else {
            return BrowserIdentitySetResult::Failed {
                ok: false,
                error: BrowserIdentityError {
                    code: "browser_identity_write_failed",
                    message: "Browser identity state is unavailable.".to_owned(),
                },
                identity: default_record().snapshot,
            };
        };

        if record.snapshot.configured_mode.is_none() && !reset {
            return BrowserIdentitySetResult::Failed {
                ok: false,
                error: BrowserIdentityError {
                    code: "browser_identity_reset_required",
                    message:
                        "Browser identity data is invalid; reset it explicitly before changing it."
                            .to_owned(),
                },
                identity: record.snapshot.clone(),
            };
        }

        if record.snapshot.configured_mode.is_none() && reset {
            if let Some(path) = self.metadata_path.as_deref() {
                if let Err(error) = backup_unhealthy_record(path) {
                    return BrowserIdentitySetResult::Failed {
                        ok: false,
                        error: BrowserIdentityError {
                            code: "browser_identity_backup_failed",
                            message: error,
                        },
                        identity: record.snapshot.clone(),
                    };
                }
            }
        }

        let persisted = PersistedBrowserIdentity {
            version: IDENTITY_VERSION,
            mode,
            explicit_selection: true,
            migration_notice_pending: false,
        };
        if let Some(path) = self.metadata_path.as_deref() {
            if let Err(error) = write_record(path, &persisted) {
                return BrowserIdentitySetResult::Failed {
                    ok: false,
                    error: BrowserIdentityError {
                        code: "browser_identity_write_failed",
                        message: error,
                    },
                    identity: record.snapshot.clone(),
                };
            }
        }

        let applied_mode = record.snapshot.applied_mode;
        record.snapshot = BrowserIdentitySnapshot {
            state: "valid",
            applied_mode,
            configured_mode: Some(mode),
            explicit_selection: Some(true),
            migration_notice_pending: Some(false),
            restart_required: applied_mode != mode,
        };
        record.migration_notice = None;
        BrowserIdentitySetResult::Ok {
            ok: true,
            identity: record.snapshot.clone(),
        }
    }
}

fn status_from_record(record: &BrowserIdentityRecord) -> BrowserIdentityStatus {
    BrowserIdentityStatus {
        identity: record.snapshot.clone(),
        migration_notice: record.migration_notice.clone(),
    }
}

fn default_record() -> BrowserIdentityRecord {
    BrowserIdentityRecord {
        snapshot: BrowserIdentitySnapshot {
            state: "missing",
            applied_mode: DEFAULT_MODE,
            configured_mode: Some(DEFAULT_MODE),
            explicit_selection: Some(false),
            migration_notice_pending: Some(false),
            restart_required: false,
        },
        migration_notice: None,
    }
}

fn load_record(path: Option<&Path>) -> BrowserIdentityRecord {
    let Some(path) = path else {
        return default_record();
    };
    let Ok(contents) = fs::read_to_string(path) else {
        return if path.exists() {
            unhealthy_record("unreadable")
        } else {
            default_record()
        };
    };
    let Ok(persisted) = serde_json::from_str::<PersistedBrowserIdentity>(&contents) else {
        return unhealthy_record("corrupt");
    };
    if persisted.version > IDENTITY_VERSION {
        return unhealthy_record("future");
    }
    if persisted.version != IDENTITY_VERSION {
        return unhealthy_record("corrupt");
    }
    BrowserIdentityRecord {
        snapshot: BrowserIdentitySnapshot {
            state: "valid",
            applied_mode: persisted.mode,
            configured_mode: Some(persisted.mode),
            explicit_selection: Some(persisted.explicit_selection),
            migration_notice_pending: Some(persisted.migration_notice_pending),
            restart_required: false,
        },
        migration_notice: persisted
            .migration_notice_pending
            .then_some(BrowserIdentityMigrationNotice { degraded: false }),
    }
}

fn unhealthy_record(state: &'static str) -> BrowserIdentityRecord {
    BrowserIdentityRecord {
        snapshot: BrowserIdentitySnapshot {
            state,
            applied_mode: DEFAULT_MODE,
            configured_mode: None,
            explicit_selection: None,
            migration_notice_pending: None,
            restart_required: false,
        },
        migration_notice: None,
    }
}

fn write_record(path: &Path, record: &PersistedBrowserIdentity) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Browser identity path has no parent directory.".to_owned())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let temporary_path = parent.join(format!(".{IDENTITY_FILE_NAME}.{suffix}.tmp"));
    let contents = serde_json::to_vec_pretty(record).map_err(|error| error.to_string())?;
    fs::write(&temporary_path, contents).map_err(|error| error.to_string())?;
    if let Err(error) = fs::rename(&temporary_path, path) {
        let _ = fs::remove_file(path);
        if let Err(rename_error) = fs::rename(&temporary_path, path) {
            let _ = fs::remove_file(&temporary_path);
            return Err(format!("{error}; retry failed: {rename_error}"));
        }
    }
    Ok(())
}

fn backup_unhealthy_record(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let backup = path.with_extension(format!("{suffix}-{}.bak", std::process::id()));
    if backup.exists() {
        return Err(format!(
            "Browser identity backup {} already exists",
            backup.display()
        ));
    }
    fs::copy(path, backup)
        .map(|_| ())
        .map_err(|error| error.to_string())
}

fn clean_user_agent(user_agent: &str) -> String {
    let mut cleaned = user_agent
        .split_whitespace()
        .filter(|token| !token.starts_with("Electron/") && !token.starts_with("Tauri/"))
        .collect::<Vec<_>>();
    if cleaned.iter().any(|token| token.starts_with("Edg/")) {
        cleaned.retain(|token| !token.starts_with("Edg/"));
    }
    cleaned.join(" ")
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserIdentitySetArgs {
    pub mode: BrowserUserAgentMode,
    #[serde(default)]
    pub reset: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserIdentityUserAgentArgs {
    pub user_agent: String,
}

#[tauri::command]
pub fn poc_browser_identity_get(state: State<BrowserIdentityState>) -> BrowserIdentityStatus {
    state.status()
}

#[tauri::command]
pub fn poc_browser_identity_set(
    state: State<BrowserIdentityState>,
    args: BrowserIdentitySetArgs,
) -> BrowserIdentitySetResult {
    state.set(args.mode, args.reset)
}

#[tauri::command]
pub fn poc_browser_identity_set_renderer_user_agent(
    state: State<BrowserIdentityState>,
    args: BrowserIdentityUserAgentArgs,
) -> bool {
    state.set_renderer_user_agent(args.user_agent)
}

pub fn browser_user_agent(state: &BrowserIdentityState) -> Option<String> {
    state.browser_user_agent()
}

#[cfg(test)]
mod tests {
    use super::{clean_user_agent, BrowserIdentityState, BrowserUserAgentMode};
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temporary_path() -> std::path::PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock")
            .as_nanos();
        std::env::temp_dir().join(format!("orca-tauri-browser-identity-{suffix}.json"))
    }

    #[test]
    fn missing_identity_defaults_to_clean() {
        let state = BrowserIdentityState::new(None);
        let status = state.status();
        assert_eq!(status.identity.applied_mode, BrowserUserAgentMode::Clean);
        assert_eq!(
            status.identity.configured_mode,
            Some(BrowserUserAgentMode::Clean)
        );
        assert!(!status.identity.restart_required);
    }

    #[test]
    fn set_persists_and_requires_restart_when_mode_changes() {
        let path = temporary_path();
        let state = BrowserIdentityState::new(Some(path.clone()));
        let result = state.set(BrowserUserAgentMode::Native, false);
        let super::BrowserIdentitySetResult::Ok { identity, .. } = result else {
            panic!("identity mode should be set");
        };
        assert_eq!(identity.applied_mode, BrowserUserAgentMode::Clean);
        assert_eq!(identity.configured_mode, Some(BrowserUserAgentMode::Native));
        assert!(identity.restart_required);
        let reloaded = BrowserIdentityState::new(Some(path.clone()));
        assert_eq!(
            reloaded.status().identity.applied_mode,
            BrowserUserAgentMode::Native
        );
        let _ = fs::remove_file(path);
    }

    #[test]
    fn clean_user_agent_removes_webview_identity_tokens() {
        assert_eq!(
            clean_user_agent("Mozilla/5.0 Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0"),
            "Mozilla/5.0 Chrome/140.0.0.0 Safari/537.36"
        );
    }
}
