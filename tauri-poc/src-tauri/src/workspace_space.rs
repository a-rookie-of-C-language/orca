use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{
    AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};

const SPACE_WINDOW_LABEL: &str = "workspace-space";
const EVENT_WINDOW_CLOSED: &str = "workspace-space:window-closed";
const EVENT_WINDOW_STATE: &str = "workspace-space:window-state";
const EVENT_WINDOW_STATE_REQUESTED: &str = "workspace-space:window-state-requested";
const EVENT_REVEAL_WORKTREE: &str = "workspace-space:reveal-worktree";
const EVENT_WORKTREE_REFRESH_REQUESTED: &str = "workspace-space:worktree-refresh-requested";
const EVENT_WINDOW_ANALYSIS: &str = "workspace-space:window-analysis";
const EVENT_SCAN_PROGRESS: &str = "workspace-space:progress";
const SNAPSHOT_FILE_NAME: &str = "orca-workspace-space-analysis.json";
const SNAPSHOT_VERSION: u64 = 2;
const MAX_SCAN_ENTRIES: u64 = 1_000_000;
const MAX_TOP_LEVEL_ITEMS: usize = 48;

static NEXT_SCAN_ID: AtomicU64 = AtomicU64::new(1);
static ACTIVE_SCAN: OnceLock<Mutex<Option<Arc<AtomicBool>>>> = OnceLock::new();

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScanInput {
    #[serde(default)]
    repos: Vec<ScanRepo>,
    #[serde(default)]
    worktrees: Vec<ScanWorktree>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScanRepo {
    id: String,
    path: String,
    display_name: String,
    connection_id: Option<String>,
    execution_host_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScanWorktree {
    id: String,
    repo_id: String,
    display_name: String,
    path: String,
    branch: String,
    is_main_worktree: bool,
    #[serde(default)]
    is_sparse: bool,
    last_activity_at: i64,
    host_id: Option<String>,
}

#[derive(Debug, Clone)]
struct EntryScan {
    name: String,
    path: String,
    kind: &'static str,
    size_bytes: u64,
    skipped_entry_count: u64,
    children: Vec<EntryScan>,
}

#[derive(Debug)]
struct ScanFailure {
    status: &'static str,
    error: String,
}

fn active_scan() -> &'static Mutex<Option<Arc<AtomicBool>>> {
    ACTIVE_SCAN.get_or_init(|| Mutex::new(None))
}

fn cancelled(token: &AtomicBool) -> bool {
    token.load(Ordering::SeqCst)
}

fn check_cancelled(token: &AtomicBool) -> Result<(), String> {
    if cancelled(token) {
        Err("cancelled".to_string())
    } else {
        Ok(())
    }
}

fn scan_id() -> String {
    format!(
        "{}-{}",
        chrono_like_now_millis(),
        NEXT_SCAN_ID.fetch_add(1, Ordering::Relaxed)
    )
}

fn chrono_like_now_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
}

fn path_failure(error: &std::io::Error) -> ScanFailure {
    let status = match error.kind() {
        std::io::ErrorKind::NotFound => "missing",
        std::io::ErrorKind::PermissionDenied => "permission-denied",
        _ => "error",
    };
    ScanFailure {
        status,
        error: error.to_string(),
    }
}

