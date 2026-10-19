use serde::Deserialize;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiVaultDeletePlan {
    pub allowed: bool,
    pub agent: String,
    pub resolved_path: String,
    pub removals: Vec<AiVaultDeleteRemoval>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiVaultDeleteRemoval {
    pub path: String,
    pub kind: String,
    pub roots: Vec<String>,
}

#[tauri::command]
pub fn poc_trash_ai_vault_session(plan: AiVaultDeletePlan) -> Result<(), String> {
    validate_plan(&plan)?;
    for removal in &plan.removals {
        trash_one(removal)?;
    }
    Ok(())
}

fn validate_plan(plan: &AiVaultDeletePlan) -> Result<(), String> {
    if !plan.allowed {
        return Err("The session delete plan is not approved.".to_string());
    }
    if plan.agent.trim().is_empty() || plan.resolved_path.trim().is_empty() {
        return Err("The session delete plan is incomplete.".to_string());
    }
    if plan.removals.is_empty() {
        return Err("The session delete plan contains no paths.".to_string());
    }
    if !plan
        .removals
        .iter()
        .any(|removal| removal.path == plan.resolved_path)
    {
        return Err("The session delete plan does not contain its transcript path.".to_string());
    }
    for removal in &plan.removals {
        if !matches!(removal.kind.as_str(), "file" | "directory") {
            return Err("The session delete plan contains an invalid target kind.".to_string());
        }
        let target = absolute_path(&removal.path)?;
        if removal.roots.is_empty() {
            return Err("The session delete plan contains no approved roots.".to_string());
        }
        let roots = removal
            .roots
            .iter()
            .map(|root| absolute_path(root))
            .collect::<Result<Vec<_>, _>>()?;
        if target.exists() {
            let metadata = fs::symlink_metadata(&target).map_err(format_io_error)?;
            if metadata.file_type().is_symlink() {
                return Err("Refusing to trash a symbolic link.".to_string());
            }
            let kind_matches = (removal.kind == "file" && metadata.is_file())
                || (removal.kind == "directory" && metadata.is_dir());
            if !kind_matches {
                return Err("The session delete target kind changed on disk.".to_string());
            }
            let real_target = fs::canonicalize(&target).map_err(format_io_error)?;
            if !roots.iter().any(|root| path_inside(root, &real_target)) {
                return Err("Refusing to trash a path outside approved roots.".to_string());
            }
        }
    }
    Ok(())
}

fn trash_one(removal: &AiVaultDeleteRemoval) -> Result<(), String> {
    let target = absolute_path(&removal.path)?;
    match fs::symlink_metadata(&target) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() {
                return Err("Refusing to trash a symbolic link.".to_string());
            }
            let kind_matches = (removal.kind == "file" && metadata.is_file())
                || (removal.kind == "directory" && metadata.is_dir());
            if !kind_matches {
                return Err("The session delete target kind changed on disk.".to_string());
            }
            trash::delete(&target).map_err(format_io_error)
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format_io_error(error)),
    }
}

fn absolute_path(value: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(value);
    if !path.is_absolute() {
        return Err("Session delete paths must be absolute.".to_string());
    }
    Ok(path)
}

fn path_inside(root: &Path, target: &Path) -> bool {
    if cfg!(windows) {
        let root = root
            .to_string_lossy()
            .replace('/', "\\")
            .to_ascii_lowercase();
        let target = target
            .to_string_lossy()
            .replace('/', "\\")
            .to_ascii_lowercase();
        target == root
            || target
                .strip_prefix(&root)
                .is_some_and(|suffix| suffix.starts_with('\\'))
    } else {
        target.starts_with(root)
    }
}

fn format_io_error(error: impl std::fmt::Display) -> String {
    error.to_string()
}
