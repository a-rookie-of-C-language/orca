use serde::Deserialize;
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};

use crate::browser_session::BrowserSessionProfileSource;

const FILE_NAME: &str = "client-route-cookie-import-sources.json";
// Why 128: mirrors Electron per-desktop badge cap; evicts oldest imports first.
const MAX_ENTRIES: usize = 128;

#[derive(Debug)]
pub struct ClientRouteImportSourceState {
    metadata_path: Option<PathBuf>,
    sources: Mutex<HashMap<String, BrowserSessionProfileSource>>,
}

fn entry_key(environment_id: &str, profile_id: &str) -> String {
    format!("{environment_id}\0{profile_id}")
}

fn load_sources(path: Option<&std::path::Path>) -> HashMap<String, BrowserSessionProfileSource> {
    let Some(path) = path else {
        return HashMap::new();
    };
    let Ok(contents) = fs::read(path) else {
        return HashMap::new();
    };
    let Ok(parsed) =
        serde_json::from_slice::<HashMap<String, BrowserSessionProfileSource>>(&contents)
    else {
        return HashMap::new();
    };
    parsed
        .into_iter()
        .filter(|(key, source)| !key.is_empty() && !source.browser_family.is_empty())
        .collect()
}

impl ClientRouteImportSourceState {
    pub fn from_app(app: &AppHandle) -> Self {
        let metadata_path = app
            .path()
            .app_data_dir()
            .ok()
            .map(|directory| directory.join(FILE_NAME));
        Self::new(metadata_path)
    }

    pub fn new(metadata_path: Option<PathBuf>) -> Self {
        Self {
            sources: Mutex::new(load_sources(metadata_path.as_deref())),
            metadata_path,
        }
    }

    fn persist(&self, sources: &HashMap<String, BrowserSessionProfileSource>) {
        let Some(path) = self.metadata_path.as_ref() else {
            return;
        };
        let Some(parent) = path.parent() else {
            return;
        };
        if fs::create_dir_all(parent).is_err() {
            return;
        }
        let Ok(contents) = serde_json::to_vec_pretty(sources) else {
            return;
        };
        let temporary_path = path.with_extension("json.tmp");
        if fs::write(&temporary_path, contents).is_ok() {
            let _ = fs::rename(&temporary_path, path);
        }
    }

    pub fn record(
        &self,
        environment_id: &str,
        profile_id: &str,
        source: BrowserSessionProfileSource,
    ) -> bool {
        if environment_id.is_empty() || profile_id.is_empty() || source.browser_family.is_empty() {
            return false;
        }
        let Ok(mut sources) = self.sources.lock() else {
            return false;
        };
        sources.insert(entry_key(environment_id, profile_id), source);
        if sources.len() > MAX_ENTRIES {
            let mut by_age: Vec<(String, u64)> = sources
                .iter()
                .map(|(key, value)| (key.clone(), value.imported_at))
                .collect();
            by_age.sort_by_key(|(_, imported_at)| *imported_at);
            for (key, _) in by_age.iter().take(sources.len() - MAX_ENTRIES) {
                sources.remove(key);
            }
        }
        self.persist(&sources);
        true
    }

    pub fn list(&self, environment_id: &str) -> HashMap<String, BrowserSessionProfileSource> {
        let prefix = format!("{environment_id}\0");
        let Ok(sources) = self.sources.lock() else {
            return HashMap::new();
        };
        sources
            .iter()
            .filter_map(|(key, source)| {
                key.strip_prefix(&prefix)
                    .map(|profile_id| (profile_id.to_owned(), source.clone()))
            })
            .collect()
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientRouteListArgs {
    pub environment_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientRouteRecordArgs {
    pub environment_id: String,
    pub profile_id: String,
    pub source: BrowserSessionProfileSource,
}

#[tauri::command]
pub fn poc_browser_client_route_list_sources(
    state: State<ClientRouteImportSourceState>,
    args: ClientRouteListArgs,
) -> HashMap<String, BrowserSessionProfileSource> {
    state.list(&args.environment_id)
}

#[tauri::command]
pub fn poc_browser_client_route_record_source(
    state: State<ClientRouteImportSourceState>,
    args: ClientRouteRecordArgs,
) -> bool {
    state.record(&args.environment_id, &args.profile_id, args.source)
}

#[cfg(test)]
mod tests {
    use super::{ClientRouteImportSourceState, MAX_ENTRIES};
    use crate::browser_session::BrowserSessionProfileSource;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temporary_path() -> std::path::PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock")
            .as_nanos();
        std::env::temp_dir().join(format!("orca-tauri-client-route-sources-{suffix}.json"))
    }

    fn source_at(imported_at: u64) -> BrowserSessionProfileSource {
        BrowserSessionProfileSource {
            browser_family: "chrome".to_owned(),
            profile_name: Some("Default".to_owned()),
            imported_at,
        }
    }

    #[test]
    fn isolates_environments_and_rejects_empty_keys() {
        let state = ClientRouteImportSourceState::new(None);
        assert!(!state.record("", "default", source_at(1)));
        assert!(!state.record("env-1", "", source_at(1)));
        assert!(state.record("env-1", "default", source_at(7)));
        assert_eq!(state.list("env-1").len(), 1);
        assert!(state.list("env-2").is_empty());
    }

    #[test]
    fn evicts_oldest_beyond_cap_and_reloads() {
        let path = temporary_path();
        let state = ClientRouteImportSourceState::new(Some(path.clone()));
        for index in 0..(MAX_ENTRIES + 10) {
            assert!(state.record(
                "env-1",
                &format!("profile-{index}"),
                source_at(index as u64),
            ));
        }
        let listed = state.list("env-1");
        assert_eq!(listed.len(), MAX_ENTRIES);
        assert!(!listed.contains_key("profile-0"));

        let reloaded = ClientRouteImportSourceState::new(Some(path.clone()));
        assert_eq!(reloaded.list("env-1").len(), MAX_ENTRIES);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn tolerates_corrupt_files() {
        let path = temporary_path();
        let _ = fs::create_dir_all(path.parent().expect("parent"));
        let _ = fs::write(&path, b"{not-json");
        let state = ClientRouteImportSourceState::new(Some(path.clone()));
        assert!(state.list("env-1").is_empty());
        assert!(state.record("env-1", "default", source_at(3)));
        let _ = fs::remove_file(path);
    }
}
