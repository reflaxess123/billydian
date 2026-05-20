// Smart S3 sync — diff-based push/pull between the local vault and any
// S3-compatible bucket. No AWS SDK dep: we sign requests with a small
// hand-rolled SigV4 implementation and parse ListObjectsV2 XML directly.
//
// Sync strategy (two-way, mtime wins):
//   - Walk the vault, collect rel paths + mtimes. `.billydian/` is
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
    pub deleted: u32,
    pub errors: Vec<String>,
}

/// Path segments we never sync. `.billydian` holds our settings + s3
/// creds (`.mindmapper` kept as the legacy name in case an old vault
/// still has one around); `.git`/`.svn`/`.hg` are tool junk;
/// `node_modules` is huge and regeneratable. The OS-specific cache
/// files at the bottom are obvious.
///
/// During sync, anything that matches this list is:
///   - skipped locally (we don't upload it), AND
///   - actively deleted on the remote side if it's already there.
const EXCLUDED_SEGMENTS: &[&str] = &[
    ".billydian",
    ".mindmapper",
    ".git",
    ".svn",
    ".hg",
    "node_modules",
    "Thumbs.db",
    ".DS_Store",
];

fn is_excluded_rel(rel: &str) -> bool {
    rel.split('/').any(|seg| EXCLUDED_SEGMENTS.contains(&seg))
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
        if EXCLUDED_SEGMENTS.contains(&name.as_str()) {
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

struct ListPage {
    entries: Vec<RemoteEntry>,
    next_token: Option<String>,
}

fn parse_list_xml(xml: &str, prefix: &str) -> Result<ListPage, String> {
    // Tiny SAX-ish walk: just collect <Contents> blocks and read <Key>,
    // <LastModified> children, plus NextContinuationToken at the root.
    use quick_xml::events::Event;
    use quick_xml::Reader;

    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);
    let mut buf = Vec::new();

    let mut out: Vec<RemoteEntry> = Vec::new();
    let mut next_token: Option<String> = None;
    let mut in_contents = false;
    let mut current_tag: Option<String> = None;
    let mut cur_key: Option<String> = None;
    let mut cur_lm: Option<DateTime<Utc>> = None;

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
                if in_contents || name == "IsTruncated" || name == "NextContinuationToken" {
                    current_tag = Some(name);
                }
            }
            Ok(Event::End(e)) => {
                let name = String::from_utf8_lossy(e.name().as_ref()).to_string();
                if name == "Contents" {
                    if let (Some(k), Some(lm)) = (cur_key.take(), cur_lm.take()) {
                        let rel = if !prefix.is_empty() && k.starts_with(prefix) {
                            k[prefix.len()..].trim_start_matches('/').to_string()
                        } else {
                            k.clone()
                        };
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
                        "NextContinuationToken" => {
                            next_token = Some(text);
                        }
                        _ => {}
                    }
                }
            }
            _ => {}
        }
        buf.clear();
    }
    Ok(ListPage { entries: out, next_token })
}

async fn list_objects(s3: &S3Settings) -> Result<Vec<RemoteEntry>, String> {
    let (_, host, base) = parse_endpoint(&s3.endpoint)?;
    let prefix = s3.prefix.clone().unwrap_or_default();
    let prefix_for_strip = if prefix.is_empty() {
        "".to_string()
    } else {
        prefix.trim_end_matches('/').to_string() + "/"
    };

    let canonical_uri = format!("/{}", s3.bucket);
    let client = reqwest::Client::new();
    let mut all: Vec<RemoteEntry> = Vec::new();
    let mut continuation: Option<String> = None;

    // Paginate until S3 stops handing back a NextContinuationToken.
    // ListObjectsV2 caps at 1000 keys per response, so a vault with a
    // few thousand objects (e.g. a `.git` folder full of loose objects)
    // does several round-trips here.
    loop {
        let mut query_pairs: Vec<(String, String)> = vec![
            ("list-type".to_string(), "2".to_string()),
        ];
        if !prefix_for_strip.is_empty() {
            query_pairs.push(("prefix".to_string(), prefix_for_strip.clone()));
        }
        if let Some(tok) = continuation.as_ref() {
            query_pairs.push(("continuation-token".to_string(), tok.clone()));
        }
        query_pairs.sort_by(|a, b| a.0.cmp(&b.0));
        let canonical_query: String = query_pairs
            .iter()
            .map(|(k, v)| format!("{}={}", urlencoding::encode(k), urlencoding::encode(v)))
            .collect::<Vec<_>>()
            .join("&");
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
        let page = parse_list_xml(&body, &prefix_for_strip)?;
        all.extend(page.entries);
        match page.next_token {
            Some(tok) if !tok.is_empty() => continuation = Some(tok),
            _ => break,
        }
    }
    Ok(all)
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

async fn delete_object(s3: &S3Settings, key: &str) -> Result<(), String> {
    let (_, host, base) = parse_endpoint(&s3.endpoint)?;
    let canonical_uri = format!("/{}/{}", s3.bucket, encode_key(key));
    let url = format!("{}{}", base, canonical_uri);
    let now = Utc::now();
    let headers = sign(
        "DELETE",
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
    let mut req = client.delete(&url);
    for (k, v) in &headers {
        req = req.header(k, v);
    }
    let res = req.send().await.map_err(|e| format!("DELETE request: {}", e))?;
    let status = res.status();
    let diag = diag_headers(&res);
    // S3 returns 204 No Content on success, 404 if the key never existed.
    // Treat 404 as success since the end state ("key not there") matches.
    if !status.is_success() && status.as_u16() != 404 {
        let body = res.text().await.unwrap_or_default();
        return Err(format!(
            "DELETE {}{} → {}\n{}",
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
    let remote_full = list_objects(&s3).await?;

    let mut report = SyncReport::default();

    // 2a. Cleanup: drop any remote object whose vault-relative path
    // crosses one of our excluded segments. Same blacklist used for the
    // local walk — keeps `.git`, `node_modules`, OS junk, and our own
    // `.billydian/` (creds!) out of the bucket regardless of how it
    // got there.
    let mut remote: Vec<RemoteEntry> = Vec::with_capacity(remote_full.len());
    for entry in remote_full {
        if is_excluded_rel(&entry.rel) {
            match delete_object(&s3, &entry.key).await {
                Ok(_) => report.deleted += 1,
                Err(e) => report.errors.push(format!("delete {}: {}", entry.rel, e)),
            }
        } else {
            remote.push(entry);
        }
    }

    let remote_map: HashMap<String, &RemoteEntry> =
        remote.iter().map(|e| (e.rel.clone(), e)).collect();
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
