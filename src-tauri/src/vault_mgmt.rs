// Vault registry, OS-level pointer file, device-local secrets blob.
//
// Lives outside the vault itself in <app_config_dir>:
//   vault.json     — list of known vaults + which one's active
//   secrets.json   — OpenRouter key + S3 creds (NEVER in the vault so
//                    they don't ride along on sync/backup)
//
// `verify_vault` is the gatekeeper every vault-touching command must
// thread through. It reads `vault.json` to confirm the caller's vault
// is actually registered — without this, a compromised renderer could
// pass an arbitrary path and use our IPC commands to walk any folder
// on disk.

use std::fs;
use std::path::{Path, PathBuf};
use tauri::Manager;

const MAX_SECRETS_BYTES: usize = 16 * 1024;

/// Disk-persisted list of known vaults + which one is currently active.
/// We keep `path` (legacy single-vault field) around so older
/// `vault.json` files still load cleanly — read it once, migrate into
/// `vaults`, then rewrite the file in the new shape next time anything
/// changes.
#[derive(Default, serde::Serialize, serde::Deserialize)]
struct VaultPointer {
    #[serde(default)]
    vaults: Vec<String>,
    #[serde(default)]
    active: Option<String>,
    #[serde(default)]
    path: Option<String>, // legacy
}

#[derive(serde::Serialize)]
pub struct KnownVaults {
    pub vaults: Vec<String>,
    pub active: Option<String>,
}

fn read_pointer(app: &tauri::AppHandle) -> Result<VaultPointer, String> {
    let p = vault_pointer_path(app)?;
    if !p.exists() {
        return Ok(VaultPointer::default());
    }
    let s = fs::read_to_string(&p).map_err(|e| e.to_string())?;
    let mut v: VaultPointer = serde_json::from_str(&s).map_err(|e| e.to_string())?;
    // Legacy → modern: v0.1 `vault.json` only had { path: "…" }. Lift
    // that into `vaults` + `active` so the rest of the code sees one
    // canonical shape.
    if v.vaults.is_empty() {
        if let Some(legacy) = v.path.take() {
            v.vaults.push(legacy.clone());
            v.active = Some(legacy);
        }
    }
    Ok(v)
}

fn write_pointer(app: &tauri::AppHandle, v: &VaultPointer) -> Result<(), String> {
    let p = vault_pointer_path(app)?;
    let body = serde_json::to_string_pretty(v).map_err(|e| e.to_string())?;
    write_atomic(&p, &body).map_err(|e| e.to_string())?;
    Ok(())
}

fn vault_pointer_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("vault.json"))
}

/// Path to the device-local secrets blob (OpenRouter key + S3 creds).
///
/// Secrets used to live alongside other settings in the vault folder
/// (`.billydian/config.json`), which meant they'd ride along on any
/// sync, backup, or cloud-folder mirror the user pointed at the vault.
/// Now they sit in `app_config_dir` (Windows: AppData\Roaming\Billydian)
/// which is per-user, per-machine, and never visited by S3 sync.
fn secrets_file_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("secrets.json"))
}

/// Write a file via tmp + atomic rename so a crash mid-write leaves
/// either the old contents or the new — never a truncated file. Used
/// for the small config blobs (vault pointer, secrets) where corruption
/// would brick the app on next launch.
fn write_atomic(path: &Path, contents: &str) -> std::io::Result<()> {
    let mut tmp = path.to_path_buf();
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| format!("{}.tmp", e))
        .unwrap_or_else(|| "tmp".to_string());
    tmp.set_extension(ext);
    fs::write(&tmp, contents)?;
    // Rust's `fs::rename` on Windows ≥1.5 maps to MoveFileExW with
    // MOVEFILE_REPLACE_EXISTING, so the rename is atomic from the
    // perspective of any concurrent reader.
    fs::rename(&tmp, path)
}

