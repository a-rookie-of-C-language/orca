use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use crate::authorized_roots::{canonicalize_existing, configured_authorized_roots, is_under_roots};
use crate::runtime_process::user_data_dir;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardWriteFileArgs {
    pub file_path: String,
    pub connection_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardFileResult {
    pub ok: bool,
    pub reason: Option<&'static str>,
}

fn invalid_result(reason: &'static str) -> ClipboardFileResult {
    ClipboardFileResult {
        ok: false,
        reason: Some(reason),
    }
}

#[tauri::command]
pub fn poc_clipboard_read_file_paths() -> Vec<String> {
    #[cfg(windows)]
    {
        use clipboard_win::{formats::FileList, Clipboard, Getter};

        let Ok(_clipboard) = Clipboard::new_attempts(10) else {
            return Vec::new();
        };
        let mut paths = Vec::new();
        if FileList.read_clipboard(&mut paths).is_ok() {
            paths
        } else {
            Vec::new()
        }
    }
    #[cfg(target_os = "linux")]
    {
        read_file_paths_from_linux_clipboard()
    }
    #[cfg(not(any(windows, target_os = "linux")))]
    {
        // Reading copied files on macOS needs the NSPasteboard filenames
        // plist — not yet wired on this port.
        Vec::new()
    }
}

/// Pulls copied file paths off the Linux clipboard. Mirrors Electron's
/// `readLinuxCopiedFilePaths`: `text/uri-list` holds one URL per line, `#`
/// lines are comments, and only `file://` URLs map to a local path.
#[cfg(target_os = "linux")]
fn read_file_paths_from_linux_clipboard() -> Vec<String> {
    use std::process::{Command, Stdio};

    let helpers: [(&str, &[&str]); 2] = [
        ("wl-paste", &["--type", "text/uri-list"][..]),
        (
            "xclip",
            &["-selection", "clipboard", "-t", "text/uri-list", "-o"][..],
        ),
    ];
    for (program, args) in helpers {
        let output = Command::new(program)
            .args(args)
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .output();
        let Ok(out) = output else { continue };
        if !out.status.success() {
            continue;
        }
        let text = String::from_utf8_lossy(&out.stdout);
        let paths = file_paths_from_uri_list(&text);
        if !paths.is_empty() {
            return paths;
        }
    }
    Vec::new()
}

/// Parses the `text/uri-list` payload into local paths. Any non-`file://`
/// URL or a file-reference (`/.file/id=…`) invalidates the whole list, like
/// Electron.
#[cfg(target_os = "linux")]
fn file_paths_from_uri_list(text: &str) -> Vec<String> {
    let mut paths = Vec::new();
    for line in text.lines() {
        let url = line.trim();
        if url.is_empty() || url.starts_with('#') {
            continue;
        }
        if !url.starts_with("file://") || url.starts_with("file:///.file/id=") {
            return Vec::new();
        }
        let path = percent_decode_file_url_path(url);
        if path.is_empty() {
            return Vec::new();
        }
        paths.push(path);
    }
    paths
}

/// Decodes a `file:///…` URL's percent-escaped path back to bytes, preserving
/// the leading slash. Empty or malformed escapes invalidate the entry.
#[cfg(target_os = "linux")]
fn percent_decode_file_url_path(url: &str) -> String {
    let encoded = &url["file://".len()..];
    let mut decoded = Vec::with_capacity(encoded.len());
    let bytes = encoded.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if i + 2 >= bytes.len() {
                return String::new();
            }
            let hi = hex_value(bytes[i + 1]);
            let lo = hex_value(bytes[i + 2]);
            match (hi, lo) {
                (Some(h), Some(l)) => decoded.push((h << 4) | l),
                _ => return String::new(),
            }
            i += 3;
        } else {
            decoded.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(decoded).unwrap_or_default()
}

#[cfg(target_os = "linux")]
fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

#[tauri::command]
pub fn poc_clipboard_write_file(args: ClipboardWriteFileArgs) -> ClipboardFileResult {
    if args
        .connection_id
        .as_deref()
        .is_some_and(|connection_id| !connection_id.trim().is_empty())
    {
        return invalid_result("remote-not-supported");
    }
    let roots = configured_authorized_roots();
    let canonical = match authorize_clipboard_write_path(&args.file_path, &roots) {
        Ok(canonical) => canonical,
        Err(reason) => return invalid_result(reason),
    };

    #[cfg(windows)]
    {
        use clipboard_win::{formats::FileList, Clipboard, Setter};

        let Ok(_clipboard) = Clipboard::new_attempts(10) else {
            return invalid_result("clipboard-write-failed");
        };
        let display = canonical.to_string_lossy().into_owned();
        if FileList.write_clipboard(&[display]).is_ok() {
            ClipboardFileResult {
                ok: true,
                reason: None,
            }
        } else {
            invalid_result("clipboard-write-failed")
        }
    }
    #[cfg(target_os = "linux")]
    {
        write_file_to_linux_clipboard(&canonical)
    }
    #[cfg(not(any(windows, target_os = "linux")))]
    {
        // Electron reaches this same `unsupported-platform` reason when the
        // desktop offers no file-clipboard helper (macOS needs NSPasteboard,
        // still unwired here).
        invalid_result("unsupported-platform")
    }
}

/// Builds the `(mime, payload)` a Linux desktop expects for a file copy.
/// Mirrors Electron's `writeFileToClipboard`: KDE/Qt managers read
/// `text/uri-list`, GNOME-family managers read the `x-special/gnome-copied-files`
/// payload that carries an explicit `copy` verb.
#[cfg(target_os = "linux")]
fn linux_clipboard_file_spec(desktop: &str, file_url: &str) -> (&'static str, String) {
    if desktop.to_ascii_lowercase().contains("kde") {
        ("text/uri-list", format!("{file_url}\r\n"))
    } else {
        ("x-special/gnome-copied-files", format!("copy\n{file_url}"))
    }
}

/// Best-effort write through the desktop's clipboard helpers, mirroring
/// Electron's `wl-copy`/`xclip` fallback. A helper that cannot start, fails or
/// is killed counts as failure; the last error stays `unsupported-platform`.
#[cfg(target_os = "linux")]
fn write_file_to_linux_clipboard(path: &Path) -> ClipboardFileResult {
    let file_url = file_url_for_path(path);
    let desktop = std::env::var("XDG_CURRENT_DESKTOP").unwrap_or_default();
    let (mime, payload) = linux_clipboard_file_spec(&desktop, &file_url);
    let helpers: [(&str, &[&str]); 2] = [
        ("wl-copy", &["--type", mime][..]),
        ("xclip", &["-selection", "clipboard", "-t", mime][..]),
    ];
    for (program, args) in helpers {
        if run_clipboard_helper(program, args, payload.as_bytes()) {
            return ClipboardFileResult {
                ok: true,
                reason: None,
            };
        }
    }
    invalid_result("unsupported-platform")
}

/// Percent-encodes a filesystem path into a `file://` URL the way
/// `pathToFileURL` does — reserved bytes stay, path separators and Unicode
/// become UTF-8 percent escapes.
#[cfg(target_os = "linux")]
fn file_url_for_path(path: &Path) -> String {
    let raw = path.to_string_lossy().replace('\\', "/");
    let mut url = String::with_capacity(raw.len() + "file://".len());
    url.push_str("file://");
    if !raw.starts_with('/') {
        url.push('/');
    }
    for byte in raw.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => {
                url.push(char::from(byte))
            }
            b => {
                url.push('%');
                url.push_str(&format!("{:02X}", b));
            }
        }
    }
    url
}

