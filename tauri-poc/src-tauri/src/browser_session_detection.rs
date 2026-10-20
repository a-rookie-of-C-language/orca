use serde::Serialize;
use serde_json::Value;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

const MAX_LOCAL_STATE_BYTES: u64 = 4 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DetectedBrowserProfile {
    pub name: String,
    pub directory: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DetectedBrowser {
    pub family: String,
    pub label: String,
    pub profiles: Vec<DetectedBrowserProfile>,
    pub selected_profile: String,
}

struct ChromiumBrowserDefinition {
    family: &'static str,
    label: &'static str,
    mac_root: Option<&'static str>,
    windows_root: Option<&'static str>,
    linux_root: Option<&'static str>,
}

const CHROMIUM_BROWSERS: &[ChromiumBrowserDefinition] = &[
    ChromiumBrowserDefinition {
        family: "chrome",
        label: "Google Chrome",
        mac_root: Some("Google/Chrome"),
        windows_root: Some("Google/Chrome/User Data"),
        linux_root: Some("google-chrome"),
    },
    ChromiumBrowserDefinition {
        family: "edge",
        label: "Microsoft Edge",
        mac_root: Some("Microsoft Edge"),
        windows_root: Some("Microsoft/Edge/User Data"),
        linux_root: Some("microsoft-edge"),
    },
    ChromiumBrowserDefinition {
        family: "arc",
        label: "Arc",
        mac_root: Some("Arc/User Data"),
        windows_root: None,
        linux_root: None,
    },
    ChromiumBrowserDefinition {
        family: "chromium",
        label: "Brave",
        mac_root: Some("BraveSoftware/Brave-Browser"),
        windows_root: Some("BraveSoftware/Brave-Browser/User Data"),
        linux_root: Some("BraveSoftware/Brave-Browser"),
    },
    ChromiumBrowserDefinition {
        family: "comet",
        label: "Comet",
        mac_root: Some("Comet"),
        windows_root: Some("Perplexity/Comet/User Data"),
        linux_root: None,
    },
    ChromiumBrowserDefinition {
        family: "helium",
        label: "Helium",
        mac_root: Some("net.imput.helium"),
        windows_root: None,
        linux_root: None,
    },
];

pub fn detect_installed_browsers() -> Vec<DetectedBrowser> {
    let mut detected = Vec::new();
    for browser in CHROMIUM_BROWSERS {
        let Some(root) = chromium_root(browser) else {
            continue;
        };
        let profiles = discover_chromium_profiles(&root);
        let Some(selected_profile) = profiles
            .iter()
            .find(|profile| chromium_cookie_path(&root.join(&profile.directory)).is_some())
            .map(|profile| profile.directory.clone())
        else {
            continue;
        };
        detected.push(DetectedBrowser {
            family: browser.family.to_owned(),
            label: browser.label.to_owned(),
            profiles,
            selected_profile,
        });
    }

    if let Some(browser) = detect_firefox() {
        detected.push(browser);
    }
    if let Some(browser) = detect_safari() {
        detected.push(browser);
    }
    detected
}

pub fn browser_cookie_path(
    browser: &DetectedBrowser,
    profile_directory: Option<&str>,
) -> Option<PathBuf> {
    let directory = profile_directory.unwrap_or(&browser.selected_profile);
    if !is_safe_profile_directory(directory) {
        return None;
    }
    if browser.family == "firefox" {
        let root = firefox_profiles_root()?;
        let path = root.join(directory).join("cookies.sqlite");
        return path.is_file().then_some(path);
    }
    if browser.family == "safari" {
        return safari_cookie_path();
    }
    let definition = CHROMIUM_BROWSERS
        .iter()
        .find(|definition| definition.family == browser.family)?;
    chromium_root(definition)
        .map(|root| root.join(directory))
        .and_then(|profile| chromium_cookie_path(&profile))
}

fn chromium_root(browser: &ChromiumBrowserDefinition) -> Option<PathBuf> {
    match env::consts::OS {
        "macos" => browser.mac_root.and_then(|root| {
            home_dir().map(|home| home.join("Library/Application Support").join(root))
        }),
        "windows" => browser.windows_root.and_then(|root| {
            env::var_os("LOCALAPPDATA").map(|path| PathBuf::from(path).join(root))
        }),
        _ => browser
            .linux_root
            .and_then(|root| linux_config_dir().map(|path| path.join(root))),
    }
}

fn discover_chromium_profiles(browser_root: &Path) -> Vec<DetectedBrowserProfile> {
    let local_state = browser_root.join("Local State");
    let profiles = fs::read(&local_state)
        .ok()
        .filter(|bytes| bytes.len() as u64 <= MAX_LOCAL_STATE_BYTES)
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .and_then(|value| {
            value
                .get("profile")?
                .get("info_cache")?
                .as_object()
                .cloned()
        });

    let Some(profiles) = profiles else {
        return vec![default_profile()];
    };

    let profiles = profiles
        .into_iter()
        .filter_map(|(directory, info)| {
            if !is_safe_profile_directory(&directory) {
                return None;
            }
            let name = info
                .get("name")
                .and_then(Value::as_str)
                .filter(|name| !name.is_empty())
                .unwrap_or(&directory)
                .to_owned();
            Some(DetectedBrowserProfile { name, directory })
        })
        .collect::<Vec<_>>();
    if profiles.is_empty() {
        vec![default_profile()]
    } else {
        profiles
    }
}

fn detect_firefox() -> Option<DetectedBrowser> {
    let root = firefox_profiles_root()?;
    let profiles = discover_firefox_profiles(&root);
    let selected_profile = profiles
        .iter()
        .find(|profile| {
            root.join(&profile.directory)
                .join("cookies.sqlite")
                .is_file()
        })?
        .directory
        .clone();
    Some(DetectedBrowser {
        family: "firefox".to_owned(),
        label: "Firefox".to_owned(),
        profiles,
        selected_profile,
    })
}

fn discover_firefox_profiles(root: &Path) -> Vec<DetectedBrowserProfile> {
    let Ok(entries) = fs::read_dir(root) else {
        return Vec::new();
    };
    let mut directories = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let file_type = entry.file_type().ok()?;
            let name = entry.file_name().to_string_lossy().into_owned();
            (file_type.is_dir() && is_safe_profile_directory(&name)).then_some(name)
        })
        .collect::<Vec<_>>();
    directories.sort_by(|left, right| {
        profile_priority(left)
            .cmp(&profile_priority(right))
            .then_with(|| left.cmp(right))
    });
    directories
        .into_iter()
        .map(|directory| DetectedBrowserProfile {
            name: directory
                .split_once('.')
                .map(|(_, name)| name.to_owned())
                .unwrap_or_else(|| directory.clone()),
            directory,
        })
        .collect()
}