fn scan_entry(
    path: &Path,
    name: String,
    token: &AtomicBool,
    entry_count: &mut u64,
) -> Result<EntryScan, ScanFailure> {
    check_cancelled(token).map_err(|_| ScanFailure {
        status: "unavailable",
        error: "Workspace Space scan cancelled.".to_string(),
    })?;
    *entry_count = entry_count.saturating_add(1);
    if *entry_count > MAX_SCAN_ENTRIES {
        return Err(ScanFailure {
            status: "error",
            error: format!("Workspace Space scan exceeded {MAX_SCAN_ENTRIES} entries."),
        });
    }
    let metadata = fs::symlink_metadata(path).map_err(|error| path_failure(&error))?;
    let path_string = path.to_string_lossy().into_owned();
    if metadata.file_type().is_symlink() {
        return Ok(EntryScan {
            name,
            path: path_string,
            kind: "symlink",
            size_bytes: metadata.len(),
            skipped_entry_count: 0,
            children: Vec::new(),
        });
    }
    if !metadata.is_dir() {
        return Ok(EntryScan {
            name,
            path: path_string,
            kind: "file",
            size_bytes: metadata.len(),
            skipped_entry_count: 0,
            children: Vec::new(),
        });
    }

    let mut children = Vec::new();
    let mut skipped_entry_count = 0;
    let directory = fs::read_dir(path).map_err(|error| path_failure(&error))?;
    for entry in directory {
        check_cancelled(token).map_err(|_| ScanFailure {
            status: "unavailable",
            error: "Workspace Space scan cancelled.".to_string(),
        })?;
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => {
                skipped_entry_count += 1;
                continue;
            }
        };
        match scan_entry(
            &entry.path(),
            entry.file_name().to_string_lossy().into_owned(),
            token,
            entry_count,
        ) {
            Ok(child) => children.push(child),
            Err(failure) if failure.error == "Workspace Space scan cancelled." => {
                return Err(failure)
            }
            Err(_) => skipped_entry_count += 1,
        }
    }
    let size_bytes = metadata
        .len()
        .saturating_add(children.iter().map(|child| child.size_bytes).sum::<u64>());
    Ok(EntryScan {
        name,
        path: path_string,
        kind: "directory",
        size_bytes,
        skipped_entry_count,
        children,
    })
}

fn entry_item(entry: &EntryScan) -> Value {
    json!({
        "name": entry.name,
        "path": entry.path,
        "kind": entry.kind,
        "sizeBytes": entry.size_bytes,
    })
}

fn compact_items(children: &[EntryScan]) -> (Vec<Value>, u64, u64) {
    let mut sorted = children.iter().collect::<Vec<_>>();
    sorted.sort_by(|left, right| {
        right
            .size_bytes
            .cmp(&left.size_bytes)
            .then_with(|| left.name.cmp(&right.name))
    });
    if sorted.len() <= MAX_TOP_LEVEL_ITEMS {
        return (sorted.into_iter().map(entry_item).collect(), 0, 0);
    }
    let visible_count = MAX_TOP_LEVEL_ITEMS - 1;
    let visible = sorted[..visible_count]
        .iter()
        .map(|entry| entry_item(entry));
    let omitted_size_bytes = sorted[visible_count..]
        .iter()
        .map(|entry| entry.size_bytes)
        .sum::<u64>();
    let omitted_count = (sorted.len() - visible_count) as u64;
    let mut items = visible.collect::<Vec<_>>();
    items.push(json!({
        "name": "Other",
        "path": "",
        "kind": "other",
        "sizeBytes": omitted_size_bytes,
    }));
    (items, omitted_count, omitted_size_bytes)
}

fn base_row(repo: &ScanRepo, worktree: &ScanWorktree, scanned_at: u128, host_id: &str) -> Value {
    json!({
        "worktreeId": worktree.id,
        "repoId": repo.id,
        "executionHostId": host_id,
        "repoDisplayName": repo.display_name,
        "repoPath": repo.path,
        "displayName": worktree.display_name,
        "path": worktree.path,
        "branch": worktree.branch,
        "isMainWorktree": worktree.is_main_worktree,
        "isRemote": host_id != "local",
        "isSparse": worktree.is_sparse,
        "canDelete": !worktree.is_main_worktree,
        "lastActivityAt": worktree.last_activity_at,
        "scannedAt": scanned_at,
    })
}

fn unavailable_row(
    repo: &ScanRepo,
    worktree: &ScanWorktree,
    scanned_at: u128,
    host_id: &str,
    status: &str,
    error: &str,
) -> Value {
    let mut row = base_row(repo, worktree, scanned_at, host_id);
    if let Some(object) = row.as_object_mut() {
        object.extend([
            ("status".to_string(), json!(status)),
            ("error".to_string(), json!(error)),
            ("sizeBytes".to_string(), json!(0)),
            ("reclaimableBytes".to_string(), json!(0)),
            ("skippedEntryCount".to_string(), json!(0)),
            ("topLevelItems".to_string(), json!([])),
            ("omittedTopLevelItemCount".to_string(), json!(0)),
            ("omittedTopLevelSizeBytes".to_string(), json!(0)),
        ]);
    }
    row
}