/// Spawn a clipboard helper, pipe the payload to its stdin, and report whether
/// it exits cleanly. Mirrors Electron's `runClipboardHelper` — inherited output
/// pipes would hang on `wl-copy`'s background selection owner, so we drop them.
#[cfg(target_os = "linux")]
fn run_clipboard_helper(program: &str, args: &[&str], stdin: &[u8]) -> bool {
    use std::io::Write;
    use std::process::{Command, Stdio};

    let mut child = match Command::new(program)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(child) => child,
        Err(_) => return false,
    };
    if let Some(mut stdin_handle) = child.stdin.take() {
        // A helper that closes stdin early must not take the write down.
        let _ = stdin_handle.write_all(stdin);
    }
    matches!(child.wait(), Ok(status) if status.success())
}

/// Authorizes a workspace file for the OS clipboard, mirroring Electron's
/// `clipboard:writeFile` reasons: `access-denied` outside the configured
/// roots or naming a Windows device, `not-found` when nothing exists there.
/// Empty roots mean no host configured containment, so only canonicalization
/// and device refusal apply.
fn authorize_clipboard_write_path(
    file_path: &str,
    roots: &[PathBuf],
) -> Result<PathBuf, &'static str> {
    let path = Path::new(file_path);
    if !path.is_absolute() {
        return Err("invalid-path");
    }
    if cfg!(windows) && is_device_namespace_text(file_path) {
        return Err("access-denied");
    }
    let canonical = canonicalize_existing(path).map_err(|_| "not-found")?;
    if cfg!(windows)
        && canonical
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(is_windows_reserved_device_stem)
    {
        return Err("access-denied");
    }
    if !roots.is_empty() && !is_under_roots(&canonical, roots) {
        return Err("access-denied");
    }
    Ok(canonical)
}

