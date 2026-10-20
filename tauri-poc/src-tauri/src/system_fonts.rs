//! System font family enumeration, mirroring Electron main.
//!
//! Electron shells out to PowerShell and its InstalledFontCollection on
//! Windows. The Tauri shell enumerates families in-process through GDI
//! instead, so no child process is spawned for a settings convenience call.
//! The contract matches listSystemFontFamilies: sorted, unique, leading-dot
//! names dropped, with the same Windows fallback when nothing enumerates.

use std::sync::{LazyLock, Mutex};

// Why: font discovery backs a settings suggestion list, so enumerate once
// per process like Electron caches after its first successful load.
static CACHED_FONTS: LazyLock<Mutex<Option<Vec<String>>>> = LazyLock::new(|| Mutex::new(None));

fn fallback_fonts() -> Vec<String> {
    [
        "Cascadia Mono",
        "Consolas",
        "Lucida Console",
        "JetBrains Mono",
        "Fira Code",
    ]
    .iter()
    .map(|name| name.to_string())
    .collect()
}

fn unique_sorted(values: Vec<String>) -> Vec<String> {
    let mut cleaned: Vec<String> = values
        .into_iter()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty() && !value.starts_with('.'))
        .collect();
    cleaned.sort();
    cleaned.dedup();
    cleaned
}

#[cfg(windows)]
fn enumerate_windows_fonts() -> Vec<String> {
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;
    use windows_sys::Win32::Foundation::LPARAM;
    use windows_sys::Win32::Graphics::Gdi::{
        EnumFontFamiliesExW, GetDC, ReleaseDC, DEFAULT_CHARSET, LOGFONTW, TEXTMETRICW,
    };

    unsafe extern "system" fn push_family(
        font: *const LOGFONTW,
        _metrics: *const TEXTMETRICW,
        _kind: u32,
        lparam: LPARAM,
    ) -> i32 {
        if font.is_null() || lparam == 0 {
            return 1;
        }
        let face = (*font).lfFaceName;
        let len = face
            .iter()
            .position(|unit| *unit == 0)
            .unwrap_or(face.len());
        let name = OsString::from_wide(&face[..len])
            .to_string_lossy()
            .into_owned();
        // Why: GDI reports one row per style, so dedupe at the callback and
        // keep the final sort stable and cheap.
        let out = &mut *(lparam as *mut Vec<String>);
        if !out.contains(&name) {
            out.push(name);
        }
        1
    }

    let mut names: Vec<String> = Vec::new();
    unsafe {
        let dc = GetDC(std::ptr::null_mut());
        if dc.is_null() {
            return Vec::new();
        }
        let mut probe: LOGFONTW = std::mem::zeroed();
        probe.lfCharSet = DEFAULT_CHARSET as u8;
        EnumFontFamiliesExW(
            dc,
            &probe,
            Some(push_family),
            &mut names as *mut Vec<String> as LPARAM,
            0,
        );
        ReleaseDC(std::ptr::null_mut(), dc);
    }
    names
}

#[cfg(not(windows))]
fn enumerate_windows_fonts() -> Vec<String> {
    Vec::new()
}

#[tauri::command]
pub(crate) fn poc_list_system_fonts() -> Vec<String> {
    if let Some(cached) = CACHED_FONTS.lock().ok().and_then(|guard| guard.clone()) {
        return cached;
    }
    let enumerated = unique_sorted(enumerate_windows_fonts());
    let fonts = if enumerated.is_empty() {
        fallback_fonts()
    } else {
        enumerated
    };
    if let Ok(mut guard) = CACHED_FONTS.lock() {
        *guard = Some(fonts.clone());
    }
    fonts
}

#[cfg(test)]
mod tests {
    use super::{fallback_fonts, unique_sorted};

    #[test]
    fn drops_blank_and_leading_dot_names_then_sorts_unique() {
        let fonts = unique_sorted(vec![
            "Consolas".to_string(),
            "  ".to_string(),
            ".Keyboard".to_string(),
            "Arial".to_string(),
            "Consolas".to_string(),
        ]);
        assert_eq!(fonts, vec!["Arial".to_string(), "Consolas".to_string()]);
    }

    #[test]
    fn fallback_covers_the_expected_windows_families() {
        let fonts = fallback_fonts();
        assert!(fonts.contains(&"Consolas".to_string()));
        assert!(fonts.contains(&"Cascadia Mono".to_string()));
        assert!(!fonts.is_empty());
    }
}
