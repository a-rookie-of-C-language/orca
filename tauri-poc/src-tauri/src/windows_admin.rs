//! Windows administrator (elevation) status, mirroring Electron main.
//!
//! Electron probes the bundled `orca.exe --orca-administrator-status`
//! launcher with a 3s timeout and reports its trimmed stdout with a
//! true/false/null vocabulary. This command runs the same binary with the
//! same budget and vocabulary so the renderer cannot tell the shells apart.

use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::{LazyLock, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Manager};

/// Same 3s probe budget Electron main allows the launcher.
const PROBE_TIMEOUT: Duration = Duration::from_secs(3);
/// Same 64-byte output cap Electron main passes to the launcher spawn.
const PROBE_MAX_OUTPUT_BYTES: usize = 64;

/// Parse the launcher stdout: exactly `true`/`false` after trimming.
/// Anything else is null, exactly like Electron's launcher-missing,
/// non-zero-exit, and unparseable branches.
fn parse_administrator_status(output: &str) -> Option<bool> {
    match output.trim() {
        "true" => Some(true),
        "false" => Some(false),
        _ => None,
    }
}

/// Dev path of the probe launcher under a repo root: the same
/// `native/windows-cli-launcher/.build/orca.exe` Electron dev resolves.
fn dev_launcher_path(repo_root: &str) -> PathBuf {
    PathBuf::from(repo_root)
        .join("native")
        .join("windows-cli-launcher")
        .join(".build")
        .join("orca.exe")
}

/// Locate the probe launcher the way Electron main does: dev reads the
/// freshly built `.build` output, packaged reads `orcad/bin/orca.exe` from the
/// resources bundle (the `orcad` resource mapping stages the whole slot there).
/// A missing file means null instead of a spawn error.

/// Packaged path of the probe launcher inside the resources bundle.
fn packaged_launcher_path(resource_dir: &Path) -> PathBuf {
    resource_dir.join("orcad").join("bin").join("orca.exe")
}
fn launcher_path(app: &AppHandle) -> Option<PathBuf> {
    if std::env::consts::OS != "windows" {
        return None;
    }
    if let Ok(repo_root) = std::env::var("ORCA_DEV_REPO_ROOT") {
        let dev = dev_launcher_path(&repo_root);
        if dev.is_file() {
            return Some(dev);
        }
    }
    let packaged = app
        .path()
        .resource_dir()
        .map(|dir| packaged_launcher_path(&dir))
        .ok()?;
    if packaged.is_file() {
        return Some(packaged);
    }
    None
}

#[cfg(windows)]
fn launcher_command(launcher: &PathBuf) -> std::process::Command {
    use std::os::windows::process::CommandExt;
    // Why: a GUI-shell spawn must not flash a console window the way a plain
    // CreateProcess would; Electron's process-host pins the same flag.
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let mut command = std::process::Command::new(launcher);
    command
        .arg("--orca-administrator-status")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .creation_flags(CREATE_NO_WINDOW);
    command
}

/// Run a probe command with a hard timeout. A wedged child resolves to
/// `None` instead of stalling the command; the launcher answers in
/// milliseconds, so a timeout always means the probe itself is stuck.
fn run_command_capped(
    mut command: std::process::Command,
    timeout: Duration,
) -> Option<std::process::Output> {
    let (done_tx, done_rx) = mpsc::channel();
    std::thread::spawn(move || {
        let output = command.output().ok();
        let _ = done_tx.send(output);
    });
    done_rx.recv_timeout(timeout).ok().flatten()
}

#[cfg(windows)]
fn run_probe(launcher: &PathBuf) -> Option<bool> {
    let output = run_command_capped(launcher_command(launcher), PROBE_TIMEOUT)?;
    if !output.status.success() {
        return None;
    }
    // Why the cap: Electron bounds the launcher read to 64 bytes, so parse
    // the same prefix instead of a longer dump the desktop never sees.
    let capped = output.stdout.len().min(PROBE_MAX_OUTPUT_BYTES);
    parse_administrator_status(&String::from_utf8_lossy(&output.stdout[..capped]))
}

#[cfg(not(windows))]
fn run_probe(_launcher: &PathBuf) -> Option<bool> {
    None
}

fn cached_answer() -> &'static Mutex<Option<Option<bool>>> {
    static CACHE: LazyLock<Mutex<Option<Option<bool>>>> = LazyLock::new(|| Mutex::new(None));
    &CACHE
}

/// The desktop token never changes while the app runs, so the first probe
/// answers for the process lifetime, exactly like Electron's cached status.
fn cached_status(app: &AppHandle) -> Option<bool> {
    let mut guard = cached_answer().lock().ok()?;
    if let Some(answer) = *guard {
        return answer;
    }
    let answer = launcher_path(app).and_then(|launcher| run_probe(&launcher));
    *guard = Some(answer);
    answer
}

/// Windows administrator status with Electron's true/false/null vocabulary:
/// the bundled launcher's answer when it runs, null when the probe is
/// unavailable, fails, or times out.
#[tauri::command]
pub(crate) fn poc_get_windows_administrator_status(app: AppHandle) -> Option<bool> {
    cached_status(&app)
}

#[cfg(test)]
mod tests {
    use super::{
        dev_launcher_path, packaged_launcher_path, parse_administrator_status, run_command_capped,
    };
    use std::time::Duration;

    #[test]
    fn parses_the_launcher_vocabulary() {
        assert_eq!(parse_administrator_status("true"), Some(true));
        assert_eq!(parse_administrator_status("false"), Some(false));
        assert_eq!(parse_administrator_status("true\n"), Some(true));
        assert_eq!(parse_administrator_status("  false  "), Some(false));
        assert_eq!(parse_administrator_status(""), None);
        assert_eq!(parse_administrator_status("yes"), None);
        assert_eq!(parse_administrator_status("true false"), None);
    }

    #[cfg(windows)]
    #[test]
    fn dev_launcher_lives_under_the_repo_root() {
        let launcher = dev_launcher_path("C:\\repo");
        assert_eq!(
            launcher,
            std::path::PathBuf::from("C:\\repo\\native\\windows-cli-launcher\\.build\\orca.exe")
        );
    }

    #[cfg(windows)]
    #[test]
    fn packaged_launcher_lives_under_the_orcad_resource() {
        let dir = std::path::Path::new("C:\\bundle\\resources");
        assert_eq!(
            packaged_launcher_path(dir),
            std::path::PathBuf::from("C:\\bundle\\resources\\orcad\\bin\\orca.exe")
        );
    }

    #[cfg(windows)]
    #[test]
    fn capped_run_reports_a_fast_probe() {
        let mut command = std::process::Command::new("cmd.exe");
        command.args(["/C", "echo true"]);
        let output = run_command_capped(command, Duration::from_secs(5)).expect("probe runs");
        assert!(output.status.success());
        assert_eq!(
            parse_administrator_status(&String::from_utf8_lossy(&output.stdout)),
            Some(true)
        );
    }

    #[cfg(windows)]
    #[test]
    fn capped_run_times_out_a_wedged_probe() {
        // `ping -n 3` stalls ~2s; the 200ms budget must win the race.
        let mut command = std::process::Command::new("cmd.exe");
        command.args(["/C", "ping -n 3 127.0.0.1 >NUL"]);
        assert!(run_command_capped(command, Duration::from_millis(200)).is_none());
    }
}
