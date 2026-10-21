//! Live shortcut-hint updates for menu items.
//!
//! Electron rebuilds its application menu on every keybinding update so item
//! labels carry the current chord text; the Tauri menu is built once, so the
//! renderer pushes each hint change back through this command. An absent
//! hint clears any previously pushed hint back to the item's base label.
use serde::Deserialize;
use tauri::{menu::MenuItemKind, AppHandle};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MenuHintUpdate {
    pub id: String,
    /// Rendered hint text (`Ctrl+,`), or None to restore the base label.
    pub hint: Option<String>,
    /// Base label used when `hint` is None. Required so the Rust side does not
    /// have to know which spec entry owns the id.
    pub base_text: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MenuHintsArgs {
    pub updates: Vec<MenuHintUpdate>,
}

fn render_label(update: &MenuHintUpdate) -> String {
    match &update.hint {
        Some(hint) if !hint.is_empty() => format!("{}\t{}", update.base_text, hint),
        _ => update.base_text.clone(),
    }
}

#[tauri::command]
pub fn poc_menu_set_hints(app: AppHandle, args: MenuHintsArgs) -> Result<(), String> {
    const MAX_UPDATES: usize = 256;
    const MAX_HINT_BYTES: usize = 64;
    const MAX_BASE_BYTES: usize = 128;
    const MAX_ID_BYTES: usize = 64;
    if args.updates.len() > MAX_UPDATES {
        return Err("menu hint update set is too large".to_string());
    }
    let menu = app
        .menu()
        .ok_or_else(|| "application menu is unavailable".to_string())?;
    let mut rejected: Vec<String> = Vec::new();
    for update in &args.updates {
        let oversized = update.id.is_empty()
            || update.id.len() > MAX_ID_BYTES
            || update.base_text.len() > MAX_BASE_BYTES
            || update
                .hint
                .as_ref()
                .is_some_and(|hint| hint.len() > MAX_HINT_BYTES);
        if oversized {
            rejected.push(update.id.clone());
            continue;
        }
        let text = render_label(update);
        let result = match menu.get(&update.id) {
            Some(MenuItemKind::MenuItem(item)) => item.set_text(text),
            Some(MenuItemKind::Check(item)) => item.set_text(text),
            Some(MenuItemKind::Icon(item)) => item.set_text(text),
            Some(MenuItemKind::Submenu(item)) => item.set_text(text),
            _ => {
                rejected.push(update.id.clone());
                continue;
            }
        };
        result.map_err(|error| error.to_string())?;
    }
    if rejected.is_empty() {
        Ok(())
    } else {
        Err(format!("unknown menu item ids: {}", rejected.join(",")))
    }
}

#[cfg(test)]
mod tests {
    use super::{render_label, MenuHintUpdate};

    fn update(hint: Option<&str>) -> MenuHintUpdate {
        MenuHintUpdate {
            id: "view-zoom-in".to_string(),
            hint: hint.map(str::to_string),
            base_text: "Zoom In".to_string(),
        }
    }

    #[test]
    fn renders_hint_as_tab_separated_label() {
        assert_eq!(render_label(&update(Some("Ctrl+="))), "Zoom In\tCtrl+=");
    }

    #[test]
    fn missing_or_empty_hint_falls_back_to_base_label() {
        assert_eq!(render_label(&update(None)), "Zoom In");
        assert_eq!(render_label(&update(Some(""))), "Zoom In");
    }
}
