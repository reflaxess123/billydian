// OpenRouter integration — generate notes, mindmaps, titles, and
// expand individual mindmap nodes. All four commands share a single
// `reqwest::Client` (managed by tauri::State) so HTTP/2 connections
// stay warm between calls — saving 100–300 ms per request after the
// first one.

use std::sync::Arc;

const MAX_TOPIC_BYTES: usize = 32 * 1024;            // 32 KB AI topic/prompt
const MAX_NOTE_BYTES: usize = 200 * 1024;            // 200 KB for title-gen content

// ─── OpenRouter request/response types ─────────────────────────────

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

// ─── Helpers ───────────────────────────────────────────────────────

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
    // `&body[..600]` would panic if byte 600 lands inside a multi-byte
    // UTF-8 sequence (very common with non-ASCII OpenRouter responses).
    // char_indices().nth(600) walks to the 601st character boundary or
    // falls back to the full body when shorter.
    let trimmed = match body.char_indices().nth(600) {
        Some((idx, _)) => format!("{}…", &body[..idx]),
        None => body.to_string(),
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

/// Strip optional ````md` / ``` ``` fences the LLM tends to wrap notes
/// in.
fn strip_markdown_fences(s: &str) -> String {
    let trimmed = s.trim();
    let stripped = if trimmed.starts_with("```") {
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

// ─── Commands ──────────────────────────────────────────────────────

#[tauri::command]
pub async fn generate_mindmap(
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
pub async fn extend_node(
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
pub async fn generate_title(
    api_key: String,
    content: String,
    model: String,
    client: tauri::State<'_, Arc<reqwest::Client>>,
) -> Result<String, String> {
    if content.len() > MAX_NOTE_BYTES {
        return Err(format!("Note content too long: {} bytes", content.len()));
    }
    // Cap the content we ship to the model — titles only need the
    // gist, and we'd rather not pay for 50k tokens of context.
    // char_indices gives us a UTF-8 boundary safe slice without
    // re-allocating the first 4000 chars into a fresh String.
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
pub async fn generate_note(
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
