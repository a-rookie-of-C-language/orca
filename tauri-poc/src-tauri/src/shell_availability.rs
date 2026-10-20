//! Shell availability probes, mirroring Electron's `gitBash:isAvailable`,
//! `pwsh:isAvailable`, `wsl:isAvailable`, and `wsl:listDistros` handlers.
//!
//! gitBash scans the same candidate install roots Electron reads from the
//! environment; pwsh and wsl spawn the same single-exit probes (`pwsh.exe
//! -Version`, `wsl.exe --status`, `wsl.exe --list --quiet`). These are
//! infrequent capability reads, so each call probes fresh rather than
//! reproducing Electron's shared negative-cache/backoff ladder — the answer
//! contract is identical, only the spawn amortization differs.

use serde::Serialize;
use std::process::{Command, Stdio};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellAvailability {
    pub git_bash: bool,
    pub pwsh: bool,
    pub wsl_available: bool,
    pub wsl_distros: Vec<String>,
    pub host_platform: String,
}

fn env_any(names: &[&str]) -> Option<std::ffi::OsString> {
    names
        .iter()
        .find_map(|name| std::env::var_os(name).filter(|value| !value.is_empty()))
}

/// Matches Electron's `isGitForWindowsBashPath`: the candidate must end in a
/// `Git|PortableGit` (optionally `usr`) `bin\bash.exe` so a stray MSYS2/Cygwin
/// bash on PATH does not register as Git Bash.
fn is_git_for_windows_bash_path(path: &std::path::Path) -> bool {
    let normalized = path.to_string_lossy().replace('/', "\\").to_lowercase();
    let normalized = normalized.trim_end_matches('\\');
    normalized.ends_with("\\git\\bin\\bash.exe")
        || normalized.ends_with("\\git\\usr\\bin\\bash.exe")
        || normalized.ends_with("\\portablegit\\bin\\bash.exe")
        || normalized.ends_with("\\portablegit\\usr\\bin\\bash.exe")
}

fn push_git_bash_candidate(
    candidates: &mut Vec<std::path::PathBuf>,
    seen: &mut std::collections::HashSet<String>,
    candidate: std::path::PathBuf,
) {
    let key = candidate.to_string_lossy().to_lowercase();
    if seen.insert(key) {
        candidates.push(candidate);
    }
}

fn candidate_git_bash_paths() -> Vec<std::path::PathBuf> {
    let mut candidates = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let roots = [
        env_any(&["ProgramFiles", "PROGRAMFILES"]),
        env_any(&["ProgramW6432", "PROGRAMW6432"]),
        env_any(&["ProgramFiles(x86)", "PROGRAMFILES(X86)"]),
        env_any(&["LOCALAPPDATA", "LocalAppData"]),
    ];
    for root in roots.iter().flatten() {
        let root = std::path::PathBuf::from(root);
        for suffix in [
            "Git\\bin\\bash.exe",
            "Git\\usr\\bin\\bash.exe",
            "Programs\\Git\\bin\\bash.exe",
            "Programs\\Git\\usr\\bin\\bash.exe",
        ] {
            push_git_bash_candidate(&mut candidates, &mut seen, root.join(suffix));
        }
    }

    // PATH scan, mirroring Electron: a Git|PortableGit\cmd or Git|PortableGit
    // directory on PATH resolves to its sibling bin\ / usr\bin\bash.exe.
    if let Some(path_value) = env_any(&["Path", "PATH"]) {
        for raw_segment in path_value.to_string_lossy().split(';') {
            let segment = raw_segment.trim().trim_matches('"');
            if segment.is_empty() {
                continue;
            }
            let segment_path = std::path::PathBuf::from(segment);
            let basename = segment_path
                .file_name()
                .map(|name| name.to_string_lossy().to_lowercase())
                .unwrap_or_default();
            if basename == "cmd" {
                if let Some(parent) = segment_path.parent() {
                    let parent_name = parent
                        .file_name()
                        .map(|name| name.to_string_lossy().to_lowercase())
                        .unwrap_or_default();
                    if parent_name == "git" || parent_name == "portablegit" {
                        push_git_bash_candidate(
                            &mut candidates,
                            &mut seen,
                            parent.join("bin\\bash.exe"),
                        );
                        push_git_bash_candidate(
                            &mut candidates,
                            &mut seen,
                            parent.join("usr\\bin\\bash.exe"),
                        );
                    }
                }
            } else if basename == "git" || basename == "portablegit" {
                push_git_bash_candidate(
                    &mut candidates,
                    &mut seen,
                    segment_path.join("bin\\bash.exe"),
                );
                push_git_bash_candidate(
                    &mut candidates,
                    &mut seen,
                    segment_path.join("usr\\bin\\bash.exe"),
                );
            }
        }
    }
    candidates
}

