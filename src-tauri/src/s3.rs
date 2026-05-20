// Smart S3 sync — diff-based push/pull between the local vault and any
// S3-compatible bucket. No AWS SDK dep: we sign requests with a small
// hand-rolled SigV4 implementation and parse ListObjectsV2 XML directly.
//
// Sync strategy (two-way, mtime wins):
//   - Walk the vault, collect rel paths + mtimes. `.mindmapper/` is
//     excluded so secrets never travel.
//   - ListObjectsV2 the bucket under <prefix>, collect keys +
//     last-modified.
//   - For each path:
//       * local only        → upload
//       * remote only       → download
//       * both, |Δ| < 2s    → skip (clocks are fuzzy)
//       * local newer       → upload
//       * remote newer      → download
//   - After every download we set the local file mtime to the remote
//     LastModified, so we don't flap on the next sync.
//
// Conflicts (both sides modified since last sync) currently resolve as
// "whoever's mtime is bigger wins"; a future pass could maintain a
// last-synced manifest to flag true conflicts.

use chrono::{DateTime, Datelike, Timelike, Utc};
use filetime::{set_file_mtime, FileTime};
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

type HmacSha256 = Hmac<Sha256>;

/// Settings as supplied by the front-end (camelCase keys).
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct S3Settings {
    pub endpoint: String,
    pub region: String,
    pub access_key_id: String,
    pub secret_access_key: String,
    pub bucket: String,
    pub prefix: Option<String>,
}

#[derive(Default, serde::Serialize)]
pub struct SyncReport {
    pub uploaded: u32,
    pub downloaded: u32,
    pub skipped: u32,
    pub errors: Vec<String>,
}

// ─── SigV4 primitives ──────────────────────────────────────────────────────

fn sha256_hex(data: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(data);
    hex::encode(h.finalize())
}

fn hmac_sha256(key: &[u8], data: &[u8]) -> Vec<u8> {
    let mut mac = HmacSha256::new_from_slice(key).expect("hmac key");
    mac.update(data);
    mac.finalize().into_bytes().to_vec()
}

/// Canonical AWS "basic" ISO-8601 timestamp: `YYYYMMDDTHHMMSSZ`.
fn amz_timestamp(now: DateTime<Utc>) -> String {
    format!(
        "{:04}{:02}{:02}T{:02}{:02}{:02}Z",
        now.year(),
        now.month(),
        now.day(),
        now.hour(),
        now.minute(),
        now.second()
    )
}

fn amz_datestamp(now: DateTime<Utc>) -> String {
    format!("{:04}{:02}{:02}", now.year(), now.month(), now.day())
}

/// Build SigV4-signed headers for an S3 request.
///
/// `canonical_uri` must already be percent-encoded the way AWS wants:
/// every segment of the path encoded except `/`.
#[allow(clippy::too_many_arguments)]
fn sign(
    method: &str,
    host: &str,
    canonical_uri: &str,
    canonical_query: &str,
    payload: &[u8],
    extra_headers: &[(&str, &str)],
    region: &str,
    access_key: &str,
    secret: &str,
    now: DateTime<Utc>,
) -> HashMap<String, String> {
    let date_stamp = amz_datestamp(now);
    let timestamp = amz_timestamp(now);
    let payload_hash = sha256_hex(payload);

    // Collect headers we plan to sign. Always: host, x-amz-content-sha256,
    // x-amz-date. Plus anything passed in via `extra_headers` (e.g.
    // Content-Type for PUT). Names lowercased per spec.
    let mut headers: Vec<(String, String)> = Vec::new();
    headers.push(("host".to_string(), host.to_string()));
    headers.push(("x-amz-content-sha256".to_string(), payload_hash.clone()));
    headers.push(("x-amz-date".to_string(), timestamp.clone()));
    for (k, v) in extra_headers {
        headers.push((k.to_lowercase(), (*v).trim().to_string()));
    }
    headers.sort_by(|a, b| a.0.cmp(&b.0));

    let canonical_headers: String = headers
        .iter()
        .map(|(k, v)| format!("{}:{}\n", k, v))
        .collect();
    let signed_headers: String = headers
        .iter()
        .map(|(k, _)| k.as_str())
        .collect::<Vec<_>>()
        .join(";");

    let canonical_request = format!(
        "{}\n{}\n{}\n{}\n{}\n{}",
        method, canonical_uri, canonical_query, canonical_headers, signed_headers, payload_hash
    );

    let credential_scope = format!("{}/{}/s3/aws4_request", date_stamp, region);
    let string_to_sign = format!(
        "AWS4-HMAC-SHA256\n{}\n{}\n{}",
        timestamp,
        credential_scope,
        sha256_hex(canonical_request.as_bytes())
    );

    // Signing key derivation: kSecret → kDate → kRegion → kService → kSigning
    let k_secret = format!("AWS4{}", secret);
    let k_date = hmac_sha256(k_secret.as_bytes(), date_stamp.as_bytes());
    let k_region = hmac_sha256(&k_date, region.as_bytes());
    let k_service = hmac_sha256(&k_region, b"s3");
    let k_signing = hmac_sha256(&k_service, b"aws4_request");
    let signature = hex::encode(hmac_sha256(&k_signing, string_to_sign.as_bytes()));

    let authorization = format!(
        "AWS4-HMAC-SHA256 Credential={}/{}, SignedHeaders={}, Signature={}",
        access_key, credential_scope, signed_headers, signature
    );

    // Dev-mode dump: when sync misbehaves, the canonical request + the
    // signed string are the first things you want to eyeball.
    #[cfg(debug_assertions)]
    {
        eprintln!("─── SigV4 ───");
        eprintln!("URL\t{}://{}{}{}{}", "https", host, canonical_uri,
            if canonical_query.is_empty() { "" } else { "?" }, canonical_query);
        eprintln!("Canonical request:\n{}", canonical_request);
        eprintln!("String to sign:\n{}", string_to_sign);
        eprintln!("─────────────");
    }

    // Note: we deliberately do NOT put "Host" in the outbound map.
    // reqwest derives the Host header from the request URL, and any
    // value we set manually here can be silently ignored. As long as
    // the URL we GET / PUT to has the same host we signed with, the
    // signatures match.
    let mut out: HashMap<String, String> = HashMap::new();
    out.insert("x-amz-content-sha256".to_string(), payload_hash);
    out.insert("x-amz-date".to_string(), timestamp);
    out.insert("Authorization".to_string(), authorization);
    for (k, v) in extra_headers {
        out.insert((*k).to_string(), (*v).to_string());
    }
    out
}

