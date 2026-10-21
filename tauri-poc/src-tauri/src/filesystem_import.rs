use crate::authorized_roots::{canonicalize_existing, configured_authorized_roots};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;
use std::fs::{self, File, Metadata, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportExternalPathsArgs {
    pub source_paths: Vec<String>,
    pub dest_dir: String,
    #[serde(default)]
    pub ensure_dir: bool,
    #[serde(default)]
    pub access: Option<Value>,
}

#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
enum ImportItemResult {
    #[serde(rename = "imported")]
    Imported {
        source_path: String,
        dest_path: String,
        kind: &'static str,
        renamed: bool,
    },
    #[serde(rename = "skipped")]
    Skipped {
        source_path: String,
        reason: &'static str,
    },
    #[serde(rename = "failed")]
    Failed { source_path: String, reason: String },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportExternalPathsResult {
    results: Vec<ImportItemResult>,
}

#[tauri::command]
pub fn poc_import_external_paths(
    args: ImportExternalPathsArgs,
) -> Result<ImportExternalPathsResult, String> {
    let destination =
        resolve_authorized_destination(&args.dest_dir, args.access.as_ref(), args.ensure_dir)?;
    let mut reserved_names = HashSet::new();
    let mut results = Vec::with_capacity(args.source_paths.len());

    for source_path in args.source_paths {
        let result = import_one_source(&source_path, &destination, &reserved_names);
        if let ImportItemResult::Imported { dest_path, .. } = &result {
            if let Some(name) = Path::new(dest_path).file_name() {
                reserved_names.insert(name.to_string_lossy().into_owned());
            }
        }
        results.push(result);
    }

    Ok(ImportExternalPathsResult { results })
}

fn import_one_source(
    source_display_path: &str,
    destination: &Path,
    reserved_names: &HashSet<String>,
) -> ImportItemResult {
    let source = resolve_input_path(source_display_path);
    let metadata = match fs::symlink_metadata(&source) {
        Ok(metadata) => metadata,
        Err(error) => return source_error(source_display_path, error),
    };
    if metadata.file_type().is_symlink() {
        return ImportItemResult::Skipped {
            source_path: source_display_path.to_string(),
            reason: "symlink",
        };
    }
    if !metadata.is_file() && !metadata.is_dir() {
        return ImportItemResult::Skipped {
            source_path: source_display_path.to_string(),
            reason: "unsupported",
        };
    }

    if metadata.is_dir() {
        match contains_symlink(&source) {
            Ok(true) => {
                return ImportItemResult::Skipped {
                    source_path: source_display_path.to_string(),
                    reason: "symlink",
                }
            }
            Ok(false) => {}
            Err(error) => {
                return ImportItemResult::Failed {
                    source_path: source_display_path.to_string(),
                    reason: error,
                }
            }
        }
    }

    let Some(original_name) = source
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
    else {
        return ImportItemResult::Skipped {
            source_path: source_display_path.to_string(),
            reason: "unsupported",
        };
    };
    let final_name = match deconflict_name(&original_name, destination, reserved_names) {
        Ok(name) => name,
        Err(error) => {
            return ImportItemResult::Failed {
                source_path: source_display_path.to_string(),
                reason: error,
            }
        }
    };
    let target = destination.join(&final_name);
    let result = if metadata.is_dir() {
        copy_directory(&source, &target)
    } else {
        copy_file_no_follow(&source, &target, &metadata)
    };
    if let Err(error) = result {
        return ImportItemResult::Failed {
            source_path: source_display_path.to_string(),
            reason: error,
        };
    }

    ImportItemResult::Imported {
        source_path: source_display_path.to_string(),
        dest_path: target.to_string_lossy().into_owned(),
        kind: if metadata.is_dir() {
            "directory"
        } else {
            "file"
        },
        renamed: final_name != original_name,
    }
}

fn resolve_authorized_destination(
    destination: &str,
    access: Option<&Value>,
    ensure_dir: bool,
) -> Result<PathBuf, String> {
    let destination = absolute_path(destination)?;
    let mut roots = Vec::new();
    if let Some(document_folder) = document_folder_from_access(access)? {
        roots.push(canonicalize_existing(&document_folder)?);
    } else {
        roots.extend(configured_authorized_roots());
    }
    if roots.is_empty() {
        return Err("Access denied: no authorized local destination is available.".to_string());
    }

    let existing = nearest_existing_ancestor(&destination)?;
    let existing_real = canonicalize_existing(&existing)?;
    if !roots.iter().any(|root| existing_real.starts_with(root)) {
        return Err("Access denied: destination is outside an authorized directory.".to_string());
    }

    if !destination.exists() {
        if !ensure_dir {
            return Err("Destination directory does not exist.".to_string());
        }
        fs::create_dir_all(&destination).map_err(|error| error.to_string())?;
    }

    let metadata = fs::symlink_metadata(&destination).map_err(|error| error.to_string())?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("Destination is not a regular directory.".to_string());
    }
    let destination_real = canonicalize_existing(&destination)?;
    if !roots.iter().any(|root| destination_real.starts_with(root)) {
        return Err("Access denied: destination is outside an authorized directory.".to_string());
    }
    Ok(destination_real)
}

fn document_folder_from_access(access: Option<&Value>) -> Result<Option<PathBuf>, String> {
    let Some(Value::Object(fields)) = access else {
        return Ok(None);
    };
    if fields.get("kind").and_then(Value::as_str) != Some("document-folder") {
        return Ok(None);
    }
    let document_path = fields
        .get("documentPath")
        .and_then(Value::as_str)
        .ok_or_else(|| "Access denied: document path is missing.".to_string())?;
    let document = absolute_path(document_path)?;
    document
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| "Access denied: document path has no parent directory.".to_string())
        .map(Some)
}

