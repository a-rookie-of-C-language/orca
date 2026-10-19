//! Pure model of the native application menu.
//!
//! Single source of truth for sections, labels, display-only hints and real
//! accelerators; `main.rs` only materializes it. Mirrors Electron's
//! `register-app-menu.ts`: on Windows/Linux almost every entry is a
//! display-only hint (label text with a tab-separated suffix) so chords keep
//! reaching the focused terminal or DOM control instead of being swallowed by
//! a menu accelerator. Only paste, devtools and fullscreen install real
//! accelerators, matching Electron's roles.
//!
//! Cut keeps the accelerator muda assigns it (Ctrl+X on Windows), matching
//! Electron's cut role. Copy is a native role only on macOS; on
//! Windows/Linux it is a display-only hint whose click routes per-surface
//! through the renderer, exactly like Electron's unbound copy item: a real
//! accelerator would swallow Ctrl+C before the focused terminal sees it.

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum MenuPlatform {
    Macos,
    Other,
}

impl MenuPlatform {
    pub fn current() -> Self {
        if cfg!(target_os = "macos") {
            Self::Macos
        } else {
            Self::Other
        }
    }
}

/// Stable menu-event ids, shared with the handler in `main.rs`.
pub mod ids {
    // Menu-bar section ids (used to rename the macOS App/File/Edit/... roots
    // when the locale or a rebindable label changes).
    pub const SECTION_APP: &str = "menu-section-app";
    pub const SECTION_FILE: &str = "menu-section-file";
    pub const SECTION_EDIT: &str = "menu-section-edit";
    pub const SECTION_VIEW: &str = "menu-section-view";
    pub const SECTION_WINDOW: &str = "menu-section-window";
    pub const SECTION_HELP: &str = "menu-section-help";
    pub const SECTION_APPEARANCE: &str = "menu-section-appearance";

    pub const FILE_SETTINGS: &str = "file-settings";
    pub const FILE_QUIT: &str = "file-quit";
    pub const EDIT_UNDO: &str = "edit-undo";
    pub const EDIT_REDO: &str = "edit-redo";
    pub const EDIT_COPY: &str = "edit-copy";
    pub const EDIT_PASTE: &str = "edit-paste";
    pub const EDIT_SELECT_ALL: &str = "edit-select-all";
    pub const VIEW_RELOAD: &str = "view-reload";
    pub const VIEW_FORCE_RELOAD: &str = "view-force-reload";
    pub const VIEW_TOGGLE_DEVTOOLS: &str = "view-toggle-devtools";
    pub const VIEW_ZOOM_IN: &str = "view-zoom-in";
    pub const VIEW_ZOOM_OUT: &str = "view-zoom-out";
    pub const VIEW_ZOOM_RESET: &str = "view-zoom-reset";
    pub const VIEW_TOGGLE_FULLSCREEN: &str = "view-toggle-fullscreen";
    pub const VIEW_TOGGLE_LEFT_SIDEBAR: &str = "view-toggle-left-sidebar";
    pub const VIEW_TOGGLE_RIGHT_SIDEBAR: &str = "view-toggle-right-sidebar";
    pub const VIEW_TOGGLE_WORKTREE_PALETTE: &str = "view-toggle-worktree-palette";
    pub const VIEW_TOGGLE_STATUS_BAR: &str = "view-toggle-status-bar";
    pub const VIEW_APPEARANCE_TASKS: &str = "view-appearance-tasks";
    pub const VIEW_APPEARANCE_AUTOMATIONS: &str = "view-appearance-automations";
    pub const VIEW_APPEARANCE_MOBILE: &str = "view-appearance-mobile";
    pub const VIEW_APPEARANCE_TITLEBAR: &str = "view-appearance-titlebar";
    pub const WINDOW_MINIMIZE: &str = "window-minimize";
    pub const WINDOW_ZOOM: &str = "window-zoom";
    pub const HELP_CRASH_REPORT: &str = "help-crash-report";
    pub const HELP_FEATURE_TOUR: &str = "help-feature-tour";
    pub const HELP_SETUP_GUIDE: &str = "help-setup-guide";
    pub const HELP_ABOUT: &str = "help-about";
    pub const HELP_CHECK_FOR_UPDATES: &str = "help-check-for-updates";
}