// ─── URL helpers ───────────────────────────────────────────────────────────

/// Percent-encode every path segment except the slash separators —
/// matches what S3's SigV4 canonical URI rules expect.
fn encode_key(key: &str) -> String {
    key.split('/')
        .map(|seg| urlencoding::encode(seg).to_string())
        .collect::<Vec<_>>()
        .join("/")
}

/// Strip protocol and trailing slash so we can compute Host vs path.
fn parse_endpoint(endpoint: &str) -> Result<(String, String, String), String> {
    let trimmed = endpoint.trim().trim_end_matches('/');
    let (scheme, rest) = if let Some(r) = trimmed.strip_prefix("https://") {
        ("https", r)
    } else if let Some(r) = trimmed.strip_prefix("http://") {
        ("http", r)
    } else {
        ("https", trimmed)
    };
    if rest.is_empty() {
        return Err("S3 endpoint is empty".into());
    }
    // We don't currently honour a path-prefix inside the endpoint URL —
    // bucket gets appended at the root. That covers the common cases
    // (s3.amazonaws.com, s3.<region>.amazonaws.com, MinIO host, R2 endpoint).
    Ok((scheme.to_string(), rest.to_string(), format!("{}://{}", scheme, rest)))
}

// ─── Local walking ─────────────────────────────────────────────────────────

#[derive(Debug)]
struct LocalEntry {
    rel: String,     // forward-slash separated, vault-relative
    mtime: SystemTime,
}

fn walk_local(root: &Path, dir: &Path, out: &mut Vec<LocalEntry>) -> Result<(), String> {
    let read = fs::read_dir(dir).map_err(|e| format!("read_dir {:?}: {}", dir, e))?;
    for entry in read {
        let entry = entry.map_err(|e| e.to_string())?;
        let p = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if name == ".mindmapper" || name == "Thumbs.db" || name == ".DS_Store" {
            continue;
        }
        if p.is_dir() {
            walk_local(root, &p, out)?;
        } else if p.is_file() {
            let rel = p
                .strip_prefix(root)
                .map_err(|e| e.to_string())?
                .to_string_lossy()
                .replace('\\', "/");
            let mtime = p
                .metadata()
                .and_then(|m| m.modified())
                .unwrap_or(SystemTime::UNIX_EPOCH);
            out.push(LocalEntry { rel, mtime });
        }
    }
    Ok(())
}

// ─── S3 LIST ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
struct RemoteEntry {
    key: String,            // raw S3 key (with prefix)
    rel: String,            // vault-relative path (prefix stripped)
    last_modified: DateTime<Utc>,
}

