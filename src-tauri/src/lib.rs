// MindMapper — vault-based backend.
//
// Storage model (Obsidian-style):
//   <vault>/
//     .billydian/
//       config.json     # app settings (api key, model, s3, theme)
//       tokens.json     # per-file token usage tracking
//     foo.md            # markdown notes
//     bar.mindmap       # mind-map JSON (custom extension)
//     Subfolder/...
//
// Older builds called the config folder `.mindmapper/`; `set_vault_path`
// transparently renames any legacy folder it finds.
//
// The frontend picks/changes the vault folder via the dialog plugin and
// stores the path in `<config_dir>/mindmapper/vault.json` so we remember
// it across launches.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::Manager;

mod s3;

// ─── OpenRouter request/response types ─────────────────────────────────────

#[derive(serde::Serialize, serde::Deserialize)]
struct OpenRouterMessage {
    role: String,
    content: String,
}

#[derive(serde::Serialize, serde::Deserialize)]
struct OpenRouterRequest {
    model: String,
    messages: Vec<OpenRouterMessage>,
}

#[derive(serde::Deserialize)]
struct OpenRouterChoiceMessage {
    content: Option<String>,
}

#[derive(serde::Deserialize)]
struct OpenRouterChoice {
    message: OpenRouterChoiceMessage,
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
struct OpenRouterUsage {
    prompt_tokens: Option<u32>,
    completion_tokens: Option<u32>,
    total_tokens: Option<u32>,
}

#[derive(serde::Deserialize)]
struct OpenRouterResponse {
    choices: Option<Vec<OpenRouterChoice>>,
    error: Option<serde_json::Value>,
    usage: Option<OpenRouterUsage>,
}

#[derive(serde::Serialize)]
struct GenerationResponse {
    data: String,
    prompt_tokens: u32,
    completion_tokens: u32,
    total_tokens: u32,
}

// ─── Vault tree types ──────────────────────────────────────────────────────

#[derive(serde::Serialize)]
struct VaultEntry {
    /// Path relative to the vault root, forward-slash separated.
    path: String,
    /// Base name with extension.
    name: String,
    /// "dir" | "md" | "mindmap" | "image" | "other"
    kind: String,
    /// Omitted from the JSON for files (where it would be null) — saves
    /// ~15 bytes per file in the IPC payload, which adds up to dozens of
    /// KB on a populated monorepo.
    #[serde(skip_serializing_if = "Option::is_none")]
    children: Option<Vec<VaultEntry>>,
    // Note: we used to include a `modified: Option<u64>` field here, but
    // the front-end never reads it — and fetching it for every file on a
    // monorepo means an extra `GetFileInformationByHandle` syscall per
    // entry on Windows, which is the difference between a snappy and a
    // sluggish tree load. The S3 sync walker keeps its own mtime
    // tracking inside `s3::walk_local`; this listing API is purely for
    // UI.
}

// ─── Helpers ───────────────────────────────────────────────────────────────

fn friendly_openrouter_error(status: reqwest::StatusCode, body: &str) -> String {
    if let Ok(json) = serde_json::from_str::<serde_json::Value>(body) {
        if let Some(err_obj) = json.get("error") {
            let msg = err_obj.get("message").and_then(|v| v.as_str()).unwrap_or("");
            let code = err_obj
                .get("code")
                .and_then(|v| v.as_str().map(|s| s.to_string()).or_else(|| v.as_i64().map(|n| n.to_string())))
                .unwrap_or_default();
            if !msg.is_empty() {
                return if code.is_empty() {
                    format!("OpenRouter ({}): {}", status, msg)
                } else {
                    format!("OpenRouter ({} / {}): {}", status, code, msg)
                };
            }
        }
    }
    let trimmed = if body.len() > 600 {
        format!("{}…", &body[..600])
    } else {
        body.to_string()
    };
    format!("OpenRouter API error (status {}): {}", status, trimmed)
}

fn parse_json_from_llm(response: &str) -> Result<String, String> {
    let clean = response.trim();
    let mut parsed = clean;
    if let Some(start) = parsed.find("```json") {
        parsed = &parsed[start + 7..];
    } else if let Some(start) = parsed.find("```") {
        parsed = &parsed[start + 3..];
    }
    if let Some(end) = parsed.rfind("```") {
        parsed = &parsed[..end];
    }
    let parsed_str = parsed.trim().to_string();
    // Validate without materialising the parsed tree — we only need to
    // know the JSON is well-formed, the frontend re-parses it anyway.
    // `IgnoredAny` skips through tokens without allocating the Value
    // nodes that `serde_json::Value` would.
    let _: serde::de::IgnoredAny = serde_json::from_str(&parsed_str)
        .map_err(|e| format!("Failed to parse JSON: {}. Raw: {}", e, parsed_str))?;
    Ok(parsed_str)
}

/// Strip optional ````md` / ``` ``` fences the LLM tends to wrap notes in.
fn strip_markdown_fences(s: &str) -> String {
    let trimmed = s.trim();
    let stripped = if trimmed.starts_with("```") {
        // remove the first line up through the newline
        let after = trimmed.splitn(2, '\n').nth(1).unwrap_or("");
        if let Some(end) = after.rfind("```") {
            after[..end].trim_end().to_string()
        } else {
            after.to_string()
        }
    } else {
        trimmed.to_string()
    };
    stripped
}

/// Disk-persisted list of known vaults + which one is currently active.
/// We keep `path` (legacy single-vault field) around so older `vault.json`
/// files still load cleanly — read it once, migrate into `vaults`, then
/// rewrite the file in the new shape next time anything changes.
#[derive(Default, serde::Serialize, serde::Deserialize)]
struct VaultPointer {
    #[serde(default)]
    vaults: Vec<String>,
    #[serde(default)]
    active: Option<String>,
    #[serde(default)]
    path: Option<String>, // legacy
}

fn read_pointer(app: &tauri::AppHandle) -> Result<VaultPointer, String> {
    let p = vault_pointer_path(app)?;
    if !p.exists() {
        return Ok(VaultPointer::default());
    }
    let s = fs::read_to_string(&p).map_err(|e| e.to_string())?;
    let mut v: VaultPointer = serde_json::from_str(&s).map_err(|e| e.to_string())?;
    // Legacy → modern: a v0.1 `vault.json` only had { path: "…" }. Lift
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
    fs::write(&p, body).map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(serde::Serialize)]
struct KnownVaults {
    vaults: Vec<String>,
    active: Option<String>,
}

/// Path to the file that remembers the user's vault choice.
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

/// Returns the contents of secrets.json, or "{}" if no secrets have
/// been written yet. The frontend parses + merges this with vault-local
/// settings to produce the final AppSettings.
#[tauri::command]
fn read_secrets(app: tauri::AppHandle) -> Result<String, String> {
    let p = secrets_file_path(&app)?;
    if !p.exists() {
        return Ok("{}".to_string());
    }
    fs::read_to_string(&p).map_err(|e| e.to_string())
}

#[tauri::command]
fn write_secrets(app: tauri::AppHandle, content: String) -> Result<(), String> {
    if content.len() > MAX_SECRETS_BYTES {
        return Err(format!(
            "Secrets payload too large: {} bytes (max {})",
            content.len(),
            MAX_SECRETS_BYTES
        ));
    }
    let p = secrets_file_path(&app)?;
    fs::write(&p, content).map_err(|e| e.to_string())?;
    // On Unix, lock down the file to user-only read/write. Windows NTFS
    // inheritance already restricts files under AppData\Roaming to the
    // current user's profile, so we skip the equivalent there.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&p, fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

/// File-classification by extension. Allocation-free: peeks at the
/// extension byte-slice and compares it case-insensitively against the
/// known kinds. The hot path (filenames without a matching extension)
/// is just a series of cheap byte compares — no per-file String alloc
/// like the old `to_lowercase()` based implementation did.
fn classify_file(name: &str) -> &'static str {
    let ext = Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("");
    if ext.eq_ignore_ascii_case("md") {
        return "md";
    }
    if ext.eq_ignore_ascii_case("mindmap") {
        return "mindmap";
    }
    if ext.eq_ignore_ascii_case("docx") {
        return "docx";
    }
    const IMG: &[&str] = &[
        "png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif",
    ];
    if IMG.iter().any(|e| ext.eq_ignore_ascii_case(e)) {
        return "image";
    }
    "other"
}

/// Recursive vault walker.
///
/// `rel_prefix` is the forward-slash-separated relative path of `dir`
/// inside the vault — passed in instead of being recomputed via
/// `strip_prefix` + `to_string_lossy` + `replace('\\', "/")` per entry.
/// Threading the prefix turns 3 allocations per file into 1 (the
/// `format!` that builds child `rel`).
fn walk_vault(rel_prefix: &str, dir: &Path) -> Result<Vec<VaultEntry>, String> {
    let read = match fs::read_dir(dir) {
        Ok(r) => r,
        Err(e) => return Err(e.to_string()),
    };

    // Pre-allocation hint — avoids Vec doubling during push on a wide
    // directory. 64 is a hand-tuned default; small dirs leak a few bytes
    // of capacity, large dirs save several reallocs.
    let mut out: Vec<VaultEntry> = Vec::with_capacity(64);

    for entry in read {
        let entry = entry.map_err(|e| e.to_string())?;
        let file_name = entry.file_name();
        let name_lossy = file_name.to_string_lossy();

        // Exclusion check BEFORE allocating the owned `name` String —
        // for excluded dirents (every `.git`, `node_modules`, etc. at
        // every level of a monorepo) this is a pure byte compare with
        // no heap allocation. Saves dozens to hundreds of allocations
        // on a typical monorepo walk.
        if s3::EXCLUDED_SEGMENTS.iter().any(|s| name_lossy == *s) {
            continue;
        }

        // file_type() reads from the DirEntry's cached attributes
        // (populated by readdir/FindFirstFileW), so no extra stat
        // syscall — unlike Path::is_dir()/is_file() which both do a
        // fresh metadata query.
        let ft = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };

        let name = name_lossy.into_owned();
        // Build the relative path incrementally instead of re-computing
        // via strip_prefix + replace per file.
        let rel = if rel_prefix.is_empty() {
            name.clone()
        } else {
            format!("{}/{}", rel_prefix, name)
        };

        if ft.is_dir() {
            let children = walk_vault(&rel, &entry.path())?;
            out.push(VaultEntry {
                path: rel,
                name,
                kind: "dir".to_string(),
                children: Some(children),
            });
        } else if ft.is_file() {
            let kind = classify_file(&name);
            out.push(VaultEntry {
                path: rel,
                name,
                kind: kind.to_string(),
                children: None,
            });
        }
        // symlinks/junctions intentionally ignored — following them on
        // Windows opens up loops + scope creep
    }

