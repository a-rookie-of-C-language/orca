//! Feature-wall asset base URL, mirroring Electron main.
//!
//! The tour surface resolves its tile art against this base: Electron dev
//! serves the repo assets through Vite's `/@fs` route (Chromium blocks
//! `file://` image loads from the http dev origin) and packaged builds use
//! a `file://` URL into the resources bundle. This command answers the same
//! two shapes so the shared `toFeatureWallAssetUrl` resolver keeps working.

use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

/// Vite dev origin the Tauri renderer is served from. Strict-port dev keeps
/// this pinned in `tauri.conf.json`; the config value wins when it parses.
const DEV_ORIGIN_FALLBACK: &str = "http://127.0.0.1:5174";

/// Repo-relative home of the tour art, shared with Electron's dev lookup.
fn dev_asset_dir(repo_root: &str) -> PathBuf {
    PathBuf::from(repo_root)
        .join("resources")
        .join("onboarding")
        .join("feature-wall")
}

/// Read the dev-server origin out of the bundled Tauri config so a future
/// port or host change does not strand the `/@fs` route on a stale default.
fn dev_origin_from_config() -> Option<String> {
    let config: serde_json::Value =
        serde_json::from_str(include_str!("../tauri.conf.json")).ok()?;
    let dev_url = config.get("build")?.get("devUrl")?.as_str()?;
    let url = url::Url::parse(dev_url).ok()?;
    Some(url.origin().ascii_serialization())
}

/// `http://host:port/@fs/<abs-dir>/`, the same Vite route Electron dev uses.
/// Forward slashes only: backslashes never form a valid `/@fs` request path.
fn dev_asset_base_url(origin: &str, dir: &Path) -> String {
    let absolute = dir.to_string_lossy().replace('\\', "/");
    let trimmed = absolute.trim_start_matches('/');
    format!("{}/@fs/{}/", origin.trim_end_matches('/'), trimmed)
}

/// `file://` URL into the staged bundle copy, like Electron packaged.
fn file_asset_base_url(dir: &Path) -> Option<String> {
    url::Url::from_directory_path(dir)
        .ok()
        .map(|url| url.to_string())
}

/// Locate the tour art the way Electron main does: dev reads the repo copy
/// through Vite, packaged reads the staged resources bundle. Nothing staged
/// and no repo root means the historical `/` fallback instead of a dangling
/// URL the renderer would resolve against the app origin.
fn asset_base_url(app: &AppHandle) -> String {
    if let Ok(repo_root) = std::env::var("ORCA_DEV_REPO_ROOT") {
        let dir = dev_asset_dir(&repo_root);
        if dir.is_dir() {
            let origin =
                dev_origin_from_config().unwrap_or_else(|| DEV_ORIGIN_FALLBACK.to_string());
            return dev_asset_base_url(&origin, &dir);
        }
    }
    if let Ok(resource_dir) = app.path().resource_dir() {
        let dir = resource_dir.join("onboarding").join("feature-wall");
        if dir.is_dir() {
            if let Some(url) = file_asset_base_url(&dir) {
                return url;
            }
        }
    }
    "/".to_string()
}

/// Feature-wall asset base URL with Electron's dev/packaged shapes.
#[tauri::command]
pub(crate) fn poc_get_feature_wall_asset_base_url(app: AppHandle) -> String {
    asset_base_url(&app)
}

#[cfg(test)]
mod tests {
    use super::{dev_asset_base_url, dev_asset_dir, dev_origin_from_config, file_asset_base_url};
    use std::path::PathBuf;

    #[test]
    fn dev_dir_lives_under_the_repo_resources() {
        assert_eq!(
            dev_asset_dir("C:\\repo"),
            PathBuf::from("C:\\repo\\resources\\onboarding\\feature-wall")
        );
    }

    #[test]
    fn dev_url_uses_the_vite_fs_route() {
        let base = dev_asset_base_url(
            "http://127.0.0.1:5174",
            &PathBuf::from("C:\\repo\\resources\\onboarding\\feature-wall"),
        );
        assert_eq!(
            base,
            "http://127.0.0.1:5174/@fs/C:/repo/resources/onboarding/feature-wall/"
        );
    }

    #[test]
    fn config_origin_tracks_the_pinned_dev_server() {
        let origin = dev_origin_from_config().expect("tauri.conf.json pins a devUrl");
        assert!(
            origin.starts_with("http://127.0.0.1:"),
            "unexpected origin: {origin}"
        );
    }

    #[test]
    fn file_url_names_a_directory() {
        let url = file_asset_base_url(&PathBuf::from("C:\\bundle\\feature-wall"))
            .expect("directory file URL");
        assert!(url.starts_with("file:///"), "unexpected URL: {url}");
        assert!(
            url.ends_with('/'),
            "directory URL keeps its trailing slash: {url}"
        );
    }
}