fn parse_list_xml(xml: &str, prefix: &str) -> Result<Vec<RemoteEntry>, String> {
    // Tiny SAX-ish walk: just collect <Contents> blocks and read <Key>,
    // <LastModified> children. Avoids serde XML mismatches.
    use quick_xml::events::Event;
    use quick_xml::Reader;

    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);
    let mut buf = Vec::new();

    let mut out: Vec<RemoteEntry> = Vec::new();
    let mut in_contents = false;
    let mut current_tag: Option<String> = None;
    let mut cur_key: Option<String> = None;
    let mut cur_lm: Option<DateTime<Utc>> = None;
    let mut truncated = false;

    loop {
        match reader.read_event_into(&mut buf) {
            Err(e) => return Err(format!("XML parse: {}", e)),
            Ok(Event::Eof) => break,
            Ok(Event::Start(e)) => {
                let name = String::from_utf8_lossy(e.name().as_ref()).to_string();
                if name == "Contents" {
                    in_contents = true;
                    cur_key = None;
                    cur_lm = None;
                }
                if in_contents || name == "IsTruncated" {
                    current_tag = Some(name);
                }
            }
            Ok(Event::End(e)) => {
                let name = String::from_utf8_lossy(e.name().as_ref()).to_string();
                if name == "Contents" {
                    if let (Some(k), Some(lm)) = (cur_key.take(), cur_lm.take()) {
                        // Strip prefix to get vault-relative path
                        let rel = if !prefix.is_empty() && k.starts_with(prefix) {
                            k[prefix.len()..].trim_start_matches('/').to_string()
                        } else {
                            k.clone()
                        };
                        // Skip "folder markers" (zero-byte keys ending in '/')
                        if !rel.is_empty() {
                            out.push(RemoteEntry {
                                key: k,
                                rel,
                                last_modified: lm,
                            });
                        }
                    }
                    in_contents = false;
                }
                current_tag = None;
            }
            Ok(Event::Text(e)) => {
                let text = e
                    .unescape()
                    .map_err(|e| e.to_string())?
                    .to_string();
                if let Some(tag) = current_tag.as_deref() {
                    match tag {
                        "Key" if in_contents => cur_key = Some(text),
                        "LastModified" if in_contents => {
                            cur_lm = DateTime::parse_from_rfc3339(&text)
                                .ok()
                                .map(|t| t.with_timezone(&Utc));
                        }
                        "IsTruncated" => {
                            truncated = text == "true";
                        }
                        _ => {}
                    }
                }
            }
            _ => {}
        }
        buf.clear();
    }
    if truncated {
        // We don't paginate yet; surface that as an error so the user
        // knows their vault is bigger than one page (1000 keys).
        return Err("Bucket has more than 1000 objects — pagination not yet implemented".into());
    }
    Ok(out)
}

async fn list_objects(s3: &S3Settings) -> Result<Vec<RemoteEntry>, String> {
    let (_, host, base) = parse_endpoint(&s3.endpoint)?;
    let prefix = s3.prefix.clone().unwrap_or_default();
    let prefix_for_strip = if prefix.is_empty() {
        "".to_string()
    } else {
        prefix.trim_end_matches('/').to_string() + "/"
    };

    // Query string (canonical form: sorted, percent-encoded values)
    let mut query_pairs: Vec<(String, String)> = vec![
        ("list-type".to_string(), "2".to_string()),
    ];
    if !prefix_for_strip.is_empty() {
        query_pairs.push(("prefix".to_string(), prefix_for_strip.clone()));
    }
    query_pairs.sort_by(|a, b| a.0.cmp(&b.0));
    let canonical_query: String = query_pairs
        .iter()
        .map(|(k, v)| format!("{}={}", urlencoding::encode(k), urlencoding::encode(v)))
        .collect::<Vec<_>>()
        .join("&");

    let canonical_uri = format!("/{}", s3.bucket);
    let url = format!("{}{}?{}", base, canonical_uri, canonical_query);

    let now = Utc::now();
    let headers = sign(
        "GET",
        &host,
        &canonical_uri,
        &canonical_query,
        b"",
        &[],
        &s3.region,
        &s3.access_key_id,
        &s3.secret_access_key,
        now,
    );

    let client = reqwest::Client::new();
    let mut req = client.get(&url);
    for (k, v) in &headers {
        req = req.header(k, v);
    }
    let res = req.send().await.map_err(|e| format!("LIST request: {}", e))?;
    let status = res.status();
    let diag = diag_headers(&res);
    let body = res.text().await.map_err(|e| format!("LIST body: {}", e))?;
    if !status.is_success() {
        return Err(format!(
            "LIST {}{} → {}\n{}",
            url, diag, status, snippet(&body, 1500)
        ));
    }
    parse_list_xml(&body, &prefix_for_strip)
}

