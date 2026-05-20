// MindMapper / Billydian — vault-based backend.
//
// Storage model (Obsidian-style):
//   <vault>/
//     .billydian/
//       config.json     # app settings (model, theme, …)
//       tokens.json     # per-file AI token usage tracking
//     foo.md            # markdown notes
//     bar.mindmap       # mind-map JSON (custom extension)
//     Subfolder/...
//
// Older builds called the config folder `.mindmapper/`;
// `vault_mgmt::set_vault_path` transparently renames any legacy folder
// it finds.
//
// Module layout:
//   ai          — OpenRouter integration (4 generate commands)
//   vault_fs    — vault tree listing + per-file CRUD
//   vault_mgmt  — known-vaults registry + device-local secrets
//   s3          — bidirectional S3 sync (preserved from prior layout)
//
// Secrets (OpenRouter key + S3 creds) live in
// <app_config_dir>/secrets.json — never inside the vault, so S3 sync
// never carries them off the machine.

use std::sync::Arc;
use tauri::Manager;

mod ai;
mod s3;
mod vault_fs;
mod vault_mgmt;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        // Remembers window position / size / maximised state across
        // launches. State file lives in <app-config-dir>/window-state.json
        // and is restored before the window is shown.
        .plugin(tauri_plugin_window_state::Builder::default().build())
        // One process-wide reqwest::Client, shared with every
        // OpenRouter command via `tauri::State`. Without this, each
        // generator call would build a fresh client → fresh TLS
        // context → fresh handshake to openrouter.ai. With a warm
        // connection pool, subsequent calls reuse the HTTP/2
        // connection, saving 100–300 ms per request. Timeouts tuned so
        // a hung server doesn't lock the app forever.
        .setup(|app| {
            let client = reqwest::Client::builder()
                .pool_max_idle_per_host(8)
                .tcp_keepalive(Some(std::time::Duration::from_secs(60)))
                .timeout(std::time::Duration::from_secs(180))
                .connect_timeout(std::time::Duration::from_secs(15))
                .build()?;
            app.manage(Arc::new(client));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // AI (OpenRouter)
            ai::generate_mindmap,
            ai::extend_node,
            ai::generate_note,
            ai::generate_title,
            // Vault registry + device-local secrets
            vault_mgmt::get_vault_path,
            vault_mgmt::set_vault_path,
            vault_mgmt::get_known_vaults,
            vault_mgmt::remove_vault,
            vault_mgmt::read_secrets,
            vault_mgmt::write_secrets,
            // Vault file ops
            vault_fs::list_vault_tree,
            vault_fs::read_vault_file,
            vault_fs::read_vault_file_bytes,
            vault_fs::read_vault_file_blob,
            vault_fs::write_vault_file,
            vault_fs::delete_vault_file,
            vault_fs::rename_vault_file,
            vault_fs::create_vault_folder,
            // S3 sync
            s3::sync_vault,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
