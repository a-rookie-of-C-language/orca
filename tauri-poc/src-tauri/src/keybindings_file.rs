//! User keybindings file IO for the Tauri shell.
//!
//! Electron main reads and writes `~/.orca/keybindings.json` directly via
//! node:fs. The renderer cannot touch that file — it is outside the
//! authorized roots — so these commands expose a narrow surface: read the
//! raw text (or "missing"), write the assembled JSON document atomically
//! (temp file + rename, like `writeJsonDocument`), and reveal it in the OS
//! file manager. Parsing stays on the renderer in `keybinding-document.ts`
//! so both hosts share one implementation.

use serde::Serialize;
use std::path::PathBuf;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeybindingsFileRead {
    pub path: String,
    /// None when the file does not exist (Electron's `exists: false`).
    pub text: Option<String>,
}

fn user_keybindings_path() -> Result<PathBuf, String> {
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .ok_or_else(|| "Could not resolve the user home directory.".to_string())?;
    Ok(PathBuf::from(home).join(".orca").join("keybindings.json"))
}

#[tauri::command]
pub(crate) fn poc_read_keybindings_file() -> Result<KeybindingsFileRead, String> {
    let path = user_keybindings_path()?;
    match std::fs::read_to_string(&path) {
        Ok(text) => Ok(KeybindingsFileRead {
            path: path.to_string_lossy().into_owned(),
            text: Some(text),
        }),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(KeybindingsFileRead {
            path: path.to_string_lossy().into_owned(),
            text: None,
        }),
        Err(error) => Err(error.to_string()),
    }
}

/// Atomic write matching Electron's `writeJsonDocument`: write to a sibling
/// temp file, then rename over the target so a crash never leaves a
/// half-written user config. `text` is the fully-assembled JSON document.
#[tauri::command]
pub(crate) fn poc_write_keybindings_file(text: String) -> Result<KeybindingsFileRead, String> {
    let path = user_keybindings_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let temp_path = path.with_extension("json.tmp");
    let write_result =
        std::fs::write(&temp_path, &text).and_then(|_| std::fs::rename(&temp_path, &path));
    if let Err(error) = write_result {
        let _ = std::fs::remove_file(&temp_path);
        return Err(error.to_string());
    }
    Ok(KeybindingsFileRead {
        path: path.to_string_lossy().into_owned(),
        text: Some(text),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_keybindings_under_home() {
        std::env::set_var("USERPROFILE", "C:\\Users\\tester");
        let path = user_keybindings_path().expect("home resolves");
        assert!(path.ends_with(".orca\\keybindings.json"));
    }
}
