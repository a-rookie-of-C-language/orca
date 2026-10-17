fn main() {
    let attributes =
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&[
            "poc_host_info",
            "poc_path_exists",
            "poc_paths_exist",
            "poc_copy_file",
            "poc_read_file_data_url",
            "poc_platform_info",
            "poc_app_identity",
            "poc_is_maximized",
            "poc_minimize",
            "poc_toggle_maximize",
            "poc_is_fullscreen",
            "poc_set_fullscreen",
            "poc_set_zoom",
            "poc_get_zoom",
            "poc_set_focus",
            "poc_request_close",
            "poc_confirm_close",
            "poc_popup_menu",
            "poc_emit_zoom",
            "poc_notification_sound_path",
            "poc_validate_dropped_paths",
        ]));
    tauri_build::try_build(attributes).expect("failed to run tauri-build");
}
