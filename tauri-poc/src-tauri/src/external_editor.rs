use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

const DEFAULT_EDITOR_COMMAND: &str = "code";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalEditorArgs {
    pub path: String,
    pub command: Option<String>,
    pub owner_host_id: String,
    pub ssh_authority: Option<String>,
    pub wsl_distro: Option<String>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(untagged)]
pub enum ExternalEditorResult {
    Success { ok: bool },
    Failure { ok: bool, reason: &'static str },
}

impl ExternalEditorResult {
    fn success() -> Self {
        Self::Success { ok: true }
    }

    fn failure(reason: &'static str) -> Self {
        Self::Failure { ok: false, reason }
    }
}

/// Launch an editor without handing an arbitrary shell command to the native side.
///
/// The Electron implementation also accepts compound shell commands. Tauri keeps this boundary
/// structured: a command is one executable name/path plus plain-argv flags, so `code
/// --new-window` works while shell-only constructs (pipes, substitution, env expansion) keep
/// failing instead of launching the wrong target. No shell ever interprets renderer input.
#[tauri::command]
pub fn poc_open_external_editor(args: ExternalEditorArgs) -> ExternalEditorResult {
    let is_remote = args.owner_host_id != "local";
    let target = PathBuf::from(&args.path);
    if !is_absolute_target(&args.path) {
        return ExternalEditorResult::failure("not-absolute");
    }
    if !is_remote && !target.exists() {
        return ExternalEditorResult::failure("not-found");
    }
    if args.path.contains('\0') {
        return ExternalEditorResult::failure("launch-failed");
    }

    let command = args
        .command
        .as_deref()
        .unwrap_or(DEFAULT_EDITOR_COMMAND)
        .trim();
    if command.is_empty() || command.contains('\0') {
        return ExternalEditorResult::failure("remote-editor-unsupported");
    }

    // Why: parse the argv-expressible subset without a shell; shell-only
    // constructs keep failing here exactly like before instead of launching
    // the wrong target with literal metacharacters.
    let Some((editor_binary, extra_args)) = split_editor_command(command) else {
        return ExternalEditorResult::failure("remote-editor-unsupported");
    };

    let Some(editor) = resolve_editor_command(&editor_binary) else {
        return ExternalEditorResult::failure("launch-failed");
    };
    let wsl_distro = args.wsl_distro.as_deref().map(str::trim);
    if wsl_distro.is_some() && !args.owner_host_id.starts_with("runtime:") {
        return ExternalEditorResult::failure("remote-editor-unsupported");
    }
    let wsl_path = if let Some(distro) = wsl_distro {
        if !is_valid_wsl_distro(distro) || !is_valid_wsl_linux_path(&args.path) {
            return ExternalEditorResult::failure("remote-editor-unsupported");
        }
        Some(args.path.as_str())
    } else {
        None
    };
    let target_arg = target.to_string_lossy().into_owned();
    let target_args = match build_launch_args(
        &editor,
        target_arg,
        is_remote,
        wsl_distro,
        wsl_path,
        args.ssh_authority.as_deref(),
    ) {
        Ok(args) => args,
        Err(reason) => return ExternalEditorResult::failure(reason),
    };
    // Why: user flags keep Electron's position (right after the launcher,
    // before the target), matching `<command> <escaped-path>` ordering.
    let mut launch_args = extra_args;
    launch_args.extend(target_args);

    let launch_result = if is_windows_script(&editor) {
        launch_windows_script(&editor, &launch_args)
    } else {
        let mut process = Command::new(&editor);
        process
            .args(&launch_args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        configure_hidden_process(&mut process);
        process.spawn().map(|_| ())
    };

    match launch_result {
        Ok(()) => ExternalEditorResult::success(),
        Err(_) => ExternalEditorResult::failure("launch-failed"),
    }
}

/// Split a configured editor command into launcher + extra args without a
/// shell. Accepts the Electron compound subset expressible as plain argv
/// (`code --new-window`, quoted launcher paths). Unquoted shell syntax
/// (pipes, redirects, substitution, globs, env expansion) is rejected so it
/// can never launch the wrong target; quoted metacharacters stay literal
/// argv, which no shell ever sees.
fn split_editor_command(command: &str) -> Option<(String, Vec<String>)> {
    let mut words: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut in_word = false;
    let mut quote: Option<char> = None;
    let mut chars = command.chars();
    while let Some(character) = chars.next() {
        if let Some(active) = quote {
            match character {
                // Why: command substitution runs even inside quotes, so a
                // quoted `$(...)` or backtick is never a literal flag.
                c if c == active => quote = None,
                '`' | '$' => return None,
                '\\' => match chars.next() {
                    Some(next) if next == active || next == '\\' => current.push(next),
                    Some(next) => {
                        current.push('\\');
                        current.push(next);
                    }
                    None => current.push('\\'),
                },
                _ => current.push(character),
            }
            continue;
        }
        match character {
            '\'' | '"' => {
                quote = Some(character);
                in_word = true;
            }
            _ if character.is_whitespace() => {
                if in_word {
                    words.push(std::mem::take(&mut current));
                    in_word = false;
                }
            }
            // Why: backslash escapes only whitespace/quotes/itself, so
            // Windows paths (`C:\new\code.cmd`) survive untouched.
            '\\' => {
                match chars.next() {
                    Some(next)
                        if next.is_whitespace() || next == '\'' || next == '"' || next == '\\' =>
                    {
                        current.push(next);
                    }
                    Some(next) => {
                        current.push('\\');
                        current.push(next);
                    }
                    None => current.push('\\'),
                }
                in_word = true;
            }
            // Why: rejected anywhere; even quoted, a future shell routing
            // would execute these instead of passing them literally.
            '`' | '$' => return None,
            _ if character.is_control() => return None,
            // Why: a non-interactive shell would interpret these; passing
            // them literally would open the wrong target, so fail loudly.
            '|' | '&' | ';' | '<' | '>' | '(' | ')' | '*' | '?' | '~' | '#' | '%' | '^' => {
                return None
            }
            _ => {
                current.push(character);
                in_word = true;
            }
        }
    }
    if quote.is_some() {
        return None;
    }
    if in_word {
        words.push(current);
    }
    let mut words = words.into_iter();
    let executable = words.next()?;
    if executable.is_empty() {
        return None;
    }
    Some((executable, words.collect()))
}

fn is_absolute_target(value: &str) -> bool {
    Path::new(value).is_absolute()
        || value.starts_with('/')
        || value.starts_with("\\\\")
        || value.as_bytes().get(1).is_some_and(|byte| *byte == b':')
            && value
                .as_bytes()
                .get(2)
                .is_some_and(|byte| *byte == b'/' || *byte == b'\\')
}

fn is_valid_remote_authority(value: &str) -> bool {
    !value.is_empty()
        && !value.chars().any(|character| {
            character.is_whitespace() || character == '\0' || character.is_control()
        })
}

fn is_valid_wsl_distro(value: &str) -> bool {
    !value.is_empty()
        && value != "."
        && value != ".."
        && !value.chars().any(|character| {
            character.is_whitespace()
                || character.is_control()
                || matches!(character, '\\' | '/' | '\0')
        })
}

fn is_valid_wsl_linux_path(value: &str) -> bool {
    value.starts_with('/')
        && !value.starts_with("//")
        && !value.contains('\\')
        && !value.contains('\0')
        && !value.split('/').any(|segment| segment == "..")
}

fn wsl_unc_path(distro: &str, linux_path: &str) -> String {
    let suffix = linux_path.replace('/', "\\");
    format!(r"\\wsl.localhost\{distro}{suffix}")
}

fn build_launch_args(
    editor: &Path,
    target_arg: String,
    is_remote: bool,
    wsl_distro: Option<&str>,
    wsl_path: Option<&str>,
    ssh_authority: Option<&str>,
) -> Result<Vec<String>, &'static str> {
    let is_cursor = editor_stem(editor)
        .map(|stem| stem.eq_ignore_ascii_case("cursor"))
        .unwrap_or(false);
    if let Some(distro) = wsl_distro {
        let path = wsl_path.ok_or("remote-editor-unsupported")?;
        if is_vscode_launcher(editor) {
            return Ok(vec![
                "--remote".to_owned(),
                format!("wsl+{distro}"),
                path.to_owned(),
            ]);
        }
        if is_cursor {
            return Ok(vec![
                "--new-window".to_owned(),
                "--remote".to_owned(),
                format!("wsl+{distro}"),
                path.to_owned(),
            ]);
        }
        return Ok(vec![wsl_unc_path(distro, path)]);
    }
    if is_remote {
        let authority = ssh_authority.ok_or("remote-editor-unsupported")?;
        if !is_valid_remote_authority(authority) || !is_vscode_launcher(editor) {
            return Err("remote-editor-unsupported");
        }
        return Ok(vec![
            "--remote".to_owned(),
            format!("ssh-remote+{authority}"),
            target_arg,
        ]);
    }
    if is_cursor {
        return Ok(vec!["--new-window".to_owned(), target_arg]);
    }
    Ok(vec![target_arg])
}

fn is_vscode_launcher(path: &Path) -> bool {
    path.file_stem()
        .and_then(|stem| stem.to_str())
        .map(|stem| {
            matches!(
                stem.to_ascii_lowercase().as_str(),
                "code" | "code-insiders" | "code - insiders"
            )
        })
        .unwrap_or(false)
}

fn resolve_editor_command(command: &str) -> Option<PathBuf> {
    let candidate = Path::new(command);
    if candidate.components().count() > 1 || candidate.is_absolute() {
        return candidate.is_file().then(|| candidate.to_path_buf());
    }

    #[cfg(windows)]
    {
        let path = std::env::var_os("PATH")?;
        let extensions = ["", ".exe", ".cmd", ".bat", ".com"];
        for directory in std::env::split_paths(&path) {
            for extension in extensions {
                let candidate = directory.join(format!("{command}{extension}"));
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
    }

    // Unix PATH lookup is performed by the OS. On Windows, keep the unresolved command as a
    // fallback so an inherited app-specific launcher can still be found by CreateProcess.
    Some(candidate.to_path_buf())
}

fn editor_stem(path: &Path) -> Option<&str> {
    path.file_stem().and_then(|stem| stem.to_str())
}

fn is_windows_script(path: &Path) -> bool {
    #[cfg(windows)]
    {
        return path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| {
                matches!(extension.to_ascii_lowercase().as_str(), "cmd" | "bat")
            });
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        false
    }
}

fn configure_hidden_process(process: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        process.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    #[cfg(not(windows))]
    {
        let _ = process;
    }
}

#[cfg(windows)]
fn launch_windows_script(editor: &Path, args: &[String]) -> std::io::Result<()> {
    use std::os::windows::process::CommandExt;

    let mut command_line = quote_cmd_argument(&editor.to_string_lossy());
    for arg in args {
        command_line.push(' ');
        command_line.push_str(&quote_cmd_argument(arg));
    }
    let comspec = std::env::var_os("ComSpec").unwrap_or_else(|| "cmd.exe".into());
    let mut process = Command::new(comspec);
    process
        .args(["/d", "/v:off", "/s", "/c", &command_line])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(0x08000000); // CREATE_NO_WINDOW
    process.spawn().map(|_| ())
}

#[cfg(windows)]
fn quote_cmd_argument(value: &str) -> String {
    let mut result = String::with_capacity(value.len() + 2);
    result.push('"');
    for character in value.chars() {
        match character {
            '^' | '&' | '|' | '<' | '>' | '(' | ')' | '!' => {
                result.push('^');
                result.push(character);
            }
            '%' => result.push_str("%%"),
            '"' => result.push_str("\\\""),
            _ => result.push(character),
        }
    }
    result.push('"');
    result
}

#[cfg(test)]
mod tests {
    use super::split_editor_command;
    use super::{
        build_launch_args, editor_stem, is_absolute_target, is_valid_remote_authority,
        is_valid_wsl_distro, is_valid_wsl_linux_path, poc_open_external_editor, wsl_unc_path,
        ExternalEditorArgs, ExternalEditorResult,
    };
    use std::path::Path;

    #[cfg(not(windows))]
    use super::is_windows_script;

    #[test]
    fn identifies_cursor_launchers() {
        assert_eq!(editor_stem(Path::new("cursor")), Some("cursor"));
        assert_eq!(
            editor_stem(Path::new("/opt/Cursor/bin/cursor")),
            Some("cursor")
        );
    }

    #[test]
    fn splits_safe_compound_commands_without_a_shell() {
        assert_eq!(
            split_editor_command("code --new-window"),
            Some(("code".to_owned(), vec!["--new-window".to_owned()]))
        );
        assert_eq!(
            split_editor_command("\"C:\\Program Files\\Editor\\code.cmd\" --new-window"),
            Some((
                "C:\\Program Files\\Editor\\code.cmd".to_owned(),
                vec!["--new-window".to_owned()]
            ))
        );
        assert_eq!(
            split_editor_command("code --server=/tmp/a --goto"),
            Some((
                "code".to_owned(),
                vec!["--server=/tmp/a".to_owned(), "--goto".to_owned()]
            ))
        );
        // Why: backslash escapes only whitespace/quotes/itself, so Windows
        // paths survive untouched.
        assert_eq!(
            split_editor_command("C:\\new\\code.cmd --flag"),
            Some(("C:\\new\\code.cmd".to_owned(), vec!["--flag".to_owned()]))
        );
        // Why: quoted metacharacters stay literal argv, which no shell sees.
        assert_eq!(
            split_editor_command("code \"a|b\""),
            Some(("code".to_owned(), vec!["a|b".to_owned()]))
        );
    }

    #[test]
    fn rejects_shell_only_constructs() {
        for command in [
            "",
            "   ",
            "code --flag | less",
            "code a; code b",
            "code && code",
            "code > out.txt",
            "code $(whoami)",
            "code `whoami`",
            "code \"$HOME/x\"",
            "code \"a$(b\"",
            "code *.md",
            "code ~/proj",
            "code %PROJ%",
            "\"unterminated --flag",
            "\"\" --flag",
        ] {
            assert_eq!(split_editor_command(command), None, "{command}");
        }
    }

    #[test]
    fn safe_compound_commands_reach_spawn_instead_of_rejection() {
        let target = tempfile::NamedTempFile::new().expect("temp target");
        let args = ExternalEditorArgs {
            path: target.path().to_string_lossy().into_owned(),
            command: Some("definitely-not-an-editor-xyz --new-window".to_owned()),
            owner_host_id: "local".to_owned(),
            ssh_authority: None,
            wsl_distro: None,
        };
        // Why: launch-failed proves the flags parsed and spawn was attempted;
        // the old boundary rejected this input before touching spawn.
        assert_eq!(
            poc_open_external_editor(args),
            ExternalEditorResult::Failure {
                ok: false,
                reason: "launch-failed"
            }
        );
    }

    #[test]
    fn shell_constructs_still_fail_before_spawn() {
        let target = tempfile::NamedTempFile::new().expect("temp target");
        let args = ExternalEditorArgs {
            path: target.path().to_string_lossy().into_owned(),
            command: Some("definitely-not-an-editor-xyz --flag | less".to_owned()),
            owner_host_id: "local".to_owned(),
            ssh_authority: None,
            wsl_distro: None,
        };
        assert_eq!(
            poc_open_external_editor(args),
            ExternalEditorResult::Failure {
                ok: false,
                reason: "remote-editor-unsupported"
            }
        );
    }

    #[test]
    fn accepts_remote_paths_without_local_existence() {
        assert!(is_absolute_target("/home/ada/project"));
        assert!(is_absolute_target("C:\\Users\\ada\\project"));
        assert!(!is_absolute_target("relative/project"));
    }

    #[test]
    fn accepts_only_safe_remote_authorities() {
        assert!(is_valid_remote_authority("ada@builder.example.com"));
        assert!(!is_valid_remote_authority("ada@builder.example.com\ncode"));
        assert!(!is_valid_remote_authority(""));
    }

    #[test]
    fn validates_wsl_distro_names_and_linux_paths() {
        assert!(is_valid_wsl_distro("Ubuntu-22.04"));
        assert!(!is_valid_wsl_distro("Ubuntu 22.04"));
        assert!(!is_valid_wsl_distro("Ubuntu\\root"));
        assert!(is_valid_wsl_linux_path("/home/ada/project"));
        assert!(!is_valid_wsl_linux_path("relative/project"));
        assert!(!is_valid_wsl_linux_path("/home/ada/../secrets"));
        assert!(!is_valid_wsl_linux_path("/home/ada\\project"));
    }

    #[test]
    fn builds_wsl_unc_paths_without_shell_syntax() {
        assert_eq!(
            wsl_unc_path("Ubuntu", "/home/ada/project"),
            r"\\wsl.localhost\Ubuntu\home\ada\project"
        );
    }

    #[test]
    fn builds_editor_arguments_for_each_wsl_launcher() {
        assert_eq!(
            build_launch_args(
                Path::new("code"),
                "/home/ada/project".to_owned(),
                true,
                Some("Ubuntu"),
                Some("/home/ada/project"),
                None,
            ),
            Ok(vec![
                "--remote".to_owned(),
                "wsl+Ubuntu".to_owned(),
                "/home/ada/project".to_owned()
            ])
        );
        assert_eq!(
            build_launch_args(
                Path::new("cursor"),
                "/home/ada/project".to_owned(),
                true,
                Some("Ubuntu"),
                Some("/home/ada/project"),
                None,
            ),
            Ok(vec![
                "--new-window".to_owned(),
                "--remote".to_owned(),
                "wsl+Ubuntu".to_owned(),
                "/home/ada/project".to_owned()
            ])
        );
        assert_eq!(
            build_launch_args(
                Path::new("zed"),
                "/home/ada/project".to_owned(),
                true,
                Some("Ubuntu"),
                Some("/home/ada/project"),
                None,
            ),
            Ok(vec![r"\\wsl.localhost\Ubuntu\home\ada\project".to_owned()])
        );
    }

    #[cfg(not(windows))]
    #[test]
    fn shell_script_detection_is_windows_only() {
        assert!(!is_windows_script(Path::new("/tmp/editor.cmd")));
    }
}