/// A Windows device-namespace path (`\\?\`, `\\.\`), which can name devices
/// and shares alike. Mirrors Electron's `isDeviceNamespacePath`, including
/// the forward-slash spelling.
fn is_device_namespace_text(file_path: &str) -> bool {
    let normalized = file_path.replace('/', "\\");
    normalized.starts_with("\\\\?\\") || normalized.starts_with("\\\\.\\")
}

/// Whether a file name addresses a Windows device rather than a file.
/// Mirrors Electron's `isWindowsReservedDeviceName`: trailing dots/spaces go,
/// then the extension or alternate-data-stream suffix, then trailing spaces,
/// so `NUL.png`, `Aux.`, `com1 .jpg` and `NUL:stream.png` all refuse.
fn is_windows_reserved_device_stem(file_name: &str) -> bool {
    let stem = file_name
        .trim_end_matches(['.', ' '])
        .split(['.', ':'])
        .next()
        .unwrap_or("")
        .trim_end_matches(' ');
    let stem = stem.to_ascii_lowercase();
    match stem.as_str() {
        "con" | "prn" | "aux" | "nul" | "conin$" | "conout$" | "clock$" => true,
        _ => {
            let rest = stem
                .strip_prefix("com")
                .or_else(|| stem.strip_prefix("lpt"));
            let Some(rest) = rest else { return false };
            let mut chars = rest.chars();
            matches!(chars.next(), Some('0'..='9' | '¹' | '²' | '³')) && chars.next().is_none()
        }
    }
}

const NATIVE_CHAT_PASTE_FOLDER: &str = "native-chat-pastes";
const MAX_RESTORED_PASTES: usize = 256;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoredNativeChatPaste {
    pub path: String,
    pub kept: bool,
    pub exists: bool,
}

/// A path as compared for containment: no `\\?\` prefix, and case-folded where
/// the platform is. Mirrors Electron's `comparablePath`.
fn comparable_path(value: &Path) -> String {
    let raw = value.to_string_lossy();
    let unprefixed = if let Some(rest) = raw.strip_prefix("\\\\?\\UNC\\") {
        format!("\\\\{rest}")
    } else {
        raw.strip_prefix("\\\\?\\").unwrap_or(&raw).to_string()
    };
    if cfg!(windows) {
        unprefixed.to_lowercase()
    } else {
        unprefixed
    }
}

/// True when `target` names something strictly inside `folder`; both must be
/// absolute already. Mirrors Electron's `isInsideNativeChatPasteFolder`.
fn is_inside_native_chat_paste_folder(folder: &Path, target: &Path) -> bool {
    let folder_cmp = comparable_path(folder);
    let target_cmp = comparable_path(target);
    let sep = if cfg!(windows) { '\\' } else { '/' };
    target_cmp.len() > folder_cmp.len()
        && target_cmp.starts_with(&folder_cmp)
        && target_cmp.as_bytes().get(folder_cmp.len()) == Some(&(sep as u8))
}

/// The paste folder as configured and as real path; None when missing or
/// itself a link. Mirrors Electron's `realPasteFolder`.
fn real_paste_folder() -> Option<(PathBuf, PathBuf)> {
    let named = user_data_dir().join(NATIVE_CHAT_PASTE_FOLDER);
    let meta = std::fs::symlink_metadata(&named).ok()?;
    if !meta.is_dir() || meta.file_type().is_symlink() {
        return None;
    }
    let real = std::fs::canonicalize(&named).ok()?;
    Some((named, real))
}

