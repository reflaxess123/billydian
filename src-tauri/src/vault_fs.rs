// Vault tree listing + per-file CRUD.
//
// Every file-touching command threads through `verify_vault`
// (in vault_mgmt) — the gatekeeper that confirms the renderer is
// asking about a vault it's actually allowed to see. Then
// `resolve_under_vault` rejects any rel-path that could escape the
// vault root.

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use std::fs;
use std::path::{Path, PathBuf};

use crate::s3;
use crate::vault_mgmt::verify_vault;

/// IPC size guards. Anything bigger than this from a frontend call is
/// rejected before we allocate. Defends against:
///   - a hostile renderer (XSS via markdown → invoke) OOM-killing the
///     Rust process with a 10 GB string,
///   - accidental loops on the JS side that re-send growing payloads,
///   - a future feature wiring user input straight into a Tauri
///     command without its own bound.
const MAX_TEXT_WRITE_BYTES: usize = 50 * 1024 * 1024; // 50 MB plain text
const MAX_BLOB_READ_BYTES: u64 = 100 * 1024 * 1024;   // 100 MB binary

/// Reserved Windows device names — opening `CON.md` opens the console
/// device, `NUL.md` opens the null sink, etc. The OS silently swallows
/// the writes which then look like the user's file vanished. Reject
/// these up front before we hand a path to fs::write.
const RESERVED_WINDOWS_NAMES: &[&str] = &[
    "CON", "PRN", "AUX", "NUL",
    "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
    "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

#[derive(serde::Serialize)]
pub(crate) struct VaultEntry {
    /// Path relative to the vault root, forward-slash separated.
    path: String,
    /// Base name with extension.
    name: String,
    /// "dir" | "md" | "mindmap" | "image" | "other"
    kind: String,
    /// Omitted from the JSON for files (where it would be null) —
    /// saves ~15 bytes per file in the IPC payload, which adds up to
    /// dozens of KB on a populated monorepo.
    #[serde(skip_serializing_if = "Option::is_none")]
    children: Option<Vec<VaultEntry>>,
    // We used to include a `modified: Option<u64>` field here, but the
    // front-end never reads it — and fetching it for every file on a
    // monorepo means an extra `GetFileInformationByHandle` syscall per
    // entry on Windows, which is the difference between a snappy and a
    // sluggish tree load. The S3 sync walker keeps its own mtime
    // tracking inside `s3::walk_local`; this listing API is purely UI.
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
/// `strip_prefix` + `to_string_lossy` + `replace('\\', "/")` per
/// entry. Threading the prefix turns 3 allocations per file into 1
/// (the `format!` that builds child `rel`).
fn walk_vault(rel_prefix: &str, dir: &Path) -> Result<Vec<VaultEntry>, String> {
    let read = match fs::read_dir(dir) {
        Ok(r) => r,
        Err(e) => return Err(e.to_string()),
    };

    // Pre-allocation hint — avoids Vec doubling during push on a wide
    // directory. 64 is a hand-tuned default; small dirs leak a few
    // bytes of capacity, large dirs save several reallocs.
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

/// Resolve a vault-relative path back to an absolute path under
/// `vault`.
///
/// Rejects every path-confusion vector we've found in the wild:
///   - `..` segments (directory traversal)
///   - backslashes (`\\?\C:\…` UNC paths, and segments that survive
///     the forward-slash split below)
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

// ─── Commands: vault file tree ─────────────────────────────────────

/// Tree listing runs on the blocking pool so a 10k-file monorepo walk
/// doesn't stall the tokio reactor (which is also driving sync, AI
/// generation, and other IPC calls). Without spawn_blocking the
/// sidebar refresh after a sync was synchronously blocking every other
/// command for the duration of the walk.
#[tauri::command]
pub async fn list_vault_tree(app: tauri::AppHandle, vault: String) -> Result<Vec<VaultEntry>, String> {
    let root = verify_vault(&app, &vault)?;
    tauri::async_runtime::spawn_blocking(move || walk_vault("", &root))
        .await
        .map_err(|e| format!("walk task: {}", e))?
}

#[tauri::command]
pub async fn read_vault_file(app: tauri::AppHandle, vault: String, rel: String) -> Result<String, String> {
    let vault_p = verify_vault(&app, &vault)?;
    let path = resolve_under_vault(&vault_p, &rel)?;
    tauri::async_runtime::spawn_blocking(move || {
        if !path.is_file() {
            return Err(format!("Not a file: {}", rel));
        }
        fs::read_to_string(&path).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("read_vault_file task: {}", e))?
}

/// Legacy base64 reader — kept for any caller that still expects a
/// data URL. New callers (ImageViewer) should use `read_vault_file_blob`
/// which transfers raw bytes via Tauri's binary IPC channel, skipping
/// the 33% base64 inflation and a String→atob roundtrip on the JS side.
#[tauri::command]
pub async fn read_vault_file_bytes(app: tauri::AppHandle, vault: String, rel: String) -> Result<String, String> {
    let vault_p = verify_vault(&app, &vault)?;
    let path = resolve_under_vault(&vault_p, &rel)?;
    tauri::async_runtime::spawn_blocking(move || {
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
    })
    .await
    .map_err(|e| format!("read_vault_file_bytes task: {}", e))?
}

/// Binary read using Tauri's raw-bytes IPC channel. Skips the base64
/// hop, halving peak memory + IPC transfer cost on large images.
/// Frontend wraps the returned ArrayBuffer in a Blob + URL.createObjectURL
/// so the <img> can render it and we can revoke the URL when the
/// viewer unmounts.
#[tauri::command]
pub async fn read_vault_file_blob(
    app: tauri::AppHandle,
    vault: String,
    rel: String,
) -> Result<tauri::ipc::Response, String> {
    let vault_p = verify_vault(&app, &vault)?;
    let path = resolve_under_vault(&vault_p, &rel)?;
    let bytes = tauri::async_runtime::spawn_blocking(move || -> Result<Vec<u8>, String> {
        if !path.is_file() {
            return Err(format!("Not a file: {}", rel));
        }
        // Cheap size check via metadata before reading the whole file
        // into memory — protects against a hostile renderer asking us
        // to slurp a 10 GB log file.
        if let Ok(meta) = fs::metadata(&path) {
            if meta.len() > MAX_BLOB_READ_BYTES {
                return Err(format!("File too large: {} bytes", meta.len()));
            }
        }
        fs::read(&path).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("read_vault_file_blob task: {}", e))??;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub async fn write_vault_file(app: tauri::AppHandle, vault: String, rel: String, content: String) -> Result<(), String> {
    if content.len() > MAX_TEXT_WRITE_BYTES {
        return Err(format!(
            "Write payload too large: {} bytes (max {})",
            content.len(),
            MAX_TEXT_WRITE_BYTES
        ));
    }
    let vault_p = verify_vault(&app, &vault)?;
    let path = resolve_under_vault(&vault_p, &rel)?;
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        fs::write(&path, content).map_err(|e| e.to_string())?;
        Ok::<(), String>(())
    })
    .await
    .map_err(|e| format!("write_vault_file task: {}", e))?
}

#[tauri::command]
pub async fn delete_vault_file(app: tauri::AppHandle, vault: String, rel: String) -> Result<(), String> {
    // Reject anything that would resolve to the vault root itself —
    // an empty/"."/"/" rel would otherwise wipe the entire vault when
    // the dir branch hits `remove_dir_all`.
    let trimmed = rel.trim().trim_matches('/');
    if trimmed.is_empty() || trimmed == "." {
        return Err("Refusing to delete vault root".into());
    }
    let vault_p = verify_vault(&app, &vault)?;
    let path = resolve_under_vault(&vault_p, &rel)?;
    // Belt-and-braces: even with the rel check above, double-check
    // that `path` is not equal to the vault root after canonicalisation.
    if path == vault_p {
        return Err("Refusing to delete vault root".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        if path.is_dir() {
            fs::remove_dir_all(&path).map_err(|e| e.to_string())?;
        } else if path.exists() {
            fs::remove_file(&path).map_err(|e| e.to_string())?;
        }
        Ok::<(), String>(())
    })
    .await
    .map_err(|e| format!("delete_vault_file task: {}", e))?
}

#[tauri::command]
pub async fn rename_vault_file(app: tauri::AppHandle, vault: String, from: String, to: String) -> Result<(), String> {
    let vault_p = verify_vault(&app, &vault)?;
    let src = resolve_under_vault(&vault_p, &from)?;
    let dst = resolve_under_vault(&vault_p, &to)?;
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(parent) = dst.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        fs::rename(&src, &dst).map_err(|e| e.to_string())?;
        Ok::<(), String>(())
    })
    .await
    .map_err(|e| format!("rename_vault_file task: {}", e))?
}

#[tauri::command]
pub async fn create_vault_folder(app: tauri::AppHandle, vault: String, rel: String) -> Result<(), String> {
    let vault_p = verify_vault(&app, &vault)?;
    let path = resolve_under_vault(&vault_p, &rel)?;
    tauri::async_runtime::spawn_blocking(move || {
        fs::create_dir_all(&path).map_err(|e| e.to_string())?;
        Ok::<(), String>(())
    })
    .await
    .map_err(|e| format!("create_vault_folder task: {}", e))?
}
