use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::{self, Metadata, OpenOptions};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;
#[cfg(not(any(unix, windows)))]
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State, Webview};

const LOCAL_LOG_TAIL_CHUNK_BYTES: usize = 256 * 1024;
const MAX_LOCAL_LOG_BYTES: u64 = 50 * 1024 * 1024;
const LOCAL_LOG_TAIL_CHANGED_EVENT: &str = "fs:localLogTailChanged";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalLogTailReadArgs {
    pub file_path: String,
    pub from_byte_offset: u64,
    pub expected_identity: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalLogTailReadResult {
    pub content_base64: String,
    pub next_byte_offset: u64,
    pub file_size: u64,
    pub file_identity: String,
    pub has_more: bool,
    pub reset: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalLogTailWatchArgs {
    pub file_path: String,
    pub subscription_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalLogSnapshot {
    pub content: String,
    pub is_binary: bool,
    pub file_identity: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct LocalLogTailChangedPayload {
    subscription_id: String,
    event_type: &'static str,
}

struct WatchHandle {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl WatchHandle {
    fn stop_and_join(mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

#[derive(Default)]
pub struct LocalLogTailState {
    watches: Mutex<HashMap<String, WatchHandle>>,
}

impl Drop for LocalLogTailState {
    fn drop(&mut self) {
        let watches = std::mem::take(
            self.watches
                .get_mut()
                .expect("local log tail mutex poisoned"),
        );
        for (_, watch) in watches {
            watch.stop_and_join();
        }
    }
}

fn validate_subscription_id(subscription_id: &str) -> Result<(), String> {
    if subscription_id.is_empty() || subscription_id.len() > 200 {
        return Err("Invalid local log tail subscription id".to_string());
    }
    Ok(())
}

fn reject_device_path(path: &Path) -> Result<(), String> {
    #[cfg(windows)]
    {
        let text = path.to_string_lossy().to_ascii_uppercase();
        if text.starts_with(r"\\.\")
            || text.starts_with(r"\\?\GLOBALROOT\")
            || text == "NUL"
            || text.starts_with("NUL.")
            || text == "CON"
            || text.starts_with("CON.")
            || text == "PRN"
            || text.starts_with("PRN.")
            || text == "AUX"
            || text.starts_with("AUX.")
        {
            return Err("Access denied: device paths cannot be tailed".to_string());
        }
    }
    Ok(())
}

fn resolve_regular_file(path_text: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(path_text);
    if !path.is_absolute() {
        return Err("Access denied: a local log file needs an absolute path".to_string());
    }
    reject_device_path(&path)?;
    let resolved = fs::canonicalize(&path).map_err(|error| error.to_string())?;
    let metadata = fs::metadata(&resolved).map_err(|error| error.to_string())?;
    if !metadata.is_file() {
        return Err("Local log tail target is not a regular file".to_string());
    }
    Ok(resolved)
}

#[cfg(not(any(unix, windows)))]
fn system_time_millis(value: SystemTime) -> u128 {
    value
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn file_identity(metadata: &Metadata, file: Option<&std::fs::File>) -> String {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let _ = file;
        // inode is stable across appends and changes when a log is atomically replaced.
        return format!("{}:{}", metadata.dev(), metadata.ino());
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{
            GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
        };
        if let Some(file) = file {
            let mut information = unsafe { std::mem::zeroed::<BY_HANDLE_FILE_INFORMATION>() };
            let success =
                unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut information) };
            if success != 0 {
                let file_index = (u64::from(information.nFileIndexHigh) << 32)
                    | u64::from(information.nFileIndexLow);
                return format!(
                    "{}:{}:{}",
                    information.dwVolumeSerialNumber,
                    file_index,
                    metadata.creation_time()
                );
            }
        }
        return format!("creation:{}", metadata.creation_time());
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = file;
        format!(
            "{}:{}",
            metadata.len(),
            system_time_millis(metadata.modified().unwrap_or(UNIX_EPOCH))
        )
    }
}

fn read_tail_range(
    file_path: &Path,
    from_byte_offset: u64,
    expected_identity: Option<&str>,
) -> Result<LocalLogTailReadResult, String> {
    let mut file = OpenOptions::new()
        .read(true)
        .open(file_path)
        .map_err(|error| error.to_string())?;
    let initial_metadata = file.metadata().map_err(|error| error.to_string())?;
    if !initial_metadata.is_file() {
        return Err("Local log tail target is not a regular file".to_string());
    }
    let identity = file_identity(&initial_metadata, Some(&file));
    if from_byte_offset > initial_metadata.len()
        || expected_identity.is_some_and(|expected| expected != identity)
    {
        return Ok(LocalLogTailReadResult {
            content_base64: String::new(),
            next_byte_offset: 0,
            file_size: initial_metadata.len(),
            file_identity: identity,
            has_more: initial_metadata.len() > 0,
            reset: true,
        });
    }

    let bytes_to_read = std::cmp::min(
        LOCAL_LOG_TAIL_CHUNK_BYTES as u64,
        initial_metadata.len() - from_byte_offset,
    ) as usize;
    file.seek(SeekFrom::Start(from_byte_offset))
        .map_err(|error| error.to_string())?;
    let mut buffer = vec![0_u8; bytes_to_read];
    let mut bytes_read = 0;
    while bytes_read < bytes_to_read {
        let count = file
            .read(&mut buffer[bytes_read..])
            .map_err(|error| error.to_string())?;
        if count == 0 {
            break;
        }
        bytes_read += count;
    }
    let next_byte_offset = from_byte_offset + bytes_read as u64;
    let final_metadata = file.metadata().map_err(|error| error.to_string())?;
    if next_byte_offset > final_metadata.len() {
        return Ok(LocalLogTailReadResult {
            content_base64: String::new(),
            next_byte_offset: 0,
            file_size: final_metadata.len(),
            file_identity: identity,
            has_more: final_metadata.len() > 0,
            reset: true,
        });
    }
    Ok(LocalLogTailReadResult {
        content_base64: BASE64.encode(&buffer[..bytes_read]),
        next_byte_offset,
        file_size: final_metadata.len(),
        file_identity: identity,
        has_more: next_byte_offset < final_metadata.len(),
        reset: false,
    })
}

#[tauri::command]
pub fn poc_read_local_log_tail(
    args: LocalLogTailReadArgs,
) -> Result<LocalLogTailReadResult, String> {
    if args.from_byte_offset > (1_u64 << 53) {
        return Err("Invalid local log tail byte offset".to_string());
    }
    let path = resolve_regular_file(&args.file_path)?;
    read_tail_range(
        &path,
        args.from_byte_offset,
        args.expected_identity.as_deref(),
    )
}

#[tauri::command]
pub fn poc_read_local_log_snapshot(path: String) -> Result<LocalLogSnapshot, String> {
    let path = resolve_regular_file(&path)?;
    let mut file = OpenOptions::new()
        .read(true)
        .open(&path)
        .map_err(|error| error.to_string())?;
    let metadata = file.metadata().map_err(|error| error.to_string())?;
    if metadata.len() > MAX_LOCAL_LOG_BYTES {
        return Err("file_too_large".to_string());
    }
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    let is_binary = bytes.contains(&0);
    Ok(LocalLogSnapshot {
        content: if is_binary {
            String::new()
        } else {
            String::from_utf8_lossy(&bytes).into_owned()
        },
        is_binary,
        file_identity: file_identity(&metadata, Some(&file)),
    })
}

fn watch_key(window_label: &str, subscription_id: &str) -> String {
    format!("{window_label}:{subscription_id}")
}

fn emit_change(app: &AppHandle, subscription_id: &str, event_type: &'static str) {
    let _ = app.emit(
        LOCAL_LOG_TAIL_CHANGED_EVENT,
        LocalLogTailChangedPayload {
            subscription_id: subscription_id.to_string(),
            event_type,
        },
    );
}

fn start_watch(
    app: AppHandle,
    state: &LocalLogTailState,
    window_label: String,
    args: LocalLogTailWatchArgs,
) -> Result<(), String> {
    validate_subscription_id(&args.subscription_id)?;
    let path = resolve_regular_file(&args.file_path)?;
    let key = watch_key(&window_label, &args.subscription_id);
    let stop = Arc::new(AtomicBool::new(false));
    let thread_stop = Arc::clone(&stop);
    let subscription_id = args.subscription_id;
    let thread_path = path;
    let thread = thread::Builder::new()
        .name("orca-local-log-tail".to_string())
        .spawn(move || {
            let mut previous = inspect_watch_file(&thread_path);
            while !thread_stop.load(Ordering::SeqCst) {
                thread::sleep(Duration::from_millis(200));
                if thread_stop.load(Ordering::SeqCst) {
                    break;
                }
                let Some(current) = inspect_watch_file(&thread_path) else {
                    emit_change(&app, &subscription_id, "rename");
                    break;
                };
                if previous.as_ref().map(|value| &value.0) != Some(&current.0) {
                    emit_change(&app, &subscription_id, "rename");
                    break;
                }
                if previous.as_ref().map(|value| (value.1, value.2)) != Some((current.1, current.2))
                {
                    emit_change(&app, &subscription_id, "change");
                }
                previous = Some(current);
            }
        })
        .map_err(|error| error.to_string())?;

    let replaced = state
        .watches
        .lock()
        .map_err(|_| "Local log tail state is unavailable".to_string())?
        .insert(
            key,
            WatchHandle {
                stop,
                thread: Some(thread),
            },
        );
    if let Some(watch) = replaced {
        watch.stop_and_join();
    }
    Ok(())
}

fn inspect_watch_file(path: &Path) -> Option<(String, u64, Option<std::time::SystemTime>)> {
    let file = OpenOptions::new().read(true).open(path).ok()?;
    let metadata = file.metadata().ok()?;
    if !metadata.is_file() {
        return None;
    }
    Some((
        file_identity(&metadata, Some(&file)),
        metadata.len(),
        metadata.modified().ok(),
    ))
}

#[tauri::command]
pub fn poc_start_local_log_tail(
    window: Webview,
    state: State<LocalLogTailState>,
    args: LocalLogTailWatchArgs,
) -> Result<(), String> {
    start_watch(
        window.app_handle().clone(),
        state.inner(),
        window.label().to_string(),
        args,
    )
}

#[tauri::command]
pub fn poc_stop_local_log_tail(
    window: Webview,
    state: State<LocalLogTailState>,
    subscription_id: String,
) -> Result<(), String> {
    validate_subscription_id(&subscription_id)?;
    let key = watch_key(window.label(), &subscription_id);
    let watch = state
        .watches
        .lock()
        .map_err(|_| "Local log tail state is unavailable".to_string())?
        .remove(&key);
    if let Some(watch) = watch {
        watch.stop_and_join();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::read_tail_range;
    use std::fs::{self, OpenOptions};
    use std::io::Write;

    #[test]
    fn reads_ranges_and_resets_after_replacement() {
        let directory = tempfile::tempdir().expect("temp directory");
        let path = directory.path().join("orca.log");
        fs::write(&path, "first\n").expect("initial log");
        let initial = read_tail_range(&path, 0, None).expect("initial read");
        assert!(!initial.reset);
        assert_eq!(initial.next_byte_offset, 6);

        let mut append = OpenOptions::new()
            .append(true)
            .open(&path)
            .expect("append log");
        append.write_all(b"second\n").expect("append");
        let appended = read_tail_range(
            &path,
            initial.next_byte_offset,
            Some(&initial.file_identity),
        )
        .expect("append read");
        assert!(!appended.reset);
        assert!(appended.next_byte_offset > initial.next_byte_offset);

        let replacement = directory.path().join("replacement.log");
        fs::write(&replacement, "replacement\n").expect("replacement");
        fs::rename(replacement, &path).expect("atomic replacement");
        let reset = read_tail_range(
            &path,
            appended.next_byte_offset,
            Some(&initial.file_identity),
        )
        .expect("replacement read");
        assert!(reset.reset);
        assert!(reset.reset);
    }
}
