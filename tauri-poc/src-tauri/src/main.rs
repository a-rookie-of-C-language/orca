use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use tauri::menu::{ContextMenu, Menu, PredefinedMenuItem};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow, WindowEvent};

const MAX_SOUND_BYTES: u64 = 16 * 1024 * 1024;
const NOTIFICATION_SOUND_EXTENSIONS: [&str; 6] = ["ogg", "mp3", "wav", "m4a", "aac", "flac"];

/// Renderer-emitted events mirror the Electron IPC channel names so the shared
/// web preload can subscribe without a second, Tauri-only contract.
const EVENT_MAXIMIZE_CHANGED: &str = "window:maximize-changed";
const EVENT_FULLSCREEN_CHANGED: &str = "window:fullscreen-changed";
const EVENT_WINDOW_CLOSE_REQUESTED: &str = "window:close-requested";
const EVENT_TERMINAL_ZOOM: &str = "terminal:zoom";

struct NativeWindowState {
    close_confirmed: AtomicBool,
    close_request_sequence: AtomicU64,
    last_maximized: AtomicBool,
    last_fullscreen: AtomicBool,
}

impl Default for NativeWindowState {
    fn default() -> Self {
        Self {
            close_confirmed: AtomicBool::new(false),
            close_request_sequence: AtomicU64::new(0),
            last_maximized: AtomicBool::new(false),
            last_fullscreen: AtomicBool::new(false),
        }
    }
}

impl NativeWindowState {
    fn confirm_close(&self) {
        self.close_confirmed.store(true, Ordering::SeqCst);
    }
}

