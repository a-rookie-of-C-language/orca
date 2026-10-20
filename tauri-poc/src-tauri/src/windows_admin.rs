//! Windows administrator (elevation) status, mirroring Electron main.
//!
//! Electron probes the bundled `orca.exe --orca-administrator-status`
//! launcher with a 3s timeout and reports its trimmed stdout with a
//! true/false/null vocabulary. This command runs the same binary with the
//! same budget and vocabulary so the renderer cannot tell the shells apart.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Manager, State};

use crate::runtime_process::OrcadRuntime;

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

// Marker the elevated instance receives so it can restart local terminals
// under the new token; consumed on startup like Electron consumes it.
pub(crate) const RESTART_LOCAL_TERMINALS_ARG: &str =
    "--orca-restart-local-terminals-as-administrator";
const RESTART_REQUEST_ARG: &str = "--orca-restart-as-administrator";
const RESTART_HELPER_FILENAME: &str = "orca-administrator-restart.exe";
/// Dev path of the elevation helper under a repo root: the same `.build`
/// output `build-windows-cli-launcher.mjs` produces next to `orca.exe`.
fn dev_restart_helper_path(repo_root: &str) -> PathBuf {
    PathBuf::from(repo_root)
        .join("native")
        .join("windows-cli-launcher")
        .join(".build")
        .join(RESTART_HELPER_FILENAME)
}
/// Packaged path of the elevation helper: staged beside `orca.exe` by
/// `prepare-release-runtime.mjs`, the Tauri equivalent of Electron's
/// `bin/orca-administrator-restart.exe` extra resource.
fn packaged_restart_helper_path(resource_dir: &Path) -> PathBuf {
    resource_dir
        .join("orcad")
        .join("bin")
        .join(RESTART_HELPER_FILENAME)
}
fn restart_helper_path(app: &AppHandle) -> Option<PathBuf> {
    if std::env::consts::OS != "windows" {
        return None;
    }
    if let Ok(repo_root) = std::env::var("ORCA_DEV_REPO_ROOT") {
        let dev = dev_restart_helper_path(&repo_root);
        if dev.is_file() {
            return Some(dev);
        }
    }
    let packaged = app
        .path()
        .resource_dir()
        .map(|dir| packaged_restart_helper_path(&dir))
        .ok()?;
    if packaged.is_file() {
        return Some(packaged);
    }
    None
}
/// One argument quoted for `CommandLineToArgvW`, mirroring
/// `quoteWindowsArgument`: always wrapped, backslash runs doubled before
/// quotes and at the tail.
fn quote_windows_argument(value: &str) -> String {
    if !value.bytes().any(|byte| byte == b'\\' || byte == b'"') {
        return format!("\"{value}\"");
    }
    let mut quoted = String::from("\"");
    let mut backslashes = 0usize;
    for char in value.chars() {
        if char == '\\' {
            backslashes += 1;
            continue;
        }
        if char == '"' {
            quoted.push_str(&"\\".repeat(backslashes * 2));
            quoted.push_str("\"\"");
            backslashes = 0;
            continue;
        }
        quoted.push_str(&"\\".repeat(backslashes));
        quoted.push(char);
        backslashes = 0;
    }
    quoted.push_str(&"\\".repeat(backslashes * 2));
    quoted.push('"');
    quoted
}
/// Current process argv without the elevation marker, the way Electron drops
/// it from `process.argv` so an unrelated later restart cannot re-trigger.
fn restartable_args() -> Vec<String> {
    std::env::args_os()
        .skip(1)
        .map(|arg| arg.to_string_lossy().into_owned())
        .filter(|arg| arg != RESTART_LOCAL_TERMINALS_ARG)
        .collect()
}
/// The helper's elevated/ordinary parameter blobs: each side is one
/// space-joined `CommandLineToArgvW` string, the elevated side carrying the
/// marker so the new instance restarts local terminals under its token.
fn restart_parameter_blobs(args: &[String]) -> (String, String) {
    let quoted: Vec<String> = args.iter().map(|arg| quote_windows_argument(arg)).collect();
    let mut elevated = quoted.clone();
    elevated.push(quote_windows_argument(RESTART_LOCAL_TERMINALS_ARG));
    (elevated.join(" "), quoted.join(" "))
}
#[cfg(windows)]
fn spawn_elevated_restart(
    helper: &Path,
    executable: &Path,
    elevated: &str,
    ordinary: &str,
) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    // Why: a GUI-shell spawn must not flash a console window the way a plain
    // CreateProcess would; the probe spawn pins the same flag.
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    std::process::Command::new(helper)
        .arg(RESTART_REQUEST_ARG)
        .arg(executable)
        .arg(elevated)
        .arg(ordinary)
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|error| format!("Unable to restart as administrator: {error}"))?;
    Ok(())
}
#[cfg(not(windows))]
fn spawn_elevated_restart(
    _helper: &Path,
    _executable: &Path,
    _elevated: &str,
    _ordinary: &str,
) -> Result<(), String> {
    Err("Administrator restart requires the installed Windows app.".to_string())
}
/// Relaunch the app elevated through the bundled restart helper, mirroring
/// `app:restartAsAdministrator`: dev and non-Windows report the same
/// installed-app error Electron throws, a missing helper reports the same
/// unavailable error, and the helper owns UAC plus fallback reopen, so this
/// process exits once it is spawned.
#[tauri::command]
pub(crate) fn poc_restart_as_administrator(
    app: AppHandle,
    runtime: State<Arc<OrcadRuntime>>,
) -> Result<(), String> {
    if std::env::consts::OS != "windows" || cfg!(debug_assertions) {
        return Err("Administrator restart requires the installed Windows app.".to_string());
    }
    let helper = restart_helper_path(&app)
        .ok_or_else(|| "The Windows administrator launcher is unavailable.".to_string())?;
    let executable = std::env::current_exe()
        .map_err(|error| format!("Unable to locate the running app: {error}"))?;
    let args = restartable_args();
    let (elevated, ordinary) = restart_parameter_blobs(&args);
    // Why: elevation must not orphan the owned Node runtime, so it waits for
    // the graceful shutdown first, like `poc_relaunch` does.
    let _ = runtime.close_owner_and_wait(Duration::from_secs(10));
    spawn_elevated_restart(&helper, &executable, &elevated, &ordinary)?;
    std::process::exit(0);
}

