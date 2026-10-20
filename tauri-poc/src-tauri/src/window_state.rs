//! Persisted main-window bounds for Windows parity with the Electron
//! main-window-state lifecycle: debounced saves on move or resize, a maximized
//! flag, off-screen rejection, and no saves once the window is closing.

// Mirror the Electron MIN_WIDTH and MIN_HEIGHT bounds exactly.
const MIN_WINDOW_WIDTH: i32 = 600;
const MIN_WINDOW_HEIGHT: i32 = 400;
// Mirror the Electron MIN_WIDTH / 2 and MIN_HEIGHT / 2 visible overlap.
const MIN_VISIBLE_WIDTH: i32 = 300;
const MIN_VISIBLE_HEIGHT: i32 = 200;
// Mirror the Electron 500ms bounds debounce during resize drags.
const SAVE_DEBOUNCE_MS: u64 = 500;
const STATE_FILE_NAME: &str = "window-state.json";

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewWindow};

/// Physical outer rectangle, the Electron main-window bounds shape.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowBounds {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

/// What the next launch restores. The pair stays atomic like Electron: a
/// maximized save keeps the previous bounds instead of clearing them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedWindowState {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bounds: Option<WindowBounds>,
    #[serde(default)]
    pub maximized: bool,
}

impl Default for PersistedWindowState {
    fn default() -> Self {
        Self {
            bounds: None,
            maximized: false,
        }
    }
}

/// Partial update for the live check command. Width and height apply together
/// and x and y apply together, so a half update cannot strand a torn rectangle.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowBoundsUpdate {
    #[serde(default)]
    pub x: Option<i32>,
    #[serde(default)]
    pub y: Option<i32>,
    #[serde(default)]
    pub width: Option<i32>,
    #[serde(default)]
    pub height: Option<i32>,
}

/// Live check answer: the outer rectangle plus the flags a relaunch restores.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowBoundsReport {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    pub maximized: bool,
    pub fullscreen: bool,
}

/// Monitor rectangle as physical x, y, width, height for the overlap test.
pub type MonitorRect = (i32, i32, i32, i32);

/// Debounced saver shared with the window-event bridge in main.
pub struct WindowStateSaver {
    path: PathBuf,
    generation: AtomicU64,
    closed: AtomicBool,
}

impl WindowStateSaver {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            generation: AtomicU64::new(0),
            closed: AtomicBool::new(false),
        }
    }

    pub fn mark_closed(&self) {
        self.closed.store(true, Ordering::SeqCst);
    }
}

/// Overlap of at least MIN_VISIBLE_WIDTH by MIN_VISIBLE_HEIGHT with any
/// monitor, mirroring Electron rectHasVisibleAreaOnAnyDisplay.
pub fn bounds_visible_on_any_monitor(rect: &WindowBounds, monitors: &[MonitorRect]) -> bool {
    monitors.iter().any(|monitor| {
        let overlap_x = (rect.x as i64 + rect.width as i64)
            .min(monitor.0 as i64 + monitor.2 as i64)
            - (rect.x as i64).max(monitor.0 as i64);
        let overlap_y = (rect.y as i64 + rect.height as i64)
            .min(monitor.1 as i64 + monitor.3 as i64)
            - (rect.y as i64).max(monitor.1 as i64);
        overlap_x >= MIN_VISIBLE_WIDTH as i64 && overlap_y >= MIN_VISIBLE_HEIGHT as i64
    })
}

/// Reject min-size or substantially off-screen bounds like Electron does at
/// window creation, so the titlebar stays reachable after display changes.
pub fn validate_saved_bounds(raw: &WindowBounds, monitors: &[MonitorRect]) -> Option<WindowBounds> {
    if raw.width <= MIN_WINDOW_WIDTH || raw.height <= MIN_WINDOW_HEIGHT {
        return None;
    }
    if bounds_visible_on_any_monitor(raw, monitors) {
        Some(*raw)
    } else {
        None
    }
}

pub fn state_file_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| path.join(STATE_FILE_NAME))
        .map_err(|error| format!("failed to resolve window state directory: {error}"))
}

pub fn load_window_state(path: &Path) -> PersistedWindowState {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

pub fn save_window_state(path: &Path, state: &PersistedWindowState) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("failed to create window state directory: {error}"))?;
    }
    let text = serde_json::to_string_pretty(state)
        .map_err(|error| format!("failed to serialize window state: {error}"))?;
    std::fs::write(path, text).map_err(|error| format!("failed to write window state: {error}"))
}