/// A clickable item owned by the spec. `hint_*` is display-only text
/// (rendered right-aligned after a tab); `accelerator_*` installs a real menu
/// accelerator that preempts the focused webview.
#[derive(Clone, Copy)]
pub struct CustomItem {
    pub id: &'static str,
    pub text_mac: &'static str,
    pub text_other: &'static str,
    pub hint_mac: Option<&'static str>,
    pub hint_other: Option<&'static str>,
    pub accelerator_mac: Option<&'static str>,
    pub accelerator_other: Option<&'static str>,
    pub checked: Option<bool>,
}

impl CustomItem {
    pub fn text(&self, platform: MenuPlatform) -> &'static str {
        match platform {
            MenuPlatform::Macos => self.text_mac,
            MenuPlatform::Other => self.text_other,
        }
    }

    pub fn accelerator(&self, platform: MenuPlatform) -> Option<&'static str> {
        match platform {
            MenuPlatform::Macos => self.accelerator_mac,
            MenuPlatform::Other => self.accelerator_other,
        }
    }

    fn hint(&self, platform: MenuPlatform) -> Option<&'static str> {
        match platform {
            MenuPlatform::Macos => self.hint_mac,
            MenuPlatform::Other => self.hint_other,
        }
    }

    /// Label as shown. A hint renders right-aligned after a tab only when the
    /// item installs no accelerator (a real accelerator renders its own hint).
    pub fn display_text(&self, platform: MenuPlatform) -> String {
        let text = self.text(platform);
        match (self.hint(platform), self.accelerator(platform)) {
            (Some(hint), None) => format!("{text}\t{hint}"),
            _ => text.to_string(),
        }
    }
}

pub enum MenuEntry {
    Custom(CustomItem),
    /// muda predefined roles; they own their accelerators (see module docs).
    Undo,
    Redo,
    Cut,
    Copy,
    /// macOS App-menu roles; only meaningful inside the app-named section.
    Services,
    Hide,
    HideOthers,
    ShowAll,
    Separator,
    Submenu {
        /// Stable identifier — `menu.get(id)` lets a locale push rename this
        /// submenu after construction.
        id: &'static str,
        label: &'static str,
        entries: Vec<MenuEntry>,
    },
}

pub struct MenuSection {
    /// Stable identifier for `menu.get(id)` — lets locale/keybinding pushes
    /// rename the section label at runtime the way Electron's rebuild does.
    pub id: &'static str,
    pub label: &'static str,
    pub entries: Vec<MenuEntry>,
}

fn custom(id: &'static str, text_mac: &'static str, text_other: &'static str) -> CustomItem {
    CustomItem {
        id,
        text_mac,
        text_other,
        hint_mac: None,
        hint_other: None,
        accelerator_mac: None,
        accelerator_other: None,
        checked: None,
    }
}

fn hinted(
    id: &'static str,
    text: &'static str,
    hint_mac: &'static str,
    hint_other: &'static str,
) -> CustomItem {
    CustomItem {
        id,
        text_mac: text,
        text_other: text,
        hint_mac: Some(hint_mac),
        hint_other: Some(hint_other),
        accelerator_mac: None,
        accelerator_other: None,
        checked: None,
    }
}

fn accelerated(
    id: &'static str,
    text: &'static str,
    accelerator_mac: &'static str,
    accelerator_other: &'static str,
) -> CustomItem {
    CustomItem {
        id,
        text_mac: text,
        text_other: text,
        hint_mac: None,
        hint_other: None,
        accelerator_mac: Some(accelerator_mac),
        accelerator_other: Some(accelerator_other),
        checked: None,
    }
}