fn absolute_path(path: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(path);
    if !path.is_absolute() {
        return Err("Access denied: path must be absolute.".to_string());
    }
    Ok(path)
}

fn resolve_input_path(path: &str) -> PathBuf {
    let path = PathBuf::from(path);
    if path.is_absolute() {
        path
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(path)
    }
}

fn nearest_existing_ancestor(path: &Path) -> Result<PathBuf, String> {
    let mut candidate = path.to_path_buf();
    while !candidate.exists() {
        if !candidate.pop() {
            return Err("Destination has no existing parent directory.".to_string());
        }
    }
    Ok(candidate)
}

fn deconflict_name(
    original: &str,
    destination: &Path,
    reserved_names: &HashSet<String>,
) -> Result<String, String> {
    let is_taken = |name: &str| {
        reserved_names.contains(name) || fs::symlink_metadata(destination.join(name)).is_ok()
    };
    if !is_taken(original) {
        return Ok(original.to_string());
    }
    let dot = original.rfind('.');
    let (stem, extension) = match dot {
        Some(index) if index > 0 => (&original[..index], &original[index..]),
        _ => (original, ""),
    };
    let first_copy = format!("{stem} copy{extension}");
    if !is_taken(&first_copy) {
        return Ok(first_copy);
    }
    for counter in 2..10_000 {
        let candidate = format!("{stem} copy {counter}{extension}");
        if !is_taken(&candidate) {
            return Ok(candidate);
        }
    }
    Err(format!(
        "Could not generate a unique name for '{original}'."
    ))
}

fn contains_symlink(directory: &Path) -> Result<bool, String> {
    for entry in fs::read_dir(directory).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path).map_err(|error| error.to_string())?;
        if metadata.file_type().is_symlink() {
            return Ok(true);
        }
        if metadata.is_dir() && contains_symlink(&path)? {
            return Ok(true);
        }
    }
    Ok(false)
}

fn copy_directory(source: &Path, destination: &Path) -> Result<(), String> {
    fs::create_dir(destination).map_err(|error| error.to_string())?;
    if let Err(error) = copy_directory_contents(source, destination) {
        let _ = fs::remove_dir_all(destination);
        return Err(error);
    }
    Ok(())
}

fn copy_directory_contents(source: &Path, destination: &Path) -> Result<(), String> {
    for entry in fs::read_dir(source).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let source_path = entry.path();
        let destination_path = destination.join(entry.file_name());
        let metadata = fs::symlink_metadata(&source_path).map_err(|error| error.to_string())?;
        if metadata.file_type().is_symlink() {
            return Err(format!(
                "Symlink not allowed in '{}'.",
                entry.file_name().to_string_lossy()
            ));
        }
        if metadata.is_dir() {
            copy_directory(&source_path, &destination_path)?;
        } else if metadata.is_file() {
            copy_file_no_follow(&source_path, &destination_path, &metadata)?;
        } else {
            return Err(format!(
                "Unsupported file type in '{}'.",
                entry.file_name().to_string_lossy()
            ));
        }
    }
    Ok(())
}

fn copy_file_no_follow(source: &Path, destination: &Path, before: &Metadata) -> Result<(), String> {
    let mut source_file = open_source_file(source)?;
    let opened = source_file.metadata().map_err(|error| error.to_string())?;
    if !same_file_identity(before, &opened) {
        return Err(format!(
            "File changed during import: '{}'.",
            source.display()
        ));
    }
    let mut destination_file = match OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)
    {
        Ok(file) => file,
        Err(error) => return Err(error.to_string()),
    };
    if let Err(error) = io::copy(&mut source_file, &mut destination_file) {
        drop(destination_file);
        let _ = fs::remove_file(destination);
        return Err(error.to_string());
    }
    Ok(())
}

fn open_source_file(path: &Path) -> Result<File, String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        return OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW)
            .open(path)
            .map_err(|error| error.to_string());
    }
    #[cfg(not(unix))]
    {
        OpenOptions::new()
            .read(true)
            .open(path)
            .map_err(|error| error.to_string())
    }
}

