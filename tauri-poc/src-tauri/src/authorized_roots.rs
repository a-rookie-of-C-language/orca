//! Host-configured local roots the native boundary trusts.
//!
//! The paired runtime owns workspace authorization; these roots cover what the
//! Rust shell must decide alone: the dev checkout and explicitly allowed
//! directories. Callers canonicalize the target first so `..` segments and
//! symlinks cannot escape containment.
use std::path::{Path, PathBuf};

pub(crate) fn canonicalize_existing(path: &Path) -> Result<PathBuf, String> {
    std::fs::canonicalize(path).map_err(|error| error.to_string())
}

pub(crate) fn configured_authorized_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Ok(repo_root) = std::env::var("ORCA_DEV_REPO_ROOT") {
        if let Ok(root) = canonicalize_existing(Path::new(&repo_root)) {
            roots.push(root);
        }
    }
    if let Ok(configured) = std::env::var("ORCA_TAURI_ALLOWED_ROOTS") {
        for root in configured.split(if cfg!(windows) { ';' } else { ':' }) {
            if let Ok(root) = canonicalize_existing(Path::new(root)) {
                if !roots.contains(&root) {
                    roots.push(root);
                }
            }
        }
    }
    roots
}

/// Component-wise containment of an already-canonical path in any root, so
/// `/a-b` never counts as under `/a`.
pub(crate) fn is_under_roots(canonical: &Path, roots: &[PathBuf]) -> bool {
    roots.iter().any(|root| canonical.starts_with(root))
}
