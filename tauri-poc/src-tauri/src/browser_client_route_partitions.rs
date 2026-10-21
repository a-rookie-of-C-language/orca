use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, State};

use crate::browser_client_route_authority::ClientRouteAuthorityState;
use crate::browser_cookie_source_import::import_cookies_from_browser;
use crate::browser_session::{BrowserSessionProfile, BrowserSessionState};
use crate::browser_session_detection::{detect_installed_browsers, DetectedBrowser};

const FILE_NAME: &str = "client-route-partition-bindings.json";
const STORE_VERSION: u32 = 1;
const PARTITION_VERSION: u32 = 1;
// Why 512: mirrors Electron per-desktop binding cap; evicts least-recently-used first.
const MAX_BINDINGS: usize = 512;
const MAX_IDENTITY_BYTES: usize = 512;

// Route-partition identity for one environment browser profile. The environment
// is part of the hash so two paired servers sharing an execution host never
// share a cookie jar.
pub struct ClientRoutePartitionIdentity {
    pub environment_id: String,
    pub browser_profile_id: String,
    pub execution_host_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DerivedClientRoutePartition {
    pub partition: String,
    pub binding_fingerprint: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PartitionBinding {
    fingerprint: String,
    #[serde(default)]
    last_used_at: u64,
    // Why: inserts inside one millisecond share last_used_at, so eviction
    // orders by insertion sequence to always drop the oldest binding first.
    #[serde(default)]
    seq: u64,
}

#[derive(Debug, Serialize, Deserialize)]
struct PersistedPartitionBindings {
    version: u32,
    bindings: HashMap<String, PartitionBinding>,
}

#[derive(Debug)]
pub struct ClientRoutePartitionStore {
    metadata_path: Option<PathBuf>,
    bindings: Mutex<HashMap<String, PartitionBinding>>,
    next_seq: AtomicU64,
}

fn sha256_hex(input: &str) -> String {
    let digest = Sha256::digest(input.as_bytes());
    let mut encoded = String::with_capacity(digest.len() * 2);
    for byte in digest {
        encoded.push(char::from_digit(u32::from(byte >> 4), 16).unwrap_or('0'));
        encoded.push(char::from_digit(u32::from(byte & 0x0f), 16).unwrap_or('0'));
    }
    encoded
}

fn profile_slug(browser_profile_id: &str) -> String {
    let slug: String = browser_profile_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '-'
            }
        })
        .take(64)
        .collect();
    if slug.is_empty() {
        "default".to_owned()
    } else {
        slug
    }
}

fn check_identity_component(name: &str, value: &str) -> Result<(), String> {
    if value.is_empty() || value.as_bytes().len() > MAX_IDENTITY_BYTES {
        return Err(format!(
            "browser_client_route_partition_identity_invalid:{name}"
        ));
    }
    Ok(())
}

// Why JSON arrays: unambiguous framing for the hashed components, mirroring
// Electron partition derivation.
pub fn derive_client_route_partition(
    identity: &ClientRoutePartitionIdentity,
) -> Result<DerivedClientRoutePartition, String> {
    check_identity_component("environment", &identity.environment_id)?;
    check_identity_component("profile", &identity.browser_profile_id)?;
    check_identity_component("host", &identity.execution_host_key)?;
    let partition_input = serde_json::to_string(&(
        "tauri-browser-route-partition",
        PARTITION_VERSION,
        ("environment", &identity.environment_id),
        ("browser-profile", &identity.browser_profile_id),
        ("execution-host", &identity.execution_host_key),
    ))
    .map_err(|error| error.to_string())?;
    let fingerprint_input = serde_json::to_string(&(
        "tauri-browser-route-partition-binding",
        PARTITION_VERSION,
        ("environment", &identity.environment_id),
        ("browser-profile", &identity.browser_profile_id),
        ("execution-host", &identity.execution_host_key),
    ))
    .map_err(|error| error.to_string())?;
    let fingerprint = sha256_hex(&fingerprint_input);
    let suffix: String = sha256_hex(&partition_input).chars().take(16).collect();
    Ok(DerivedClientRoutePartition {
        partition: format!(
            "persist:tauri-browser-v{PARTITION_VERSION}-{}-{suffix}",
            profile_slug(&identity.browser_profile_id)
        ),
        binding_fingerprint: fingerprint,
    })
}