fn same_file_identity(before: &Metadata, after: &Metadata) -> bool {
    if !after.is_file() || before.len() != after.len() {
        return false;
    }
    if before.modified().ok() != after.modified().ok() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        return before.ino() == after.ino() && before.dev() == after.dev();
    }
    #[cfg(not(unix))]
    {
        true
    }
}

fn source_error(source_path: &str, error: io::Error) -> ImportItemResult {
    let reason = match error.kind() {
        io::ErrorKind::NotFound => Some("missing"),
        io::ErrorKind::PermissionDenied => Some("permission-denied"),
        _ => None,
    };
    if let Some(reason) = reason {
        ImportItemResult::Skipped {
            source_path: source_path.to_string(),
            reason,
        }
    } else {
        ImportItemResult::Failed {
            source_path: source_path.to_string(),
            reason: error.to_string(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::{create_dir_all, read_to_string, remove_dir_all, write};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir() -> PathBuf {
        std::env::temp_dir().join(format!(
            "orca-tauri-import-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ))
    }

    fn document_access(document: &Path) -> Value {
        serde_json::json!({ "kind": "document-folder", "documentPath": document })
    }

    #[test]
    fn imports_files_and_deconflicts_names() {
        let root = temp_dir();
        let source = root.join("source.txt");
        let destination = root.join("document");
        create_dir_all(&destination).expect("destination");
        write(&source, "first").expect("source");
        write(destination.join("source.txt"), "existing").expect("existing");
        let result = poc_import_external_paths(ImportExternalPathsArgs {
            source_paths: vec![source.to_string_lossy().into_owned()],
            dest_dir: destination.to_string_lossy().into_owned(),
            ensure_dir: false,
            access: Some(document_access(&destination.join("note.md"))),
        })
        .expect("import");
        assert!(matches!(
            result.results[0],
            ImportItemResult::Imported { renamed: true, .. }
        ));
        assert_eq!(
            read_to_string(destination.join("source copy.txt")).expect("copy"),
            "first"
        );
        remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn imports_directories_recursively() {
        let root = temp_dir();
        let source = root.join("assets");
        let destination = root.join("document");
        create_dir_all(source.join("nested")).expect("source");
        create_dir_all(&destination).expect("destination");
        write(source.join("nested/icon.svg"), "icon").expect("file");
        let result = poc_import_external_paths(ImportExternalPathsArgs {
            source_paths: vec![source.to_string_lossy().into_owned()],
            dest_dir: destination.to_string_lossy().into_owned(),
            ensure_dir: false,
            access: Some(document_access(&destination.join("note.md"))),
        })
        .expect("import");
        assert!(matches!(
            result.results[0],
            ImportItemResult::Imported {
                kind: "directory",
                ..
            }
        ));
        assert_eq!(
            read_to_string(destination.join("assets/nested/icon.svg")).expect("copy"),
            "icon"
        );
        remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn refuses_destination_outside_open_document_folder() {
        let root = temp_dir();
        let document_folder = root.join("document");
        let outside = root.join("outside");
        create_dir_all(&document_folder).expect("document");
        create_dir_all(&outside).expect("outside");
        let result = poc_import_external_paths(ImportExternalPathsArgs {
            source_paths: Vec::new(),
            dest_dir: outside.to_string_lossy().into_owned(),
            ensure_dir: false,
            access: Some(document_access(&document_folder.join("note.md"))),
        });
        assert!(result.expect_err("must refuse").contains("outside"));
        remove_dir_all(root).expect("cleanup");
    }

    #[cfg(unix)]
    #[test]
    fn skips_symlinked_sources() {
        use std::os::unix::fs::symlink;
        let root = temp_dir();
        let target = root.join("target.txt");
        let link = root.join("link.txt");
        let destination = root.join("document");
        create_dir_all(&destination).expect("destination");
        write(&target, "target").expect("target");
        symlink(&target, &link).expect("link");
        let result = poc_import_external_paths(ImportExternalPathsArgs {
            source_paths: vec![link.to_string_lossy().into_owned()],
            dest_dir: destination.to_string_lossy().into_owned(),
            ensure_dir: false,
            access: Some(document_access(&destination.join("note.md"))),
        })
        .expect("import");
        assert!(matches!(
            result.results[0],
            ImportItemResult::Skipped {
                reason: "symlink",
                ..
            }
        ));
        remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn normalizes_authorized_root_components() {
        let root = temp_dir();
        let destination = root.join("document/nested");
        create_dir_all(&destination).expect("destination");
        let result = resolve_authorized_destination(
            &root.join("document/./nested/../nested").to_string_lossy(),
            Some(&document_access(&root.join("document/note.md"))),
            false,
        )
        .expect("authorized");
        assert_eq!(
            result,
            fs::canonicalize(destination).expect("real destination")
        );
        remove_dir_all(root).expect("cleanup");
    }
}
