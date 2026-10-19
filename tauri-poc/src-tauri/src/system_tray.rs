//! Native system-tray parity with Electron tray module.
//!
//! Windows notification-area icon and macOS menu-bar status item; every other
//! platform reports unavailable. Labels stay renderer-owned (translated) so a
//! locale change rebuilds the menu without touching Rust; main.rs routes the
//! menu-item and click events.

use image::codecs::png::{CompressionType, FilterType, PngEncoder};
use image::{ExtendedColorType, ImageEncoder};
use serde::Deserialize;
use std::sync::Mutex;
use tauri::image::Image;
use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
#[cfg(target_os = "macos")]
use tauri::Manager;
use tauri::{AppHandle, State};

/// Menu-event ids, shared with the handler in `main.rs`.
pub mod ids {
    pub const TRAY_OPEN: &str = "tray-open";
    pub const TRAY_OPEN_SETTINGS: &str = "tray-open-settings";
    pub const TRAY_CHECK_FOR_UPDATES: &str = "tray-check-for-updates";
    pub const TRAY_QUIT: &str = "tray-quit";
}

/// Tray menu-item routing, shared with the `handle_menu_event` branch in
/// `main.rs`. Pure so the id-to-action mapping is unit-testable without a
/// window; delivering an actual OS click to it still needs a visible run
/// with OS-level input.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrayMenuRoute {
    Open,
    OpenSettings,
    CheckForUpdates,
    Quit,
}

pub fn tray_menu_route(id: &str) -> Option<TrayMenuRoute> {
    match id {
        ids::TRAY_OPEN => Some(TrayMenuRoute::Open),
        ids::TRAY_OPEN_SETTINGS => Some(TrayMenuRoute::OpenSettings),
        ids::TRAY_CHECK_FOR_UPDATES => Some(TrayMenuRoute::CheckForUpdates),
        ids::TRAY_QUIT => Some(TrayMenuRoute::Quit),
        _ => None,
    }
}

pub const TRAY_ICON_ID: &str = "main-tray";
// Windows notification-area glyph: the app icon is larger, so pull this size
// from the icon resource instead of letting the shell shrink it.
const TRAY_ICON_PX: u32 = 16;
// Amber-500, Orca needs-attention color, over a near-white halo ring.
const DOT_R: u8 = 0xf5;
const DOT_G: u8 = 0x9e;
const DOT_B: u8 = 0x0b;
const RING_R: u8 = 0xff;
const RING_G: u8 = 0xff;
const RING_B: u8 = 0xff;
// Pixel-caps DEV badge stamped left of the macOS glyph on dev instances.
#[cfg(any(target_os = "macos", test))]
const DEV_BADGE_ROWS: [&str; 5] = [
    "##..###.#.#",
    "#.#.#...#.#",
    "#.#.##..#.#",
    "#.#.#...#.#",
    "##..###..#.",
];
#[cfg(any(target_os = "macos", test))]
const DEV_BADGE_OFFSET_X: u32 = 0;
#[cfg(any(target_os = "macos", test))]
const DEV_BADGE_OFFSET_Y: u32 = 3;
// The orca tail touches the badge V stroke, so clear a margin first.
#[cfg(any(target_os = "macos", test))]
const DEV_BADGE_CLEAR_MARGIN: u32 = 1;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrayLabels {
    pub open_label: String,
    pub settings_label: Option<String>,
    pub check_updates_label: Option<String>,
    pub quit_label: String,
    pub activity_waiting: String,
    pub activity_waiting_suffix: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrayEnsureArgs {
    pub is_dev: bool,
    pub dev_label: Option<String>,
    #[serde(flatten)]
    pub labels: TrayLabels,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrayAttentionArgs {
    pub active: bool,
}

#[derive(Debug, Default)]
pub struct SystemTrayState {
    inner: Mutex<SystemTrayInner>,
}

#[derive(Debug, Default)]
struct SystemTrayInner {
    // Desired attention state; remembered so a tray created later reflects it.
    attention: bool,
    ensure: Option<TrayEnsureArgs>,
}

impl SystemTrayState {
    fn snapshot(&self) -> (bool, Option<TrayEnsureArgs>) {
        self.inner
            .lock()
            .map(|inner| (inner.attention, inner.ensure.clone()))
            .unwrap_or_default()
    }

    fn store(&self, args: TrayEnsureArgs) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.ensure = Some(args);
        }
    }

    fn set_attention(&self, active: bool) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.attention = active;
        }
    }
}

