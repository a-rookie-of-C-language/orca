//! Authenticated directory listing for Warp theme scanning.
//!
//! Electron main readdir()s the Warp theme folders directly. The Tauri shell
//! keeps the same read surface but only inside the authorized roots, matching
//! poc_stage_external_paths' containment so a crafted invoke cannot enumerate
//! arbitrary host directories.

use crate::authorized_roots::{canonicalize_existing, configured_authorized_roots, is_under_roots};
use serde::Serialize;
use std::path::PathBuf;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListedDirectoryEntry {
    pub name: String,
    pub is_directory: bool,
    pub is_file: bool,
    pub is_symlink: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryListResult {
    pub entries: Vec<ListedDirectoryEntry>,
}

#[tauri::command]
pub(crate) fn poc_list_directory(path: String) -> Result<DirectoryListResult, String> {
    let canonical = canonicalize_existing(std::path::Path::new(&path))
        .map_err(|error| format!("Could not resolve directory: {error}"))?;
    let roots = configured_authorized_roots();
    if !is_under_roots(&canonical, &roots) {
        return Err("Directory is outside the authorized roots.".to_string());
    }
    let read_dir = std::fs::read_dir(&canonical).map_err(|error| error.to_string())?;
    let mut entries = Vec::new();
    for entry in read_dir {
        let entry = entry.map_err(|error| error.to_string())?;
        let file_type = entry.file_type().map_err(|error| error.to_string())?;
        entries.push(ListedDirectoryEntry {
            name: entry.file_name().to_string_lossy().into_owned(),
            is_directory: file_type.is_dir(),
            is_file: file_type.is_file(),
            is_symlink: file_type.is_symlink(),
        });
    }
    Ok(DirectoryListResult { entries })
}

#[cfg(test)]
mod tests {
    use super::poc_list_directory;

    #[test]
    fn rejects_paths_outside_authorized_roots() {
        // No ORCA_DEV_REPO_ROOT / ORCA_TAURI_ALLOWED_ROOTS in the test env, so
        // every absolute path is out of bounds — mirrors Electron refusing
        // reads it never authorized.
        let result = poc_list_directory("C:\\Windows\\System32".to_string());
        assert!(result.is_err());
    }
}
