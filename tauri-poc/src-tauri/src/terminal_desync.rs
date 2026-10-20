//! Terminal render-desync evidence writer, mirroring Electron main.
//!
//! The capture id becomes a directory name under the app profile, so the
//! shared contract's character class is enforced before touching the
//! filesystem. Base64 here is strict: Electron's Buffer parse silently
//! drops bad characters, while this rejects the payload instead of
//! persisting a partially decoded image.

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;

const EVIDENCE_DIRECTORY: &str = "terminal-render-desync-evidence";
const MAX_PNG_DATA_URL_BYTES: usize = 40 * 1024 * 1024;
const MAX_METADATA_BYTES: usize = 1024 * 1024;
const MAX_CAPTURE_DIRECTORIES: usize = 4;
const MAX_EVIDENCE_BYTES: u64 = 96 * 1024 * 1024;
const PNG_DATA_URL_PREFIX: &str = "data:image/png;base64,";

// Why: serialize retention with writes, but never let one failed capture
// poison later diagnostics for the life of the process.
static EVIDENCE_WRITE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesyncEvidenceArgs {
    pub capture_id: String,
    pub phase: String,
    pub png_data_url: String,
    pub metadata: Option<Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesyncEvidenceResult {
    pub directory: String,
    pub png_path: String,
    pub metadata_path: Option<String>,
}

fn valid_capture_id(value: &str) -> bool {
    let len = value.len();
    (1..=120).contains(&len)
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

fn valid_phase(value: &str) -> bool {
    value == "corrupt" || value == "healed"
}

// Same profile home the owned orcad runtime uses: dev writes under the
// repo cache so the real %APPDATA%/Orca profile is never touched, while
// packaged builds share Electron's userData directory. ORCA_USER_DATA is
// only set on the orcad child, so the app process repeats the lookup
// instead of reusing the runtime helper.
fn evidence_base_dir() -> PathBuf {
    if let Some(path) = std::env::var_os("ORCA_TAURI_RUNTIME_PROFILE")
        .or_else(|| std::env::var_os("ORCA_USER_DATA"))
        .or_else(|| std::env::var_os("ORCA_USER_DATA_PATH"))
    {
        return PathBuf::from(path);
    }
    if cfg!(debug_assertions) {
        return std::env::var_os("ORCA_DEV_REPO_ROOT")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."))
            .join(".cache/tauri-orcad-profile");
    }
    if cfg!(windows) {
        return std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir)
            .join("Orca");
    }
    if cfg!(target_os = "macos") {
        return std::env::var_os("HOME")
            .map(|home| PathBuf::from(home).join("Library/Application Support/Orca"))
            .unwrap_or_else(std::env::temp_dir);
    }
    std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".config")))
        .unwrap_or_else(std::env::temp_dir)
        .join("Orca")
}

struct CaptureUsage {
    directory: PathBuf,
    bytes: u64,
    modified_ms: u128,
}

fn capture_usage(directory: PathBuf) -> CaptureUsage {
    let modified_ms = fs::metadata(&directory)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|elapsed| elapsed.as_millis())
        .unwrap_or(0);
    let mut bytes = 0u64;
    if let Ok(entries) = fs::read_dir(&directory) {
        for entry in entries.flatten() {
            if let Ok(metadata) = entry.metadata() {
                if metadata.is_file() {
                    bytes += metadata.len();
                }
            }
        }
    }
    CaptureUsage {
        directory,
        bytes,
        modified_ms,
    }
}

fn prune_with_budgets(
    root: &Path,
    current: &Path,
    max_dirs: usize,
    max_bytes: u64,
) -> Result<(), String> {
    let entries = fs::read_dir(root)
        .map_err(|error| format!("failed to scan render-desync evidence: {error}"))?;
    let mut captures: Vec<CaptureUsage> = entries
        .flatten()
        .filter(|entry| entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false))
        .map(|entry| capture_usage(entry.path()))
        .collect();
    captures.sort_by(|left, right| {
        (left.modified_ms, &left.directory).cmp(&(right.modified_ms, &right.directory))
    });
    let mut total_bytes: u64 = captures.iter().map(|capture| capture.bytes).sum();
    while captures.len() > max_dirs || total_bytes > max_bytes {
        let index = captures
            .iter()
            .position(|capture| capture.directory != current)
            .unwrap_or(0);
        let removed = captures.remove(index);
        total_bytes = total_bytes.saturating_sub(removed.bytes);
        fs::remove_dir_all(&removed.directory)
            .map_err(|error| format!("failed to prune render-desync evidence: {error}"))?;
        if removed.directory == current {
            return Err("Render-desync evidence exceeds the aggregate storage budget".to_string());
        }
    }
    Ok(())
}