fn base_tooltip(is_dev: bool, dev_label: Option<&str>) -> String {
    if !is_dev {
        return "Orca".to_owned();
    }
    match dev_label {
        Some(label) if !label.is_empty() => format!("Orca DEV ({label})"),
        _ => "Orca DEV".to_owned(),
    }
}

fn attention_tooltip(args: &TrayEnsureArgs) -> String {
    if args.is_dev {
        format!(
            "{} - {}",
            base_tooltip(true, args.dev_label.as_deref()),
            args.labels.activity_waiting_suffix
        )
    } else {
        args.labels.activity_waiting.clone()
    }
}

fn current_tooltip(args: &TrayEnsureArgs, attention: bool) -> String {
    if attention {
        attention_tooltip(args)
    } else {
        base_tooltip(args.is_dev, args.dev_label.as_deref())
    }
}
/// Ports the Electron attention badge: amber dot hugging the top-right corner
/// over a halo ring. Operates on RGBA bytes in place.
fn compose_attention_dot(pixels: &mut [u8], width: u32, height: u32) {
    let expected = width as usize * height as usize * 4;
    if width == 0 || height == 0 || pixels.len() != expected {
        return;
    }
    let dot_radius = ((width.min(height) as f64 * 0.2).round() as i64).max(2);
    let ring_radius = dot_radius + 1;
    let center_x = width as i64 - 1 - dot_radius;
    let center_y = dot_radius;
    for y in 0..height as i64 {
        for x in 0..width as i64 {
            let dx = x - center_x;
            let dy = y - center_y;
            let dist_sq = dx * dx + dy * dy;
            if dist_sq > ring_radius * ring_radius {
                continue;
            }
            let offset = (y as usize * width as usize + x as usize) * 4;
            let (r, g, b) = if dist_sq <= dot_radius * dot_radius {
                (DOT_R, DOT_G, DOT_B)
            } else {
                (RING_R, RING_G, RING_B)
            };
            pixels[offset] = r;
            pixels[offset + 1] = g;
            pixels[offset + 2] = b;
            pixels[offset + 3] = 0xff;
        }
    }
}

#[cfg(any(target_os = "macos", test))]
/// Ports the Electron template tint: a mask has no real colors, so bake the
/// glyph to black (light bar) or its alpha (dark bar) once tinting is off.
fn tint_template_for_attention(pixels: &mut [u8], use_light_glyph: bool) {
    for pixel in pixels.chunks_exact_mut(4) {
        let channel = if use_light_glyph { pixel[3] } else { 0x00 };
        pixel[0] = channel;
        pixel[1] = channel;
        pixel[2] = channel;
    }
}

