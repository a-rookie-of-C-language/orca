// Host-side keep-awake blocker: orcad computes the {mode, active} verdict and
// the renderer forwards it here; the OS assertion lives in this process the
// way Electron's `powerSaveBlocker` lives in the desktop main process.

use serde::Serialize;
use std::process::Child;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

pub const EVENT_AGENT_AWAKE_CHANGED: &str = "agentAwake:changed";

pub struct AgentAwakeState {
    active: AtomicBool,
    mode: Mutex<String>,
    helper: Mutex<Option<Child>>,
}

impl Default for AgentAwakeState {
    fn default() -> Self {
        Self {
            active: AtomicBool::new(false),
            mode: Mutex::new("off".to_string()),
            helper: Mutex::new(None),
        }
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AgentAwakeStatusPayload {
    pub mode: String,
    pub active: bool,
}

/// Applies or releases the OS sleep assertion. Windows uses
/// `SetThreadExecutionState` like Electron's `prevent-display-sleep` blocker;
/// macOS holds `caffeinate -dimsu` and Linux holds `systemd-inhibit --what=sleep:idle`,
/// matching the assertions `AgentAwakeService` builds through its platform helpers.
fn set_os_blocker(active: bool, helper: &Mutex<Option<Child>>) {
    #[cfg(windows)]
    {
        use windows_sys::Win32::System::Power::{
            SetThreadExecutionState, ES_CONTINUOUS, ES_DISPLAY_REQUIRED, ES_SYSTEM_REQUIRED,
        };
        unsafe {
            if active {
                SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED);
            } else {
                SetThreadExecutionState(ES_CONTINUOUS);
            }
        }
        let _ = helper;
    }
    #[cfg(target_os = "macos")]
    {
        sync_helper_child(helper, active, "caffeinate", &["-dimsu"]);
    }
    #[cfg(target_os = "linux")]
    {
        sync_helper_child(
            helper,
            active,
            "systemd-inhibit",
            &[
                "--what=sleep:idle",
                "--who=Orca",
                "--why=Orca is keeping the computer awake while agents run",
                "--mode=block",
                "sleep",
                "infinity",
            ],
        );
    }
    #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
    {
        let _ = (active, helper);
    }
}

/// Holds or releases a long-lived inhibit child. The process is the assertion:
/// killing it drops the lock the same way Electron's assertion stop does.
#[cfg(any(target_os = "macos", target_os = "linux"))]
fn sync_helper_child(helper: &Mutex<Option<Child>>, active: bool, program: &str, args: &[&str]) {
    let mut guard = match helper.lock() {
        Ok(guard) => guard,
        Err(_) => return,
    };
    if active {
        if guard.is_some() {
            return;
        }
        use std::process::{Command, Stdio};
        match Command::new(program)
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
        {
            Ok(child) => *guard = Some(child),
            Err(error) => eprintln!("[agent-awake] could not start {program}: {error}"),
        }
    } else if let Some(mut child) = guard.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
}

#[tauri::command]
pub fn poc_agent_awake_set_active(
    app: AppHandle,
    state: State<'_, AgentAwakeState>,
    mode: Option<String>,
    active: bool,
) -> AgentAwakeStatusPayload {
    let mode = mode.unwrap_or_else(|| "off".to_string());
    if let Ok(mut stored) = state.mode.lock() {
        *stored = mode.clone();
    }
    let was_active = state.active.swap(active, Ordering::SeqCst);
    if was_active != active {
        set_os_blocker(active, &state.helper);
    }
    let status = AgentAwakeStatusPayload { mode, active };
    let _ = app.emit(EVENT_AGENT_AWAKE_CHANGED, status.clone());
    status
}

#[tauri::command]
pub fn poc_agent_awake_status(state: State<'_, AgentAwakeState>) -> AgentAwakeStatusPayload {
    AgentAwakeStatusPayload {
        mode: state
            .mode
            .lock()
            .map(|mode| mode.clone())
            .unwrap_or_else(|_| "off".to_string()),
        active: state.active.load(Ordering::SeqCst),
    }
}

/// Called from `main` cleanup so a quitting Tauri never strands an inhibit
/// helper child.
pub fn release_agent_awake_blocker(app: &AppHandle) {
    if let Some(state) = app.try_state::<AgentAwakeState>() {
        set_os_blocker(false, &state.helper);
        state.active.store(false, Ordering::SeqCst);
    }
}