fn write_evidence(root: &Path, args: &DesyncEvidenceArgs) -> Result<DesyncEvidenceResult, String> {
    if !valid_capture_id(&args.capture_id) {
        return Err("Invalid render-desync capture id".to_string());
    }
    if !valid_phase(&args.phase) {
        return Err("Invalid render-desync evidence phase".to_string());
    }
    if !args.png_data_url.starts_with(PNG_DATA_URL_PREFIX)
        || args.png_data_url.len() > MAX_PNG_DATA_URL_BYTES
    {
        return Err("Invalid render-desync PNG payload".to_string());
    }
    let png = STANDARD
        .decode(&args.png_data_url[PNG_DATA_URL_PREFIX.len()..])
        .map_err(|_| "Invalid render-desync PNG payload".to_string())?;
    let serialized_metadata = args
        .metadata
        .as_ref()
        .map(|metadata| {
            serde_json::to_string_pretty(metadata)
                .map(|text| format!("{text}\n"))
                .map_err(|error| error.to_string())
        })
        .transpose()?;
    if let Some(text) = serialized_metadata.as_deref() {
        if text.len() > MAX_METADATA_BYTES {
            return Err("Render-desync metadata exceeds the storage budget".to_string());
        }
    }
    let directory = root.join(&args.capture_id);
    let png_path = directory.join(format!("{}.png", args.phase));
    let metadata_path = args
        .metadata
        .as_ref()
        .map(|_| directory.join(format!("{}.json", args.phase)));
    // Why: captures contain terminal pixels and buffer text, so the
    // opt-in field evidence stays private to the local OS account.
    fs::create_dir_all(&directory)
        .map_err(|error| format!("failed to create render-desync evidence directory: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&directory, fs::Permissions::from_mode(0o700));
    }
    fs::write(&png_path, png)
        .map_err(|error| format!("failed to write render-desync PNG: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&png_path, fs::Permissions::from_mode(0o600));
    }
    if let (Some(path), Some(text)) = (metadata_path.as_ref(), serialized_metadata.as_deref()) {
        fs::write(path, text)
            .map_err(|error| format!("failed to write render-desync metadata: {error}"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
        }
    }
    prune_with_budgets(
        root,
        &directory,
        MAX_CAPTURE_DIRECTORIES,
        MAX_EVIDENCE_BYTES,
    )?;
    Ok(DesyncEvidenceResult {
        directory: directory.to_string_lossy().into_owned(),
        png_path: png_path.to_string_lossy().into_owned(),
        metadata_path: metadata_path.map(|path| path.to_string_lossy().into_owned()),
    })
}

#[tauri::command]
pub fn poc_write_terminal_render_desync_evidence(
    args: DesyncEvidenceArgs,
) -> Result<DesyncEvidenceResult, String> {
    let _guard = EVIDENCE_WRITE_LOCK
        .lock()
        .map_err(|_| "render-desync evidence writer is unavailable".to_string())?;
    write_evidence(&evidence_base_dir().join(EVIDENCE_DIRECTORY), &args)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const PROBE_PNG_DATA_URL: &str = "data:image/png;base64,aGk=";

    fn probe_args(capture_id: &str) -> DesyncEvidenceArgs {
        DesyncEvidenceArgs {
            capture_id: capture_id.to_string(),
            phase: "corrupt".to_string(),
            png_data_url: PROBE_PNG_DATA_URL.to_string(),
            metadata: Some(json!({ "probe": true })),
        }
    }

    #[test]
    fn rejects_ids_phases_and_payloads_electron_rejects() {
        let root = tempfile::tempdir().unwrap();
        let mut bad_id = probe_args("../escape");
        assert_eq!(
            write_evidence(root.path(), &bad_id).unwrap_err(),
            "Invalid render-desync capture id"
        );
        bad_id.capture_id = "x".repeat(121);
        assert_eq!(
            write_evidence(root.path(), &bad_id).unwrap_err(),
            "Invalid render-desync capture id"
        );
        let mut bad_phase = probe_args("ok-id");
        bad_phase.phase = "fuzzy".to_string();
        assert_eq!(
            write_evidence(root.path(), &bad_phase).unwrap_err(),
            "Invalid render-desync evidence phase"
        );
        let mut bad_payload = probe_args("ok-id");
        bad_payload.png_data_url = "data:image/png;base64,!!!not-base64!!!".to_string();
        assert_eq!(
            write_evidence(root.path(), &bad_payload).unwrap_err(),
            "Invalid render-desync PNG payload"
        );
    }

    #[test]
    fn writes_png_and_metadata_sidecars() {
        let root = tempfile::tempdir().unwrap();
        let result = write_evidence(root.path(), &probe_args("cap-1")).unwrap();
        assert_eq!(fs::read(&result.png_path).unwrap(), b"hi");
        let metadata_path = result.metadata_path.unwrap();
        assert_eq!(
            fs::read_to_string(metadata_path).unwrap(),
            "{\n  \"probe\": true\n}\n"
        );
        assert!(result.directory.ends_with("cap-1"));
    }

    #[test]
    fn prunes_oldest_captures_first() {
        let root = tempfile::tempdir().unwrap();
        for id in ["cap-a", "cap-b", "cap-c"] {
            write_evidence(root.path(), &probe_args(id)).unwrap();
        }
        let current = root.path().join("cap-c");
        prune_with_budgets(root.path(), &current, 2, u64::MAX).unwrap();
        assert!(!root.path().join("cap-a").exists());
        assert!(root.path().join("cap-b").exists());
        assert!(current.exists());
    }

    #[test]
    fn fails_loud_when_the_current_capture_overflows() {
        let root = tempfile::tempdir().unwrap();
        write_evidence(root.path(), &probe_args("cap-only")).unwrap();
        let current = root.path().join("cap-only");
        let error = prune_with_budgets(root.path(), &current, 0, u64::MAX).unwrap_err();
        assert_eq!(
            error,
            "Render-desync evidence exceeds the aggregate storage budget"
        );
        assert!(!current.exists());
    }
}