    // `sort_by_cached_key` computes the lowercase name ONCE per entry
    // (N allocations); the old `sort_by` + `entry_sort_key` did it
    // O(N log N) times during comparisons — ~10x the allocator traffic.
    out.sort_by_cached_key(|e| {
        (
            if e.kind == "dir" { 0u8 } else { 1u8 },
            e.name.to_ascii_lowercase(),
        )
    });
    Ok(out)
}

/// Reserved Windows device names — opening `CON.md` opens the console
/// device, `NUL.md` opens the null sink, etc. The OS silently swallows
/// the writes which then look like the user's file vanished. Reject
/// these up front before we hand a path to fs::write.
const RESERVED_WINDOWS_NAMES: &[&str] = &[
    "CON", "PRN", "AUX", "NUL",
    "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
    "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// IPC size guards. Anything bigger than this from a frontend call is
/// rejected before we allocate. Defends against:
///   - a hostile renderer (XSS via markdown → invoke) OOM-killing the
///     Rust process with a 10 GB string,
///   - accidental loops on the JS side that re-send growing payloads,
///   - a future feature wiring user input straight into a Tauri command
///     without its own bound.
const MAX_TEXT_WRITE_BYTES: usize = 50 * 1024 * 1024; // 50 MB plain text
const MAX_BLOB_READ_BYTES: u64 = 100 * 1024 * 1024;   // 100 MB binary
const MAX_TOPIC_BYTES: usize = 32 * 1024;             // 32 KB AI topic/prompt
const MAX_NOTE_BYTES: usize = 200 * 1024;             // 200 KB for title-gen content
const MAX_SECRETS_BYTES: usize = 16 * 1024;           // 16 KB secrets.json

/// Resolve a vault-relative path back to an absolute path under `vault`.
///
/// Rejects every path-confusion vector we've found in the wild:
///   - `..` segments (directory traversal)
///   - backslashes (`\\?\C:\…` UNC paths, and segments that survive the
///     forward-slash split below)
///   - colons in segments (Windows drive letters `C:/`, NTFS Alternate
///     Data Streams `file.md:hidden`)
///   - control characters (0x00-0x1F) — let an attacker craft files
///     that don't appear in directory listings
///   - trailing dot or space — Windows silently strips these, leading
///     to path-collision shenanigans
///   - reserved device names (`CON`, `NUL`, `LPT1`, …)
///
/// With these in place, `PathBuf::push(seg)` cannot escape the vault
/// root by construction — every seg is a benign relative component.
fn resolve_under_vault(vault: &Path, rel: &str) -> Result<PathBuf, String> {
    let rel = rel.trim_start_matches('/');
    if rel.contains('\\') {
        return Err("Path contains backslash".into());
    }
    let mut p = vault.to_path_buf();
    for seg in rel.split('/') {
        if seg.is_empty() || seg == "." {
            continue;
        }
        if seg == ".." {
            return Err("Invalid path (traversal)".into());
        }
        if seg.contains(':') {
            return Err("Path segment contains colon".into());
        }
        if seg.bytes().any(|b| b < 0x20) {
            return Err("Path segment contains control character".into());
        }
        if seg.ends_with('.') || seg.ends_with(' ') {
            return Err("Path segment ends with dot or space".into());
        }
        // Compare the stem (before any extension) case-insensitively.
        // `CON.md`, `con.MD`, even `LPT9.something.txt` all hit this.
        let stem = seg.split('.').next().unwrap_or("");
        let upper = stem.to_ascii_uppercase();
        if RESERVED_WINDOWS_NAMES.contains(&upper.as_str()) {
            return Err(format!("Reserved Windows name: {}", seg));
        }
        p.push(seg);
    }
    Ok(p)
}

// ─── Commands: vault pointer ───────────────────────────────────────────────

#[tauri::command]
fn get_vault_path(app: tauri::AppHandle) -> Result<Option<String>, String> {
    Ok(read_pointer(&app)?.active)
}

/// Full list of vaults the user has ever opened, plus which one is
/// currently active. Front-end uses this to power the vault picker
/// dropdown — clicking a row calls `set_vault_path` with that path.
#[tauri::command]
fn get_known_vaults(app: tauri::AppHandle) -> Result<KnownVaults, String> {
    let v = read_pointer(&app)?;
    Ok(KnownVaults { vaults: v.vaults, active: v.active })
}

#[tauri::command]
fn set_vault_path(app: tauri::AppHandle, path: String) -> Result<(), String> {
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
/// untouched on disk — we only remove the pointer. If the removed vault
/// was active, the new active is whatever's left at the top of the list
/// (or None when the list empties).
#[tauri::command]
fn remove_vault(app: tauri::AppHandle, path: String) -> Result<KnownVaults, String> {
    let mut state = read_pointer(&app)?;
    state.vaults.retain(|v| v != &path);
    if state.active.as_deref() == Some(path.as_str()) {
        state.active = state.vaults.first().cloned();
    }
    write_pointer(&app, &state)?;
    Ok(KnownVaults { vaults: state.vaults, active: state.active })
}

// ─── Commands: vault file tree ─────────────────────────────────────────────

/// Tree listing runs on the blocking pool so a 10k-file monorepo walk
/// doesn't stall the tokio reactor (which is also driving sync, AI
/// generation, and other IPC calls). Without spawn_blocking the
/// sidebar refresh after a sync was synchronously blocking every other
/// command for the duration of the walk.
#[tauri::command]
async fn list_vault_tree(vault: String) -> Result<Vec<VaultEntry>, String> {
    let root = PathBuf::from(&vault);
    if !root.is_dir() {
        return Err(format!("Vault is not a directory: {}", vault));
    }
    tauri::async_runtime::spawn_blocking(move || walk_vault("", &root))
        .await
        .map_err(|e| format!("walk task: {}", e))?
}

#[tauri::command]
fn read_vault_file(vault: String, rel: String) -> Result<String, String> {
    let path = resolve_under_vault(&PathBuf::from(&vault), &rel)?;
    if !path.is_file() {
        return Err(format!("Not a file: {}", rel));
    }
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

/// Legacy base64 reader — kept for any caller that still expects a
/// data URL. New callers (ImageViewer) should use `read_vault_file_blob`
/// which transfers raw bytes via Tauri's binary IPC channel, skipping
/// the 33% base64 inflation and a String→atob roundtrip on the JS side.
#[tauri::command]
fn read_vault_file_bytes(vault: String, rel: String) -> Result<String, String> {
    use base64::{engine::general_purpose::STANDARD as B64, Engine};
    let path = resolve_under_vault(&PathBuf::from(&vault), &rel)?;
    if !path.is_file() {
        return Err(format!("Not a file: {}", rel));
    }
    if let Ok(meta) = fs::metadata(&path) {
        if meta.len() > MAX_BLOB_READ_BYTES {
            return Err(format!("File too large: {} bytes", meta.len()));
        }
    }
    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
    Ok(B64.encode(bytes))
}

/// Binary read using Tauri's raw-bytes IPC channel. Skips the base64
/// hop, halving peak memory + IPC transfer cost on large images.
/// Frontend wraps the returned ArrayBuffer in a Blob + URL.createObjectURL
/// so the <img> can render it and we can revoke the URL when the
/// viewer unmounts.
#[tauri::command]
async fn read_vault_file_blob(
    vault: String,
    rel: String,
) -> Result<tauri::ipc::Response, String> {
    let path = resolve_under_vault(&PathBuf::from(&vault), &rel)?;
    if !path.is_file() {
        return Err(format!("Not a file: {}", rel));
    }
    // Cheap size check via metadata before reading the whole file into
    // memory — protects against a hostile renderer asking us to slurp a
    // 10 GB log file.
    if let Ok(meta) = fs::metadata(&path) {
        if meta.len() > MAX_BLOB_READ_BYTES {
            return Err(format!("File too large: {} bytes", meta.len()));
        }
    }
    let bytes = tauri::async_runtime::spawn_blocking(move || fs::read(&path))
        .await
        .map_err(|e| format!("read task: {}", e))?
        .map_err(|e| e.to_string())?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
fn write_vault_file(vault: String, rel: String, content: String) -> Result<(), String> {
    if content.len() > MAX_TEXT_WRITE_BYTES {
        return Err(format!(
            "Write payload too large: {} bytes (max {})",
            content.len(),
            MAX_TEXT_WRITE_BYTES
        ));
    }
    let path = resolve_under_vault(&PathBuf::from(&vault), &rel)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&path, content).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn delete_vault_file(vault: String, rel: String) -> Result<(), String> {
    let path = resolve_under_vault(&PathBuf::from(&vault), &rel)?;
    if path.is_dir() {
        fs::remove_dir_all(&path).map_err(|e| e.to_string())?;
    } else if path.exists() {
        fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn rename_vault_file(vault: String, from: String, to: String) -> Result<(), String> {
    let vault_p = PathBuf::from(&vault);
    let src = resolve_under_vault(&vault_p, &from)?;
    let dst = resolve_under_vault(&vault_p, &to)?;
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::rename(&src, &dst).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn create_vault_folder(vault: String, rel: String) -> Result<(), String> {
    let path = resolve_under_vault(&PathBuf::from(&vault), &rel)?;
    fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    Ok(())
}

// ─── Commands: OpenRouter calls ────────────────────────────────────────────

async fn call_openrouter(
    client: &reqwest::Client,
    api_key: String,
    model: String,
    prompt: String,
) -> Result<(String, OpenRouterUsage), String> {
    let res = client
        .post("https://openrouter.ai/api/v1/chat/completions")
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Content-Type", "application/json")
        .header("HTTP-Referer", "https://github.com/reflaxess123/mapper")
        .header("X-Title", "MindMapper")
        .json(&OpenRouterRequest {
            model,
            messages: vec![OpenRouterMessage {
                role: "user".to_string(),
                content: prompt,
            }],
        })
        .send()
        .await
        .map_err(|e| format!("HTTP request failed: {}", e))?;

    let status = res.status();
    let body = res.text().await.map_err(|e| format!("Failed to read response body: {}", e))?;

    if !status.is_success() {
        return Err(friendly_openrouter_error(status, &body));
    }

    let response_data: OpenRouterResponse = serde_json::from_str(&body)
        .map_err(|e| format!("Failed to parse API response JSON: {}. Response: {}", e, body))?;

    if let Some(err) = response_data.error {
        let msg = err.get("message").and_then(|v| v.as_str()).unwrap_or("");
        let code = err
            .get("code")
            .and_then(|v| v.as_str().map(|s| s.to_string()).or_else(|| v.as_i64().map(|n| n.to_string())))
            .unwrap_or_default();
        if !msg.is_empty() {
            return Err(if code.is_empty() {
                format!("OpenRouter: {}", msg)
            } else {
                format!("OpenRouter ({}): {}", code, msg)
            });
        }
        return Err(format!("OpenRouter returned error: {}", err));
    }

    let choices = response_data.choices.ok_or("No choices returned from OpenRouter API")?;
    if choices.is_empty() {
        return Err("Empty choices returned from OpenRouter API".to_string());
    }
    let content = choices[0]
        .message
        .content
        .as_ref()
        .ok_or("No message content returned from OpenRouter API")?
        .clone();
    let usage = response_data.usage.unwrap_or(OpenRouterUsage {
        prompt_tokens: Some(0),
        completion_tokens: Some(0),
        total_tokens: Some(0),
    });
    Ok((content, usage))
}

#[tauri::command]
async fn generate_mindmap(
    api_key: String,
    topic: String,
    model: String,
    client: tauri::State<'_, Arc<reqwest::Client>>,
) -> Result<String, String> {
    if topic.len() > MAX_TOPIC_BYTES {
        return Err(format!("Topic too long: {} bytes", topic.len()));
    }
    let prompt = format!(
        "Generate a detailed, hierarchical mind map on the topic: \"{}\".\n\
         Return ONLY a valid JSON object matching the following structure. Do not output any markdown formatting, code blocks, or extra text.\n\
         \n\
         Schema:\n\
         {{\n\
           \"id\": \"root\",\n\
           \"name\": \"Topic Name\",\n\
           \"children\": [\n\
             {{\n\
               \"id\": \"subtopic-id-1\",\n\
               \"name\": \"Subtopic A\",\n\
               \"children\": [\n\
                 {{\n\
                   \"id\": \"sub-subtopic-id-1-1\",\n\
                   \"name\": \"Sub-subtopic A1\",\n\
                   \"children\": []\n\
                 }}\n\
               ]\n\
             }}\n\
           ]\n\
         }}\n\
         \n\
         Provide 3 to 5 main branches, and each main branch should have 2 to 4 sub-branches. Keep the names concise (1-5 words). Ensure the JSON is completely valid.",
        topic
    );
    let (content, usage) = call_openrouter(&client, api_key, model, prompt).await?;
    let clean_json = parse_json_from_llm(&content)?;
    let resp = GenerationResponse {
        data: clean_json,
        prompt_tokens: usage.prompt_tokens.unwrap_or(0),
        completion_tokens: usage.completion_tokens.unwrap_or(0),
        total_tokens: usage.total_tokens.unwrap_or(0),
    };
    serde_json::to_string(&resp).map_err(|e| format!("Failed to serialize result: {}", e))
}

#[tauri::command]
async fn extend_node(
    api_key: String,
    topic_context: String,
    node_label: String,
    model: String,
    client: tauri::State<'_, Arc<reqwest::Client>>,
) -> Result<String, String> {
    if topic_context.len() > MAX_TOPIC_BYTES || node_label.len() > MAX_TOPIC_BYTES {
        return Err("Topic context or node label too long".into());
    }
    let prompt = format!(
        "We are building a mind map about the overarching theme: \"{}\".\n\
         We want to expand the specific node named: \"{}\".\n\
         Generate 3 to 5 highly relevant sub-branches (children) for this specific node.\n\
         Return ONLY a valid JSON array of these child nodes, matching the following structure. Do not output any markdown formatting, code blocks, or extra text.\n\
         \n\
         Schema:\n\
         [\n\
           {{\n\
             \"id\": \"unique-subtopic-id-1\",\n\
             \"name\": \"Child Subtopic Name 1\",\n\
             \"children\": []\n\
           }},\n\
           {{\n\
             \"id\": \"unique-subtopic-id-2\",\n\
             \"name\": \"Child Subtopic Name 2\",\n\
             \"children\": []\n\
           }}\n\
         ]\n\
         \n\
         Ensure the generated IDs are unique strings and the response is a valid JSON array.",
        topic_context, node_label
    );
    let (content, usage) = call_openrouter(&client, api_key, model, prompt).await?;
    let clean_json = parse_json_from_llm(&content)?;
    let resp = GenerationResponse {
        data: clean_json,
        prompt_tokens: usage.prompt_tokens.unwrap_or(0),
        completion_tokens: usage.completion_tokens.unwrap_or(0),
        total_tokens: usage.total_tokens.unwrap_or(0),
    };
    serde_json::to_string(&resp).map_err(|e| format!("Failed to serialize result: {}", e))
}

#[tauri::command]
async fn generate_title(
    api_key: String,
    content: String,
    model: String,
    client: tauri::State<'_, Arc<reqwest::Client>>,
) -> Result<String, String> {
    if content.len() > MAX_NOTE_BYTES {
        return Err(format!("Note content too long: {} bytes", content.len()));
    }
    // Cap the content we ship to the model — titles only need the gist,
    // and we'd rather not pay for 50k tokens of context. char_indices
    // gives us a UTF-8 boundary safe slice without re-allocating the
    // first 4000 chars into a fresh String.
    let snippet: &str = match content.char_indices().nth(4000) {
        Some((idx, _)) => &content[..idx],
        None => content.as_str(),
    };
    let prompt = format!(
        "Read the markdown note below and propose a short title for it.\n\
         Requirements:\n\
         - 3 to 7 words, Title Case.\n\
         - No quotes, no trailing punctuation, no leading `#`.\n\
         - Output ONLY the title text on a single line.\n\
         \n\
         --- NOTE START ---\n{}\n--- NOTE END ---",
        snippet
    );
    let (raw, usage) = call_openrouter(&client, api_key, model, prompt).await?;
    // Some models return code fences anyway — strip + trim.
    let title = strip_markdown_fences(&raw)
        .lines()
        .next()
        .unwrap_or("")
        .trim()
        .trim_matches(|c: char| c == '"' || c == '\'' || c == '#' || c == '.')
        .trim()
        .to_string();
    let resp = GenerationResponse {
        data: title,
        prompt_tokens: usage.prompt_tokens.unwrap_or(0),
        completion_tokens: usage.completion_tokens.unwrap_or(0),
        total_tokens: usage.total_tokens.unwrap_or(0),
    };
    serde_json::to_string(&resp).map_err(|e| format!("Failed to serialize result: {}", e))
}

#[tauri::command]
async fn generate_note(
    api_key: String,
    topic: String,
    model: String,
    client: tauri::State<'_, Arc<reqwest::Client>>,
) -> Result<String, String> {
    if topic.len() > MAX_TOPIC_BYTES {
        return Err(format!("Topic too long: {} bytes", topic.len()));
    }
    let prompt = format!(
        "Write a detailed, well-structured study note on the topic: \"{}\".\n\
         Output ONLY raw GitHub-Flavored Markdown — no surrounding code fences, no preamble.\n\
         Use:\n\
         - `# Title` as the first line (use the topic as the title).\n\
         - `##` / `###` headings to organize sections.\n\
         - Bullet lists for enumerable points; numbered lists for sequences.\n\
         - Bold for key terms.\n\
         - Inline `$...$` and display `$$...$$` LaTeX for any math.\n\
         - Fenced code blocks where code is helpful.\n\
         Aim for 400–800 words. Be specific and avoid fluff.",
        topic
    );
    let (content, usage) = call_openrouter(&client, api_key, model, prompt).await?;
    let md = strip_markdown_fences(&content);
    let resp = GenerationResponse {
        data: md,
        prompt_tokens: usage.prompt_tokens.unwrap_or(0),
        completion_tokens: usage.completion_tokens.unwrap_or(0),
        total_tokens: usage.total_tokens.unwrap_or(0),
    };
    serde_json::to_string(&resp).map_err(|e| format!("Failed to serialize result: {}", e))
}

// ─── Entry point ───────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        // Remembers window position / size / maximised state across
        // launches. State file lives in <app-config-dir>/window-state.json
        // and is restored before the window is shown.
        .plugin(tauri_plugin_window_state::Builder::default().build())
        // One process-wide reqwest::Client, shared with every OpenRouter
        // command via `tauri::State`. Without this, each generator call
        // built a fresh client → fresh TLS context → fresh handshake to
        // openrouter.ai. With a warm connection pool, subsequent calls
        // reuse the HTTP/2 connection, saving 100-300 ms per request.
        // Tuned timeouts so a hung server doesn't lock the app forever.
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
            // OpenRouter
            generate_mindmap,
            extend_node,
            generate_note,
            generate_title,
            // Vault pointer
            get_vault_path,
            set_vault_path,
            get_known_vaults,
            remove_vault,
            // Device-local secrets (apiKey + S3 creds, stored outside
            // the vault so they never ride along on sync/backup).
            read_secrets,
            write_secrets,
            // Vault file ops
            list_vault_tree,
            read_vault_file,
            read_vault_file_bytes,
            read_vault_file_blob,
            write_vault_file,
            delete_vault_file,
            rename_vault_file,
            create_vault_folder,
            // S3 sync
            s3::sync_vault,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