fn git_bash_available() -> bool {
    candidate_git_bash_paths()
        .iter()
        .any(|path| is_git_for_windows_bash_path(path) && path.is_file())
}

/// Spawn `program args` hidden and report whether it exited 0 within `timeout`.
fn probe_exit_zero(
    program: &str,
    args: &[&str],
    env: &[(&str, &str)],
    timeout: std::time::Duration,
) -> Option<std::process::Output> {
    let mut command = Command::new(program);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    for (key, value) in env {
        command.env(key, value);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW keeps console tools from flashing a window.
        command.creation_flags(0x0800_0000);
    }
    let child = command.spawn().ok()?;
    wait_with_timeout(child, timeout).ok().flatten()
}

fn wait_with_timeout(
    mut child: std::process::Child,
    timeout: std::time::Duration,
) -> std::io::Result<Option<std::process::Output>> {
    use std::time::Instant;
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait()? {
            Some(_) => {
                let output = child.wait_with_output()?;
                return Ok(Some(output));
            }
            None if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return Ok(None);
            }
            None => std::thread::sleep(std::time::Duration::from_millis(10)),
        }
    }
}

fn pwsh_available() -> bool {
    probe_exit_zero(
        "pwsh.exe",
        &["-Version"],
        &[],
        std::time::Duration::from_secs(5),
    )
    .map(|output| output.status.success())
    .unwrap_or(false)
}

fn run_wsl(args: &[&str]) -> Option<std::process::Output> {
    // WSL_UTF8=1 makes wsl.exe emit UTF-8 instead of UTF-16 so no transcoding is needed.
    probe_exit_zero(
        "wsl.exe",
        args,
        &[("WSL_UTF8", "1")],
        std::time::Duration::from_secs(10),
    )
}

fn parse_wsl_distros(stdout: &[u8]) -> Vec<String> {
    String::from_utf8_lossy(stdout)
        .replace(char::from(0), "")
        .lines()
        .map(|line| line.trim().trim_start_matches('*').trim())
        .filter(|line| !line.is_empty() && !line.to_lowercase().starts_with("docker-desktop"))
        .map(|line| line.to_string())
        .collect()
}

fn wsl_probe() -> (bool, Vec<String>) {
    // `wsl --status` exits non-zero (incl. 0x1bc missing kernel) when unusable;
    // a failed/absent wsl.exe answers both as unavailable with no distros.
    let Some(status) = run_wsl(&["--status"]) else {
        return (false, Vec::new());
    };
    if !status.status.success() {
        return (false, Vec::new());
    }
    let distros = run_wsl(&["--list", "--quiet"])
        .map(|output| {
            if output.status.success() {
                parse_wsl_distros(&output.stdout)
            } else {
                Vec::new()
            }
        })
        .unwrap_or_default();
    (true, distros)
}

#[tauri::command]
pub(crate) fn poc_shell_availability() -> ShellAvailability {
    #[cfg(windows)]
    {
        let (wsl_available, wsl_distros) = wsl_probe();
        return ShellAvailability {
            git_bash: git_bash_available(),
            pwsh: pwsh_available(),
            wsl_available,
            wsl_distros,
            host_platform: "win32".to_string(),
        };
    }
    #[cfg(not(windows))]
    {
        ShellAvailability {
            git_bash: false,
            pwsh: false,
            wsl_available: false,
            wsl_distros: Vec::new(),
            host_platform: std::env::consts::OS.to_string(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{is_git_for_windows_bash_path, parse_wsl_distros, poc_shell_availability};

    #[test]
    fn parses_wsl_distro_list() {
        let output = "Ubuntu\0\r\n\0* docker-desktop\r\nDebian\r\n";
        assert_eq!(
            parse_wsl_distros(output.as_bytes()),
            vec!["Ubuntu", "Debian"]
        );
    }

    #[test]
    fn matches_git_for_windows_bash_paths() {
        assert!(is_git_for_windows_bash_path(std::path::Path::new(
            "D:\\Git\\bin\\bash.exe"
        )));
        assert!(is_git_for_windows_bash_path(std::path::Path::new(
            "D:\\Git\\usr\\bin\\bash.exe"
        )));
        assert!(!is_git_for_windows_bash_path(std::path::Path::new(
            "C:\\msys64\\usr\\bin\\bash.exe"
        )));
    }

    #[test]
    fn availability_is_serializable() {
        let state = poc_shell_availability();
        let json = serde_json::to_string(&state).unwrap();
        assert!(json.contains("gitBash"));
    }
}
