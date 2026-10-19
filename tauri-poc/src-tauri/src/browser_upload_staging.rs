use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, State};

use crate::browser_webview::browser_download_directory;

#[derive(Default)]
pub struct BrowserUploadStagingState {
    sessions: Mutex<HashMap<String, PathBuf>>,
}

static NEXT_UPLOAD_ID: AtomicU64 = AtomicU64::new(1);
const MAX_STAGE_CHUNK_BYTES: usize = 1024 * 1024;
const MAX_STAGED_UPLOAD_BYTES: u64 = 64 * 1024 * 1024;
const MAX_RELAY_CHUNK_BYTES: u64 = 128 * 1024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StageUploadChunkArgs {
    pub upload_id: Option<String>,
    pub filename: String,
    pub content_base64: String,
    pub final_chunk: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StageUploadChunkResult {
    pub upload_id: String,
    pub staging_path: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayDownloadChunkArgs {
    pub save_path: String,
    pub offset: u64,
    pub length: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayDownloadChunkResult {
    pub content_base64: String,
    pub bytes_read: u64,
    pub total_bytes: u64,
    pub eof: bool,
}

fn validated_filename(filename: &str) -> Result<String, String> {
    let trimmed = filename.trim();
    if trimmed.is_empty() || trimmed.len() > 255 {
        return Err("browser staged filename is invalid".to_string());
    }
    let has_separator = trimmed.contains('/') || trimmed.contains('\\');
    let is_dot = trimmed == "." || trimmed == "..";
    let mut normal_only = true;
    for component in Path::new(trimmed).components() {
        if !matches!(component, std::path::Component::Normal(_)) {
            normal_only = false;
        }
    }
    if has_separator || is_dot || !normal_only {
        return Err("browser staged filename is invalid".to_string());
    }
    Ok(trimmed.to_string())
}

fn staging_directory(upload_id: &str) -> PathBuf {
    std::env::temp_dir()
        .join("orca-browser-uploads")
        .join(upload_id)
}

fn fresh_upload_id() -> String {
    format!(
        "browser-upload-{}-{}",
        std::process::id(),
        NEXT_UPLOAD_ID.fetch_add(1, Ordering::Relaxed)
    )
}

// Why upload staging: automation file inputs name REMOTE workspace paths. The
// bytes are pulled over the file channel, so the page needs a LOCAL file for
// CDP setFileInputFiles. Staged copies live under the temp dir and the
// renderer discards them right after the input is set.
#[tauri::command]
pub fn poc_browser_stage_upload_chunk(
    state: State<'_, BrowserUploadStagingState>,
    args: StageUploadChunkArgs,
) -> Result<StageUploadChunkResult, String> {
    let filename = validated_filename(&args.filename)?;
    let bytes = BASE64
        .decode(args.content_base64.as_bytes())
        .map_err(|error| format!("browser staged chunk is invalid: {error}"))?;
    if bytes.len() > MAX_STAGE_CHUNK_BYTES {
        return Err("browser staged chunk exceeds its byte budget".to_string());
    }
    let provided = args.upload_id.unwrap_or_default();
    let upload_id = if provided.trim().is_empty() || provided.len() > 128 {
        fresh_upload_id()
    } else {
        provided
    };
    let directory = staging_directory(&upload_id);
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let staging_path = directory.join(&filename);
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&staging_path)
        .map_err(|error| error.to_string())?;
    file.write_all(&bytes).map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())?;
    drop(file);
    let staged_bytes = fs::metadata(&staging_path)
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    if staged_bytes > MAX_STAGED_UPLOAD_BYTES {
        let _ = fs::remove_dir_all(&directory);
        return Err("browser staged upload exceeds its byte budget".to_string());
    }
    if let Ok(mut sessions) = state.sessions.lock() {
        sessions.insert(upload_id.clone(), staging_path.clone());
    }
    let done = args.final_chunk;
    let path_text = staging_path.to_string_lossy().into_owned();
    Ok(StageUploadChunkResult {
        upload_id,
        staging_path: if done { Some(path_text) } else { None },
    })
}

#[tauri::command]
pub fn poc_browser_discard_staged_upload(
    state: State<'_, BrowserUploadStagingState>,
    upload_id: String,
) -> Result<(), String> {
    let staged = state
        .sessions
        .lock()
        .map_err(|_| "browser upload staging state is poisoned".to_string())?
        .remove(&upload_id);
    let directory = staging_directory(&upload_id);
    if let Some(path) = staged {
        let _ = fs::remove_file(&path);
    }
    let _ = fs::remove_dir(&directory);
    Ok(())
}

fn validated_relay_path(app: &AppHandle, save_path: &str) -> Result<PathBuf, String> {
    if save_path.trim().is_empty() {
        return Err("browser relay path is invalid".to_string());
    }
    let root = browser_download_directory(app);
    let root_canon = root
        .canonicalize()
        .map_err(|_| "browser download directory is unavailable".to_string())?;
    let canon = PathBuf::from(save_path)
        .canonicalize()
        .map_err(|_| "browser relay path is invalid".to_string())?;
    if !canon.starts_with(&root_canon) {
        return Err("browser relay path escapes the download directory".to_string());
    }
    Ok(canon)
}

// Why relay reads: automation downloads land in the desktop download dir, but
// a client-placed page's bytes belong to the REMOTE workspace. The renderer
// streams the finished file over the file channel, then deletes the local
// copy so automation never litters the user's Downloads folder.
#[tauri::command]
pub fn poc_browser_relay_download_chunk(
    app: AppHandle,
    args: RelayDownloadChunkArgs,
) -> Result<RelayDownloadChunkResult, String> {
    if args.length == 0 || args.length > MAX_RELAY_CHUNK_BYTES {
        return Err("browser relay chunk exceeds its byte budget".to_string());
    }
    let path = validated_relay_path(&app, &args.save_path)?;
    let mut file: File = File::open(&path).map_err(|error| error.to_string())?;
    let total_bytes = file.metadata().map(|m| m.len()).unwrap_or(0);
    if args.offset > total_bytes {
        return Err("browser relay offset is out of range".to_string());
    }
    file.seek(SeekFrom::Start(args.offset))
        .map_err(|error| error.to_string())?;
    let mut buffer = vec![0u8; args.length as usize];
    let mut bytes_read = 0usize;
    while bytes_read < buffer.len() {
        let rest = &mut buffer[bytes_read..];
        match file.read(rest) {
            Ok(0) => break,
            Ok(n) => bytes_read += n,
            Err(error) => return Err(error.to_string()),
        }
    }
    let encoded = BASE64.encode(&buffer[..bytes_read]);
    Ok(RelayDownloadChunkResult {
        content_base64: encoded,
        bytes_read: bytes_read as u64,
        total_bytes,
        eof: args.offset + bytes_read as u64 >= total_bytes,
    })
}

#[tauri::command]
pub fn poc_browser_cleanup_relayed_download(
    app: AppHandle,
    save_path: String,
) -> Result<(), String> {
    let path = validated_relay_path(&app, &save_path)?;
    fs::remove_file(&path).map_err(|error| error.to_string())?;
    Ok(())
}
