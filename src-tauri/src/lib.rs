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
    /// "dir" | "md" | "mindmap" | "other"
    kind: String,
    /// `null` for files; recursive list of children for directories.
    children: Option<Vec<VaultEntry>>,
    /// Last-modified unix seconds (files only).
    modified: Option<u64>,
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
    let _: serde_json::Value = serde_json::from_str(&parsed_str)
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

/// Path to the file that remembers the user's vault choice.
fn vault_pointer_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("vault.json"))
}

/// Convert a filesystem path into "/"-separated, vault-relative form.
fn rel_path(vault: &Path, p: &Path) -> Option<String> {
    p.strip_prefix(vault)
        .ok()
        .map(|r| r.to_string_lossy().replace('\\', "/"))
}

fn classify_file(name: &str) -> &'static str {
    let lower = name.to_lowercase();
    if lower.ends_with(".md") {
        "md"
    } else if lower.ends_with(".mindmap") {
        "mindmap"
    } else {
        "other"
    }
}

fn entry_sort_key(e: &VaultEntry) -> (u8, String) {
    // dirs first, then files; case-insensitive name compare
    (if e.kind == "dir" { 0 } else { 1 }, e.name.to_lowercase())
}

fn walk_vault(root: &Path, dir: &Path) -> Result<Vec<VaultEntry>, String> {
    let mut out: Vec<VaultEntry> = Vec::new();
    let read = match fs::read_dir(dir) {
        Ok(r) => r,
        Err(e) => return Err(e.to_string()),
    };
    for entry in read {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();

        // Skip OS junk
        if name == "Thumbs.db" || name == ".DS_Store" {
            continue;
        }

        if path.is_dir() {
            let children = walk_vault(root, &path)?;
            out.push(VaultEntry {
                path: rel_path(root, &path).unwrap_or_else(|| name.clone()),
                name,
                kind: "dir".to_string(),
                children: Some(children),
                modified: None,
            });
        } else if path.is_file() {
            let kind = classify_file(&name);
            let modified = path
                .metadata()
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs());
            out.push(VaultEntry {
                path: rel_path(root, &path).unwrap_or_else(|| name.clone()),
                name,
                kind: kind.to_string(),
                children: None,
                modified,
            });
        }
    }
    out.sort_by(|a, b| entry_sort_key(a).cmp(&entry_sort_key(b)));
    Ok(out)
}

/// Resolve a vault-relative path back to an absolute path under `vault`,
/// rejecting `..` traversal.
fn resolve_under_vault(vault: &Path, rel: &str) -> Result<PathBuf, String> {
    let rel = rel.trim_start_matches('/');
    let mut p = vault.to_path_buf();
    for seg in rel.split('/') {
        if seg.is_empty() || seg == "." {
            continue;
        }
        if seg == ".." {
            return Err("Invalid path (traversal)".into());
        }
        p.push(seg);
    }
    Ok(p)
}

// ─── Commands: vault pointer ───────────────────────────────────────────────

#[tauri::command]
fn get_vault_path(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let ptr = vault_pointer_path(&app)?;
    if !ptr.exists() {
        return Ok(None);
    }
    let s = fs::read_to_string(&ptr).map_err(|e| e.to_string())?;
    let v: serde_json::Value = serde_json::from_str(&s).map_err(|e| e.to_string())?;
    Ok(v.get("path").and_then(|p| p.as_str()).map(|s| s.to_string()))
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

    // Create config dir eagerly so settings have somewhere to land
    fs::create_dir_all(&cfg_dir).map_err(|e| e.to_string())?;

    let ptr = vault_pointer_path(&app)?;
    let body = serde_json::json!({ "path": path });
    fs::write(&ptr, body.to_string()).map_err(|e| e.to_string())?;
    Ok(())
}

// ─── Commands: vault file tree ─────────────────────────────────────────────

#[tauri::command]
fn list_vault_tree(vault: String) -> Result<Vec<VaultEntry>, String> {
    let root = PathBuf::from(&vault);
    if !root.is_dir() {
        return Err(format!("Vault is not a directory: {}", vault));
    }
    walk_vault(&root, &root)
}

#[tauri::command]
fn read_vault_file(vault: String, rel: String) -> Result<String, String> {
    let path = resolve_under_vault(&PathBuf::from(&vault), &rel)?;
    if !path.is_file() {
        return Err(format!("Not a file: {}", rel));
    }
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn write_vault_file(vault: String, rel: String, content: String) -> Result<(), String> {
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
    api_key: String,
    model: String,
    prompt: String,
) -> Result<(String, OpenRouterUsage), String> {
    let client = reqwest::Client::new();
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
async fn generate_mindmap(api_key: String, topic: String, model: String) -> Result<String, String> {
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
    let (content, usage) = call_openrouter(api_key, model, prompt).await?;
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
) -> Result<String, String> {
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
    let (content, usage) = call_openrouter(api_key, model, prompt).await?;
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
async fn generate_title(api_key: String, content: String, model: String) -> Result<String, String> {
    // Cap the content we ship to the model — titles only need the gist,
    // and we'd rather not pay for 50k tokens of context.
    let snippet: String = content.chars().take(4000).collect();
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
    let (raw, usage) = call_openrouter(api_key, model, prompt).await?;
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
async fn generate_note(api_key: String, topic: String, model: String) -> Result<String, String> {
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
    let (content, usage) = call_openrouter(api_key, model, prompt).await?;
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
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        // Remembers window position / size / maximised state across
        // launches. State file lives in <app-config-dir>/window-state.json
        // and is restored before the window is shown.
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            // OpenRouter
            generate_mindmap,
            extend_node,
            generate_note,
            generate_title,
            // Vault pointer
            get_vault_path,
            set_vault_path,
            // Vault file ops
            list_vault_tree,
            read_vault_file,
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