#[cfg(any(target_os = "macos", test))]
/// Ports the Electron DEV stamp: pixel-text left of the glyph. Badge pixels
/// stay template black so macOS tints them with the glyph in both themes.
fn stamp_dev_badge(pixels: &mut [u8], width: u32, height: u32) {
    let expected = width as usize * height as usize * 4;
    if width == 0 || height == 0 || pixels.len() != expected {
        return;
    }
    let clear_left = DEV_BADGE_OFFSET_X.saturating_sub(DEV_BADGE_CLEAR_MARGIN);
    let clear_top = DEV_BADGE_OFFSET_Y.saturating_sub(DEV_BADGE_CLEAR_MARGIN);
    let clear_right = DEV_BADGE_OFFSET_X + DEV_BADGE_ROWS[0].len() as u32 + DEV_BADGE_CLEAR_MARGIN;
    let clear_bottom = DEV_BADGE_OFFSET_Y + DEV_BADGE_ROWS.len() as u32 + DEV_BADGE_CLEAR_MARGIN;
    for y in clear_top..clear_bottom.min(height) {
        for x in clear_left..clear_right.min(width) {
            let offset = (y as usize * width as usize + x as usize) * 4;
            pixels[offset..offset + 4].fill(0x00);
        }
    }
    for (row, pattern) in DEV_BADGE_ROWS.iter().enumerate() {
        for (col, ch) in pattern.chars().enumerate() {
            if ch != '#' {
                continue;
            }
            let x = DEV_BADGE_OFFSET_X + col as u32;
            let y = DEV_BADGE_OFFSET_Y + row as u32;
            if x >= width || y >= height {
                continue;
            }
            let offset = (y as usize * width as usize + x as usize) * 4;
            pixels[offset] = 0x00;
            pixels[offset + 1] = 0x00;
            pixels[offset + 2] = 0x00;
            pixels[offset + 3] = 0xff;
        }
    }
}

fn encode_png_rgba(width: u32, height: u32, rgba: &[u8]) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    {
        let encoder = PngEncoder::new_with_quality(
            &mut bytes,
            CompressionType::Default,
            FilterType::Adaptive,
        );
        encoder
            .write_image(rgba, width, height, ExtendedColorType::Rgba8)
            .map_err(|error| error.to_string())?;
    }
    Ok(bytes)
}

fn png_to_image(png: &[u8]) -> Result<Image<'static>, String> {
    Image::from_bytes(png)
        .map(|image| image.to_owned())
        .map_err(|error| error.to_string())
}

struct BaseIcon {
    rgba: Vec<u8>,
    width: u32,
    height: u32,
}

#[cfg(target_os = "windows")]
fn load_base_icon(app: &AppHandle, _is_dev: bool) -> Result<BaseIcon, String> {
    if let Ok(icon) = Image::from_app_icon_resource(TRAY_ICON_PX) {
        return Ok(BaseIcon {
            rgba: icon.rgba().to_vec(),
            width: icon.width(),
            height: icon.height(),
        });
    }
    let Some(icon) = app.default_window_icon() else {
        return Err("tray app icon is missing".to_string());
    };
    Ok(BaseIcon {
        rgba: nearest_to_16(icon.rgba(), icon.width(), icon.height()),
        width: TRAY_ICON_PX,
        height: TRAY_ICON_PX,
    })
}

// Fallback scaler when the 16px icon-resource entry is absent.
#[cfg(target_os = "windows")]
fn nearest_to_16(rgba: &[u8], width: u32, height: u32) -> Vec<u8> {
    let mut out = vec![0u8; TRAY_ICON_PX as usize * TRAY_ICON_PX as usize * 4];
    if width == 0 || height == 0 || rgba.len() != width as usize * height as usize * 4 {
        return out;
    }
    for y in 0..TRAY_ICON_PX {
        for x in 0..TRAY_ICON_PX {
            let sx = (x * width / TRAY_ICON_PX).min(width - 1) as usize;
            let sy = (y * height / TRAY_ICON_PX).min(height - 1) as usize;
            let src = (sy * width as usize + sx) * 4;
            let dst = (y as usize * TRAY_ICON_PX as usize + x as usize) * 4;
            out[dst..dst + 4].copy_from_slice(&rgba[src..src + 4]);
        }
    }
    out
}

#[cfg(target_os = "macos")]
fn load_base_icon(app: &AppHandle, is_dev: bool) -> Result<BaseIcon, String> {
    let bytes = std::fs::read(template_path(app)?).map_err(|error| error.to_string())?;
    let image = Image::from_bytes(&bytes).map_err(|error| error.to_string())?;
    let mut rgba = image.rgba().to_vec();
    if is_dev {
        stamp_dev_badge(&mut rgba, image.width(), image.height());
    }
    Ok(BaseIcon {
        rgba,
        width: image.width(),
        height: image.height(),
    })
}

