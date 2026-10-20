//! Desktop away/idle state, mirroring Electron's `notifications:getDesktopAwayState`.
//!
//! Electron reads `powerMonitor.getSystemIdleState(DESKTOP_AWAY_SECONDS)` and
//! `getSystemIdleTime()` and returns true for `locked`/`idle`, false for
//! `active`, or undefined when the probe cannot answer. The Tauri shell asks
//! Win32 directly: lock via the input desktop, idle via `GetLastInputInfo`.

use serde::Serialize;

/// Idle seconds after which the desktop counts as away; shared with the
/// renderer's presence evidence and Electron's threshold.
const DESKTOP_AWAY_SECONDS: u32 = 180;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopAwayState {
    /// `Some(true)` locked/idle, `Some(false)` active, `None` when the probe
    /// could not answer — matching Electron's `undefined` (never silence).
    pub away: Option<bool>,
}

#[cfg(windows)]
fn probe_away() -> DesktopAwayState {
    use windows_sys::Win32::System::StationsAndDesktops::{
        CloseDesktop, OpenInputDesktop, DESKTOP_READOBJECTS,
    };
    use windows_sys::Win32::System::SystemInformation::GetTickCount;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};

    // A locked session has no openable input desktop; treat a failed open as
    // locked like Electron's 'locked' state. Always close the handle we get.
    let desktop = unsafe { OpenInputDesktop(0, 0, DESKTOP_READOBJECTS) };
    if desktop.is_null() {
        return DesktopAwayState { away: Some(true) };
    }
    unsafe { CloseDesktop(desktop) };

    let mut info = LASTINPUTINFO {
        cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
        dwTime: 0,
    };
    if unsafe { GetLastInputInfo(&mut info) } == 0 {
        return DesktopAwayState { away: None };
    }
    // GetTickCount wraps at ~49.7 days and dwTime is the same tick domain, so
    // subtract rather than compare absolute values.
    let idle_ms = unsafe { GetTickCount() }.wrapping_sub(info.dwTime);
    let idle_seconds = idle_ms / 1000;
    DesktopAwayState {
        away: Some(idle_seconds >= DESKTOP_AWAY_SECONDS),
    }
}

#[cfg(not(windows))]
fn probe_away() -> DesktopAwayState {
    DesktopAwayState { away: None }
}

#[tauri::command]
pub(crate) fn poc_desktop_away_state() -> DesktopAwayState {
    probe_away()
}

#[cfg(test)]
mod tests {
    use super::poc_desktop_away_state;

    #[test]
    fn returns_a_state() {
        // On a live Windows desktop this is Some(false) (active) or Some(true)
        // (locked); off Windows it is always None. The contract is that the
        // call never panics and produces a JSON-serializable result.
        let state = poc_desktop_away_state();
        let json = serde_json::to_string(&state).unwrap();
        assert!(json.contains("away"));
    }
}