// ─── S3 GET / PUT ──────────────────────────────────────────────────────────

async fn get_object(
    s3: &S3Settings,
    key: &str,
) -> Result<(Vec<u8>, DateTime<Utc>), String> {
    let (_, host, base) = parse_endpoint(&s3.endpoint)?;
    let canonical_uri = format!("/{}/{}", s3.bucket, encode_key(key));
    let url = format!("{}{}", base, canonical_uri);
    let now = Utc::now();
    let headers = sign(
        "GET",
        &host,
        &canonical_uri,
        "",
        b"",
        &[],
        &s3.region,
        &s3.access_key_id,
        &s3.secret_access_key,
        now,
    );
    let client = reqwest::Client::new();
    let mut req = client.get(&url);
    for (k, v) in &headers {
        req = req.header(k, v);
    }
    let res = req.send().await.map_err(|e| format!("GET request: {}", e))?;
    let status = res.status();
    let diag = diag_headers(&res);
    // Pull Last-Modified before we consume the body
    let lm = res
        .headers()
        .get("last-modified")
        .and_then(|h| h.to_str().ok())
        .and_then(|s| chrono::DateTime::parse_from_rfc2822(s).ok())
        .map(|t| t.with_timezone(&Utc))
        .unwrap_or_else(Utc::now);
    let body_bytes = res.bytes().await.map_err(|e| format!("GET body: {}", e))?;
    if !status.is_success() {
        return Err(format!(
            "GET {}{} → {}\n{}",
            url, diag, status,
            snippet(&String::from_utf8_lossy(&body_bytes), 1500)
        ));
    }
    Ok((body_bytes.to_vec(), lm))
}

async fn put_object(s3: &S3Settings, key: &str, body: Vec<u8>) -> Result<(), String> {
    let (_, host, base) = parse_endpoint(&s3.endpoint)?;
    let canonical_uri = format!("/{}/{}", s3.bucket, encode_key(key));
    let url = format!("{}{}", base, canonical_uri);
    let now = Utc::now();
    let content_type = content_type_for(key);
    let headers = sign(
        "PUT",
        &host,
        &canonical_uri,
        "",
        &body,
        &[("content-type", content_type)],
        &s3.region,
        &s3.access_key_id,
        &s3.secret_access_key,
        now,
    );
    let client = reqwest::Client::new();
    let mut req = client.put(&url).body(body);
    for (k, v) in &headers {
        req = req.header(k, v);
    }
    let res = req.send().await.map_err(|e| format!("PUT request: {}", e))?;
    let status = res.status();
    let diag = diag_headers(&res);
    if !status.is_success() {
        let body = res.text().await.unwrap_or_default();
        return Err(format!(
            "PUT {}{} → {}\n{}",
            url, diag, status,
            snippet(&body, 1500)
        ));
    }
    Ok(())
}

fn content_type_for(key: &str) -> &'static str {
    let lower = key.to_lowercase();
    if lower.ends_with(".md") {
        "text/markdown; charset=utf-8"
    } else if lower.ends_with(".mindmap") || lower.ends_with(".json") {
        "application/json"
    } else if lower.ends_with(".txt") {
        "text/plain; charset=utf-8"
    } else {
        "application/octet-stream"
    }
}

fn snippet(s: &str, n: usize) -> String {
    if s.len() > n {
        format!("{}…", &s[..n])
    } else {
        s.to_string()
    }
}

/// Pull S3-flavoured diagnostic headers off a reqwest response — Yandex
/// (and AWS) return `x-amz-request-id` and `x-amz-id-2` that the storage
/// support team needs to triage a failure.
fn diag_headers(res: &reqwest::Response) -> String {
    let req_id = res
        .headers()
        .get("x-amz-request-id")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let id2 = res
        .headers()
        .get("x-amz-id-2")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if req_id.is_empty() && id2.is_empty() {
        String::new()
    } else if id2.is_empty() {
        format!(" [request-id: {}]", req_id)
    } else {
        format!(" [request-id: {} / {}]", req_id, id2)
    }
}

// ─── Public command: sync_vault ────────────────────────────────────────────