fn scanned_row(
    repo: &ScanRepo,
    worktree: &ScanWorktree,
    scanned_at: u128,
    host_id: &str,
    root: EntryScan,
) -> Value {
    let (top_level_items, omitted_count, omitted_size) = compact_items(&root.children);
    let mut row = base_row(repo, worktree, scanned_at, host_id);
    if let Some(object) = row.as_object_mut() {
        object.extend([
            ("status".to_string(), json!("ok")),
            ("error".to_string(), Value::Null),
            ("sizeBytes".to_string(), json!(root.size_bytes)),
            (
                "reclaimableBytes".to_string(),
                json!(if worktree.is_main_worktree {
                    0
                } else {
                    root.size_bytes
                }),
            ),
            (
                "skippedEntryCount".to_string(),
                json!(root.skipped_entry_count),
            ),
            ("topLevelItems".to_string(), json!(top_level_items)),
            ("omittedTopLevelItemCount".to_string(), json!(omitted_count)),
            ("omittedTopLevelSizeBytes".to_string(), json!(omitted_size)),
        ]);
    }
    row
}

fn emit_progress(app: &AppHandle, progress: Value) {
    let _ = app.emit(EVENT_SCAN_PROGRESS, progress);
}

fn host_id(repo: &ScanRepo, worktree: &ScanWorktree) -> String {
    worktree
        .host_id
        .as_deref()
        .or(repo.execution_host_id.as_deref())
        .filter(|host| !host.is_empty())
        .or_else(|| {
            repo.connection_id
                .as_deref()
                .filter(|connection| !connection.is_empty())
                .map(|_| "remote")
        })
        .unwrap_or("local")
        .to_string()
}