#[cfg(target_os = "macos")]
fn template_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    const FILE: &str = "orca-menu-barTemplate.png";
    if let Ok(dir) = app.path().resource_dir() {
        let candidate = dir.join("tray").join(FILE);
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    let dev = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("resources")
        .join("tray")
        .join(FILE);
    if dev.is_file() {
        return Ok(dev);
    }
    Err("tray menu bar icon is missing".to_string())
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn load_base_icon(_app: &AppHandle, _is_dev: bool) -> Result<BaseIcon, String> {
    Err("system tray is unavailable on this platform".to_string())
}

fn icon_is_template(attention: bool) -> bool {
    // Template tinting makes the amber dot impossible, so it goes off with it.
    cfg!(target_os = "macos") && !attention
}

fn render_icon(
    app: &AppHandle,
    args: &TrayEnsureArgs,
    attention: bool,
) -> Result<Image<'static>, String> {
    let base = load_base_icon(app, args.is_dev)?;
    let mut rgba = base.rgba;
    #[cfg(target_os = "macos")]
    if attention {
        let dark = app
            .get_webview_window("main")
            .and_then(|window| window.theme().ok())
            .is_some_and(|theme| matches!(theme, tauri::Theme::Dark));
        tint_template_for_attention(&mut rgba, dark);
    }
    if attention {
        compose_attention_dot(&mut rgba, base.width, base.height);
    }
    let png = encode_png_rgba(base.width, base.height, &rgba)?;
    Ok(png_to_image(&png)?)
}
fn build_tray_menu<R: tauri::Runtime>(
    app: &AppHandle<R>,
    args: &TrayEnsureArgs,
) -> tauri::Result<tauri::menu::Menu<R>> {
    let mut builder = MenuBuilder::new(app);
    if args.is_dev {
        // Several dev instances (one per worktree) can show trays at once;
        // the disabled header ties this one to its worktree or branch.
        let header = MenuItemBuilder::with_id(
            "tray-dev-header",
            base_tooltip(true, args.dev_label.as_deref()),
        )
        .enabled(false)
        .build(app)?;
        builder = builder.item(&header);
        builder = builder.item(&PredefinedMenuItem::separator(app)?);
    }
    let open =
        MenuItemBuilder::with_id(ids::TRAY_OPEN, args.labels.open_label.clone()).build(app)?;
    builder = builder.item(&open);
    builder = builder.item(&PredefinedMenuItem::separator(app)?);
    // macOS carries the app-menu entries too so the two never drift.
    let mut extended = false;
    if let Some(label) = args.labels.settings_label.as_deref() {
        let item =
            MenuItemBuilder::with_id(ids::TRAY_OPEN_SETTINGS, label.to_owned()).build(app)?;
        builder = builder.item(&item);
        extended = true;
    }
    if let Some(label) = args.labels.check_updates_label.as_deref() {
        let item =
            MenuItemBuilder::with_id(ids::TRAY_CHECK_FOR_UPDATES, label.to_owned()).build(app)?;
        builder = builder.item(&item);
        extended = true;
    }
    if extended {
        builder = builder.item(&PredefinedMenuItem::separator(app)?);
    }
    let quit =
        MenuItemBuilder::with_id(ids::TRAY_QUIT, args.labels.quit_label.clone()).build(app)?;
    builder = builder.item(&quit);
    builder.build()
}

