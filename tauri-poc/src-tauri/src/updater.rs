use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_updater::UpdaterExt;
use url::Url;

const GITHUB_RELEASES_PER_PAGE: u32 = 100;
const GITHUB_API_TIMEOUT_SECS: u64 = 8;

pub const EVENT_UPDATER_STATUS: &str = "updater:status";

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "state")]
pub enum NativeUpdaterStatus {
    #[serde(rename = "idle")]
    Idle,
    #[serde(rename = "checking")]
    Checking {
        #[serde(rename = "userInitiated")]
        user_initiated: bool,
    },
    #[serde(rename = "available")]
    Available {
        version: String,
        changelog: Option<NativeChangelog>,
    },
    #[serde(rename = "not-available")]
    NotAvailable {
        #[serde(rename = "userInitiated")]
        user_initiated: bool,
    },
    #[serde(rename = "downloading")]
    Downloading { percent: f64, version: String },
    #[serde(rename = "downloaded")]
    Downloaded { version: String },
    #[serde(rename = "error")]
    Error { message: String },
}

#[derive(Debug, Clone, Serialize)]
pub struct NativeChangelog {
    pub release: NativeChangelogRelease,
    #[serde(rename = "releasesBehind")]
    pub releases_behind: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
pub struct NativeChangelogRelease {
    pub title: String,
    pub description: String,
    #[serde(rename = "releaseNotesUrl")]
    pub release_notes_url: String,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UpdaterCheckArgs {
    pub user_initiated: Option<bool>,
    pub include_prerelease: Option<bool>,
    pub include_perf_prerelease: Option<bool>,
    pub channel: Option<String>,
    pub target_tag: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdaterBuildListArgs {
    pub channel: String,
    pub force: Option<bool>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeReleaseBuild {
    pub tag: String,
    pub version: String,
    pub channel: String,
    pub name: Option<String>,
    pub published_at: Option<String>,
    pub release_url: String,
    pub installer_url: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeReleaseBuildListResult {
    pub ok: bool,
    pub channel: String,
    pub builds: Option<Vec<NativeReleaseBuild>>,
    pub message: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GitHubRelease {
    tag_name: Option<String>,
    name: Option<String>,
    draft: Option<bool>,
    published_at: Option<String>,
    html_url: Option<String>,
    assets: Option<Vec<GitHubAsset>>,
}

#[derive(Debug, Deserialize)]
struct GitHubAsset {
    name: Option<String>,
}

pub struct UpdaterState {
    pending_update: Mutex<Option<tauri_plugin_updater::Update>>,
    pending_bytes: Mutex<Option<Vec<u8>>>,
    status: Mutex<NativeUpdaterStatus>,
    pending_channel_build: Mutex<Option<ChannelBuildInstall>>,
}

impl Default for UpdaterState {
    fn default() -> Self {
        Self {
            pending_update: Mutex::new(None),
            pending_bytes: Mutex::new(None),
            status: Mutex::new(NativeUpdaterStatus::Idle),
            pending_channel_build: Mutex::new(None),
        }
    }
}

/// A GitHub-resolved build the signed updater cannot install itself.
/// Why kept: `poc_updater_download` must explain the manual-install route
/// instead of failing with a generic "no update" message.
#[derive(Debug, Clone)]
pub struct ChannelBuildInstall {
    version: String,
    installer_url: Option<String>,
    release_url: String,
}

fn configured_update_source() -> Result<(Vec<Url>, String), String> {
    let endpoints = std::env::var("ORCA_TAURI_UPDATER_ENDPOINTS")
        .map_err(|_| "Tauri updater is not configured for this build.".to_string())?
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| {
            Url::parse(value).map_err(|error| format!("Invalid updater endpoint: {error}"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    if endpoints.is_empty() {
        return Err("Tauri updater has no configured endpoints.".to_string());
    }
    let public_key = std::env::var("ORCA_TAURI_UPDATER_PUBLIC_KEY")
        .map_err(|_| "Tauri updater public key is not configured for this build.".to_string())?;
    if public_key.trim().is_empty() {
        return Err("Tauri updater public key is empty.".to_string());
    }
    Ok((endpoints, public_key))
}

fn publish_status(app: &AppHandle, state: &UpdaterState, status: NativeUpdaterStatus) {
    if let Ok(mut current) = state.status.lock() {
        *current = status.clone();
    }
    let _ = app.emit(EVENT_UPDATER_STATUS, status);
}

#[tauri::command]
pub fn poc_updater_get_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

#[tauri::command]
pub fn poc_updater_get_status(state: State<UpdaterState>) -> NativeUpdaterStatus {
    state
        .status
        .lock()
        .map(|status| status.clone())
        .unwrap_or(NativeUpdaterStatus::Idle)
}

/// Which GitHub-backed check a non-default `poc_updater_check` request asks for.
/// Why mirrored: Electron routes the same options through `UpdateCheckVariant`
/// in `updater-check-state.ts` — perf only matches `rc.N.perf` tags, prerelease
/// matches the stable/RC series with perf excluded.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ChannelCheckKind {
    /// Exact build jump from the settings picker (`check({channel, targetTag})`).
    Pinned,
    /// Ctrl+click modifier check: newest `X.Y.Z-rc.N.perf` tag only.
    Perf,
    /// Shift+click modifier check: newest stable-or-RC tag, perf excluded.
    Prerelease,
}

fn channel_check_kind(args: &UpdaterCheckArgs) -> Option<ChannelCheckKind> {
    if !args.channel.as_deref().unwrap_or("").is_empty()
        && !args.target_tag.as_deref().unwrap_or("").is_empty()
    {
        return Some(ChannelCheckKind::Pinned);
    }
    if args.include_perf_prerelease.unwrap_or(false) {
        return Some(ChannelCheckKind::Perf);
    }
    if args.include_prerelease.unwrap_or(false) {
        return Some(ChannelCheckKind::Prerelease);
    }
    None
}

fn clear_channel_build(state: &State<UpdaterState>) {
    if let Ok(mut pending) = state.pending_channel_build.lock() {
        *pending = None;
    }
}

/// Numeric release comparison mirroring `compareAppVersions`: core parts
/// numerically, stable above prerelease, identifiers numerically when both are
/// digits. Unparseable versions compare equal so a bad tag never wins a max.
fn compare_release_versions(left: &str, right: &str) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    let parse = |value: &str| {
        let normalized = value.trim().trim_start_matches(['v', 'V']);
        let (core, prerelease) = match normalized.split_once('-') {
            Some((core, pre)) => (core, Some(pre)),
            None => (normalized, None),
        };
        let mut parts = Vec::new();
        for part in core.split('.') {
            if part.is_empty() || !part.bytes().all(|byte| byte.is_ascii_digit()) {
                return None;
            }
            parts.push(part.parse::<u64>().unwrap_or(u64::MAX));
        }
        if parts.len() != 3 {
            return None;
        }
        let prerelease = match prerelease {
            Some(pre) if !pre.is_empty() => pre.split('.').map(str::to_string).collect(),
            Some(_) => return None,
            None => Vec::new(),
        };
        Some((parts, prerelease))
    };
    let (Some((left_core, left_pre)), Some((right_core, right_pre))) = (parse(left), parse(right))
    else {
        return Ordering::Equal;
    };
    for index in 0..3 {
        match left_core[index].cmp(&right_core[index]) {
            Ordering::Equal => {}
            ordering => return ordering,
        }
    }
    match (left_pre.is_empty(), right_pre.is_empty()) {
        (true, true) => Ordering::Equal,
        (true, false) => Ordering::Greater,
        (false, true) => Ordering::Less,
        (false, false) => {
            let width = left_pre.len().max(right_pre.len());
            for index in 0..width {
                match (left_pre.get(index), right_pre.get(index)) {
                    (None, None) => return Ordering::Equal,
                    (None, _) => return Ordering::Less,
                    (_, None) => return Ordering::Greater,
                    (Some(left_part), Some(right_part)) => {
                        let ordering = compare_prerelease_identifier(left_part, right_part);
                        if ordering != Ordering::Equal {
                            return ordering;
                        }
                    }
                }
            }
            Ordering::Equal
        }
    }
}

fn compare_prerelease_identifier(left: &str, right: &str) -> std::cmp::Ordering {
    let left_numeric = !left.is_empty() && left.bytes().all(|byte| byte.is_ascii_digit());
    let right_numeric = !right.is_empty() && right.bytes().all(|byte| byte.is_ascii_digit());
    match (left_numeric, right_numeric) {
        (true, true) => left
            .parse::<u64>()
            .unwrap_or(u64::MAX)
            .cmp(&right.parse::<u64>().unwrap_or(u64::MAX)),
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        (false, false) => left.cmp(right),
    }
}

/// Why explicit: perf tags are `X.Y.Z-rc.N.perf`, and a plain "contains perf"
/// test would also match a hypothetical stable `+perf` build-metadata suffix.
fn is_perf_prerelease_version(version: &str) -> bool {
    let base = version.trim().trim_start_matches(['v', 'V']);
    let prerelease = match base.split_once('-') {
        Some((_, pre)) => pre,
        None => return false,
    };
    let identifiers: Vec<&str> = prerelease.split('.').collect();
    identifiers.len() == 3
        && identifiers[0] == "rc"
        && !identifiers[1].is_empty()
        && identifiers[1].bytes().all(|byte| byte.is_ascii_digit())
        && identifiers[2] == "perf"
}

/// Resolves a channel/variant check against an already-fetched build list.
/// Returns the build to report, or `None` when the answer is "not available".
/// Why pinned-needs-downgrade: the picker jumps to older tags on purpose, so
/// only the running version itself counts as not-available.
fn resolve_channel_build<'a>(
    current_version: &str,
    kind: ChannelCheckKind,
    target_tag: &str,
    builds: &'a [NativeReleaseBuild],
) -> Option<&'a NativeReleaseBuild> {
    use std::cmp::Ordering;
    match kind {
        ChannelCheckKind::Pinned => {
            builds
                .iter()
                .find(|build| build.tag == target_tag)
                .filter(|build| {
                    compare_release_versions(&build.version, current_version) != Ordering::Equal
                })
        }
        ChannelCheckKind::Prerelease => builds
            .iter()
            .filter(|build| !is_perf_prerelease_version(&build.version))
            .filter(|build| {
                compare_release_versions(&build.version, current_version) == Ordering::Greater
            })
            .max_by(|left, right| compare_release_versions(&left.version, &right.version)),
        ChannelCheckKind::Perf => builds
            .iter()
            .filter(|build| is_perf_prerelease_version(&build.version))
            .filter(|build| {
                compare_release_versions(&build.version, current_version) == Ordering::Greater
            })
            .max_by(|left, right| compare_release_versions(&left.version, &right.version)),
    }
}

/// GitHub-backed availability check for pinned builds and modifier-click
/// variants. The signed updater feed has no channel concept, so these resolve
/// against the release list and report availability with the release-page URL;
/// installation stays manual (see `poc_updater_download`).
async fn check_github_channel_build(
    app: AppHandle,
    state: &State<'_, UpdaterState>,
    user_initiated: bool,
    kind: ChannelCheckKind,
    channel: String,
    target_tag: String,
) -> Result<NativeUpdaterStatus, String> {
    publish_status(
        &app,
        state,
        NativeUpdaterStatus::Checking { user_initiated },
    );
    // Why up front: a stale signed pending_update must not survive into a
    // channel result, or Download would install a build the check never reported.
    clear_channel_build(state);
    if let Ok(mut pending) = state.pending_update.lock() {
        *pending = None;
    }
    if let Ok(mut bytes) = state.pending_bytes.lock() {
        *bytes = None;
    }
    // Why `rc` for bare variants: Shift/Ctrl+click checks run against the main
    // repo series, exactly like Electron's atom-feed preflight.
    let channel_name = if channel.is_empty() {
        "rc"
    } else {
        channel.as_str()
    };
    let builds = match list_github_builds(channel_name).await {
        Ok(builds) => builds,
        Err(message) => {
            let status = NativeUpdaterStatus::Error {
                message: message.clone(),
            };
            publish_status(&app, state, status.clone());
            return Err(message);
        }
    };
    let current_version = app.package_info().version.to_string();
    match resolve_channel_build(&current_version, kind, &target_tag, &builds) {
        Some(build) => {
            if let Ok(mut pending) = state.pending_channel_build.lock() {
                *pending = Some(ChannelBuildInstall {
                    version: build.version.clone(),
                    installer_url: build.installer_url.clone(),
                    release_url: build.release_url.clone(),
                });
            }
            let status = NativeUpdaterStatus::Available {
                version: build.version.clone(),
                changelog: Some(NativeChangelog {
                    release: NativeChangelogRelease {
                        title: format!("Orca {}", build.version),
                        description: build.name.clone().unwrap_or_default(),
                        release_notes_url: build.release_url.clone(),
                    },
                    releases_behind: None,
                }),
            };
            publish_status(&app, state, status.clone());
            Ok(status)
        }
        None => {
            if kind == ChannelCheckKind::Pinned
                && !builds.iter().any(|build| build.tag == target_tag)
            {
                let message = format!("No build \"{target_tag}\" in the {channel_name} channel.");
                let status = NativeUpdaterStatus::Error {
                    message: message.clone(),
                };
                publish_status(&app, state, status.clone());
                return Err(message);
            }
            let status = NativeUpdaterStatus::NotAvailable { user_initiated };
            publish_status(&app, state, status.clone());
            Ok(status)
        }
    }
}

#[tauri::command]
pub async fn poc_updater_check(
    app: AppHandle,
    state: State<'_, UpdaterState>,
    args: Option<UpdaterCheckArgs>,
) -> Result<NativeUpdaterStatus, String> {
    let args = args.unwrap_or_default();
    let user_initiated = args.user_initiated.unwrap_or(true);
    if let Some(kind) = channel_check_kind(&args) {
        return check_github_channel_build(
            app,
            &state,
            user_initiated,
            kind,
            args.channel.unwrap_or_default(),
            args.target_tag.unwrap_or_default(),
        )
        .await;
    }
    clear_channel_build(&state);
    publish_status(
        &app,
        &state,
        NativeUpdaterStatus::Checking { user_initiated },
    );
    let (endpoints, public_key) = match configured_update_source() {
        Ok(source) => source,
        Err(error) => {
            let status = NativeUpdaterStatus::Error {
                message: error.clone(),
            };
            publish_status(&app, &state, status.clone());
            return Err(error);
        }
    };
    let updater = app
        .updater_builder()
        .endpoints(endpoints)
        .map_err(|error| error.to_string())?
        .pubkey(public_key)
        .build()
        .map_err(|error| error.to_string())?;
    match updater.check().await {
        Ok(Some(update)) => {
            let status = NativeUpdaterStatus::Available {
                version: update.version.clone(),
                changelog: update.body.clone().map(|description| NativeChangelog {
                    release: NativeChangelogRelease {
                        title: format!("Orca {}", update.version),
                        description,
                        release_notes_url: update.download_url.to_string(),
                    },
                    releases_behind: None,
                }),
            };
            if let Ok(mut pending) = state.pending_update.lock() {
                *pending = Some(update);
            }
            if let Ok(mut bytes) = state.pending_bytes.lock() {
                *bytes = None;
            }
            publish_status(&app, &state, status.clone());
            Ok(status)
        }
        Ok(None) => {
            let status = NativeUpdaterStatus::NotAvailable { user_initiated };
            publish_status(&app, &state, status.clone());
            Ok(status)
        }
        Err(error) => {
            let status = NativeUpdaterStatus::Error {
                message: error.to_string(),
            };
            publish_status(&app, &state, status.clone());
            Err(status_message(&status))
        }
    }
}

/// Lists published builds for the settings picker without coupling Tauri to the
/// Electron updater's in-process release cache.
#[tauri::command]
pub async fn poc_updater_list_builds(args: UpdaterBuildListArgs) -> NativeReleaseBuildListResult {
    // Tauri does not keep a process-global release cache yet, so every request
    // is already equivalent to Electron's forced refresh path.
    let _force = args.force.unwrap_or(false);
    let channel = args.channel;
    let result = list_github_builds(&channel).await;
    match result {
        Ok(builds) => NativeReleaseBuildListResult {
            ok: true,
            channel,
            builds: Some(builds),
            message: None,
        },
        Err(message) => NativeReleaseBuildListResult {
            ok: false,
            channel,
            builds: None,
            message: Some(message),
        },
    }
}

async fn list_github_builds(channel: &str) -> Result<Vec<NativeReleaseBuild>, String> {
    let repository = match channel {
        "stable" | "rc" => "stablyai/orca",
        "hourly" => "stablyai/orca-hourly",
        "daily" => "stablyai/orca-daily",
        "adhoc" => "stablyai/orca-adhoc",
        _ => return Err(format!("Unknown release channel \"{channel}\".")),
    };
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(GITHUB_API_TIMEOUT_SECS))
        .user_agent("Orca Tauri updater")
        .build()
        .map_err(|error| format!("Could not initialize the release client: {error}"))?;
    let url = format!(
        "https://api.github.com/repos/{repository}/releases?per_page={GITHUB_RELEASES_PER_PAGE}"
    );
    let mut request = client
        .get(url)
        .header("Accept", "application/vnd.github+json");
    if let Some(token) = std::env::var("GH_TOKEN")
        .ok()
        .or_else(|| std::env::var("GITHUB_TOKEN").ok())
    {
        request = request.bearer_auth(token);
    }
    let response = request
        .send()
        .await
        .map_err(|error| format!("Could not list {channel} builds: {error}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(if status.as_u16() == 404 {
            format!("No releases repository found at {repository}.")
        } else if status.as_u16() == 403 || status.as_u16() == 429 {
            format!("GitHub rate limit reached while listing {channel} builds.")
        } else {
            format!("Could not list {channel} builds (HTTP {status}).")
        });
    }
    let releases = response
        .json::<Vec<GitHubRelease>>()
        .await
        .map_err(|error| format!("Could not read the {channel} release list: {error}"))?;
    let mut builds = releases
        .into_iter()
        .filter_map(|release| parse_release_build(release, repository, channel))
        .collect::<Vec<_>>();
    // Why numeric and not lexicographic: plain string order puts `1.4.9`
    // above `1.4.214`, which misorders the settings picker and the "newest"
    // resolution in `resolve_channel_build`.
    builds.sort_by(|left, right| compare_release_versions(&right.version, &left.version));
    Ok(builds)
}

fn parse_release_build(
    release: GitHubRelease,
    repository: &str,
    requested_channel: &str,
) -> Option<NativeReleaseBuild> {
    if release.draft.unwrap_or(false) {
        return None;
    }
    let tag = release.tag_name?;
    let version = tag.strip_prefix('v').unwrap_or(&tag).to_owned();
    if !is_supported_release_version(&version)
        || release_channel_for_version(&version) != requested_channel
    {
        return None;
    }
    let assets = release
        .assets
        .unwrap_or_default()
        .into_iter()
        .filter_map(|asset| asset.name)
        .collect::<Vec<_>>();
    if !has_installable_asset(&assets) {
        return None;
    }
    let encoded_tag = utf8_percent_encode(&tag, NON_ALPHANUMERIC).to_string();
    let release_url = release
        .html_url
        .unwrap_or_else(|| format!("https://github.com/{repository}/releases/tag/{encoded_tag}"));
    let name = release
        .name
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty() && value != &tag);
    let installer_url = find_installer_asset(&assets).map(|asset| {
        format!(
            "https://github.com/{repository}/releases/download/{}/{}",
            encoded_tag,
            utf8_percent_encode(asset, NON_ALPHANUMERIC)
        )
    });
    Some(NativeReleaseBuild {
        tag,
        version,
        channel: requested_channel.to_owned(),
        name,
        published_at: release.published_at,
        release_url,
        installer_url,
    })
}

fn release_channel_for_version(version: &str) -> &'static str {
    if version.contains("-hourly.") {
        "hourly"
    } else if version.contains("-daily.") {
        "daily"
    } else if version.contains("-adhoc.") {
        "adhoc"
    } else if version.contains('-') {
        "rc"
    } else {
        "stable"
    }
}

fn is_supported_release_version(version: &str) -> bool {
    let (base, prerelease) = version
        .split_once('-')
        .map_or((version, None), |(base, suffix)| (base, Some(suffix)));
    let base_parts = base.split('.').collect::<Vec<_>>();
    base_parts.len() == 3
        && base_parts
            .iter()
            .all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
        && prerelease.map_or(true, |suffix| !suffix.is_empty())
}

fn has_installable_asset(assets: &[String]) -> bool {
    if cfg!(target_os = "windows") {
        assets
            .iter()
            .any(|asset| asset.eq_ignore_ascii_case("latest.yml"))
    } else if cfg!(target_os = "macos") {
        assets
            .iter()
            .any(|asset| asset.to_ascii_lowercase().ends_with(".dmg"))
    } else if cfg!(target_os = "linux") {
        assets.iter().any(|asset| {
            asset.eq_ignore_ascii_case("latest-linux.yml")
                || asset.eq_ignore_ascii_case("latest-linux-arm64.yml")
        })
    } else {
        true
    }
}

fn find_installer_asset(assets: &[String]) -> Option<&str> {
    if cfg!(target_os = "windows") {
        assets
            .iter()
            .find(|asset| asset.to_ascii_lowercase().ends_with("windows-setup.exe"))
            .map(String::as_str)
    } else if cfg!(target_os = "macos") {
        assets
            .iter()
            .find(|asset| asset.to_ascii_lowercase().ends_with(".dmg"))
            .map(String::as_str)
    } else if cfg!(target_os = "linux") {
        assets
            .iter()
            .find(|asset| asset.to_ascii_lowercase().ends_with(".appimage"))
            .map(String::as_str)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::{
        channel_check_kind, compare_release_versions, has_installable_asset,
        is_perf_prerelease_version, is_supported_release_version, release_channel_for_version,
        resolve_channel_build, ChannelCheckKind, NativeReleaseBuild, UpdaterCheckArgs,
    };
    use std::cmp::Ordering;

    fn channel_build(tag: &str, version: &str) -> NativeReleaseBuild {
        NativeReleaseBuild {
            tag: tag.to_string(),
            version: version.to_string(),
            channel: "rc".to_string(),
            name: None,
            published_at: None,
            release_url: format!("https://github.com/stablyai/orca/releases/tag/{tag}"),
            installer_url: None,
        }
    }

    fn check_args(
        include_prerelease: bool,
        include_perf_prerelease: bool,
        channel: Option<&str>,
        target_tag: Option<&str>,
    ) -> UpdaterCheckArgs {
        UpdaterCheckArgs {
            user_initiated: Some(true),
            include_prerelease: Some(include_prerelease),
            include_perf_prerelease: Some(include_perf_prerelease),
            channel: channel.map(str::to_string),
            target_tag: target_tag.map(str::to_string),
        }
    }

    #[test]
    fn classifies_release_channels_from_version_stamps() {
        assert_eq!(release_channel_for_version("1.4.214"), "stable");
        assert_eq!(release_channel_for_version("1.4.214-rc.1"), "rc");
        assert_eq!(
            release_channel_for_version("1.4.214-hourly.202610190300"),
            "hourly"
        );
        assert_eq!(
            release_channel_for_version("1.4.214-daily.202610190300"),
            "daily"
        );
        assert_eq!(
            release_channel_for_version("1.4.214-adhoc.20261019030000"),
            "adhoc"
        );
    }

    #[test]
    fn rejects_non_semver_release_tags() {
        assert!(is_supported_release_version("1.4.214"));
        assert!(is_supported_release_version("1.4.214-rc.1"));
        assert!(!is_supported_release_version("latest"));
        assert!(!is_supported_release_version("1.4"));
        assert!(!is_supported_release_version("1.4.214-"));
    }

    #[test]
    fn compares_release_versions_numerically() {
        assert_eq!(compare_release_versions("1.4.9", "1.4.214"), Ordering::Less);
        assert_eq!(
            compare_release_versions("1.4.214", "1.4.214"),
            Ordering::Equal
        );
        assert_eq!(
            compare_release_versions("2.0.0", "1.9.9"),
            Ordering::Greater
        );
        // Why stable above prerelease: mirrors `compareAppVersions`.
        assert_eq!(
            compare_release_versions("1.4.214", "1.4.214-rc.1"),
            Ordering::Greater
        );
        assert_eq!(
            compare_release_versions("1.4.214-rc.1", "1.4.214-rc.2"),
            Ordering::Less
        );
        assert_eq!(
            compare_release_versions("1.4.214-rc.1", "1.4.214-rc.1.perf"),
            Ordering::Less
        );
        // Why equal on garbage: an unparseable tag must never win a newest pick.
        assert_eq!(
            compare_release_versions("latest", "1.4.214"),
            Ordering::Equal
        );
        assert_eq!(compare_release_versions("1.4", "1.4.214"), Ordering::Equal);
    }

    #[test]
    fn detects_perf_prerelease_versions() {
        assert!(is_perf_prerelease_version("1.4.214-rc.1.perf"));
        assert!(!is_perf_prerelease_version("1.4.214-rc.1"));
        assert!(!is_perf_prerelease_version("1.4.214"));
        assert!(!is_perf_prerelease_version("1.4.214-hourly.202610190300"));
        assert!(!is_perf_prerelease_version("1.4.214-rc.perf"));
    }

    #[test]
    fn routes_check_args_to_channel_check_kinds() {
        assert_eq!(channel_check_kind(&UpdaterCheckArgs::default()), None);
        assert_eq!(
            channel_check_kind(&check_args(true, false, None, None)),
            Some(ChannelCheckKind::Prerelease)
        );
        // Why perf wins: Electron's variant routing checks perf first too.
        assert_eq!(
            channel_check_kind(&check_args(true, true, None, None)),
            Some(ChannelCheckKind::Perf)
        );
        assert_eq!(
            channel_check_kind(&check_args(false, false, Some("rc"), Some("v1.4.1"))),
            Some(ChannelCheckKind::Pinned)
        );
        // Why none: a pinned check needs both parts, like Electron's options trio.
        assert_eq!(
            channel_check_kind(&check_args(false, false, Some("rc"), None)),
            None
        );
    }

    #[test]
    fn resolves_pinned_builds_including_older_ones() {
        let builds = vec![
            channel_build("v1.4.214", "1.4.214"),
            channel_build("v1.4.200", "1.4.200"),
        ];
        let found = resolve_channel_build("1.4.214", ChannelCheckKind::Pinned, "v1.4.200", &builds);
        assert_eq!(found.map(|build| build.version.as_str()), Some("1.4.200"));
        // Why none: jumping to the running build is a not-available, not an error.
        assert!(
            resolve_channel_build("1.4.214", ChannelCheckKind::Pinned, "v1.4.214", &builds)
                .is_none()
        );
        assert!(
            resolve_channel_build("1.4.214", ChannelCheckKind::Pinned, "v9.9.9", &builds).is_none()
        );
    }

    #[test]
    fn resolves_variant_checks_to_the_newest_matching_build() {
        let builds = vec![
            channel_build("v1.4.214", "1.4.214"),
            channel_build("v1.4.220-rc.1", "1.4.220-rc.1"),
            channel_build("v1.4.230-rc.2.perf", "1.4.230-rc.2.perf"),
        ];
        // Why rc.1: the prerelease series skips perf tags even when newer.
        let prerelease =
            resolve_channel_build("1.4.214", ChannelCheckKind::Prerelease, "", &builds);
        assert_eq!(
            prerelease.map(|build| build.version.as_str()),
            Some("1.4.220-rc.1")
        );
        let perf = resolve_channel_build("1.4.214", ChannelCheckKind::Perf, "", &builds);
        assert_eq!(
            perf.map(|build| build.version.as_str()),
            Some("1.4.230-rc.2.perf")
        );
        // Why none: nothing newer on either series.
        assert!(resolve_channel_build(
            "1.4.230-rc.2.perf",
            ChannelCheckKind::Prerelease,
            "",
            &builds
        )
        .is_none());
        assert!(
            resolve_channel_build("1.4.230-rc.2.perf", ChannelCheckKind::Perf, "", &builds)
                .is_none()
        );
    }

    #[test]
    fn requires_the_platform_manifest_before_listing_a_build() {
        if cfg!(target_os = "windows") {
            assert!(has_installable_asset(&["latest.yml".to_string()]));
            assert!(!has_installable_asset(&[
                "Orca-windows-setup.exe".to_string()
            ]));
        } else if cfg!(target_os = "macos") {
            assert!(has_installable_asset(&["Orca.dmg".to_string()]));
        } else if cfg!(target_os = "linux") {
            assert!(has_installable_asset(&["latest-linux.yml".to_string()]));
        }
    }
}

#[tauri::command]
pub async fn poc_updater_download(
    app: AppHandle,
    state: State<'_, UpdaterState>,
) -> Result<NativeUpdaterStatus, String> {
    let update = state
        .pending_update
        .lock()
        .map_err(|_| "Updater state is unavailable.".to_string())?
        .clone()
        .ok_or_else(|| {
            // Why a guided error: channel/variant checks resolve GitHub builds
            // the signed feed cannot install, mirroring Electron's pinned
            // dev-channel error that points at the release page instead.
            if let Ok(pending) = state.pending_channel_build.lock() {
                if let Some(build) = pending.as_ref() {
                    let location = build.installer_url.as_deref().unwrap_or(&build.release_url);
                    return format!(
                        "Build {} cannot be installed by the signed updater. Download the installer from {} and run it once — updates work normally from there, including back to Stable.",
                        build.version, location
                    );
                }
            }
            "No update is available to download.".to_string()
        })?;
    let version = update.version.clone();
    let progress_version = version.clone();
    let app_for_progress = app.clone();
    let mut downloaded_bytes = 0u64;
    let bytes = update
        .download(
            move |chunk_length, content_length| {
                downloaded_bytes = downloaded_bytes.saturating_add(chunk_length as u64);
                let percent = content_length
                    .filter(|length| *length > 0)
                    .map(|length| ((downloaded_bytes as f64 / length as f64) * 100.0).min(100.0))
                    .unwrap_or(0.0);
                let state = app_for_progress.state::<UpdaterState>();
                publish_status(
                    &app_for_progress,
                    &state,
                    NativeUpdaterStatus::Downloading {
                        percent,
                        version: progress_version.clone(),
                    },
                );
            },
            || {},
        )
        .await
        .map_err(|error| error.to_string())?;
    if let Ok(mut pending_bytes) = state.pending_bytes.lock() {
        *pending_bytes = Some(bytes);
    }
    let status = NativeUpdaterStatus::Downloaded { version };
    publish_status(&app, &state, status.clone());
    Ok(status)
}

#[tauri::command]
pub fn poc_updater_quit_and_install(
    app: AppHandle,
    state: State<'_, UpdaterState>,
) -> Result<(), String> {
    let update = state
        .pending_update
        .lock()
        .map_err(|_| "Updater state is unavailable.".to_string())?
        .clone()
        .ok_or_else(|| "No update is available to install.".to_string())?;
    let bytes = state
        .pending_bytes
        .lock()
        .map_err(|_| "Updater state is unavailable.".to_string())?
        .take()
        .ok_or_else(|| "Download the update before installing it.".to_string())?;
    update.install(bytes).map_err(|error| error.to_string())?;
    app.exit(0);
    Ok(())
}

#[tauri::command]
pub fn poc_updater_dismiss_nudge() {}

#[tauri::command]
pub fn poc_updater_dismiss_available_update() {}

fn status_message(status: &NativeUpdaterStatus) -> String {
    match status {
        NativeUpdaterStatus::Error { message } => message.clone(),
        _ => "Updater operation failed.".to_string(),
    }
}