fn runtime_profile_directory() -> PathBuf {
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

fn snapshot_path() -> PathBuf {
    runtime_profile_directory().join(SNAPSHOT_FILE_NAME)
}

fn persist_snapshot(analysis: &Value) {
    let path = snapshot_path();
    let Some(parent) = path.parent() else { return };
    if fs::create_dir_all(parent).is_err() {
        return;
    }
    let mut cached = analysis.clone();
    if let Some(rows) = cached.get_mut("worktrees").and_then(Value::as_array_mut) {
        for row in rows {
            if let Some(object) = row.as_object_mut() {
                let item_size = object
                    .get("topLevelItems")
                    .and_then(Value::as_array)
                    .map(|items| {
                        items
                            .iter()
                            .filter_map(|item| item.get("sizeBytes").and_then(Value::as_u64))
                            .sum::<u64>()
                    })
                    .unwrap_or(0);
                let items = object
                    .remove("topLevelItems")
                    .and_then(|value| value.as_array().map(|items| items.len() as u64))
                    .unwrap_or(0);
                let omitted = object
                    .get("omittedTopLevelItemCount")
                    .and_then(Value::as_u64)
                    .unwrap_or(0);
                object.insert("topLevelItems".to_string(), json!([]));
                object.insert(
                    "omittedTopLevelItemCount".to_string(),
                    json!(omitted.saturating_add(items)),
                );
                let omitted_size = object
                    .get("omittedTopLevelSizeBytes")
                    .and_then(Value::as_u64)
                    .unwrap_or(0);
                object.insert(
                    "omittedTopLevelSizeBytes".to_string(),
                    json!(omitted_size.saturating_add(item_size)),
                );
            }
        }
    }
    let payload = json!({ "version": SNAPSHOT_VERSION, "analysis": cached });
    let temporary = path.with_extension("json.tmp");
    if fs::write(&temporary, payload.to_string()).is_ok() {
        let _ = fs::rename(temporary, path);
    }
}

fn analyze_workspace_space(app: AppHandle, input: ScanInput, token: Arc<AtomicBool>) -> Value {
    let scanned_at = chrono_like_now_millis();
    let scan_id = scan_id();
    let total_repo_count = input.repos.len();
    emit_progress(
        &app,
        json!({
            "scanId": scan_id.clone(),
            "state": "running",
            "startedAt": scanned_at,
            "updatedAt": scanned_at,
            "totalRepoCount": total_repo_count,
            "scannedRepoCount": 0,
            "totalWorktreeCount": 0,
            "scannedWorktreeCount": 0,
            "currentRepoDisplayName": Value::Null,
            "currentWorktreeDisplayName": Value::Null,
        }),
    );
    let mut rows = Vec::new();
    let mut repos = Vec::new();
    let mut scanned_repo_count = 0;
    let mut scanned_worktree_count = 0;
    let mut unavailable_worktree_count = 0;
    for repo in &input.repos {
        if cancelled(&token) {
            return json!({ "ok": false, "cancelled": true });
        }
        let repo_host = repo
            .execution_host_id
            .as_deref()
            .filter(|host| !host.is_empty())
            .or_else(|| {
                repo.connection_id
                    .as_deref()
                    .filter(|connection| !connection.is_empty())
                    .map(|_| "remote")
            })
            .unwrap_or("local");
        let repo_worktrees = input
            .worktrees
            .iter()
            .filter(|worktree| worktree.repo_id == repo.id)
            .collect::<Vec<_>>();
        let is_remote = repo_host != "local" || repo.connection_id.is_some();
        let mut repo_rows = Vec::new();
        let mut repo_error = None;
        if is_remote {
            repo_error = Some(format!(
                "Host {repo_host} is not reachable from the local Tauri process."
            ));
            unavailable_worktree_count += 1;
        } else {
            for worktree in repo_worktrees {
                if cancelled(&token) {
                    return json!({ "ok": false, "cancelled": true });
                }
                emit_progress(
                    &app,
                    json!({
                        "scanId": scan_id.clone(),
                        "state": "running",
                        "startedAt": scanned_at,
                        "updatedAt": chrono_like_now_millis(),
                        "totalRepoCount": total_repo_count,
                        "scannedRepoCount": scanned_repo_count,
                        "totalWorktreeCount": input.worktrees.len(),
                        "scannedWorktreeCount": scanned_worktree_count,
                        "currentRepoDisplayName": repo.display_name,
                        "currentWorktreeDisplayName": worktree.display_name,
                    }),
                );
                let host = host_id(repo, worktree);
                let row = if host != "local" {
                    unavailable_worktree_count += 1;
                    unavailable_row(
                        repo,
                        worktree,
                        scanned_at,
                        &host,
                        "unavailable",
                        &format!("Host {host} is not reachable from the local Tauri process."),
                    )
                } else {
                    let mut entry_count = 0;
                    let result = scan_entry(
                        Path::new(&worktree.path),
                        Path::new(&worktree.path)
                            .file_name()
                            .and_then(|name| name.to_str())
                            .unwrap_or(&worktree.display_name)
                            .to_string(),
                        &token,
                        &mut entry_count,
                    );
                    match result {
                        Ok(root) => {
                            scanned_worktree_count += 1;
                            scanned_row(repo, worktree, scanned_at, &host, root)
                        }
                        Err(failure) if failure.error == "Workspace Space scan cancelled." => {
                            return json!({ "ok": false, "cancelled": true });
                        }
                        Err(failure) => {
                            unavailable_worktree_count += 1;
                            unavailable_row(
                                repo,
                                worktree,
                                scanned_at,
                                &host,
                                failure.status,
                                &failure.error,
                            )
                        }
                    }
                };
                repo_rows.push(row.clone());
                rows.push(row);
                emit_progress(
                    &app,
                    json!({
                        "scanId": scan_id.clone(),
                        "state": "running",
                        "startedAt": scanned_at,
                        "updatedAt": chrono_like_now_millis(),
                        "totalRepoCount": total_repo_count,
                        "scannedRepoCount": scanned_repo_count,
                        "totalWorktreeCount": input.worktrees.len(),
                        "scannedWorktreeCount": scanned_worktree_count,
                        "currentRepoDisplayName": repo.display_name,
                        "currentWorktreeDisplayName": Value::Null,
                        "completedMeasurements": [{
                            "worktreeId": worktree.id,
                            "executionHostId": host,
                            "status": repo_rows.last().and_then(|row| row.get("status")).cloned().unwrap_or_else(|| json!("error")),
                            "sizeBytes": repo_rows.last().and_then(|row| row.get("sizeBytes")).cloned().unwrap_or_else(|| json!(0)),
                        }]
                    }),
                );
            }
        }
        scanned_repo_count += 1;
        let total_size = repo_rows
            .iter()
            .filter_map(|row| row.get("sizeBytes").and_then(Value::as_u64))
            .sum::<u64>();
        let reclaimable = repo_rows
            .iter()
            .filter_map(|row| row.get("reclaimableBytes").and_then(Value::as_u64))
            .sum::<u64>();
        let row_count = repo_rows.len();
        let unavailable = repo_rows
            .iter()
            .filter(|row| row.get("status").and_then(Value::as_str) != Some("ok"))
            .count() as u64;
        repos.push(json!({
            "repoId": repo.id,
            "executionHostId": repo_host,
            "displayName": repo.display_name,
            "path": repo.path,
            "isRemote": is_remote,
            "worktreeCount": row_count,
            "scannedWorktreeCount": repo_rows.len() as u64 - unavailable,
            "unavailableWorktreeCount": unavailable + if repo_error.is_some() { 1 } else { 0 },
            "totalSizeBytes": total_size,
            "reclaimableBytes": reclaimable,
            "error": repo_error,
        }));
    }
    rows.sort_by(|left, right| {
        right
            .get("sizeBytes")
            .and_then(Value::as_u64)
            .unwrap_or(0)
            .cmp(&left.get("sizeBytes").and_then(Value::as_u64).unwrap_or(0))
            .then_with(|| {
                left.get("displayName")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .cmp(
                        right
                            .get("displayName")
                            .and_then(Value::as_str)
                            .unwrap_or(""),
                    )
            })
    });
    let total_size = rows
        .iter()
        .filter_map(|row| row.get("sizeBytes").and_then(Value::as_u64))
        .sum::<u64>();
    let reclaimable = rows
        .iter()
        .filter_map(|row| row.get("reclaimableBytes").and_then(Value::as_u64))
        .sum::<u64>();
    let analysis = json!({
        "scannedAt": scanned_at,
        "totalSizeBytes": total_size,
        "reclaimableBytes": reclaimable,
        "worktreeCount": rows.len(),
        "scannedWorktreeCount": scanned_worktree_count,
        "unavailableWorktreeCount": unavailable_worktree_count,
        "repos": repos,
        "worktrees": rows,
    });
    emit_progress(
        &app,
        json!({
            "scanId": scan_id.clone(),
            "state": "running",
            "startedAt": scanned_at,
            "updatedAt": chrono_like_now_millis(),
            "totalRepoCount": total_repo_count,
            "scannedRepoCount": scanned_repo_count,
            "totalWorktreeCount": input.worktrees.len(),
            "scannedWorktreeCount": scanned_worktree_count,
            "currentRepoDisplayName": Value::Null,
            "currentWorktreeDisplayName": Value::Null,
        }),
    );
    persist_snapshot(&analysis);
    json!({ "ok": true, "analysis": analysis })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RevealWorktreePayload {
    worktree_id: String,
    execution_host_id: Option<String>,
}

fn is_background_launch() -> bool {
    std::env::var("ORCA_BACKGROUND_LAUNCH").as_deref() == Ok("1")
}

fn require_label(window: &WebviewWindow, expected: &str) -> Result<(), String> {
    if window.label() == expected {
        Ok(())
    } else {
        Err(format!(
            "workspace space command is not valid for window {}",
            window.label()
        ))
    }
}

fn space_url() -> Result<WebviewUrl, String> {
    if cfg!(debug_assertions) {
        "http://127.0.0.1:5174/space.html"
            .parse()
            .map(WebviewUrl::External)
            .map_err(|error| format!("invalid Tauri development URL: {error}"))
    } else {
        Ok(WebviewUrl::App("space.html".into()))
    }
}

#[tauri::command]
pub fn poc_workspace_space_open(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(SPACE_WINDOW_LABEL) {
        if !is_background_launch() {
            let _ = window.show();
            let _ = window.unminimize();
            let _ = window.set_focus();
        }
        return Ok(());
    }

    let visible = !is_background_launch();
    let window = WebviewWindowBuilder::new(&app, SPACE_WINDOW_LABEL, space_url()?)
        .title("Orca Space")
        .inner_size(1180.0, 820.0)
        .min_inner_size(700.0, 520.0)
        .visible(visible)
        .build()
        .map_err(|error| format!("failed to create Orca Space window: {error}"))?;

    // Why: Electron applies the persisted `uiZoomLevel` to the space window on
    // dom-ready; the Tauri shell does the same so a zoomed app does not open a
    // 100%-zoom Space window.
    crate::seed_secondary_window_zoom(&app, SPACE_WINDOW_LABEL);

    let notified = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let app_for_close = app.clone();
    window.on_window_event(move |event| {
        if matches!(event, WindowEvent::CloseRequested { .. })
            && !notified.swap(true, std::sync::atomic::Ordering::SeqCst)
        {
            let _ = app_for_close.emit(EVENT_WINDOW_CLOSED, ());
        }
    });
    Ok(())
}

#[tauri::command]
pub fn poc_workspace_space_close(window: WebviewWindow) -> Result<(), String> {
    require_label(&window, SPACE_WINDOW_LABEL)?;
    window
        .close()
        .map_err(|error| format!("failed to close Orca Space window: {error}"))
}

#[tauri::command]
pub fn poc_workspace_space_publish_window_state(
    window: WebviewWindow,
    app: AppHandle,
    state: Value,
) -> Result<(), String> {
    require_label(&window, "main")?;
    app.emit(EVENT_WINDOW_STATE, state)
        .map_err(|error| format!("failed to publish Orca Space window state: {error}"))
}

#[tauri::command]
pub fn poc_workspace_space_request_window_state(
    window: WebviewWindow,
    app: AppHandle,
) -> Result<(), String> {
    require_label(&window, SPACE_WINDOW_LABEL)?;
    app.emit(EVENT_WINDOW_STATE_REQUESTED, ())
        .map_err(|error| format!("failed to request Orca Space window state: {error}"))
}

#[tauri::command]
pub fn poc_workspace_space_reveal_worktree(
    window: WebviewWindow,
    app: AppHandle,
    worktree_id: String,
    execution_host_id: Option<String>,
) -> Result<(), String> {
    require_label(&window, SPACE_WINDOW_LABEL)?;
    if worktree_id.trim().is_empty() || worktree_id.len() > 1024 {
        return Err("invalid workspace id".to_string());
    }
    app.emit(
        EVENT_REVEAL_WORKTREE,
        RevealWorktreePayload {
            worktree_id,
            execution_host_id,
        },
    )
    .map_err(|error| format!("failed to reveal worktree from Orca Space: {error}"))
}

#[tauri::command]
pub fn poc_workspace_space_request_worktree_refresh(
    window: WebviewWindow,
    app: AppHandle,
) -> Result<(), String> {
    require_label(&window, SPACE_WINDOW_LABEL)?;
    app.emit(EVENT_WORKTREE_REFRESH_REQUESTED, ())
        .map_err(|error| format!("failed to request worktree refresh: {error}"))
}

#[tauri::command]
pub fn poc_workspace_space_publish_window_analysis(
    window: WebviewWindow,
    app: AppHandle,
    analysis: Value,
) -> Result<(), String> {
    require_label(&window, SPACE_WINDOW_LABEL)?;
    if !analysis.is_object() {
        return Err("workspace space analysis must be an object".to_string());
    }
    app.emit(EVENT_WINDOW_ANALYSIS, analysis)
        .map_err(|error| format!("failed to publish Orca Space analysis: {error}"))
}

#[tauri::command]
pub async fn poc_workspace_space_analyze(
    app: AppHandle,
    input: Option<Value>,
) -> Result<Value, String> {
    let input = serde_json::from_value::<ScanInput>(input.unwrap_or_else(|| json!({})))
        .map_err(|error| format!("invalid Workspace Space scan input: {error}"))?;
    let token = Arc::new(AtomicBool::new(false));
    {
        let mut active = active_scan()
            .lock()
            .map_err(|_| "Workspace Space scan lock unavailable.".to_string())?;
        if active.is_some() {
            return Err("Workspace Space scan is already running.".to_string());
        }
        *active = Some(Arc::clone(&token));
    }
    let result = tauri::async_runtime::spawn_blocking(move || {
        analyze_workspace_space(app, input, token.clone())
    })
    .await
    .map_err(|error| error.to_string());
    if let Ok(mut active) = active_scan().lock() {
        *active = None;
    }
    result
}

#[tauri::command]
pub fn poc_workspace_space_cancel() -> bool {
    let Ok(active) = active_scan().lock() else {
        return false;
    };
    if let Some(token) = active.as_ref() {
        token.store(true, Ordering::SeqCst);
        return true;
    }
    false
}

#[tauri::command]
pub fn poc_workspace_space_get_cached_analysis() -> Option<Value> {
    let parsed = fs::read_to_string(snapshot_path())
        .ok()
        .and_then(|contents| serde_json::from_str::<Value>(&contents).ok())?;
    if parsed.get("version").and_then(Value::as_u64) != Some(SNAPSHOT_VERSION) {
        return None;
    }
    parsed.get("analysis").cloned()
}
