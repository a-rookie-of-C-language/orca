use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::{Deserialize, Serialize};
use std::fs::{self, File, Metadata, OpenOptions};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

pub const RUNTIME_UPLOAD_SLICE_BYTES: u64 = 384 * 1024;
const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_TOTAL_BYTES: u64 = 8 * 1024 * 1024 * 1024;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalFileIdentity {
    pub byte_length: u64,
    pub inode: u64,
    pub device_id: u64,
    pub modified_at_ms: u64,
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum StagedExternalEntry {
    #[serde(rename = "directory", rename_all = "camelCase")]
    Directory { relative_path: String },
    #[serde(rename = "file", rename_all = "camelCase")]
    File {
        relative_path: String,
        #[serde(flatten)]
        identity: ExternalFileIdentity,
    },
}

#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum StagedExternalSource {
    #[serde(rename = "staged", rename_all = "camelCase")]
    Staged {
        source_path: String,
        name: String,
        kind: String,
        entries: Vec<StagedExternalEntry>,
    },
    #[serde(rename = "skipped", rename_all = "camelCase")]
    Skipped { source_path: String, reason: String },
    #[serde(rename = "failed", rename_all = "camelCase")]
    Failed { source_path: String, reason: String },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StageExternalPathsArgs {
    pub source_paths: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StageExternalPathsResult {
    pub sources: Vec<StagedExternalSource>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadExternalFileChunkArgs {
    pub source_root_path: String,
    pub entry_relative_path: String,
    pub expected: ExternalFileIdentity,
    pub offset: u64,
    pub length: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadExternalFileChunkResult {
    pub content_base64: String,
    pub byte_length: u64,
}

#[derive(Debug)]
enum StageError {
    Skipped(&'static str),
    Failed(String),
}

#[tauri::command]
pub fn poc_stage_external_paths(
    args: StageExternalPathsArgs,
) -> Result<StageExternalPathsResult, String> {
    let mut total_bytes = 0_u64;
    let mut sources = Vec::with_capacity(args.source_paths.len());
    for source_path in args.source_paths {
        let staged = stage_source(&source_path, &mut total_bytes);
        sources.push(staged);
    }
    Ok(StageExternalPathsResult { sources })
}

#[tauri::command]
pub fn poc_read_external_file_chunk(
    args: ReadExternalFileChunkArgs,
) -> Result<ReadExternalFileChunkResult, String> {
    if args.length > RUNTIME_UPLOAD_SLICE_BYTES {
        return Err("Requested file chunk is too large.".to_string());
    }
    let source_path = resolve_entry_path(&args.source_root_path, &args.entry_relative_path)?;
    let metadata = verify_regular_file(&source_path, &args.expected)?;
    if args.offset > metadata.len() {
        return Err("File offset is past the end of the staged file.".to_string());
    }

    let mut file = OpenOptions::new()
        .read(true)
        .open(&source_path)
        .map_err(|error| error.to_string())?;
    verify_regular_file(&source_path, &args.expected)?;
    file.seek(SeekFrom::Start(args.offset))
        .map_err(|error| error.to_string())?;
    let remaining = metadata.len().saturating_sub(args.offset);
    let requested = remaining.min(args.length);
    let mut bytes = vec![0_u8; requested as usize];
    let mut read = 0_usize;
    while read < bytes.len() {
        let count = file
            .read(&mut bytes[read..])
            .map_err(|error| error.to_string())?;
        if count == 0 {
            break;
        }
        read += count;
    }
    bytes.truncate(read);
    verify_regular_file(&source_path, &args.expected)?;
    Ok(ReadExternalFileChunkResult {
        content_base64: BASE64.encode(bytes),
        byte_length: read as u64,
    })
}

fn stage_source(source_path: &str, total_bytes: &mut u64) -> StagedExternalSource {
    let resolved_path = resolve_path(source_path);
    let metadata = match fs::symlink_metadata(&resolved_path) {
        Ok(metadata) => metadata,
        Err(error) => {
            return classify_source_error(source_path, error);
        }
    };
    if metadata.file_type().is_symlink() {
        return skipped(source_path, "symlink");
    }
    if !metadata.is_file() && !metadata.is_dir() {
        return skipped(source_path, "unsupported");
    }

    let name = resolved_path
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| source_path.to_string());
    let total_before = *total_bytes;
    let result = if metadata.is_dir() {
        let mut source_total = total_before;
        stage_directory(&resolved_path, &mut source_total).map(|entries| {
            *total_bytes = source_total;
            ("directory".to_string(), entries)
        })
    } else {
        stage_file(&resolved_path, "", *total_bytes).map(|(entry, bytes)| {
            *total_bytes = (*total_bytes).saturating_add(bytes);
            ("file".to_string(), vec![entry])
        })
    };
    match result {
        Ok((kind, entries)) => StagedExternalSource::Staged {
            source_path: source_path.to_string(),
            name,
            kind,
            entries,
        },
        Err(StageError::Skipped(reason)) => skipped(source_path, reason),
        Err(StageError::Failed(reason)) => failed(source_path, reason),
    }
}

fn stage_directory(
    root_path: &Path,
    total_bytes: &mut u64,
) -> Result<Vec<StagedExternalEntry>, StageError> {
    let root_real_path = fs::canonicalize(root_path).map_err(io_failure)?;
    let mut entries = vec![StagedExternalEntry::Directory {
        relative_path: String::new(),
    }];
    visit_directory(
        root_path,
        root_path,
        &root_real_path,
        total_bytes,
        &mut entries,
    )?;
    Ok(entries)
}

fn visit_directory(
    root_path: &Path,
    directory_path: &Path,
    root_real_path: &Path,
    total_bytes: &mut u64,
    entries: &mut Vec<StagedExternalEntry>,
) -> Result<(), StageError> {
    let metadata = checked_directory_metadata(directory_path, root_real_path)?;
    if !metadata.is_dir() {
        return Err(StageError::Skipped("unsupported"));
    }
    let mut children = fs::read_dir(directory_path)
        .map_err(io_failure)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(io_failure)?;
    children.sort_by_key(|entry| entry.file_name());
    for child in children {
        let child_path = child.path();
        let relative_path = relative_upload_path(root_path, &child_path)?;
        let child_metadata = fs::symlink_metadata(&child_path).map_err(io_failure)?;
        if child_metadata.file_type().is_symlink() {
            return Err(StageError::Skipped("symlink"));
        }
        if child_metadata.is_dir() {
            ensure_inside_root(root_real_path, &child_path, &relative_path)?;
            entries.push(StagedExternalEntry::Directory {
                relative_path: relative_path.clone(),
            });
            visit_directory(root_path, &child_path, root_real_path, total_bytes, entries)?;
            continue;
        }
        if !child_metadata.is_file() {
            return Err(StageError::Skipped("unsupported"));
        }
        let (entry, bytes) = stage_file(&child_path, &relative_path, *total_bytes)?;
        *total_bytes = (*total_bytes).saturating_add(bytes);
        entries.push(entry);
    }
    Ok(())
}

fn stage_file(
    file_path: &Path,
    relative_path: &str,
    total_bytes: u64,
) -> Result<(StagedExternalEntry, u64), StageError> {
    let metadata = fs::symlink_metadata(file_path).map_err(io_failure)?;
    if metadata.file_type().is_symlink() {
        return Err(StageError::Skipped("symlink"));
    }
    if !metadata.is_file() {
        return Err(StageError::Skipped("unsupported"));
    }
    let identity = file_identity(&metadata);
    assert_budget(relative_path, identity.byte_length, total_bytes)?;
    let file = File::open(file_path).map_err(io_failure)?;
    let opened_metadata = file.metadata().map_err(io_failure)?;
    if !same_identity(&identity, &file_identity(&opened_metadata)) {
        return Err(StageError::Failed(
            "File changed during upload staging.".to_string(),
        ));
    }
    Ok((
        StagedExternalEntry::File {
            relative_path: relative_path.to_string(),
            identity,
        },
        opened_metadata.len(),
    ))
}

fn verify_regular_file(
    file_path: &Path,
    expected: &ExternalFileIdentity,
) -> Result<Metadata, String> {
    let metadata = fs::symlink_metadata(file_path).map_err(|error| error.to_string())?;
    if metadata.file_type().is_symlink() {
        return Err("Symlink not allowed in uploaded files.".to_string());
    }
    if !metadata.is_file() {
        return Err("Uploaded path is not a regular file.".to_string());
    }
    let observed = file_identity(&metadata);
    if !same_identity(expected, &observed) {
        return Err("File changed since it was staged.".to_string());
    }
    Ok(metadata)
}

fn resolve_entry_path(root: &str, entry_relative_path: &str) -> Result<PathBuf, String> {
    let root_path = resolve_path(root);
    let root_metadata = fs::symlink_metadata(&root_path).map_err(|error| error.to_string())?;
    if root_metadata.file_type().is_symlink() {
        return Err("Symlink not allowed in uploaded files.".to_string());
    }
    if entry_relative_path.is_empty() {
        return Ok(root_path);
    }
    if !root_metadata.is_dir() {
        return Err("A file upload cannot have a nested entry.".to_string());
    }
    let mut result = root_path;
    for part in entry_relative_path.split(['/', '\\']) {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".."
            || Path::new(part)
                .components()
                .any(|component| matches!(component, Component::RootDir | Component::Prefix(_)))
        {
            return Err("Uploaded entry path escapes its source directory.".to_string());
        }
        result.push(part);
        let metadata = fs::symlink_metadata(&result).map_err(|error| error.to_string())?;
        if metadata.file_type().is_symlink() {
            return Err("Symlink not allowed in uploaded files.".to_string());
        }
    }
    let root_real_path =
        fs::canonicalize(&resolve_path(root)).map_err(|error| error.to_string())?;
    ensure_inside_root(&root_real_path, &result, entry_relative_path).map_err(
        |error| match error {
            StageError::Skipped(reason) => format!("Path rejected: {reason}"),
            StageError::Failed(reason) => reason,
        },
    )?;
    Ok(result)
}

fn checked_directory_metadata(
    directory_path: &Path,
    root_real_path: &Path,
) -> Result<Metadata, StageError> {
    let metadata = fs::symlink_metadata(directory_path).map_err(io_failure)?;
    if metadata.file_type().is_symlink() {
        return Err(StageError::Skipped("symlink"));
    }
    ensure_inside_root(root_real_path, directory_path, "")?;
    Ok(metadata)
}

fn ensure_inside_root(
    root_real_path: &Path,
    candidate_path: &Path,
    display_path: &str,
) -> Result<(), StageError> {
    let candidate_real_path = fs::canonicalize(candidate_path).map_err(io_failure)?;
    if !candidate_real_path.starts_with(root_real_path) {
        return Err(StageError::Failed(format!(
            "Path escaped upload root during staging: '{display_path}'"
        )));
    }
    Ok(())
}

fn relative_upload_path(root_path: &Path, child_path: &Path) -> Result<String, StageError> {
    let relative = child_path
        .strip_prefix(root_path)
        .map_err(|_| StageError::Failed("Could not determine uploaded entry path.".to_string()))?;
    Ok(relative
        .to_string_lossy()
        .replace('\\', "/")
        .trim_matches('/')
        .to_string())
}

fn assert_budget(display_path: &str, bytes: u64, total_bytes: u64) -> Result<(), StageError> {
    if bytes > MAX_FILE_BYTES {
        return Err(StageError::Failed(format!(
            "'{display_path}' exceeds the 2 GB per-file remote import limit."
        )));
    }
    let next_total = total_bytes
        .checked_add(bytes)
        .ok_or_else(|| StageError::Failed("Remote import size overflow.".to_string()))?;
    if next_total > MAX_TOTAL_BYTES {
        return Err(StageError::Failed(
            "This import exceeds the 8 GB total remote import limit.".to_string(),
        ));
    }
    Ok(())
}

fn resolve_path(path: &str) -> PathBuf {
    let path = PathBuf::from(path);
    if path.is_absolute() {
        path
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(path)
    }
}

fn io_failure(error: std::io::Error) -> StageError {
    match error.kind() {
        std::io::ErrorKind::NotFound => StageError::Skipped("missing"),
        std::io::ErrorKind::PermissionDenied => StageError::Skipped("permission-denied"),
        _ => StageError::Failed(error.to_string()),
    }
}

fn classify_source_error(source_path: &str, error: std::io::Error) -> StagedExternalSource {
    match io_failure(error) {
        StageError::Skipped(reason) => skipped(source_path, reason),
        StageError::Failed(reason) => failed(source_path, reason),
    }
}

fn skipped(source_path: &str, reason: &str) -> StagedExternalSource {
    StagedExternalSource::Skipped {
        source_path: source_path.to_string(),
        reason: reason.to_string(),
    }
}

fn failed(source_path: &str, reason: String) -> StagedExternalSource {
    StagedExternalSource::Failed {
        source_path: source_path.to_string(),
        reason,
    }
}

fn file_identity(metadata: &Metadata) -> ExternalFileIdentity {
    ExternalFileIdentity {
        byte_length: metadata.len(),
        inode: file_identity_parts(metadata).0,
        device_id: file_identity_parts(metadata).1,
        modified_at_ms: metadata
            .modified()
            .ok()
            .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis().min(u64::MAX as u128) as u64)
            .unwrap_or(0),
    }
}

fn same_identity(expected: &ExternalFileIdentity, observed: &ExternalFileIdentity) -> bool {
    expected.byte_length == observed.byte_length
        && expected.modified_at_ms == observed.modified_at_ms
        && (expected.inode == 0 || observed.inode == 0 || expected.inode == observed.inode)
        && (expected.device_id == 0
            || observed.device_id == 0
            || expected.device_id == observed.device_id)
}

#[cfg(unix)]
fn file_identity_parts(metadata: &Metadata) -> (u64, u64) {
    use std::os::unix::fs::MetadataExt;
    (metadata.ino(), metadata.dev())
}

#[cfg(windows)]
fn file_identity_parts(_metadata: &Metadata) -> (u64, u64) {
    // The stable Windows MetadataExt API does not expose a portable file id;
    // size and write time still detect the common replacement cases.
    (0, 0)
}

#[cfg(not(any(unix, windows)))]
fn file_identity_parts(_metadata: &Metadata) -> (u64, u64) {
    (0, 0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::{create_dir_all, remove_dir_all, write};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temporary_directory() -> PathBuf {
        std::env::temp_dir().join(format!(
            "orca-tauri-upload-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system clock is before unix epoch")
                .as_nanos()
        ))
    }

    #[test]
    fn stages_and_reads_a_file_without_loading_the_whole_source() {
        let root = temporary_directory();
        create_dir_all(&root).expect("create temporary directory");
        let path = root.join("note.txt");
        write(&path, b"hello from tauri").expect("write fixture");

        let staged = poc_stage_external_paths(StageExternalPathsArgs {
            source_paths: vec![path.to_string_lossy().into_owned()],
        })
        .expect("stage source")
        .sources
        .pop()
        .expect("staged source");
        let StagedExternalSource::Staged { entries, .. } = staged else {
            panic!("fixture should be staged")
        };
        let StagedExternalEntry::File { identity, .. } = &entries[0] else {
            panic!("fixture should have a file entry")
        };
        let chunk = poc_read_external_file_chunk(ReadExternalFileChunkArgs {
            source_root_path: path.to_string_lossy().into_owned(),
            entry_relative_path: String::new(),
            expected: identity.clone(),
            offset: 0,
            length: 5,
        })
        .expect("read source chunk");
        assert_eq!(chunk.byte_length, 5);
        assert_eq!(
            BASE64.decode(chunk.content_base64).expect("decode chunk"),
            b"hello"
        );

        remove_dir_all(root).expect("remove temporary directory");
    }

    #[test]
    fn rejects_a_source_that_changes_after_staging() {
        let root = temporary_directory();
        create_dir_all(&root).expect("create temporary directory");
        let path = root.join("note.txt");
        write(&path, b"before").expect("write fixture");
        let staged = poc_stage_external_paths(StageExternalPathsArgs {
            source_paths: vec![path.to_string_lossy().into_owned()],
        })
        .expect("stage source")
        .sources
        .pop()
        .expect("staged source");
        let StagedExternalSource::Staged { entries, .. } = staged else {
            panic!("fixture should be staged")
        };
        let StagedExternalEntry::File { identity, .. } = &entries[0] else {
            panic!("fixture should have a file entry")
        };
        write(&path, b"after changed").expect("replace fixture");
        let error = poc_read_external_file_chunk(ReadExternalFileChunkArgs {
            source_root_path: path.to_string_lossy().into_owned(),
            entry_relative_path: String::new(),
            expected: identity.clone(),
            offset: 0,
            length: 5,
        })
        .expect_err("changed source should be refused");
        assert!(error.contains("changed since it was staged"));

        remove_dir_all(root).expect("remove temporary directory");
    }

    #[test]
    fn staged_sources_serialize_with_renderer_camel_case() {
        let source = StagedExternalSource::Staged {
            source_path: String::from("C:\\repo\\note.txt"),
            name: String::from("note.txt"),
            kind: String::from("file"),
            entries: vec![StagedExternalEntry::File {
                relative_path: String::new(),
                identity: ExternalFileIdentity {
                    byte_length: 4,
                    inode: 0,
                    device_id: 0,
                    modified_at_ms: 1,
                },
            }],
        };
        let value = serde_json::to_value(&source).expect("serialize staged source");
        assert_eq!(value["sourcePath"], "C:\\repo\\note.txt");
        assert_eq!(value["entries"][0]["relativePath"], "");
        assert_eq!(value["entries"][0]["byteLength"], 4);
        assert!(value.get("source_path").is_none());
        assert!(value["entries"][0].get("relative_path").is_none());
        assert!(value["entries"][0].get("byte_length").is_none());
    }
}
