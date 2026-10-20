use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

const MAX_DOWNLOAD_CHUNK_BYTES: usize = 8 * 1024 * 1024;
static NEXT_TRANSFER_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Default)]
pub struct DownloadSessions(Mutex<HashMap<String, DownloadSession>>);

#[derive(Default)]
pub struct FolderDownloadSessions(Mutex<HashMap<String, FolderDownloadSession>>);

struct DownloadSession {
    destination_path: PathBuf,
    temp_path: PathBuf,
    destination_existed: bool,
    file: File,
}

struct FolderDownloadSession {
    destination_path: PathBuf,
    temp_path: PathBuf,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadDestinationArgs {
    pub destination_path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderDownloadStartArgs {
    pub parent_path: String,
    pub suggested_name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveDownloadedFileArgs {
    pub destination_path: String,
    pub content: String,
    pub encoding: DownloadEncoding,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DownloadEncoding {
    Utf8,
    Base64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadStarted {
    pub transfer_id: String,
    pub destination_path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadFinished {
    pub destination_path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderDownloadStarted {
    pub transfer_id: String,
    pub destination_path: String,
    pub temp_path: String,
}

#[tauri::command]
pub fn poc_start_downloaded_folder(
    sessions: tauri::State<'_, FolderDownloadSessions>,
    args: FolderDownloadStartArgs,
) -> Result<FolderDownloadStarted, String> {
    let parent = validate_directory(&args.parent_path)?;
    validate_folder_name(&args.suggested_name)?;
    let destination = parent.join(&args.suggested_name);
    if fs::symlink_metadata(&destination).is_ok() {
        return Err("Destination folder already exists.".to_string());
    }
    let transfer_id = format!(
        "{}-folder-{}",
        std::process::id(),
        NEXT_TRANSFER_ID.fetch_add(1, Ordering::Relaxed)
    );
    let temp_path = parent.join(format!(".{}.orca-folder-download", transfer_id));
    if fs::symlink_metadata(&temp_path).is_ok() {
        return Err("Could not reserve a temporary folder download path.".to_string());
    }
    sessions
        .0
        .lock()
        .map_err(|_| "Download state is unavailable.")?
        .insert(
            transfer_id.clone(),
            FolderDownloadSession {
                destination_path: destination.clone(),
                temp_path: temp_path.clone(),
            },
        );
    Ok(FolderDownloadStarted {
        transfer_id,
        destination_path: destination.to_string_lossy().into_owned(),
        temp_path: temp_path.to_string_lossy().into_owned(),
    })
}

#[tauri::command]
pub fn poc_finish_downloaded_folder(
    sessions: tauri::State<'_, FolderDownloadSessions>,
    transfer_id: String,
) -> Result<DownloadFinished, String> {
    let session = sessions
        .0
        .lock()
        .map_err(|_| "Download state is unavailable.")?
        .remove(&transfer_id)
        .ok_or_else(|| "Folder download session not found.".to_string())?;
    let result = (|| {
        let metadata =
            fs::symlink_metadata(&session.temp_path).map_err(|error| error.to_string())?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err("Temporary folder download is invalid.".to_string());
        }
        if fs::symlink_metadata(&session.destination_path).is_ok() {
            return Err("Destination folder appeared before download completed.".to_string());
        }
        fs::rename(&session.temp_path, &session.destination_path)
            .map_err(|error| error.to_string())?;
        Ok(DownloadFinished {
            destination_path: session.destination_path.to_string_lossy().into_owned(),
        })
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&session.temp_path);
    }
    result
}

#[tauri::command]
pub fn poc_cancel_downloaded_folder(
    sessions: tauri::State<'_, FolderDownloadSessions>,
    transfer_id: String,
) -> Result<(), String> {
    let session = sessions
        .0
        .lock()
        .map_err(|_| "Download state is unavailable.")?
        .remove(&transfer_id)
        .ok_or_else(|| "Folder download session not found.".to_string())?;
    remove_folder_if_present(&session.temp_path)
}

#[tauri::command]
pub fn poc_save_downloaded_file(args: SaveDownloadedFileArgs) -> Result<DownloadFinished, String> {
    let destination = validate_destination(&args.destination_path)?;
    let bytes = decode_content(&args.content, &args.encoding, None)?;
    let (temp_path, mut file, existed) = create_transfer_file(&destination)?;
    let result = (|| {
        file.write_all(&bytes).map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
        drop(file);
        promote_download(&temp_path, &destination, existed)?;
        Ok(DownloadFinished {
            destination_path: destination.to_string_lossy().into_owned(),
        })
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }
    result
}

#[tauri::command]
pub fn poc_start_downloaded_file(
    sessions: tauri::State<'_, DownloadSessions>,
    args: DownloadDestinationArgs,
) -> Result<DownloadStarted, String> {
    let destination = validate_destination(&args.destination_path)?;
    let (temp_path, file, destination_existed) = create_transfer_file(&destination)?;
    let transfer_id = format!(
        "{}-{}",
        std::process::id(),
        NEXT_TRANSFER_ID.fetch_add(1, Ordering::Relaxed)
    );
    let session = DownloadSession {
        destination_path: destination.clone(),
        temp_path,
        destination_existed,
        file,
    };
    let mut stored_sessions = sessions
        .0
        .lock()
        .map_err(|_| "Download state is unavailable.")?;
    stored_sessions.insert(transfer_id.clone(), session);
    Ok(DownloadStarted {
        transfer_id,
        destination_path: destination.to_string_lossy().into_owned(),
    })
}

#[tauri::command]
pub fn poc_append_downloaded_file_chunk(
    sessions: tauri::State<'_, DownloadSessions>,
    transfer_id: String,
    content_base64: String,
) -> Result<(), String> {
    if transfer_id.trim().is_empty() || content_base64.trim().is_empty() {
        return Err("A transfer id and chunk are required.".to_string());
    }
    let bytes = BASE64
        .decode(content_base64)
        .map_err(|error| format!("Invalid download chunk: {error}"))?;
    if bytes.len() > MAX_DOWNLOAD_CHUNK_BYTES {
        return Err("Download chunk exceeds the 8 MB limit.".to_string());
    }
    let mut sessions = sessions
        .0
        .lock()
        .map_err(|_| "Download state is unavailable.")?;
    let session = sessions
        .get_mut(&transfer_id)
        .ok_or_else(|| "Download session not found.".to_string())?;
    session
        .file
        .write_all(&bytes)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn poc_finish_downloaded_file(
    sessions: tauri::State<'_, DownloadSessions>,
    transfer_id: String,
) -> Result<DownloadFinished, String> {
    let session = {
        let mut sessions = sessions
            .0
            .lock()
            .map_err(|_| "Download state is unavailable.")?;
        sessions
            .remove(&transfer_id)
            .ok_or_else(|| "Download session not found.".to_string())?
    };
    let DownloadSession {
        destination_path,
        temp_path,
        destination_existed,
        mut file,
    } = session;
    let result = (|| {
        file.flush().map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
        drop(file);
        promote_download(&temp_path, &destination_path, destination_existed)?;
        Ok(DownloadFinished {
            destination_path: destination_path.to_string_lossy().into_owned(),
        })
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }
    result
}

#[tauri::command]
pub fn poc_cancel_downloaded_file(
    sessions: tauri::State<'_, DownloadSessions>,
    transfer_id: String,
) -> Result<(), String> {
    let session = {
        let mut sessions = sessions
            .0
            .lock()
            .map_err(|_| "Download state is unavailable.")?;
        sessions
            .remove(&transfer_id)
            .ok_or_else(|| "Download session not found.".to_string())?
    };
    drop(session.file);
    match fs::remove_file(session.temp_path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

impl DownloadSessions {
    pub fn cancel_all(&self) {
        let Ok(mut sessions) = self.0.lock() else {
            return;
        };
        for (_, session) in sessions.drain() {
            drop(session.file);
            let _ = fs::remove_file(session.temp_path);
        }
    }
}

impl FolderDownloadSessions {
    pub fn cancel_all(&self) {
        let Ok(mut sessions) = self.0.lock() else {
            return;
        };
        for (_, session) in sessions.drain() {
            let _ = fs::remove_dir_all(session.temp_path);
        }
    }
}

fn validate_directory(value: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(value);
    if !path.is_absolute() {
        return Err("Folder path must be absolute.".to_string());
    }
    let metadata = fs::symlink_metadata(&path).map_err(|error| error.to_string())?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("Folder path must be a regular directory.".to_string());
    }
    Ok(path)
}

fn validate_folder_name(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value == "."
        || value == ".."
        || value.contains('/')
        || value.contains('\\')
    {
        return Err("Folder name is invalid.".to_string());
    }
    if value
        .chars()
        .any(|character| character.is_control() || "<>:\"|?*".contains(character))
    {
        return Err("Folder name contains unsupported characters.".to_string());
    }
    Ok(())
}

fn remove_folder_if_present(path: &Path) -> Result<(), String> {
    match fs::remove_dir_all(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

fn validate_destination(value: &str) -> Result<PathBuf, String> {
    let destination = PathBuf::from(value);
    if !destination.is_absolute() {
        return Err("Download destination must be an absolute path.".to_string());
    }
    if destination
        .file_name()
        .filter(|name| !name.to_string_lossy().is_empty())
        .is_none()
    {
        return Err("Download destination must name a file.".to_string());
    }
    if let Ok(metadata) = fs::symlink_metadata(&destination) {
        if metadata.file_type().is_symlink() {
            return Err("Download destination cannot be a symbolic link.".to_string());
        }
        if metadata.is_dir() {
            return Err("Cannot download to a directory.".to_string());
        }
    }
    if !destination.parent().is_some_and(|parent| parent.is_dir()) {
        return Err("Download destination folder does not exist.".to_string());
    }
    Ok(destination)
}

fn create_transfer_file(destination: &Path) -> Result<(PathBuf, File, bool), String> {
    let destination_existed = fs::symlink_metadata(destination).is_ok();
    for _ in 0..32 {
        let id = NEXT_TRANSFER_ID.fetch_add(1, Ordering::Relaxed);
        let temp_path = destination.with_file_name(format!(
            ".{}.orca-download-{id}",
            destination
                .file_name()
                .map(|name| name.to_string_lossy())
                .unwrap_or_default()
        ));
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp_path)
        {
            Ok(file) => return Ok((temp_path, file, destination_existed)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.to_string()),
        }
    }
    Err("Could not create a temporary download file.".to_string())
}

fn promote_download(
    temp_path: &Path,
    destination: &Path,
    destination_existed: bool,
) -> Result<(), String> {
    if !destination_existed {
        if fs::symlink_metadata(destination).is_ok() {
            return Err("Destination file appeared before download completed.".to_string());
        }
        return fs::rename(temp_path, destination).map_err(|error| error.to_string());
    }

    let backup_path = destination.with_file_name(format!(
        ".{}.orca-download-backup-{}",
        destination
            .file_name()
            .map(|name| name.to_string_lossy())
            .unwrap_or_default(),
        NEXT_TRANSFER_ID.fetch_add(1, Ordering::Relaxed)
    ));
    fs::rename(destination, &backup_path).map_err(|error| error.to_string())?;
    match fs::rename(temp_path, destination) {
        Ok(()) => {
            let _ = fs::remove_file(backup_path);
            Ok(())
        }
        Err(error) => {
            let _ = fs::rename(&backup_path, destination);
            Err(error.to_string())
        }
    }
}

fn decode_content(
    content: &str,
    encoding: &DownloadEncoding,
    max_bytes: Option<usize>,
) -> Result<Vec<u8>, String> {
    let bytes = match encoding {
        DownloadEncoding::Utf8 => content.as_bytes().to_vec(),
        DownloadEncoding::Base64 => BASE64
            .decode(content)
            .map_err(|error| format!("Invalid download content: {error}"))?,
    };
    if max_bytes.is_some_and(|limit| bytes.len() > limit) {
        return Err("Download chunk exceeds the 8 MB limit.".to_string());
    }
    Ok(bytes)
}