fn restore_native_chat_paste(
    folders: Option<&(PathBuf, PathBuf)>,
    restored: &str,
) -> RestoredNativeChatPaste {
    let refused = |path: &str| RestoredNativeChatPaste {
        path: path.to_string(),
        kept: false,
        exists: false,
    };
    let Some((named_folder, real_folder)) = folders else {
        return refused(restored);
    };
    if restored.is_empty() || !Path::new(restored).is_absolute() {
        return refused(restored);
    }
    // Why both: the text the draft stores and the file it really names must
    // each be inside.
    let named = PathBuf::from(restored);
    if !is_inside_native_chat_paste_folder(named_folder, &named)
        && !is_inside_native_chat_paste_folder(real_folder, &named)
    {
        return refused(restored);
    }
    let Ok(real) = std::fs::canonicalize(&named) else {
        return refused(restored);
    };
    if !is_inside_native_chat_paste_folder(real_folder, &real) {
        return refused(restored);
    }
    match std::fs::metadata(&real) {
        Ok(meta) if meta.is_file() => RestoredNativeChatPaste {
            path: restored.to_string(),
            kept: true,
            exists: true,
        },
        _ => refused(restored),
    }
}

/// For each restored local paste: kept only when its real path is a file
/// inside the real paste folder (symlinks and junctions resolved). Anything
/// else comes back as a placeholder. Never throws — mirrors Electron's
/// `restoreNativeChatPastes`.
#[tauri::command]
pub fn poc_clipboard_restore_native_chat_pastes(
    paths: Vec<String>,
) -> Vec<RestoredNativeChatPaste> {
    let folders = real_paste_folder();
    paths
        .iter()
        .take(MAX_RESTORED_PASTES)
        .map(|path| restore_native_chat_paste(folders.as_ref(), path))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{
        authorize_clipboard_write_path, is_device_namespace_text, is_windows_reserved_device_stem,
        poc_clipboard_write_file, ClipboardWriteFileArgs,
    };
    use std::fs::{create_dir_all, remove_dir_all, write};
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn rejects_remote_file_clipboard_requests_before_touching_local_paths() {
        let result = poc_clipboard_write_file(ClipboardWriteFileArgs {
            file_path: "relative.txt".to_string(),
            connection_id: Some("ssh-1".to_string()),
        });
        assert_eq!(result.reason, Some("remote-not-supported"));
    }

    #[test]
    fn rejects_relative_file_clipboard_paths() {
        let result = poc_clipboard_write_file(ClipboardWriteFileArgs {
            file_path: "relative.txt".to_string(),
            connection_id: None,
        });
        assert_eq!(result.reason, Some("invalid-path"));
    }

    fn temp_sandbox() -> PathBuf {
        std::env::temp_dir().join(format!(
            "orca-tauri-clipboard-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ))
    }

    fn real_dir(path: &PathBuf) -> PathBuf {
        create_dir_all(path).expect("sandbox dir");
        std::fs::canonicalize(path).expect("real sandbox dir")
    }

    #[test]
    fn refuses_paths_outside_configured_roots() {
        let root = temp_sandbox();
        let elsewhere = temp_sandbox();
        let outside = root.join("outside.txt");
        create_dir_all(&root).expect("sandbox");
        write(&outside, "clipboard").expect("sandbox file");
        let roots = vec![real_dir(&elsewhere)];
        assert_eq!(
            authorize_clipboard_write_path(&outside.to_string_lossy(), &roots),
            Err("access-denied")
        );
        remove_dir_all(&root).expect("cleanup");
        remove_dir_all(&elsewhere).expect("cleanup");
    }

    #[test]
    fn allows_configured_paths_and_reports_the_canonical_path() {
        let root = temp_sandbox();
        let nested = root.join("nested");
        create_dir_all(&nested).expect("sandbox");
        write(root.join("inside.txt"), "clipboard").expect("sandbox file");
        let roots = vec![real_dir(&root)];
        let authorized =
            authorize_clipboard_write_path(&nested.join("../inside.txt").to_string_lossy(), &roots)
                .expect("authorized");
        assert_eq!(
            authorized,
            std::fs::canonicalize(root.join("inside.txt")).expect("real file")
        );
        remove_dir_all(&root).expect("cleanup");
    }

    #[test]
    fn skips_containment_when_no_roots_are_configured() {
        let root = temp_sandbox();
        let file = root.join("inside.txt");
        create_dir_all(&root).expect("sandbox");
        write(&file, "clipboard").expect("sandbox file");
        let authorized =
            authorize_clipboard_write_path(&file.to_string_lossy(), &[]).expect("authorized");
        assert_eq!(authorized, std::fs::canonicalize(&file).expect("real file"));
        remove_dir_all(&root).expect("cleanup");
    }

    #[test]
    fn reports_missing_paths_as_not_found() {
        let missing = temp_sandbox().join("missing.txt");
        assert_eq!(
            authorize_clipboard_write_path(&missing.to_string_lossy(), &[]),
            Err("not-found")
        );
    }

    #[test]
    fn refuses_device_namespace_text() {
        for banned in [
            "\\\\.\\C:\\device",
            "\\\\?\\C:\\device",
            "//./C:/device",
            "//?/C:/device",
        ] {
            assert!(is_device_namespace_text(banned), "{banned}");
        }
        for allowed in ["C:\\device", "\\\\host\\share", "/tmp/device"] {
            assert!(!is_device_namespace_text(allowed), "{allowed}");
        }
    }

    #[test]
    fn refuses_windows_reserved_device_stems() {
        for banned in [
            "NUL",
            "nul.txt",
            "NUL.png",
            "com1 .jpg",
            "COM9",
            "Aux.",
            "NUL:stream.png",
            "conin$",
            "conout$",
            "clock$",
            "lpt¹",
            "LPT3 ",
        ] {
            assert!(is_windows_reserved_device_stem(banned), "{banned}");
        }
        for allowed in [
            "notes.txt",
            "console.log",
            "null.png",
            "auxiliary.txt",
            "com",
            "com10",
            "lpt123",
            "clock",
        ] {
            assert!(!is_windows_reserved_device_stem(allowed), "{allowed}");
        }
    }

    #[cfg(windows)]
    #[test]
    fn refuses_device_namespace_before_touching_the_filesystem() {
        assert_eq!(
            authorize_clipboard_write_path("\\\\.\\C:\\orca-tauri-missing-device-path", &[]),
            Err("access-denied")
        );
    }

    mod restore_pastes {
        use super::super::{
            comparable_path, is_inside_native_chat_paste_folder, restore_native_chat_paste,
        };
        use std::fs::{create_dir_all, remove_dir_all, write};
        use std::path::PathBuf;
        use std::time::{SystemTime, UNIX_EPOCH};

        fn temp_folder() -> PathBuf {
            std::env::temp_dir().join(format!(
                "orca-tauri-pastes-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .expect("clock")
                    .as_nanos()
            ))
        }

        fn real_dir(path: &PathBuf) -> PathBuf {
            create_dir_all(path).expect("sandbox dir");
            std::fs::canonicalize(path).expect("real sandbox dir")
        }

        #[test]
        fn keeps_a_file_inside_the_real_folder() {
            let folder = temp_folder();
            let real = real_dir(&folder);
            let file = folder.join("orca-paste-1.png");
            write(&file, b"png").expect("paste file");
            let result =
                restore_native_chat_paste(Some(&(folder.clone(), real)), &file.to_string_lossy());
            assert!(result.kept && result.exists);
            remove_dir_all(&folder).expect("cleanup");
        }

        #[test]
        fn refuses_paths_outside_the_folder_and_missing_folder() {
            let folder = temp_folder();
            let real = real_dir(&folder);
            let outside_dir = temp_folder();
            create_dir_all(&outside_dir).expect("outside dir");
            let outside = outside_dir.join("outside.png");
            write(&outside, b"png").expect("outside file");
            let folders = Some((folder.clone(), real));
            let result = restore_native_chat_paste(folders.as_ref(), &outside.to_string_lossy());
            assert!(!result.kept && !result.exists);
            let result = restore_native_chat_paste(None, &outside.to_string_lossy());
            assert!(!result.kept && !result.exists);
            remove_dir_all(&folder).expect("cleanup");
            remove_dir_all(&outside_dir).expect("cleanup");
        }

        #[test]
        fn refuses_relative_and_empty_paths() {
            let folder = temp_folder();
            let real = real_dir(&folder);
            let folders = Some((folder.clone(), real));
            for path in ["", "relative.png", "..\\up.png"] {
                let result = restore_native_chat_paste(folders.as_ref(), path);
                assert!(!result.kept && !result.exists, "{path}");
            }
            remove_dir_all(&folder).expect("cleanup");
        }

        #[test]
        fn refuses_a_missing_file_inside_the_folder() {
            let folder = temp_folder();
            let real = real_dir(&folder);
            let missing = folder.join("orca-paste-gone.png");
            let result = restore_native_chat_paste(
                Some(&(folder.clone(), real)),
                &missing.to_string_lossy(),
            );
            assert!(!result.kept && !result.exists);
            remove_dir_all(&folder).expect("cleanup");
        }

        #[test]
        fn containment_rejects_sibling_prefix_and_parent() {
            let root = temp_folder();
            let folder = root.join("pastes");
            let sibling = root.join("pastes-evil");
            create_dir_all(&folder).expect("folder");
            create_dir_all(&sibling).expect("sibling");
            assert!(is_inside_native_chat_paste_folder(
                &folder,
                &folder.join("a.png")
            ));
            assert!(!is_inside_native_chat_paste_folder(
                &folder,
                &sibling.join("a.png")
            ));
            assert!(!is_inside_native_chat_paste_folder(&folder, &folder));
            assert!(!is_inside_native_chat_paste_folder(&folder, &root));
            remove_dir_all(&root).expect("cleanup");
        }

        #[test]
        fn comparable_path_strips_extended_prefixes() {
            assert_eq!(
                comparable_path(&PathBuf::from("\\\\?\\C:\\A\\b.png")),
                if cfg!(windows) {
                    "c:\\a\\b.png"
                } else {
                    "\\\\?\\C:\\A\\b.png"
                }
            );
            assert_eq!(
                comparable_path(&PathBuf::from("\\\\?\\UNC\\srv\\share\\f.png")),
                if cfg!(windows) {
                    "\\\\srv\\share\\f.png"
                } else {
                    "\\\\?\\UNC\\srv\\share\\f.png"
                }
            );
        }
    }

    #[cfg(target_os = "linux")]
    mod linux {
        use super::super::{
            file_paths_from_uri_list, file_url_for_path, linux_clipboard_file_spec,
            percent_decode_file_url_path,
        };
        use std::path::PathBuf;

        #[test]
        fn kde_desktops_pick_uri_list_and_gnome_picks_copied_files() {
            let (mime, payload) = linux_clipboard_file_spec("KDE", "file:///home/orca/notes.txt");
            assert_eq!(mime, "text/uri-list");
            assert_eq!(payload, "file:///home/orca/notes.txt\r\n");

            let (mime, payload) = linux_clipboard_file_spec("GNOME", "file:///home/orca/notes.txt");
            assert_eq!(mime, "x-special/gnome-copied-files");
            assert_eq!(payload, "copy\nfile:///home/orca/notes.txt");

            let (mime, payload) = linux_clipboard_file_spec("sway", "file:///home/orca/notes.txt");
            assert_eq!(mime, "x-special/gnome-copied-files");
            assert_eq!(payload, "copy\nfile:///home/orca/notes.txt");
        }

        #[test]
        fn file_url_encodes_spaces_and_unicode_and_keeps_slashes() {
            let url = file_url_for_path(&PathBuf::from("/home/orca/notes file 测试.txt"));
            assert_eq!(
                url,
                "file:///home/orca/notes%20file%20%E6%B5%8B%E8%AF%95.txt"
            );
        }

        #[test]
        fn file_url_keeps_relative_path_under_file_scheme() {
            // The authorizer rejects non-absolute paths before this runs, so
            // this only documents the URL shape for an absolute path.
            let url = file_url_for_path(&PathBuf::from("/tmp/a.txt"));
            assert_eq!(url, "file:///tmp/a.txt");
        }

        #[test]
        fn uri_list_parses_multiple_files_and_skips_comments() {
            let text = "# comment\nfile:///tmp/a.txt\r\nfile:///tmp/b%20file.txt\n\n";
            assert_eq!(
                file_paths_from_uri_list(text),
                vec!["/tmp/a.txt".to_string(), "/tmp/b file.txt".to_string()]
            );
        }

        #[test]
        fn uri_list_rejects_non_file_urls_and_file_references() {
            for text in [
                "https://example.com/x\n",
                "file:///.file/id=12345\n",
                "file:///tmp/a.txt\nhttp://other/x\n",
            ] {
                assert_eq!(
                    file_paths_from_uri_list(text),
                    Vec::<String>::new(),
                    "{text}"
                );
            }
        }

        #[test]
        fn uri_list_rejects_malformed_percent_escapes() {
            for text in ["file:///tmp/bad%2\n", "file:///tmp/bad%zz\n"] {
                assert_eq!(
                    file_paths_from_uri_list(text),
                    Vec::<String>::new(),
                    "{text}"
                );
            }
        }

        #[test]
        fn percent_decode_round_trips_unicode_and_space() {
            assert_eq!(
                percent_decode_file_url_path(
                    "file:///home/orca/notes%20file%20%E6%B5%8B%E8%AF%95.txt"
                ),
                "/home/orca/notes file 测试.txt"
            );
        }
    }
}