fn snapshot_live_state(
    saver: &WindowStateSaver,
    window: &WebviewWindow,
) -> Option<PersistedWindowState> {
    // Why: a fullscreen window has no restorable outer rectangle, and a
    // minimized one reports no meaningful position, so neither may clobber
    // the last good save the way teardown sizes must not.
    if window.is_fullscreen().unwrap_or(false) {
        return None;
    }
    if window.is_minimized().unwrap_or(false) {
        return None;
    }
    let maximized = window.is_maximized().unwrap_or(false);
    let previous = load_window_state(&saver.path);
    if maximized {
        return Some(PersistedWindowState {
            bounds: previous.bounds,
            maximized: true,
        });
    }
    let (Ok(position), Ok(size)) = (window.outer_position(), window.outer_size()) else {
        return None;
    };
    let width = size.width.min(i32::MAX as u32) as i32;
    let height = size.height.min(i32::MAX as u32) as i32;
    if width <= MIN_WINDOW_WIDTH || height <= MIN_WINDOW_HEIGHT {
        return Some(PersistedWindowState {
            bounds: previous.bounds,
            maximized: false,
        });
    }
    Some(PersistedWindowState {
        bounds: Some(WindowBounds {
            x: position.x,
            y: position.y,
            width,
            height,
        }),
        maximized: false,
    })
}

/// Debounced save entry for move and resize events. Only the latest event in
/// the debounce window writes, and nothing writes once closing starts.
pub fn note_window_moved_or_resized(
    saver: &Arc<WindowStateSaver>,
    window: &WebviewWindow,
    close_confirmed: bool,
) {
    if close_confirmed || saver.closed.load(Ordering::SeqCst) {
        return;
    }
    let generation = saver.generation.fetch_add(1, Ordering::SeqCst) + 1;
    let saver = Arc::clone(saver);
    let window = window.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(SAVE_DEBOUNCE_MS));
        if saver.generation.load(Ordering::SeqCst) != generation {
            return;
        }
        if saver.closed.load(Ordering::SeqCst) {
            return;
        }
        if let Some(next) = snapshot_live_state(&saver, &window) {
            let _ = save_window_state(&saver.path, &next);
        }
    });
}

pub fn current_monitor_rects(window: &WebviewWindow) -> Vec<MonitorRect> {
    match window.available_monitors() {
        Ok(monitors) if !monitors.is_empty() => monitors
            .iter()
            .map(|monitor| {
                let position = monitor.position();
                let size = monitor.size();
                (
                    position.x,
                    position.y,
                    size.width.min(i32::MAX as u32) as i32,
                    size.height.min(i32::MAX as u32) as i32,
                )
            })
            .collect(),
        _ => window
            .primary_monitor()
            .ok()
            .flatten()
            .map(|monitor| {
                let position = monitor.position();
                let size = monitor.size();
                vec![(
                    position.x,
                    position.y,
                    size.width.min(i32::MAX as u32) as i32,
                    size.height.min(i32::MAX as u32) as i32,
                )]
            })
            .unwrap_or_default(),
    }
}

fn center_on_primary(window: &WebviewWindow) {
    let Ok(size) = window.outer_size() else {
        return;
    };
    let Some(primary) = window.primary_monitor().ok().flatten() else {
        return;
    };
    let area = primary.size();
    let x = area.width.saturating_sub(size.width) / 2;
    let y = area.height.saturating_sub(size.height) / 2;
    let origin = primary.position();
    let _ = window.set_position(PhysicalPosition::new(
        origin.x + x.min(i32::MAX as u32) as i32,
        origin.y + y.min(i32::MAX as u32) as i32,
    ));
}

/// Apply the persisted state before the window first shows, mirroring the
/// Electron creation path: maximized wins, then validated bounds, then a
/// centered default when nothing usable was saved.
pub fn restore_main_window(window: &WebviewWindow) {
    let saved = state_file_path(&window.app_handle())
        .ok()
        .map(|path| load_window_state(&path))
        .unwrap_or_default();
    if saved.maximized {
        let _ = window.maximize();
        return;
    }
    let monitors = current_monitor_rects(window);
    let valid = saved
        .bounds
        .and_then(|raw| validate_saved_bounds(&raw, &monitors));
    match valid {
        Some(rect) => {
            let _ = window.set_size(PhysicalSize::new(rect.width as u32, rect.height as u32));
            let _ = window.set_position(PhysicalPosition::new(rect.x, rect.y));
        }
        None => center_on_primary(window),
    }
}