#[tauri::command]
pub async fn sync_vault(vault: String, s3: S3Settings) -> Result<SyncReport, String> {
    if s3.bucket.trim().is_empty()
        || s3.access_key_id.trim().is_empty()
        || s3.secret_access_key.trim().is_empty()
        || s3.region.trim().is_empty()
        || s3.endpoint.trim().is_empty()
    {
        return Err("All S3 fields (endpoint, region, bucket, key id, secret) are required.".into());
    }
    let root = PathBuf::from(&vault);
    if !root.is_dir() {
        return Err(format!("Vault is not a directory: {}", vault));
    }

    // 1. Local listing
    let mut local: Vec<LocalEntry> = Vec::new();
    walk_local(&root, &root, &mut local)?;
    let local_map: HashMap<String, &LocalEntry> =
        local.iter().map(|e| (e.rel.clone(), e)).collect();

    // 2. Remote listing
    let remote = list_objects(&s3).await?;
    let remote_map: HashMap<String, &RemoteEntry> =
        remote.iter().map(|e| (e.rel.clone(), e)).collect();

    let mut report = SyncReport::default();
    let prefix = s3.prefix.clone().unwrap_or_default();
    let prefix_norm = if prefix.is_empty() {
        "".to_string()
    } else {
        prefix.trim_end_matches('/').to_string() + "/"
    };

    let make_key = |rel: &str| -> String {
        if prefix_norm.is_empty() {
            rel.to_string()
        } else {
            format!("{}{}", prefix_norm, rel)
        }
    };

    // 3. Local-only → upload
    for entry in &local {
        if remote_map.contains_key(&entry.rel) {
            continue;
        }
        let abs = root.join(entry.rel.replace('/', std::path::MAIN_SEPARATOR_STR));
        match fs::read(&abs) {
            Ok(bytes) => match put_object(&s3, &make_key(&entry.rel), bytes).await {
                Ok(_) => report.uploaded += 1,
                Err(e) => report.errors.push(format!("upload {}: {}", entry.rel, e)),
            },
            Err(e) => report.errors.push(format!("read {}: {}", entry.rel, e)),
        }
    }

    // 4. Remote-only → download
    for entry in &remote {
        if local_map.contains_key(&entry.rel) {
            continue;
        }
        match get_object(&s3, &entry.key).await {
            Ok((bytes, lm)) => {
                let abs = root.join(entry.rel.replace('/', std::path::MAIN_SEPARATOR_STR));
                if let Some(parent) = abs.parent() {
                    let _ = fs::create_dir_all(parent);
                }
                match fs::write(&abs, &bytes) {
                    Ok(_) => {
                        // Sync local mtime to remote LastModified so we don't
                        // immediately re-upload on the next pass.
                        let secs = lm.timestamp().max(0) as u64;
                        let _ = set_file_mtime(&abs, FileTime::from_unix_time(secs as i64, 0));
                        report.downloaded += 1;
                    }
                    Err(e) => report.errors.push(format!("write {}: {}", entry.rel, e)),
                }
            }
            Err(e) => report.errors.push(format!("download {}: {}", entry.rel, e)),
        }
    }

    // 5. In both: compare mtimes
    const SKEW_SECS: i64 = 2;
    for entry in &local {
        if let Some(remote_entry) = remote_map.get(&entry.rel) {
            let local_secs = entry
                .mtime
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0);
            let remote_secs = remote_entry.last_modified.timestamp();
            let delta = local_secs - remote_secs;
            if delta.abs() <= SKEW_SECS {
                report.skipped += 1;
                continue;
            }
            if delta > 0 {
                // local newer → upload
                let abs = root.join(entry.rel.replace('/', std::path::MAIN_SEPARATOR_STR));
                match fs::read(&abs) {
                    Ok(bytes) => match put_object(&s3, &make_key(&entry.rel), bytes).await {
                        Ok(_) => report.uploaded += 1,
                        Err(e) => report.errors.push(format!("upload {}: {}", entry.rel, e)),
                    },
                    Err(e) => report.errors.push(format!("read {}: {}", entry.rel, e)),
                }
            } else {
                // remote newer → download
                match get_object(&s3, &remote_entry.key).await {
                    Ok((bytes, lm)) => {
                        let abs = root.join(entry.rel.replace('/', std::path::MAIN_SEPARATOR_STR));
                        if let Some(parent) = abs.parent() {
                            let _ = fs::create_dir_all(parent);
                        }
                        match fs::write(&abs, &bytes) {
                            Ok(_) => {
                                let secs = lm.timestamp().max(0) as u64;
                                let _ = set_file_mtime(
                                    &abs,
                                    FileTime::from_unix_time(secs as i64, 0),
                                );
                                report.downloaded += 1;
                            }
                            Err(e) => report.errors.push(format!("write {}: {}", entry.rel, e)),
                        }
                    }
                    Err(e) => {
                        report.errors.push(format!("download {}: {}", entry.rel, e))
                    }
                }
            }
        }
    }

    Ok(report)
}