fn repaint_locked(app: &AppHandle, args: &TrayEnsureArgs, attention: bool) -> Result<(), String> {
    let Some(tray) = app.tray_by_id(TRAY_ICON_ID) else {
        return Ok(());
    };
    let icon = render_icon(app, args, attention)?;
    let menu = build_tray_menu(app, args).map_err(|error| error.to_string())?;
    tray.set_menu(Some(menu))
        .map_err(|error| error.to_string())?;
    tray.set_tooltip(Some(current_tooltip(args, attention)))
        .map_err(|error| error.to_string())?;
    tray.set_icon_with_as_template(Some(icon), icon_is_template(attention))
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn poc_tray_ensure(
    app: AppHandle,
    state: State<SystemTrayState>,
    args: TrayEnsureArgs,
) -> Result<bool, String> {
    if !cfg!(target_os = "windows") && !cfg!(target_os = "macos") {
        return Ok(false);
    }
    state.store(args.clone());
    let (attention, _) = state.snapshot();
    if app.tray_by_id(TRAY_ICON_ID).is_some() {
        repaint_locked(&app, &args, attention)?;
        return Ok(true);
    }
    let icon = render_icon(&app, &args, attention)?;
    let menu = build_tray_menu(&app, &args).map_err(|error| error.to_string())?;
    let mut builder = TrayIconBuilder::with_id(TRAY_ICON_ID)
        .icon(icon)
        .tooltip(current_tooltip(&args, attention))
        .menu(&menu);
    #[cfg(target_os = "macos")]
    {
        builder = builder.icon_as_template(icon_is_template(attention));
    }
    #[cfg(target_os = "windows")]
    {
        // Left-click restores the window; the menu stays on right-click.
        builder = builder.show_menu_on_left_click(false);
    }
    builder.build(&app).map_err(|error| error.to_string())?;
    Ok(true)
}

#[tauri::command]
pub fn poc_tray_set_attention(
    app: AppHandle,
    state: State<SystemTrayState>,
    args: TrayAttentionArgs,
) -> Result<bool, String> {
    // The flag settles even without a tray so an early bell is not lost.
    state.set_attention(args.active);
    let (_, stored) = state.snapshot();
    let Some(stored) = stored else {
        return Ok(false);
    };
    if app.tray_by_id(TRAY_ICON_ID).is_none() {
        return Ok(false);
    }
    repaint_locked(&app, &stored, args.active)?;
    Ok(true)
}

/// Refreshes translated labels without recreating the tray or its actions.
#[tauri::command]
pub fn poc_tray_rebuild(
    app: AppHandle,
    state: State<SystemTrayState>,
    args: TrayEnsureArgs,
) -> Result<bool, String> {
    if !cfg!(target_os = "windows") && !cfg!(target_os = "macos") {
        return Ok(false);
    }
    state.store(args.clone());
    let (attention, _) = state.snapshot();
    if app.tray_by_id(TRAY_ICON_ID).is_none() {
        return Ok(false);
    }
    repaint_locked(&app, &args, attention)?;
    Ok(true)
}

/// Applies the macOS visibility preference without affecting other platforms.
#[tauri::command]
pub fn poc_tray_set_visible(app: AppHandle, visible: bool) -> Result<bool, String> {
    if !cfg!(target_os = "macos") {
        return Ok(false);
    }
    if visible {
        return Ok(app.tray_by_id(TRAY_ICON_ID).is_some());
    }
    app.remove_tray_by_id(TRAY_ICON_ID);
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tray_menu_ids_route_to_their_actions() {
        assert_eq!(tray_menu_route(ids::TRAY_OPEN), Some(TrayMenuRoute::Open));
        assert_eq!(
            tray_menu_route(ids::TRAY_OPEN_SETTINGS),
            Some(TrayMenuRoute::OpenSettings)
        );
        assert_eq!(
            tray_menu_route(ids::TRAY_CHECK_FOR_UPDATES),
            Some(TrayMenuRoute::CheckForUpdates)
        );
        assert_eq!(tray_menu_route(ids::TRAY_QUIT), Some(TrayMenuRoute::Quit));
    }

    #[test]
    fn tray_menu_ids_are_distinct_and_closed() {
        // A duplicated id would silently steal another item's action.
        let mut sorted = vec![
            ids::TRAY_OPEN,
            ids::TRAY_OPEN_SETTINGS,
            ids::TRAY_CHECK_FOR_UPDATES,
            ids::TRAY_QUIT,
        ];
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(sorted.len(), 4);
        assert_eq!(tray_menu_route("tray-does-not-exist"), None);
        assert_eq!(tray_menu_route(""), None);
    }

    fn solid_rgba(width: u32, height: u32, r: u8, g: u8, b: u8, a: u8) -> Vec<u8> {
        let mut pixels = Vec::with_capacity(width as usize * height as usize * 4);
        for _ in 0..width as usize * height as usize {
            pixels.extend_from_slice(&[r, g, b, a]);
        }
        pixels
    }

    #[test]
    fn attention_dot_paints_top_right_corner() {
        let (width, height) = (16, 16);
        let mut pixels = solid_rgba(width, height, 0, 0, 0, 0);
        compose_attention_dot(&mut pixels, width, height);
        // radius max(2, round(16 * 0.2)) = 3; center (16 - 1 - 3, 3).
        let center = (3usize * width as usize + 12) * 4;
        assert_eq!(&pixels[center..center + 4], &[DOT_R, DOT_G, DOT_B, 0xff]);
        // radius 4 due west of the center lands on the halo ring.
        let ring = (3usize * width as usize + 8) * 4;
        assert_eq!(&pixels[ring..ring + 4], &[RING_R, RING_G, RING_B, 0xff]);
        // Far corner stays untouched.
        let far = (15usize * width as usize) * 4;
        assert_eq!(&pixels[far..far + 4], &[0, 0, 0, 0]);
    }

    #[test]
    fn attention_dot_rejects_size_mismatch() {
        let mut pixels = vec![0u8; 10];
        compose_attention_dot(&mut pixels, 16, 16);
        assert!(pixels.iter().all(|byte| *byte == 0));
    }

    #[test]
    fn template_tint_bakes_alpha_for_dark_bars() {
        let mut pixels = vec![0x00, 0x00, 0x00, 0x80];
        tint_template_for_attention(&mut pixels, true);
        assert_eq!(pixels, vec![0x80, 0x80, 0x80, 0x80]);
        let mut pixels = vec![0x00, 0x00, 0x00, 0x80];
        tint_template_for_attention(&mut pixels, false);
        assert_eq!(pixels, vec![0x00, 0x00, 0x00, 0x80]);
    }

    #[test]
    fn dev_badge_stamps_template_black_pixels() {
        let (width, height) = (24, 24);
        let mut pixels = solid_rgba(width, height, 0, 0, 0, 0);
        stamp_dev_badge(&mut pixels, width, height);
        // First row "##..###.#.#": badge at col 0, cleared gap at col 2.
        let badge = (DEV_BADGE_OFFSET_Y as usize * width as usize) * 4;
        assert_eq!(&pixels[badge..badge + 4], &[0, 0, 0, 0xff]);
        let gap = (DEV_BADGE_OFFSET_Y as usize * width as usize + 2) * 4;
        assert_eq!(&pixels[gap..gap + 4], &[0, 0, 0, 0]);
    }

    #[test]
    fn tooltips_carry_the_dev_marker() {
        assert_eq!(base_tooltip(false, None), "Orca");
        assert_eq!(base_tooltip(true, None), "Orca DEV");
        assert_eq!(base_tooltip(true, Some("main")), "Orca DEV (main)");
        let args = TrayEnsureArgs {
            is_dev: true,
            dev_label: Some("main".to_owned()),
            labels: TrayLabels {
                open_label: "Open".to_owned(),
                settings_label: None,
                check_updates_label: None,
                quit_label: "Quit".to_owned(),
                activity_waiting: "Orca - activity waiting".to_owned(),
                activity_waiting_suffix: "activity waiting".to_owned(),
            },
        };
        assert_eq!(
            attention_tooltip(&args),
            "Orca DEV (main) - activity waiting"
        );
    }

    #[test]
    fn attention_png_round_trips_through_tauri_image() {
        let (width, height) = (16, 16);
        let mut rgba = solid_rgba(width, height, 10, 20, 30, 255);
        compose_attention_dot(&mut rgba, width, height);
        let png = encode_png_rgba(width, height, &rgba).expect("encode");
        let image = png_to_image(&png).expect("decode");
        assert_eq!((image.width(), image.height()), (width, height));
        assert_eq!(image.rgba().len(), rgba.len());
    }
}