#[tauri::command]
pub fn poc_window_get_bounds(window: WebviewWindow) -> Result<WindowBoundsReport, String> {
    let position = window.outer_position().map_err(|error| error.to_string())?;
    let size = window.outer_size().map_err(|error| error.to_string())?;
    let maximized = window.is_maximized().map_err(|error| error.to_string())?;
    let fullscreen = window.is_fullscreen().map_err(|error| error.to_string())?;
    Ok(WindowBoundsReport {
        x: position.x,
        y: position.y,
        width: size.width.min(i32::MAX as u32) as i32,
        height: size.height.min(i32::MAX as u32) as i32,
        maximized,
        fullscreen,
    })
}

#[tauri::command]
pub fn poc_window_set_bounds(
    window: WebviewWindow,
    update: WindowBoundsUpdate,
) -> Result<(), String> {
    if let (Some(width), Some(height)) = (update.width, update.height) {
        if width <= 0 || height <= 0 {
            return Err("window size must stay positive".to_string());
        }
        window
            .set_size(PhysicalSize::new(width as u32, height as u32))
            .map_err(|error| error.to_string())?;
    }
    if let (Some(x), Some(y)) = (update.x, update.y) {
        window
            .set_position(PhysicalPosition::new(x, y))
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn two_monitors() -> Vec<MonitorRect> {
        vec![(0, 0, 1920, 1080), (1920, 0, 1280, 1024)]
    }

    #[test]
    fn saved_bounds_on_the_primary_display_restore() {
        let raw = WindowBounds {
            x: 100,
            y: 100,
            width: 1100,
            height: 750,
        };
        assert_eq!(validate_saved_bounds(&raw, &two_monitors()), Some(raw));
    }

    #[test]
    fn saved_bounds_on_the_secondary_display_restore() {
        let raw = WindowBounds {
            x: 2000,
            y: 100,
            width: 800,
            height: 600,
        };
        assert_eq!(validate_saved_bounds(&raw, &two_monitors()), Some(raw));
    }

    #[test]
    fn min_size_bounds_fall_back_to_default() {
        let raw = WindowBounds {
            x: 100,
            y: 100,
            width: 600,
            height: 400,
        };
        assert_eq!(validate_saved_bounds(&raw, &two_monitors()), None);
    }

    #[test]
    fn off_screen_bounds_fall_back_to_default() {
        let raw = WindowBounds {
            x: 99999,
            y: 99999,
            width: 1100,
            height: 750,
        };
        assert_eq!(validate_saved_bounds(&raw, &two_monitors()), None);
    }

    #[test]
    fn sliver_overlap_falls_back_to_default() {
        // Only 299 of the required 300 horizontal pixels stay visible.
        let raw = WindowBounds {
            x: -800,
            y: 100,
            width: 833,
            height: 600,
        };
        assert_eq!(bounds_visible_on_any_monitor(&raw, &two_monitors()), false);
        assert_eq!(validate_saved_bounds(&raw, &two_monitors()), None);
    }

    #[test]
    fn exact_threshold_overlap_restores() {
        // Exactly 300 by 200 pixels stay visible on the primary display.
        let raw = WindowBounds {
            x: -500,
            y: -400,
            width: 800,
            height: 600,
        };
        assert_eq!(bounds_visible_on_any_monitor(&raw, &two_monitors()), true);
        assert_eq!(validate_saved_bounds(&raw, &two_monitors()), Some(raw));
    }

    #[test]
    fn missing_state_file_restores_nothing() {
        let path = std::env::temp_dir().join("orca-tauri-poc-window-state-missing.json");
        let _ = std::fs::remove_file(&path);
        assert_eq!(load_window_state(&path), PersistedWindowState::default());
    }

    #[test]
    fn corrupt_state_file_restores_nothing() {
        let dir = std::env::temp_dir().join("orca-tauri-poc-window-state-corrupt");
        let path = dir.join("window-state.json");
        let _ = std::fs::create_dir_all(&dir);
        let _ = std::fs::write(&path, "{not json");
        assert_eq!(load_window_state(&path), PersistedWindowState::default());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn state_round_trips_through_the_file() {
        let dir = std::env::temp_dir().join("orca-tauri-poc-window-state-roundtrip");
        let path = dir.join("window-state.json");
        let next = PersistedWindowState {
            bounds: Some(WindowBounds {
                x: 100,
                y: 100,
                width: 1100,
                height: 750,
            }),
            maximized: true,
        };
        save_window_state(&path, &next).expect("state saves");
        assert_eq!(load_window_state(&path), next);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