#[derive(Debug, Serialize)]
struct HostInfo {
    host: &'static str,
    transport: &'static str,
    runtime: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct FileDataUrl {
    data_url: String,
    file_name: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativePlatformInfo {
    platform: &'static str,
    os_release: String,
    arch: &'static str,
    shell: String,
    display_server: Option<&'static str>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeAppIdentity {
    name: String,
    is_dev: bool,
    dev_label: Option<String>,
    dev_branch: Option<String>,
    dev_worktree_name: Option<String>,
    dev_repo_root: Option<String>,
    dock_badge_label: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CloseRequestedPayload {
    is_quitting: bool,
    request_id: u64,
}

#[derive(Debug, Deserialize)]
struct NotificationSoundPathArgs {
    path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct NotificationSoundPathResult {
    ok: bool,
    path: Option<String>,
    reason: Option<&'static str>,
}

#[tauri::command]
fn poc_host_info() -> HostInfo {
    HostInfo {
        host: "tauri",
        transport: "rust-command",
        runtime: "Tauri 2",
    }
}

#[tauri::command]
fn poc_platform_info() -> NativePlatformInfo {
    NativePlatformInfo {
        platform: current_platform(),
        os_release: std::env::var("OS").unwrap_or_default(),
        arch: std::env::consts::ARCH,
        shell: std::env::var("ComSpec")
            .or_else(|_| std::env::var("SHELL"))
            .map(|value| value.trim().to_owned())
            .unwrap_or_default(),
        display_server: None,
    }
}

fn current_platform() -> &'static str {
    match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        platform => platform,
    }
}

#[tauri::command]
fn poc_app_identity() -> NativeAppIdentity {
    NativeAppIdentity {
        name: "Orca".to_string(),
        is_dev: cfg!(debug_assertions),
        dev_label: None,
        dev_branch: None,
        dev_worktree_name: None,
        dev_repo_root: None,
        dock_badge_label: None,
    }
}

#[tauri::command]
fn poc_path_exists(path: String) -> bool {
    Path::new(&path).exists()
}

#[tauri::command]
fn poc_paths_exist(paths: Vec<String>) -> Vec<bool> {
    paths.iter().map(|path| Path::new(path).exists()).collect()
}

#[tauri::command]
fn poc_copy_file(src_path: String, dest_path: String) -> Result<(), String> {
    let source = Path::new(&src_path);
    let destination = Path::new(&dest_path);
    if !source.is_absolute() || !destination.is_absolute() {
        return Err("Both source and destination must be absolute paths.".to_string());
    }
    if destination.exists() {
        return Err("Destination file already exists.".to_string());
    }
    fs::copy(src_path, dest_path)
        .map(|_| ())
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn poc_read_file_data_url(path: String) -> Result<FileDataUrl, String> {
    const MAX_ICON_BYTES: u64 = 256 * 1024;
    let source = Path::new(&path);
    if source
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| !extension.eq_ignore_ascii_case("png"))
        .unwrap_or(true)
    {
        return Err("Repository icons must be PNG files.".to_string());
    }
    let metadata = fs::metadata(source).map_err(|error| error.to_string())?;
    if !metadata.is_file() || metadata.len() > MAX_ICON_BYTES {
        return Err("Selected file is not a supported-size regular file.".to_string());
    }
    let bytes = fs::read(source).map_err(|error| error.to_string())?;
    let file_name = source
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .ok_or_else(|| "Selected file has no file name.".to_string())?;
    Ok(FileDataUrl {
        data_url: format!("data:image/png;base64,{}", BASE64.encode(bytes)),
        file_name,
    })
}

#[tauri::command]
fn poc_is_maximized(window: WebviewWindow) -> Result<bool, String> {
    window.is_maximized().map_err(|error| error.to_string())
}

#[tauri::command]
fn poc_minimize(window: WebviewWindow) -> Result<(), String> {
    window.minimize().map_err(|error| error.to_string())
}

#[tauri::command]
fn poc_toggle_maximize(window: WebviewWindow) -> Result<(), String> {
    let maximized = window.is_maximized().map_err(|error| error.to_string())?;
    if maximized {
        window.unmaximize()
    } else {
        window.maximize()
    }
    .map_err(|error| error.to_string())
}

#[tauri::command]
fn poc_is_fullscreen(window: WebviewWindow) -> Result<bool, String> {
    window.is_fullscreen().map_err(|error| error.to_string())
}

#[tauri::command]
fn poc_set_fullscreen(window: WebviewWindow, fullscreen: bool) -> Result<(), String> {
    window
        .set_fullscreen(fullscreen)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn poc_set_zoom(window: WebviewWindow, scale_factor: f64) -> Result<(), String> {
    if !scale_factor.is_finite() || !(0.1..=10.0).contains(&scale_factor) {
        return Err("Zoom scale factor is outside the supported range.".to_string());
    }
    window
        .set_zoom(scale_factor)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn poc_get_zoom(window: WebviewWindow) -> Result<f64, String> {
    window.scale_factor().map_err(|error| error.to_string())
}

/// Matches Electron's `ui:window-revealed`: repaint the webview without
/// activating the window, which keeps background validation off screen.
#[tauri::command]
fn poc_set_focus(window: WebviewWindow) {
    let _ = window.eval("window.dispatchEvent(new Event('resize'));");
}

#[tauri::command]
fn poc_request_close(window: WebviewWindow, state: State<Arc<NativeWindowState>>) {
    // Why: the renderer-drawn X never reaches the native close event, so the
    // handshake starts here exactly as Electron's `window:request-close` does.
    emit_close_request(&window, &state, false);
}

#[tauri::command]
fn poc_confirm_close(window: WebviewWindow, state: State<Arc<NativeWindowState>>) {
    state.inner().confirm_close();
    let _ = window.destroy();
}

fn emit_close_request(window: &WebviewWindow, state: &NativeWindowState, is_quitting: bool) {
    let request_id = state.close_request_sequence.fetch_add(1, Ordering::SeqCst) + 1;
    let _ = window.emit(
        EVENT_WINDOW_CLOSE_REQUESTED,
        CloseRequestedPayload {
            is_quitting,
            request_id,
        },
    );
}

#[tauri::command]
fn poc_popup_menu(window: WebviewWindow) -> Result<(), String> {
    let app = window.app_handle();
    let menu = Menu::with_items(
        app,
        &[
            &PredefinedMenuItem::undo(app, None).map_err(|error| error.to_string())?,
            &PredefinedMenuItem::redo(app, None).map_err(|error| error.to_string())?,
            &PredefinedMenuItem::separator(app).map_err(|error| error.to_string())?,
            &PredefinedMenuItem::cut(app, None).map_err(|error| error.to_string())?,
            &PredefinedMenuItem::copy(app, None).map_err(|error| error.to_string())?,
            &PredefinedMenuItem::paste(app, None).map_err(|error| error.to_string())?,
            &PredefinedMenuItem::select_all(app, None).map_err(|error| error.to_string())?,
            &PredefinedMenuItem::separator(app).map_err(|error| error.to_string())?,
            &PredefinedMenuItem::minimize(app, None).map_err(|error| error.to_string())?,
            &PredefinedMenuItem::maximize(app, None).map_err(|error| error.to_string())?,
            &PredefinedMenuItem::fullscreen(app, None).map_err(|error| error.to_string())?,
            &PredefinedMenuItem::separator(app).map_err(|error| error.to_string())?,
            &PredefinedMenuItem::close_window(app, None).map_err(|error| error.to_string())?,
        ],
    )
    .map_err(|error| error.to_string())?;
    menu.popup(window.as_ref().window())
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn poc_emit_zoom(window: WebviewWindow, direction: String) -> Result<(), String> {
    if !matches!(direction.as_str(), "in" | "out" | "reset") {
        return Err("Unsupported zoom direction.".to_string());
    }
    window
        .emit(EVENT_TERMINAL_ZOOM, direction)
        .map_err(|error| error.to_string())
}

/// Validates a renderer-supplied notification sound path before the web layer
/// hands it to an `<audio>` element, mirroring Electron's main-process checks.
#[tauri::command]
fn poc_notification_sound_path(args: NotificationSoundPathArgs) -> NotificationSoundPathResult {
    let path = PathBuf::from(&args.path);
    if !path.is_absolute() {
        return NotificationSoundPathResult {
            ok: false,
            path: None,
            reason: Some("invalid-path"),
        };
    }
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase());
    if !extension
        .as_deref()
        .is_some_and(|value| NOTIFICATION_SOUND_EXTENSIONS.contains(&value))
    {
        return NotificationSoundPathResult {
            ok: false,
            path: None,
            reason: Some("unsupported-type"),
        };
    }
    let metadata = match fs::metadata(&path) {
        Ok(metadata) => metadata,
        Err(_) => {
            return NotificationSoundPathResult {
                ok: false,
                path: None,
                reason: Some("missing-path"),
            }
        }
    };
    if !metadata.is_file() {
        return NotificationSoundPathResult {
            ok: false,
            path: None,
            reason: Some("invalid-path"),
        };
    }
    if metadata.len() > MAX_SOUND_BYTES {
        return NotificationSoundPathResult {
            ok: false,
            path: None,
            reason: Some("too-large"),
        };
    }
    NotificationSoundPathResult {
        ok: true,
        path: Some(args.path),
        reason: None,
    }
}

/// Mirrors `validateNativeFileDropPaths` in the shared renderer contract: a
/// bounded count and byte budget, no filesystem ownership widening.
#[tauri::command]
fn poc_validate_dropped_paths(paths: Vec<String>) -> Result<Vec<String>, String> {
    const MAX_PATHS: usize = 256;
    const MAX_PATH_BYTES: usize = 256 * 1024;
    if paths.len() > MAX_PATHS {
        return Err("too-many-paths".to_string());
    }
    let mut byte_length = 0usize;
    let mut seen = HashSet::with_capacity(paths.len());
    let mut accepted = Vec::with_capacity(paths.len());
    for path in paths {
        if path.is_empty() {
            continue;
        }
        let normalized = PathBuf::from(&path);
        if !normalized.is_absolute() {
            return Err("invalid-path".to_string());
        }
        byte_length += path.len();
        if byte_length > MAX_PATH_BYTES {
            return Err("paths-too-large".to_string());
        }
        let key = normalized.to_string_lossy().into_owned();
        if seen.insert(key) {
            accepted.push(path);
        }
    }
    Ok(accepted)
}

fn install_poc_badge(app: &AppHandle) -> tauri::Result<()> {
    let Some(window) = app.get_webview_window("main") else {
        return Ok(());
    };

    if std::env::var("ORCA_BACKGROUND_LAUNCH").as_deref() == Ok("1") {
        window.hide()?;
    }

    window.eval(
        r#"(() => {
          const install = async () => {
            const host = await window.__TAURI_INTERNALS__.invoke('poc_host_info');
            const badge = document.createElement('div');
            badge.setAttribute('data-orca-tauri-poc', 'connected');
            badge.textContent = `${host.host} host · ${host.transport}`;
            Object.assign(badge.style, {
              position: 'fixed',
              right: '12px',
              bottom: '12px',
              zIndex: '2147483647',
              padding: '6px 10px',
              border: '1px solid var(--border, #444)',
              borderRadius: '6px',
              background: 'var(--card, #222)',
              color: 'var(--muted-foreground, #aaa)',
              font: '12px/1.25 system-ui, sans-serif',
              pointerEvents: 'none'
            });
            document.body.appendChild(badge);
          };
          if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => void install(), { once: true });
          } else {
            void install();
          }
        })();"#,
    )?;