fn checked(id: &'static str, text: &'static str) -> CustomItem {
    CustomItem {
        id,
        text_mac: text,
        text_other: text,
        hint_mac: None,
        hint_other: None,
        accelerator_mac: None,
        accelerator_other: None,
        checked: Some(true),
    }
}

/// Full menu bar: Orca, Edit, View, Window, Help on macOS; File distributes
/// the App-menu entries everywhere else, matching Electron.
pub fn application_menu_bar() -> Vec<MenuSection> {
    application_menu_bar_for(MenuPlatform::current())
}

/// Platform-resolved menu bar. Undo/redo/copy stay native roles on macOS
/// (the OS routes them per-view) but become display-only hints elsewhere so
/// Ctrl+Z/Y/C keep reaching the focused terminal or DOM control, exactly
/// like Electron's unbound roles; menu clicks route per-surface through the
/// renderer.
pub fn application_menu_bar_for(platform: MenuPlatform) -> Vec<MenuSection> {
    let undo_redo: Vec<MenuEntry> = match platform {
        MenuPlatform::Macos => vec![MenuEntry::Undo, MenuEntry::Redo],
        MenuPlatform::Other => vec![
            MenuEntry::Custom(hinted(ids::EDIT_UNDO, "Undo", "⌘Z", "Ctrl+Z")),
            MenuEntry::Custom(hinted(ids::EDIT_REDO, "Redo", "⇧⌘Z", "Ctrl+Y")),
        ],
    };
    let copy = match platform {
        MenuPlatform::Macos => MenuEntry::Copy,
        MenuPlatform::Other => MenuEntry::Custom(hinted(ids::EDIT_COPY, "Copy", "⌘C", "Ctrl+C")),
    };
    let mut edit_entries = undo_redo;
    edit_entries.extend([
        MenuEntry::Separator,
        MenuEntry::Cut,
        copy,
        MenuEntry::Custom(accelerated(ids::EDIT_PASTE, "Paste", "CMD+V", "CTRL+V")),
        MenuEntry::Custom(custom(ids::EDIT_SELECT_ALL, "Select All", "Select All")),
    ]);
    // The macOS app-named menu owns About, updates and Settings plus the hide
    // and services roles; everywhere else File distributes Settings and Quit.
    let head = match platform {
        MenuPlatform::Macos => MenuSection {
            id: ids::SECTION_APP,
            label: "Orca",
            entries: vec![
                MenuEntry::Custom(custom(ids::HELP_ABOUT, "About Orca", "About Orca")),
                MenuEntry::Custom(custom(
                    ids::HELP_CHECK_FOR_UPDATES,
                    "Check for Updates...",
                    "Check for Updates...",
                )),
                MenuEntry::Custom(custom(ids::FILE_SETTINGS, "Settings", "Settings")),
                MenuEntry::Separator,
                MenuEntry::Services,
                MenuEntry::Separator,
                MenuEntry::Hide,
                MenuEntry::HideOthers,
                MenuEntry::ShowAll,
                MenuEntry::Separator,
                MenuEntry::Custom(CustomItem {
                    // Why: Electron's quit role binds Cmd+Q on macOS — the
                    // accelerator preempts the focused webview on purpose.
                    accelerator_mac: Some("CMD+Q"),
                    ..custom(ids::FILE_QUIT, "Quit", "Quit")
                }),
            ],
        },
        MenuPlatform::Other => MenuSection {
            id: ids::SECTION_FILE,
            label: "File",
            entries: vec![
                MenuEntry::Custom(custom(ids::FILE_SETTINGS, "Settings", "Settings")),
                MenuEntry::Separator,
                MenuEntry::Custom(CustomItem {
                    // Windows convention says "Exit" while Linux keeps the
                    // Electron quit-role label "Quit".
                    text_other: if cfg!(target_os = "linux") {
                        "Quit"
                    } else {
                        "Exit"
                    },
                    // Electron gives the quit role CmdOrCtrl+Q on Linux and
                    // macOS but leaves it unbound on Windows.
                    accelerator_other: if cfg!(target_os = "linux") {
                        Some("CTRL+Q")
                    } else {
                        None
                    },
                    ..custom(ids::FILE_QUIT, "Quit", "Quit")
                }),
            ],
        },
    };
    let mut bar = vec![
        head,
        MenuSection {
            id: ids::SECTION_EDIT,
            label: "Edit",
            entries: edit_entries,
        },
        MenuSection {
            id: ids::SECTION_VIEW,
            label: "View",
            entries: vec![
                MenuEntry::Custom(custom(ids::VIEW_RELOAD, "Reload", "Reload")),
                MenuEntry::Custom(hinted(
                    ids::VIEW_FORCE_RELOAD,
                    "Force Reload",
                    "⌘⇧R",
                    "Ctrl+Shift+R",
                )),
                MenuEntry::Custom(accelerated(
                    ids::VIEW_TOGGLE_DEVTOOLS,
                    "Toggle Developer Tools",
                    "CMD+ALT+I",
                    "CTRL+SHIFT+I",
                )),
                MenuEntry::Separator,
                MenuEntry::Custom(hinted(ids::VIEW_ZOOM_RESET, "Reset Size", "⌘0", "Ctrl+0")),
                MenuEntry::Custom(hinted(ids::VIEW_ZOOM_IN, "Zoom In", "⌘=", "Ctrl+=")),
                MenuEntry::Custom(hinted(ids::VIEW_ZOOM_OUT, "Zoom Out", "⌘-", "Ctrl+-")),
                MenuEntry::Separator,
                MenuEntry::Custom(hinted(
                    ids::VIEW_TOGGLE_WORKTREE_PALETTE,
                    "Open Worktree Palette",
                    "⌘J",
                    "Ctrl+Shift+J",
                )),
                MenuEntry::Separator,
                MenuEntry::Custom(accelerated(
                    ids::VIEW_TOGGLE_FULLSCREEN,
                    "Toggle Fullscreen",
                    "CMD+CTRL+F",
                    "F11",
                )),
                MenuEntry::Separator,
                MenuEntry::Submenu {
                    id: ids::SECTION_APPEARANCE,
                    label: "Appearance",
                    entries: vec![
                        MenuEntry::Custom(hinted(
                            ids::VIEW_TOGGLE_LEFT_SIDEBAR,
                            "Toggle Left Sidebar",
                            "⌘B",
                            "Ctrl+B",
                        )),
                        MenuEntry::Custom(hinted(
                            ids::VIEW_TOGGLE_RIGHT_SIDEBAR,
                            "Toggle Right Sidebar",
                            "⌘L",
                            "Ctrl+L",
                        )),
                        MenuEntry::Custom(checked(
                            ids::VIEW_TOGGLE_STATUS_BAR,
                            "Toggle Status Bar",
                        )),
                        MenuEntry::Separator,
                        MenuEntry::Custom(checked(ids::VIEW_APPEARANCE_TASKS, "Show Tasks Button")),
                        MenuEntry::Custom(checked(
                            ids::VIEW_APPEARANCE_AUTOMATIONS,
                            "Show Automations Button",
                        )),
                        MenuEntry::Custom(checked(
                            ids::VIEW_APPEARANCE_MOBILE,
                            "Show Orca Mobile Button",
                        )),
                        MenuEntry::Custom(checked(
                            ids::VIEW_APPEARANCE_TITLEBAR,
                            "Show Titlebar App Name",
                        )),
                    ],
                },
            ],
        },
        MenuSection {
            id: ids::SECTION_WINDOW,
            label: "Window",
            entries: match platform {
                // Electron's `zoom` role is macOS-only (it toggles the traffic-
                // light zoom/maximize state); keep it out elsewhere.
                MenuPlatform::Macos => vec![
                    MenuEntry::Custom(custom(ids::WINDOW_MINIMIZE, "Minimize", "Minimize")),
                    MenuEntry::Custom(custom(ids::WINDOW_ZOOM, "Zoom", "Zoom")),
                ],
                MenuPlatform::Other => vec![MenuEntry::Custom(custom(
                    ids::WINDOW_MINIMIZE,
                    "Minimize",
                    "Minimize",
                ))],
            },
        },
    ];
    // About and updates live in the App menu on macOS, at the Help tail
    // everywhere else.
    let mut help_entries = vec![
        MenuEntry::Custom(custom(
            ids::HELP_CRASH_REPORT,
            "Report Crash...",
            "Report Crash...",
        )),
        MenuEntry::Separator,
        MenuEntry::Custom(custom(
            ids::HELP_FEATURE_TOUR,
            "Explore Orca",
            "Explore Orca",
        )),
        MenuEntry::Custom(custom(
            ids::HELP_SETUP_GUIDE,
            "Getting Started with Orca",
            "Getting Started with Orca",
        )),
    ];
    if platform == MenuPlatform::Other {
        help_entries.push(MenuEntry::Separator);
        help_entries.push(MenuEntry::Custom(custom(
            ids::HELP_ABOUT,
            "About Orca",
            "About Orca",
        )));
        help_entries.push(MenuEntry::Custom(custom(
            ids::HELP_CHECK_FOR_UPDATES,
            "Check for Updates...",
            "Check for Updates...",
        )));
    }
    bar.push(MenuSection {
        id: ids::SECTION_HELP,
        label: "Help",
        entries: help_entries,
    });
    bar
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::{HashMap, HashSet};

    fn collect_custom(bar: &[MenuSection]) -> Vec<(&'static str, CustomItem)> {
        fn walk(
            section: &'static str,
            entries: &[MenuEntry],
            out: &mut Vec<(&'static str, CustomItem)>,
        ) {
            for entry in entries {
                match entry {
                    MenuEntry::Custom(item) => out.push((section, *item)),
                    MenuEntry::Submenu { entries, .. } => walk(section, entries, out),
                    _ => {}
                }
            }
        }
        let mut out = Vec::new();
        for section in bar {
            walk(section.label, &section.entries, &mut out);
        }
        out
    }

    #[test]
    fn sections_cover_file_edit_view_window_help_in_order() {
        for (platform, expected) in [
            (
                MenuPlatform::Macos,
                vec!["Orca", "Edit", "View", "Window", "Help"],
            ),
            (
                MenuPlatform::Other,
                vec!["File", "Edit", "View", "Window", "Help"],
            ),
        ] {
            let labels: Vec<&'static str> = application_menu_bar_for(platform)
                .iter()
                .map(|section| section.label)
                .collect();
            assert_eq!(labels, expected, "platform: {platform:?}");
        }
    }

    fn section_entries<'a>(bar: &'a [MenuSection], label: &str) -> &'a [MenuEntry] {
        &bar.iter()
            .find(|section| section.label == label)
            .unwrap_or_else(|| panic!("missing {label} section"))
            .entries
    }

    fn has_role(entries: &[MenuEntry], matches: impl Fn(&MenuEntry) -> bool) -> bool {
        entries.iter().any(matches)
    }

    fn is_app_role(entry: &MenuEntry, name: &str) -> bool {
        matches!(
            (entry, name),
            (MenuEntry::Services, "Services")
                | (MenuEntry::Hide, "Hide")
                | (MenuEntry::HideOthers, "HideOthers")
                | (MenuEntry::ShowAll, "ShowAll")
        )
    }

    #[test]
    fn mac_app_menu_owns_about_updates_settings_and_hide_roles() {
        let bar = application_menu_bar_for(MenuPlatform::Macos);
        let app = section_entries(&bar, "Orca");
        // About, updates and Settings keep their renderer ids; the about role
        // is materialized in main.rs so the dialog stays native everywhere.
        for id in [
            ids::HELP_ABOUT,
            ids::HELP_CHECK_FOR_UPDATES,
            ids::FILE_SETTINGS,
        ] {
            assert!(
                has_role(
                    app,
                    |entry| matches!(entry, MenuEntry::Custom(item) if item.id == id)
                ),
                "{id} missing from the macOS App menu"
            );
        }
        for role in ["Services", "Hide", "HideOthers", "ShowAll"] {
            assert!(
                has_role(app, |entry| is_app_role(entry, role)),
                "{role} missing from the macOS App menu"
            );
        }
        // Settings and Quit leave File; About and updates leave Help.
        assert!(bar.iter().all(|section| section.label != "File"));
        let help = section_entries(&bar, "Help");
        for id in [ids::HELP_ABOUT, ids::HELP_CHECK_FOR_UPDATES] {
            assert!(
                !has_role(
                    help,
                    |entry| matches!(entry, MenuEntry::Custom(item) if item.id == id)
                ),
                "{id} duplicated in macOS Help"
            );
        }
    }

    #[test]
    fn custom_id_inventory_matches_expected() {
        // Why per-platform: undo/redo/copy are native roles on macOS but custom
        // display-only entries elsewhere, so the inventory differs by platform.
        for (platform, extra) in [
            (MenuPlatform::Macos, vec![]),
            (
                MenuPlatform::Other,
                vec![ids::EDIT_COPY, ids::EDIT_REDO, ids::EDIT_UNDO],
            ),
        ] {
            let mut found: Vec<&'static str> = collect_custom(&application_menu_bar_for(platform))
                .iter()
                .map(|(_, item)| item.id)
                .collect();
            found.sort_unstable();
            let mut expected = vec![
                "edit-paste",
                "edit-select-all",
                "file-quit",
                "file-settings",
                "help-about",
                "help-check-for-updates",
                "help-crash-report",
                "help-feature-tour",
                "help-setup-guide",
                "view-appearance-automations",
                "view-appearance-mobile",
                "view-appearance-tasks",
                "view-appearance-titlebar",
                "view-force-reload",
                "view-reload",
                "view-toggle-devtools",
                "view-toggle-fullscreen",
                "view-toggle-left-sidebar",
                "view-toggle-right-sidebar",
                "view-toggle-status-bar",
                "view-toggle-worktree-palette",
                "view-zoom-in",
                "view-zoom-out",
                "view-zoom-reset",
                "window-minimize",
            ];
            if platform == MenuPlatform::Macos {
                expected.push("window-zoom");
            }
            expected.extend(extra);
            expected.sort_unstable();
            assert_eq!(found, expected);
        }
    }

    #[test]
    fn only_paste_devtools_and_fullscreen_install_real_accelerators() {
        for platform in [MenuPlatform::Macos, MenuPlatform::Other] {
            let mut actual: HashMap<&'static str, &'static str> = HashMap::new();
            for (_, item) in collect_custom(&application_menu_bar()) {
                if let Some(accelerator) = item.accelerator(platform) {
                    actual.insert(item.id, accelerator);
                }
            }
            let expected: HashMap<&'static str, &'static str> = if platform == MenuPlatform::Macos {
                HashMap::from([
                    ("edit-paste", "CMD+V"),
                    ("view-toggle-devtools", "CMD+ALT+I"),
                    ("view-toggle-fullscreen", "CMD+CTRL+F"),
                ])
            } else {
                HashMap::from([
                    ("edit-paste", "CTRL+V"),
                    ("view-toggle-devtools", "CTRL+SHIFT+I"),
                    ("view-toggle-fullscreen", "F11"),
                ])
            };
            assert_eq!(actual, expected, "platform: {platform:?}");
        }
    }

    #[test]
    fn hints_never_accompany_accelerators() {
        for platform in [MenuPlatform::Macos, MenuPlatform::Other] {
            for (_, item) in collect_custom(&application_menu_bar()) {
                let hint = match platform {
                    MenuPlatform::Macos => item.hint_mac,
                    MenuPlatform::Other => item.hint_other,
                };
                assert!(
                    hint.is_none() || item.accelerator(platform).is_none(),
                    "{} has both hint and accelerator on {platform:?}",
                    item.id
                );
            }
        }
    }

    #[test]
    fn sidebar_hints_match_the_renderer_keybindings() {
        let bar = application_menu_bar();
        let by_id: HashMap<&'static str, CustomItem> = collect_custom(&bar)
            .into_iter()
            .map(|(_, item)| (item.id, item))
            .collect();
        let left = by_id[ids::VIEW_TOGGLE_LEFT_SIDEBAR].display_text(MenuPlatform::Other);
        let right = by_id[ids::VIEW_TOGGLE_RIGHT_SIDEBAR].display_text(MenuPlatform::Other);
        assert_eq!(left, "Toggle Left Sidebar\tCtrl+B");
        // Guards the earlier wrong Ctrl+Alt+B: the binding is Mod+L.
        assert_eq!(right, "Toggle Right Sidebar\tCtrl+L");
        let right_mac = by_id[ids::VIEW_TOGGLE_RIGHT_SIDEBAR].display_text(MenuPlatform::Macos);
        assert_eq!(right_mac, "Toggle Right Sidebar\t⌘L");
    }

    #[test]
    fn quit_uses_platform_conventions_without_stealing_chords() {
        // Linux keeps Electron's quit-role label/accelerator; Windows swaps to
        // "Exit" and leaves the chord unbound. macOS binds Cmd+Q on the
        // app-named menu.
        let (expected_other_text, expected_other_accel) = if cfg!(target_os = "linux") {
            ("Quit", Some("CTRL+Q"))
        } else {
            ("Exit", None)
        };

        let macos_bar = application_menu_bar_for(MenuPlatform::Macos);
        let macos_item = collect_custom(&macos_bar)
            .into_iter()
            .find(|(_, item)| item.id == ids::FILE_QUIT)
            .map(|(_, item)| item)
            .expect("macOS bar must include Quit");
        assert_eq!(macos_item.text(MenuPlatform::Macos), "Quit");
        assert_eq!(macos_item.accelerator(MenuPlatform::Macos), Some("CMD+Q"));

        let other_bar = application_menu_bar_for(MenuPlatform::Other);
        let other_item = collect_custom(&other_bar)
            .into_iter()
            .find(|(_, item)| item.id == ids::FILE_QUIT)
            .map(|(_, item)| item)
            .expect("non-macOS bar must include Quit");
        assert_eq!(other_item.text(MenuPlatform::Other), expected_other_text);
        assert_eq!(
            other_item.accelerator(MenuPlatform::Other),
            expected_other_accel
        );
    }

    #[test]
    fn settings_stays_unbound_like_the_keybinding_default() {
        let bar = application_menu_bar();
        let by_id: HashMap<&'static str, CustomItem> = collect_custom(&bar)
            .into_iter()
            .map(|(_, item)| (item.id, item))
            .collect();
        let settings = by_id[ids::FILE_SETTINGS];
        // app.settings ships unbound so Ctrl+, keeps reaching terminal apps.
        assert_eq!(settings.accelerator(MenuPlatform::Macos), None);
        assert_eq!(settings.accelerator(MenuPlatform::Other), None);
        assert_eq!(settings.display_text(MenuPlatform::Other), "Settings");
    }

    #[test]
    fn appearance_checks_default_on() {
        let bar = application_menu_bar();
        let appearance = bar
            .iter()
            .find(|section| section.label == "View")
            .and_then(|view| {
                view.entries.iter().find_map(|entry| match entry {
                    MenuEntry::Submenu { id, entries, .. } if *id == ids::SECTION_APPEARANCE => {
                        Some(entries)
                    }
                    _ => None,
                })
            })
            .expect("Appearance submenu");
        let checks: Vec<(&'static str, bool)> = appearance
            .iter()
            .filter_map(|entry| match entry {
                MenuEntry::Custom(item) => item.checked.map(|checked| (item.id, checked)),
                _ => None,
            })
            .collect();
        assert_eq!(checks.len(), 5);
        assert!(checks.iter().all(|(_, checked)| *checked));
    }

    #[test]
    fn custom_ids_are_unique() {
        let mut seen = HashSet::new();
        for (_, item) in collect_custom(&application_menu_bar()) {
            assert!(seen.insert(item.id), "duplicate id {}", item.id);
        }
    }

    #[test]
    fn help_ends_with_about_then_check_for_updates() {
        let bar = application_menu_bar();
        let help = bar
            .iter()
            .find(|section| section.label == "Help")
            .expect("Help section");
        let customs: Vec<&'static str> = help
            .entries
            .iter()
            .filter_map(|entry| match entry {
                MenuEntry::Custom(item) => Some(item.id),
                _ => None,
            })
            .collect();
        assert_eq!(
            customs,
            vec![
                ids::HELP_CRASH_REPORT,
                ids::HELP_FEATURE_TOUR,
                ids::HELP_SETUP_GUIDE,
                ids::HELP_ABOUT,
                ids::HELP_CHECK_FOR_UPDATES,
            ]
        );
    }

    fn edit_entries_for(platform: MenuPlatform) -> Vec<MenuEntry> {
        application_menu_bar_for(platform)
            .into_iter()
            .find(|section| section.label == "Edit")
            .expect("Edit section")
            .entries
    }

    #[test]
    fn undo_redo_are_native_roles_only_on_macos() {
        let macos = edit_entries_for(MenuPlatform::Macos);
        assert!(macos.iter().any(|entry| matches!(entry, MenuEntry::Undo)));
        assert!(macos.iter().any(|entry| matches!(entry, MenuEntry::Redo)));
    }

    #[test]
    fn undo_redo_are_display_only_hints_off_macos() {
        // Why: a real accelerator would preempt the focused terminal or DOM
        // control; display-only hints keep Ctrl+Z/Y reaching the surface.
        let other = edit_entries_for(MenuPlatform::Other);
        assert!(!other
            .iter()
            .any(|entry| matches!(entry, MenuEntry::Undo | MenuEntry::Redo)));
        let customs: Vec<&CustomItem> = other
            .iter()
            .filter_map(|entry| match entry {
                MenuEntry::Custom(item)
                    if item.id == ids::EDIT_UNDO || item.id == ids::EDIT_REDO =>
                {
                    Some(item)
                }
                _ => None,
            })
            .collect();
        assert_eq!(customs.len(), 2);
        for item in customs {
            assert_eq!(item.accelerator(MenuPlatform::Other), None);
            assert_eq!(
                item.display_text(MenuPlatform::Other),
                match item.id {
                    ids::EDIT_UNDO => "Undo\tCtrl+Z".to_string(),
                    _ => "Redo\tCtrl+Y".to_string(),
                }
            );
        }
    }

    #[test]
    fn copy_is_a_native_role_only_on_macos() {
        let macos = edit_entries_for(MenuPlatform::Macos);
        assert!(macos.iter().any(|entry| matches!(entry, MenuEntry::Copy)));
    }

    #[test]
    fn copy_is_a_display_only_hint_off_macos() {
        // Why: a real accelerator would swallow Ctrl+C before the focused
        // terminal or DOM control sees it; Electron leaves copy unbound too.
        let other = edit_entries_for(MenuPlatform::Other);
        assert!(!other.iter().any(|entry| matches!(entry, MenuEntry::Copy)));
        let copy = other
            .iter()
            .find_map(|entry| match entry {
                MenuEntry::Custom(item) if item.id == ids::EDIT_COPY => Some(item),
                _ => None,
            })
            .expect("display-only Copy");
        assert_eq!(copy.accelerator(MenuPlatform::Other), None);
        assert_eq!(
            copy.display_text(MenuPlatform::Other),
            "Copy\tCtrl+C".to_string()
        );
    }
}