// Take-once latch for the elevation marker, mirroring Electron stripping it
// from `process.argv`: a later in-app restart must not re-trigger the daemon
// restart.
static ELEVATION_RESTART_TAKEN: AtomicBool = AtomicBool::new(false);
/// Scan argv for the elevation marker the restart helper passes the new
/// instance. Pure for unit tests; the take-once wrapper feeds it the real
/// process argv.
fn has_elevation_restart_marker(mut args: impl Iterator<Item = String>) -> bool {
    args.any(|arg| arg == RESTART_LOCAL_TERMINALS_ARG)
}
/// Take the elevation restart request once per process. The renderer calls
/// this on boot, then checks elevation itself and restarts the owned daemon
/// through orcad when the new token is actually elevated.
pub(crate) fn take_elevation_restart_request() -> bool {
    if ELEVATION_RESTART_TAKEN.swap(true, Ordering::SeqCst) {
        return false;
    }
    has_elevation_restart_marker(
        std::env::args_os()
            .skip(1)
            .map(|arg| arg.to_string_lossy().into_owned()),
    )
}
#[tauri::command]
pub(crate) fn poc_take_elevation_restart_request() -> bool {
    take_elevation_restart_request()
}

#[cfg(test)]
mod tests {
    use super::{
        dev_launcher_path, dev_restart_helper_path, has_elevation_restart_marker,
        packaged_launcher_path, packaged_restart_helper_path, parse_administrator_status,
        quote_windows_argument, restart_parameter_blobs, run_command_capped,
        RESTART_LOCAL_TERMINALS_ARG,
    };
    use std::time::Duration;
    #[test]
    fn finds_the_elevation_marker_in_argv() {
        let marker = RESTART_LOCAL_TERMINALS_ARG.to_string();
        assert!(has_elevation_restart_marker(
            vec!["--foo".to_string(), marker.clone()].into_iter()
        ));
        assert!(!has_elevation_restart_marker(
            vec!["--foo".to_string()].into_iter()
        ));
        assert!(!has_elevation_restart_marker(
            Vec::<String>::new().into_iter()
        ));
    }

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
    #[test]
    fn quotes_plain_arguments_with_wrapping_quotes() {
        assert_eq!(
            quote_windows_argument("C:\\tools\\orca.exe"),
            "\"C:\\tools\\orca.exe\""
        );
        assert_eq!(quote_windows_argument("--flag"), "\"--flag\"");
    }
    #[test]
    fn doubles_backslash_runs_around_embedded_quotes() {
        assert_eq!(quote_windows_argument("say \"hi\""), "\"say \"\"hi\"\"\"");
        assert_eq!(quote_windows_argument("C:\\dir\\"), "\"C:\\dir\\\\\"");
    }
    #[test]
    fn restart_blobs_carry_the_marker_only_on_the_elevated_side() {
        let (elevated, ordinary) = restart_parameter_blobs(&[
            "--foo bar".to_string(),
            RESTART_LOCAL_TERMINALS_ARG.to_string(),
        ]);
        assert_eq!(
            ordinary,
            "\"--foo bar\" \"--orca-restart-local-terminals-as-administrator\""
        );
        assert!(elevated.starts_with(&ordinary));
        assert!(elevated.ends_with("\"--orca-restart-local-terminals-as-administrator\""));
        let (empty_elevated, empty_ordinary) = restart_parameter_blobs(&[]);
        assert_eq!(empty_ordinary, "");
        assert_eq!(
            empty_elevated,
            "\"--orca-restart-local-terminals-as-administrator\""
        );
    }
    #[cfg(windows)]
    #[test]
    fn dev_restart_helper_lives_next_to_the_dev_launcher() {
        let helper = dev_restart_helper_path("C:\\repo");
        assert_eq!(
            helper,
            std::path::PathBuf::from(
                "C:\\repo\\native\\windows-cli-launcher\\.build\\orca-administrator-restart.exe"
            )
        );
    }
    #[cfg(windows)]
    #[test]
    fn packaged_restart_helper_lives_beside_the_packaged_launcher() {
        let dir = std::path::Path::new("C:\\bundle\\resources");
        assert_eq!(
            packaged_restart_helper_path(dir),
            std::path::PathBuf::from(
                "C:\\bundle\\resources\\orcad\\bin\\orca-administrator-restart.exe"
            )
        );
    }
}