    Ok(())
}

fn install_window_state_bridge(window: &WebviewWindow, state: Arc<NativeWindowState>) {
    let window_handle = window.clone();
    window.on_window_event(move |event| match event {
        WindowEvent::CloseRequested { api, .. } => {
            if state.close_confirmed.swap(false, Ordering::SeqCst) {
                return;
            }
            // Why: Electron lets the renderer protect running terminals and
            // unsaved editors; Alt+F4 and OS close must go through the same gate.
            api.prevent_close();
            emit_close_request(&window_handle, &state, false);
        }
        WindowEvent::Resized(_) => {
            let Ok(maximized) = window_handle.is_maximized() else {
                return;
            };
            if state.last_maximized.swap(maximized, Ordering::SeqCst) != maximized {
                let _ = window_handle.emit(EVENT_MAXIMIZE_CHANGED, maximized);
            }
            let Ok(fullscreen) = window_handle.is_fullscreen() else {
                return;
            };
            if state.last_fullscreen.swap(fullscreen, Ordering::SeqCst) != fullscreen {
                let _ = window_handle.emit(EVENT_FULLSCREEN_CHANGED, fullscreen);
            }
        }
        _ => {}
    });
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_opener::Builder::new()
                .open_js_links_on_click(false)
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            poc_host_info,
            poc_path_exists,
            poc_paths_exist,
            poc_copy_file,
            poc_read_file_data_url,
            poc_platform_info,
            poc_app_identity,
            poc_is_maximized,
            poc_minimize,
            poc_toggle_maximize,
            poc_is_fullscreen,
            poc_set_fullscreen,
            poc_set_zoom,
            poc_get_zoom,
            poc_set_focus,
            poc_request_close,
            poc_confirm_close,
            poc_popup_menu,
            poc_emit_zoom,
            poc_notification_sound_path,
            poc_validate_dropped_paths
        ])
        .setup(|app| {
            let window = app
                .get_webview_window("main")
                .ok_or_else(|| tauri::Error::AssetNotFound("main window".to_string()))?;
            let state = Arc::new(NativeWindowState::default());
            app.manage(Arc::clone(&state));
            install_window_state_bridge(&window, state);
            install_poc_badge(app.handle())?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Orca Tauri PoC");
}

#[cfg(test)]
mod tests {
    use super::poc_host_info;

    #[test]
    fn host_info_identifies_the_tauri_transport() {
        let info = poc_host_info();

        assert_eq!(info.host, "tauri");
        assert_eq!(info.transport, "rust-command");
        assert_eq!(info.runtime, "Tauri 2");
    }
}
