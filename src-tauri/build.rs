// The app's OWN commands are declared here, which is what makes the capability files
// mean anything about them.
//
// Tauri 2's ACL covers an app command only when the app generates a permission for it;
// with a bare `tauri_build::build()` none exist, `gen/schemas/acl-manifests.json` holds
// only the plugin manifests, and the `"windows"` list in a capability constrains nothing
// the app itself defines. Every command in the handler was therefore reachable from the
// MIDI webview — `write_binary_file`, `read_text_file`, `vd_set`, `midi_open_input`,
// `set_keep_awake` — while `capabilities/midi-window.json` described an isolation
// ("no device or file access of its own") that nothing enforced. CSP (`script-src
// 'self'`) bounds what could exploit it, so this is the contract being made true rather
// than a hole being closed.
//
// The list must stay in step with `generate_handler!` in lib.rs: a command missing here
// has no permission to grant, and a name here that no command answers to fails the
// build. `capabilities/default.json` grants the whole set to `main`; the MIDI window's
// capability grants only the relay pair it actually needs.
fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "read_text_file",
            "read_binary_file",
            "write_text_file",
            "write_binary_file",
            "experimental_enabled",
            "self_test_requested",
            "prepare_modified_requested",
            "reset_storage_requested",
            "third_party_licenses",
            "vd_connect",
            "vd_set",
            "vd_get",
            "vd_set_str",
            "vd_get_str",
            "vd_meters_subscribe",
            "vd_meters_unsubscribe",
            "vd_params_subscribe",
            "vd_params_unsubscribe",
            "vd_watch_link",
            "vd_disconnect",
            "vd_link_stats",
            "append_link_log",
            "app_build_kind",
            "midi_list_inputs",
            "midi_list_outputs",
            "midi_open_ports",
            "midi_open_input",
            "midi_close_input",
            "midi_open_output",
            "midi_close_output",
            "midi_send",
            "open_midi_window",
            "close_midi_window",
            "focus_midi_window",
            "pin_midi_window",
            "midi_window_open",
            "midi_ui_attach_main",
            "midi_ui_attach_window",
            "midi_ui_to_main",
            "midi_ui_to_window",
            "set_keep_awake",
            "set_edit_menu_state",
            "set_edit_menu_labels",
        ]),
    ))
    .expect("failed to run tauri-build");
}