fn load_bindings(path: Option<&std::path::Path>) -> HashMap<String, PartitionBinding> {
    let Some(path) = path else {
        return HashMap::new();
    };
    let Ok(contents) = fs::read(path) else {
        return HashMap::new();
    };
    let Ok(persisted) = serde_json::from_slice::<PersistedPartitionBindings>(&contents) else {
        return HashMap::new();
    };
    if persisted.version != STORE_VERSION {
        return HashMap::new();
    }
    persisted
        .bindings
        .into_iter()
        .filter(|(partition, binding)| {
            partition.starts_with("persist:tauri-browser-") && !binding.fingerprint.is_empty()
        })
        .collect()
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

impl ClientRoutePartitionStore {
    pub fn from_app(app: &AppHandle) -> Self {
        let metadata_path = app
            .path()
            .app_data_dir()
            .ok()
            .map(|directory| directory.join(FILE_NAME));
        Self::new(metadata_path)
    }

    pub fn new(metadata_path: Option<PathBuf>) -> Self {
        let bindings = load_bindings(metadata_path.as_deref());
        let next_seq = bindings
            .values()
            .map(|binding| binding.seq + 1)
            .max()
            .unwrap_or(0);
        Self {
            bindings: Mutex::new(bindings),
            metadata_path,
            next_seq: AtomicU64::new(next_seq),
        }
    }

    #[cfg(test)]
    pub fn contains_fingerprint(&self, fingerprint: &str) -> bool {
        self.bindings
            .lock()
            .map(|bindings| {
                bindings
                    .values()
                    .any(|binding| binding.fingerprint == fingerprint)
            })
            .unwrap_or(false)
    }

    fn persist(&self, bindings: &HashMap<String, PartitionBinding>) {
        let Some(path) = self.metadata_path.as_ref() else {
            return;
        };
        let Some(parent) = path.parent() else {
            return;
        };
        if fs::create_dir_all(parent).is_err() {
            return;
        }
        let persisted = PersistedPartitionBindings {
            version: STORE_VERSION,
            bindings: bindings.clone(),
        };
        let Ok(contents) = serde_json::to_vec_pretty(&persisted) else {
            return;
        };
        let temporary_path = path.with_extension("json.tmp");
        if fs::write(&temporary_path, contents).is_ok() {
            let _ = fs::rename(&temporary_path, path);
        }
    }

    // Binds the identity partition, adopting the stored name when this exact
    // route was bound before. A different fingerprint on the same name is a
    // cross-route collision and fails instead of mixing cookie jars.
    pub fn resolve(
        &self,
        identity: &ClientRoutePartitionIdentity,
    ) -> Result<DerivedClientRoutePartition, String> {
        let derived = derive_client_route_partition(identity)?;
        let Ok(mut bindings) = self.bindings.lock() else {
            return Err("browser_route_partition_binding_unavailable".to_owned());
        };
        if let Some(bound) = bindings
            .iter()
            .find(|(_, binding)| binding.fingerprint == derived.binding_fingerprint)
            .map(|(partition, _)| partition.clone())
        {
            return Ok(DerivedClientRoutePartition {
                partition: bound,
                binding_fingerprint: derived.binding_fingerprint,
            });
        }
        match bindings.get(&derived.partition) {
            None => {}
            Some(existing) if existing.fingerprint == derived.binding_fingerprint => {
                let mut binding = existing.clone();
                binding.last_used_at = now_ms();
                bindings.insert(derived.partition.clone(), binding);
                self.persist(&bindings);
                return Ok(derived);
            }
            Some(_) => {
                return Err("browser_route_partition_binding_conflict".to_owned());
            }
        }
        while bindings.len() >= MAX_BINDINGS {
            let Some(victim) = bindings
                .iter()
                .min_by_key(|(_, binding)| (binding.last_used_at, binding.seq))
                .map(|(partition, _)| partition.clone())
            else {
                break;
            };
            bindings.remove(&victim);
        }
        bindings.insert(
            derived.partition.clone(),
            PartitionBinding {
                fingerprint: derived.binding_fingerprint.clone(),
                last_used_at: now_ms(),
                seq: self.next_seq.fetch_add(1, Ordering::Relaxed),
            },
        );
        self.persist(&bindings);
        Ok(derived)
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientRoutePartitionResolveArgs {
    pub environment_id: String,
    pub profile_id: String,
    pub execution_host_key: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientRoutePartitionImportArgs {
    pub environment_id: String,
    pub profile_id: String,
    pub execution_host_key: String,
    pub browser_family: String,
    pub browser_profile: Option<String>,
}

#[tauri::command]
pub fn poc_browser_client_route_resolve_partition(
    state: State<ClientRoutePartitionStore>,
    args: ClientRoutePartitionResolveArgs,
) -> Result<DerivedClientRoutePartition, String> {
    state.resolve(&ClientRoutePartitionIdentity {
        environment_id: args.environment_id,
        browser_profile_id: args.profile_id,
        execution_host_key: args.execution_host_key,
    })
}

// Why: browserProfile reaches a filesystem path, so reject traversal before use.
fn reject_import_profile_traversal(browser_profile: Option<&str>) -> Result<(), String> {
    if let Some(profile) = browser_profile {
        if profile.contains('/') || profile.contains('\\') || profile.contains("..") {
            return Err("Invalid browser profile name.".to_owned());
        }
    }
    Ok(())
}

// Display name of the imported profile, mirroring Electron importedProfileName:
// the profile record matching the imported directory, else the directory itself.
fn import_profile_display_name(browser: &DetectedBrowser, requested: Option<&str>) -> String {
    let selected = requested.unwrap_or(&browser.selected_profile);
    browser
        .profiles
        .iter()
        .find(|profile| profile.directory == selected)
        .map(|profile| profile.name.clone())
        .unwrap_or_else(|| selected.to_owned())
}

// The import names a local session profile, mirroring Electron getProfile: an
// unknown profile fails closed instead of minting a jar nothing will read.
fn require_import_browser_profile(
    profiles: &[BrowserSessionProfile],
    browser_profile_id: &str,
) -> Result<(), String> {
    if profiles
        .iter()
        .any(|profile| profile.id == browser_profile_id)
    {
        Ok(())
    } else {
        Err("Session profile not found.".to_owned())
    }
}
#[tauri::command]
pub async fn poc_browser_client_route_import_from_browser(
    app: AppHandle,
    state: State<'_, ClientRoutePartitionStore>,
    authorities: State<'_, ClientRouteAuthorityState>,
    profiles: State<'_, BrowserSessionState>,
    args: ClientRoutePartitionImportArgs,
) -> Result<Value, String> {
    // Host-owned lease authority wins over the per-request renderer identity;
    // without a noted lease the request identity is the fallback, mirroring
    // the renderer-registry behavior.
    if require_import_browser_profile(&profiles.list(), &args.profile_id).is_err() {
        return Ok(json!({ "ok": false, "reason": "Session profile not found." }));
    }
    let opening = authorities.get(&args.environment_id);
    let identity = ClientRoutePartitionIdentity {
        environment_id: args.environment_id,
        browser_profile_id: args.profile_id,
        execution_host_key: opening
            .as_ref()
            .map(|authority| authority.execution_host_key.clone())
            .unwrap_or(args.execution_host_key),
    };
    let derived = match state.resolve(&identity) {
        Ok(derived) => derived,
        Err(reason) => return Ok(json!({ "ok": false, "reason": reason })),
    };
    let browser = detect_installed_browsers()
        .into_iter()
        .find(|browser| browser.family == args.browser_family);
    let Some(browser) = browser else {
        return Ok(json!({
            "ok": false,
            "reason": "Browser not found on this system."
        }));
    };
    if let Err(reason) = reject_import_profile_traversal(args.browser_profile.as_deref()) {
        return Ok(json!({ "ok": false, "reason": reason }));
    }
    if let Some(profile) = args.browser_profile.as_deref() {
        if !browser
            .profiles
            .iter()
            .any(|candidate| candidate.directory == profile)
        {
            return Ok(json!({
                "ok": false,
                "reason": format!("No cookies database found for profile \"{profile}\".")
            }));
        }
    }
    let imported_profile_name =
        import_profile_display_name(&browser, args.browser_profile.as_deref());
    let mut result = import_cookies_from_browser(
        &app,
        &derived.partition,
        &browser,
        args.browser_profile.as_deref(),
    )
    .await?;
    // Why: a lease or binding change inside the import window retargets the
    // route, so success here would badge a partition no page will ever read
    // from. The host-owned authority is the verdict when a lease was noted.
    if let Some(opening) = opening {
        match authorities.get(&identity.environment_id) {
            Some(current) if current == opening => {}
            Some(_) => {
                return Ok(json!({
                    "ok": false,
                    "reason": "This server was re-paired during the import. Try again."
                }));
            }
            None => {
                return Ok(json!({
                    "ok": false,
                    "reason": "The connection to this server ended during the import. Reconnect and try again."
                }));
            }
        }
    }
    let settled = match state.resolve(&identity) {
        Ok(settled) => settled,
        Err(_) => {
            return Ok(json!({
                "ok": false,
                "reason": "This server was re-paired during the import. Try again."
            }));
        }
    };
    if settled.partition != derived.partition {
        return Ok(json!({
            "ok": false,
            "reason": "This server was re-paired during the import. Try again."
        }));
    }
    if result.get("ok").and_then(Value::as_bool) == Some(true) {
        if let Some(object) = result.as_object_mut() {
            object.insert(
                "profileId".to_owned(),
                Value::String(identity.browser_profile_id),
            );
            object.insert(
                "profileName".to_owned(),
                Value::String(imported_profile_name),
            );
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::{
        derive_client_route_partition, import_profile_display_name,
        reject_import_profile_traversal, ClientRoutePartitionIdentity, ClientRoutePartitionStore,
        MAX_BINDINGS,
    };
    use crate::browser_session_detection::{DetectedBrowser, DetectedBrowserProfile};
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn identity(environment: &str, profile: &str, host: &str) -> ClientRoutePartitionIdentity {
        ClientRoutePartitionIdentity {
            environment_id: environment.to_owned(),
            browser_profile_id: profile.to_owned(),
            execution_host_key: host.to_owned(),
        }
    }

    fn temporary_path() -> std::path::PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock")
            .as_nanos();
        std::env::temp_dir().join(format!("orca-tauri-client-route-partitions-{suffix}.json"))
    }

    #[test]
    fn derives_stable_env_scoped_partitions() {
        let first = derive_client_route_partition(&identity("env-1", "default", "native:1"))
            .expect("valid identity");
        let second = derive_client_route_partition(&identity("env-1", "default", "native:1"))
            .expect("valid identity");
        assert_eq!(first, second);
        assert!(first
            .partition
            .starts_with("persist:tauri-browser-v1-default-"));
        // Same profile and host on another server must not share a jar.
        let other = derive_client_route_partition(&identity("env-2", "default", "native:1"))
            .expect("valid identity");
        assert_ne!(first.partition, other.partition);
        assert_ne!(first.binding_fingerprint, other.binding_fingerprint);
    }

    #[test]
    fn rejects_invalid_identities() {
        assert!(derive_client_route_partition(&identity("", "default", "native:1")).is_err());
        assert!(derive_client_route_partition(&identity("env-1", "", "native:1")).is_err());
        assert!(derive_client_route_partition(&identity("env-1", "default", "")).is_err());
        assert!(
            derive_client_route_partition(&identity("env-1", &"p".repeat(513), "native:1"))
                .is_err()
        );
    }

    #[test]
    fn resolve_is_idempotent_and_reloads() {
        let path = temporary_path();
        let store = ClientRoutePartitionStore::new(Some(path.clone()));
        let first = store
            .resolve(&identity("env-1", "default", "native:1"))
            .expect("resolve");
        let second = store
            .resolve(&identity("env-1", "default", "native:1"))
            .expect("resolve");
        assert_eq!(first, second);
        let reloaded = ClientRoutePartitionStore::new(Some(path.clone()));
        let third = reloaded
            .resolve(&identity("env-1", "default", "native:1"))
            .expect("resolve");
        assert_eq!(first.partition, third.partition);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn rejects_profile_traversal() {
        assert!(reject_import_profile_traversal(None).is_ok());
        assert!(reject_import_profile_traversal(Some("Default")).is_ok());
        assert!(reject_import_profile_traversal(Some("../escape")).is_err());
        assert!(reject_import_profile_traversal(Some("a/b")).is_err());
        assert!(reject_import_profile_traversal(Some("a\\b")).is_err());
    }

    #[test]
    fn rejects_unknown_session_profiles() {
        use super::require_import_browser_profile;
        use super::BrowserSessionProfile;
        use crate::browser_session::BrowserSessionProfileSource;
        let known = BrowserSessionProfile {
            id: "default".to_owned(),
            scope: "default".to_owned(),
            partition: "persist:orca-browser".to_owned(),
            label: "Default".to_owned(),
            source: None::<BrowserSessionProfileSource>,
        };
        assert!(require_import_browser_profile(&[known], "default").is_ok());
        assert!(require_import_browser_profile(&[], "default").is_err());
        assert!(require_import_browser_profile(&[], "missing").is_err());
    }

    #[test]
    fn resolves_import_profile_display_names() {
        let browser = DetectedBrowser {
            family: "chrome".to_owned(),
            label: "Chrome".to_owned(),
            profiles: vec![
                DetectedBrowserProfile {
                    name: "Default".to_owned(),
                    directory: "Default".to_owned(),
                },
                DetectedBrowserProfile {
                    name: "Work".to_owned(),
                    directory: "Profile 1".to_owned(),
                },
            ],
            selected_profile: "Default".to_owned(),
        };
        assert_eq!(
            import_profile_display_name(&browser, Some("Profile 1")),
            "Work"
        );
        assert_eq!(import_profile_display_name(&browser, None), "Default");
        assert_eq!(
            import_profile_display_name(&browser, Some("Unknown dir")),
            "Unknown dir"
        );
    }
    #[test]
    fn evicts_least_recently_used_beyond_cap() {
        let store = ClientRoutePartitionStore::new(None);
        for index in 0..(MAX_BINDINGS + 5) {
            store
                .resolve(&identity("env-1", &format!("profile-{index}"), "native:1"))
                .expect("resolve");
        }
        // The earliest profile fingerprint must have been evicted, newest kept.
        let victim = derive_client_route_partition(&identity("env-1", "profile-0", "native:1"))
            .expect("valid identity");
        assert!(!store.contains_fingerprint(&victim.binding_fingerprint));
        let newest = derive_client_route_partition(&identity(
            "env-1",
            &format!("profile-{}", MAX_BINDINGS + 4),
            "native:1",
        ))
        .expect("valid identity");
        assert!(store.contains_fingerprint(&newest.binding_fingerprint));
    }
}
