//! Live checkmarks for the View > Appearance menu.
//!
//! Electron rebuilds its application menu on every settings update so the
//! Appearance checkboxes track state; the Tauri menu is built once, so the
//! renderer pushes each appearance change back through this command.
use serde::Deserialize;
use tauri::{menu::MenuItemKind, AppHandle};

use crate::application_menu_spec::ids;

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppearanceChecksArgs {
    pub status_bar_visible: Option<bool>,
    pub show_tasks_button: Option<bool>,
    pub show_automations_button: Option<bool>,
    pub show_mobile_button: Option<bool>,
    pub show_titlebar_app_name: Option<bool>,
}

/// Present fields in Appearance-submenu order; missing fields stay untouched
/// so partial updates cannot reset unrelated checkmarks.
fn appearance_checks(args: &AppearanceChecksArgs) -> Vec<(&'static str, bool)> {
    [
        (ids::VIEW_TOGGLE_STATUS_BAR, args.status_bar_visible),
        (ids::VIEW_APPEARANCE_TASKS, args.show_tasks_button),
        (
            ids::VIEW_APPEARANCE_AUTOMATIONS,
            args.show_automations_button,
        ),
        (ids::VIEW_APPEARANCE_MOBILE, args.show_mobile_button),
        (ids::VIEW_APPEARANCE_TITLEBAR, args.show_titlebar_app_name),
    ]
    .into_iter()
    .filter_map(|(id, checked)| checked.map(|checked| (id, checked)))
    .collect()
}

#[tauri::command]
pub fn poc_menu_set_appearance_checks(
    app: AppHandle,
    args: AppearanceChecksArgs,
) -> Result<(), String> {
    let menu = app
        .menu()
        .ok_or_else(|| "application menu is unavailable".to_string())?;
    for (id, checked) in appearance_checks(&args) {
        match menu.get(id) {
            Some(MenuItemKind::Check(item)) => item
                .set_checked(checked)
                .map_err(|error| error.to_string())?,
            _ => return Err("appearance menu item is unavailable".to_string()),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{appearance_checks, AppearanceChecksArgs};
    use crate::application_menu_spec::ids;

    fn all_present() -> AppearanceChecksArgs {
        AppearanceChecksArgs {
            status_bar_visible: Some(true),
            show_tasks_button: Some(false),
            show_automations_button: Some(true),
            show_mobile_button: Some(false),
            show_titlebar_app_name: Some(true),
        }
    }

    #[test]
    fn maps_present_keys_in_submenu_order() {
        assert_eq!(
            appearance_checks(&all_present()),
            vec![
                (ids::VIEW_TOGGLE_STATUS_BAR, true),
                (ids::VIEW_APPEARANCE_TASKS, false),
                (ids::VIEW_APPEARANCE_AUTOMATIONS, true),
                (ids::VIEW_APPEARANCE_MOBILE, false),
                (ids::VIEW_APPEARANCE_TITLEBAR, true),
            ]
        );
    }

    #[test]
    fn skips_missing_keys_without_touching_the_rest() {
        let args = AppearanceChecksArgs {
            status_bar_visible: Some(false),
            ..Default::default()
        };
        assert_eq!(
            appearance_checks(&args),
            vec![(ids::VIEW_TOGGLE_STATUS_BAR, false)]
        );
        assert!(appearance_checks(&AppearanceChecksArgs::default()).is_empty());
    }
}