/// Verify `vault` is one of the vaults the user has actually opened
/// (`pointer.vaults`). Without this, a compromised renderer could call
/// `read_vault_file({vault: "C:/Users/me", rel: "Documents/secret.txt"})`
/// — `resolve_under_vault` checks `rel` for traversal but never
/// constrains `vault` itself. Every vault file command threads `app`
/// through this so the backend has a single source of truth on which
/// roots are legitimate.
pub(crate) fn verify_vault(app: &tauri::AppHandle, vault: &str) -> Result<PathBuf, String> {
    let pointer = read_pointer(app)?;
    if !pointer.vaults.iter().any(|v| v == vault) {
        return Err("Vault is not registered".into());
    }
    let p = PathBuf::from(vault);
    if !p.is_dir() {
        return Err(format!("Vault is not a directory: {}", vault));
    }
    Ok(p)
}

// ─── Commands: vault pointer ───────────────────────────────────────

#[tauri::command]
pub fn get_vault_path(app: tauri::AppHandle) -> Result<Option<String>, String> {
    Ok(read_pointer(&app)?.active)
}

/// Full list of vaults the user has ever opened, plus which one is
/// currently active. Front-end uses this to power the vault picker
/// dropdown — clicking a row calls `set_vault_path` with that path.
#[tauri::command]
pub fn get_known_vaults(app: tauri::AppHandle) -> Result<KnownVaults, String> {
    let v = read_pointer(&app)?;
    Ok(KnownVaults { vaults: v.vaults, active: v.active })
}

#[tauri::command]
pub fn set_vault_path(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if !p.is_dir() {
        return Err(format!("Not a directory: {}", path));
    }

    // One-time migration: older builds stored settings in `.mindmapper/`.
    // If that folder exists and the new `.billydian/` doesn't, hand the
    // whole tree over. No data loss, no manual move on the user's part.
    let legacy = p.join(".mindmapper");
    let cfg_dir = p.join(".billydian");
    if legacy.is_dir() && !cfg_dir.exists() {
        fs::rename(&legacy, &cfg_dir)
            .map_err(|e| format!("Could not migrate .mindmapper → .billydian: {}", e))?;
    }
    fs::create_dir_all(&cfg_dir).map_err(|e| e.to_string())?;

    let mut state = read_pointer(&app)?;
    if !state.vaults.iter().any(|v| v == &path) {
        state.vaults.push(path.clone());
    }
    state.active = Some(path);
    state.path = None;
    write_pointer(&app, &state)?;
    Ok(())
}

/// Forget a vault from the known list. The vault folder itself stays
/// untouched on disk — we only remove the pointer. If the removed
/// vault was active, the new active is whatever's left at the top of
/// the list (or None when the list empties).
#[tauri::command]
pub fn remove_vault(app: tauri::AppHandle, path: String) -> Result<KnownVaults, String> {
    let mut state = read_pointer(&app)?;
    state.vaults.retain(|v| v != &path);
    if state.active.as_deref() == Some(path.as_str()) {
        state.active = state.vaults.first().cloned();
    }
    write_pointer(&app, &state)?;
    Ok(KnownVaults { vaults: state.vaults, active: state.active })
}

// ─── Commands: device-local secrets ────────────────────────────────

/// Returns the contents of secrets.json, or "{}" if no secrets have
/// been written yet. The frontend parses + merges this with
/// vault-local settings to produce the final AppSettings.
#[tauri::command]
pub async fn read_secrets(app: tauri::AppHandle) -> Result<String, String> {
    let p = secrets_file_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        if !p.exists() {
            return Ok("{}".to_string());
        }
        fs::read_to_string(&p).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("read_secrets task: {}", e))?
}

#[tauri::command]
pub async fn write_secrets(app: tauri::AppHandle, content: String) -> Result<(), String> {
    if content.len() > MAX_SECRETS_BYTES {
        return Err(format!(
            "Secrets payload too large: {} bytes (max {})",
            content.len(),
            MAX_SECRETS_BYTES
        ));
    }
    let p = secrets_file_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        write_atomic(&p, &content).map_err(|e| e.to_string())?;
        // On Unix, lock down the file to user-only read/write. Windows
        // NTFS inheritance already restricts files under AppData\Roaming
        // to the current user's profile, so we skip the equivalent
        // there.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&p, fs::Permissions::from_mode(0o600));
        }
        Ok::<(), String>(())
    })
    .await
    .map_err(|e| format!("write_secrets task: {}", e))?
}