fn profile_priority(directory: &str) -> u8 {
    if directory.contains("default-release") {
        0
    } else if directory.contains("default") {
        1
    } else {
        2
    }
}

fn detect_safari() -> Option<DetectedBrowser> {
    let path = safari_cookie_path()?;
    if !path.is_file() {
        return None;
    }
    Some(DetectedBrowser {
        family: "safari".to_owned(),
        label: "Safari".to_owned(),
        profiles: vec![default_profile()],
        selected_profile: "Default".to_owned(),
    })
}

fn safari_cookie_path() -> Option<PathBuf> {
    if env::consts::OS != "macos" {
        return None;
    }
    let home = home_dir()?;
    [
        home.join("Library/Cookies/Cookies.binarycookies"),
        home.join("Library/Containers/com.apple.Safari/Data/Library/Cookies/Cookies.binarycookies"),
    ]
    .into_iter()
    .find(|path| path.is_file())
}

fn firefox_profiles_root() -> Option<PathBuf> {
    match env::consts::OS {
        "macos" => Some(home_dir()?.join("Library/Application Support/Firefox/Profiles")),
        "windows" => Some(PathBuf::from(env::var_os("APPDATA")?).join("Mozilla/Firefox/Profiles")),
        _ => Some(home_dir()?.join(".mozilla/firefox")),
    }
}

fn linux_config_dir() -> Option<PathBuf> {
    env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| home_dir().map(|home| home.join(".config")))
}

fn home_dir() -> Option<PathBuf> {
    env::var_os("HOME")
        .map(PathBuf::from)
        .or_else(|| env::var_os("USERPROFILE").map(PathBuf::from))
}

fn chromium_cookie_path(profile: &Path) -> Option<PathBuf> {
    let network = profile.join("Network/Cookies");
    if network.is_file() {
        return Some(network);
    }
    let legacy = profile.join("Cookies");
    legacy.is_file().then_some(legacy)
}

fn default_profile() -> DetectedBrowserProfile {
    DetectedBrowserProfile {
        name: "Default".to_owned(),
        directory: "Default".to_owned(),
    }
}

fn is_safe_profile_directory(directory: &str) -> bool {
    !directory.is_empty()
        && directory != "."
        && !directory.contains('\0')
        && !directory.contains('/')
        && !directory.contains('\\')
        && !directory.contains("..")
}

#[cfg(test)]
mod tests {
    use super::{discover_chromium_profiles, is_safe_profile_directory, profile_priority};
    use serde_json::json;
    use std::fs;

    #[test]
    fn ignores_unsafe_profile_directories_and_keeps_display_names() {
        let directory = tempfile::tempdir().expect("temporary directory");
        fs::write(
            directory.path().join("Local State"),
            serde_json::to_vec(&json!({
                "profile": {"info_cache": {
                    "Default": {"name": "Personal"},
                    "Profile 1": {"name": "Work"},
                    "../escape": {"name": "Bad"}
                }}
            }))
            .expect("serialize local state"),
        )
        .expect("write local state");

        let profiles = discover_chromium_profiles(directory.path());
        assert_eq!(profiles.len(), 2);
        assert_eq!(profiles[0].name, "Personal");
        assert_eq!(profiles[1].directory, "Profile 1");
    }

    #[test]
    fn profile_validation_matches_the_filesystem_boundary() {
        assert!(is_safe_profile_directory("Default"));
        assert!(!is_safe_profile_directory("../Default"));
        assert!(!is_safe_profile_directory("Profile/1"));
        assert!(!is_safe_profile_directory(""));
        assert_eq!(profile_priority("abc.default-release"), 0);
    }
}
