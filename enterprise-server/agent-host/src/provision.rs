use crate::store::{ProvisionResult, WorkspaceMeta, WorkspaceStore};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use chrono::Utc;
use flate2::read::GzDecoder;
use serde::Deserialize;
use std::fs::{self, File};
use std::io::{copy, Cursor, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use tar::Archive;
use zip::ZipArchive;

#[derive(Debug, Deserialize)]
pub struct PreloadedBody {
    pub workspace_id: Option<String>,
    pub server_path: String,
    #[serde(default)]
    pub read_only: bool,
}

#[derive(Debug, Deserialize)]
pub struct SyncBody {
    pub workspace_id: Option<String>,
    pub archive_base64: String,
    pub format: String,
    pub project_name: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct SyncChunkBody {
    pub upload_id: String,
    pub chunk_index: u32,
    pub total_chunks: u32,
    pub chunk_base64: String,
    pub workspace_id: Option<String>,
    pub project_name: Option<String>,
    #[serde(default = "default_format")]
    pub format: String,
}

fn default_format() -> String {
    "tar".into()
}

#[derive(Debug, Deserialize)]
pub struct GitBody {
    pub workspace_id: Option<String>,
    pub url: String,
    pub r#ref: Option<String>,
    pub token: Option<String>,
    pub depth: Option<u32>,
}

#[derive(Debug, serde::Serialize)]
pub struct ChunkAck {
    pub ok: bool,
    pub received: u32,
}

fn resolve_id(_store: &WorkspaceStore, maybe: Option<String>) -> anyhow::Result<String> {
    let id = maybe
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(WorkspaceStore::new_id);
    WorkspaceStore::validate_id(&id)?;
    Ok(id)
}

pub fn provision_preloaded(
    store: &WorkspaceStore,
    body: PreloadedBody,
) -> anyhow::Result<ProvisionResult> {
    let server_path = PathBuf::from(body.server_path.trim());
    if !server_path.exists() {
        anyhow::bail!("server_path does not exist: {}", server_path.display());
    }
    if !server_path.is_dir() {
        anyhow::bail!("server_path must be a directory");
    }
    let root = server_path
        .canonicalize()
        .unwrap_or(server_path);
    let id = resolve_id(store, body.workspace_id)?;
    let meta = WorkspaceMeta {
        id: id.clone(),
        root_path: root.to_string_lossy().to_string(),
        provision: "preloaded".into(),
        read_only: body.read_only,
        created_at: Utc::now(),
    };
    store.save_meta(&meta)?;
    Ok(ProvisionResult {
        workspace_id: id,
        root_path: meta.root_path,
        message: "Bound preloaded server path".into(),
    })
}

pub fn provision_sync(store: &WorkspaceStore, body: SyncBody) -> anyhow::Result<ProvisionResult> {
    let id = resolve_id(store, body.workspace_id)?;
    let root = store.ensure_workspace_root(&id)?;
    // Clear existing contents (keep workspace dir).
    clear_dir_contents(&root)?;
    let bytes = B64
        .decode(body.archive_base64.trim())
        .map_err(|e| anyhow::anyhow!("Invalid archive_base64: {e}"))?;
    extract_archive(&bytes, &body.format, &root, body.project_name.as_deref())?;
    let meta = WorkspaceMeta {
        id: id.clone(),
        root_path: root.to_string_lossy().to_string(),
        provision: "client_sync".into(),
        read_only: false,
        created_at: Utc::now(),
    };
    store.save_meta(&meta)?;
    Ok(ProvisionResult {
        workspace_id: id,
        root_path: meta.root_path,
        message: "Archive extracted into workspace".into(),
    })
}

pub fn provision_sync_chunk(
    store: &WorkspaceStore,
    body: SyncChunkBody,
) -> anyhow::Result<serde_json::Value> {
    let upload_id = body.upload_id.trim();
    if upload_id.is_empty()
        || upload_id.contains("..")
        || upload_id.contains('/')
        || upload_id.contains('\\')
    {
        anyhow::bail!("Invalid upload_id");
    }
    if body.total_chunks == 0 || body.chunk_index >= body.total_chunks {
        anyhow::bail!("Invalid chunk_index/total_chunks");
    }

    let upload_dir = store.uploads_dir().join(upload_id);
    fs::create_dir_all(&upload_dir)?;
    let chunk_bytes = B64
        .decode(body.chunk_base64.trim())
        .map_err(|e| anyhow::anyhow!("Invalid chunk_base64: {e}"))?;
    let chunk_path = upload_dir.join(format!("{:06}.part", body.chunk_index));
    fs::write(&chunk_path, chunk_bytes)?;

    let received = fs::read_dir(&upload_dir)?
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.path()
                .extension()
                .and_then(|x| x.to_str())
                .map(|x| x == "part")
                .unwrap_or(false)
        })
        .count() as u32;

    if received < body.total_chunks {
        return Ok(serde_json::to_value(ChunkAck {
            ok: true,
            received,
        })?);
    }

    // Assemble in order.
    let assembled = upload_dir.join("assembled.bin");
    {
        let mut out = File::create(&assembled)?;
        for i in 0..body.total_chunks {
            let part = upload_dir.join(format!("{:06}.part", i));
            let mut f = File::open(&part)
                .map_err(|_| anyhow::anyhow!("Missing chunk {i} for upload {upload_id}"))?;
            copy(&mut f, &mut out)?;
        }
    }
    let bytes = fs::read(&assembled)?;
    let _ = fs::remove_dir_all(&upload_dir);

    let id = resolve_id(store, body.workspace_id)?;
    let root = store.ensure_workspace_root(&id)?;
    clear_dir_contents(&root)?;
    extract_archive(&bytes, &body.format, &root, body.project_name.as_deref())?;
    let meta = WorkspaceMeta {
        id: id.clone(),
        root_path: root.to_string_lossy().to_string(),
        provision: "client_sync".into(),
        read_only: false,
        created_at: Utc::now(),
    };
    store.save_meta(&meta)?;
    Ok(serde_json::to_value(ProvisionResult {
        workspace_id: id,
        root_path: meta.root_path,
        message: "Chunked archive assembled and extracted".into(),
    })?)
}

pub fn provision_git(store: &WorkspaceStore, body: GitBody) -> anyhow::Result<ProvisionResult> {
    let url_raw = body.url.trim();
    if url_raw.is_empty() {
        anyhow::bail!("url is required");
    }
    let id = resolve_id(store, body.workspace_id)?;
    let root = store.ensure_workspace_root(&id)?;
    clear_dir_contents(&root)?;

    let auth_url = inject_git_token(url_raw, body.token.as_deref());
    let depth = body.depth.unwrap_or(1).max(1);

    // Never log token / auth_url with credentials.
    tracing::info!(workspace_id = %id, "git clone starting");

    let mut cmd = Command::new("git");
    cmd.arg("clone")
        .arg("--depth")
        .arg(depth.to_string());
    if let Some(r) = body.r#ref.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        cmd.arg("--branch").arg(r);
    }
    cmd.arg(&auth_url).arg(&root);
    cmd.env("GIT_TERMINAL_PROMPT", "0");

    let output = cmd
        .output()
        .map_err(|e| anyhow::anyhow!("Failed to spawn git: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let scrubbed = scrub_secrets(&stderr, body.token.as_deref());
        anyhow::bail!("git clone failed: {scrubbed}");
    }

    let meta = WorkspaceMeta {
        id: id.clone(),
        root_path: root.to_string_lossy().to_string(),
        provision: "git_clone".into(),
        read_only: false,
        created_at: Utc::now(),
    };
    store.save_meta(&meta)?;
    Ok(ProvisionResult {
        workspace_id: id,
        root_path: meta.root_path,
        message: "Git repository cloned into workspace".into(),
    })
}

fn inject_git_token(url: &str, token: Option<&str>) -> String {
    let Some(token) = token.map(str::trim).filter(|t| !t.is_empty()) else {
        return url.to_string();
    };
    if let Some(rest) = url.strip_prefix("https://") {
        format!("https://x-access-token:{token}@{rest}")
    } else if let Some(rest) = url.strip_prefix("http://") {
        format!("http://x-access-token:{token}@{rest}")
    } else {
        url.to_string()
    }
}

fn scrub_secrets(s: &str, token: Option<&str>) -> String {
    let mut out = s.to_string();
    if let Some(t) = token {
        if !t.is_empty() {
            out = out.replace(t, "***");
        }
    }
    out
}

fn clear_dir_contents(dir: &Path) -> anyhow::Result<()> {
    if !dir.exists() {
        fs::create_dir_all(dir)?;
        return Ok(());
    }
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.is_dir() {
            fs::remove_dir_all(&path)?;
        } else {
            fs::remove_file(&path)?;
        }
    }
    Ok(())
}

fn extract_archive(
    bytes: &[u8],
    format: &str,
    dest: &Path,
    project_name: Option<&str>,
) -> anyhow::Result<()> {
    let format = format.trim().to_ascii_lowercase();
    let target = if let Some(name) = project_name.map(str::trim).filter(|s| !s.is_empty()) {
        if name.contains("..") || name.contains('/') || name.contains('\\') {
            anyhow::bail!("Invalid project_name");
        }
        let t = dest.join(name);
        fs::create_dir_all(&t)?;
        t
    } else {
        dest.to_path_buf()
    };

    match format.as_str() {
        "zip" => extract_zip(bytes, &target),
        "tar" | "tar.gz" | "tgz" => extract_tar(bytes, &target),
        other => anyhow::bail!("Unsupported archive format '{other}' (use zip or tar)"),
    }
}

fn extract_zip(bytes: &[u8], dest: &Path) -> anyhow::Result<()> {
    let cursor = Cursor::new(bytes);
    let mut archive = ZipArchive::new(cursor)?;
    for i in 0..archive.len() {
        let mut file = archive.by_index(i)?;
        let Some(name) = file.enclosed_name().map(|p| p.to_path_buf()) else {
            continue;
        };
        let out_path = dest.join(&name);
        if file.is_dir() {
            fs::create_dir_all(&out_path)?;
        } else {
            if let Some(parent) = out_path.parent() {
                fs::create_dir_all(parent)?;
            }
            let mut outfile = File::create(&out_path)?;
            copy(&mut file, &mut outfile)?;
        }
    }
    Ok(())
}

fn extract_tar(bytes: &[u8], dest: &Path) -> anyhow::Result<()> {
    // Try gzip first; fall back to plain tar.
    let gz = GzDecoder::new(Cursor::new(bytes));
    let mut archive = Archive::new(gz);
    match archive.unpack(dest) {
        Ok(()) => Ok(()),
        Err(_) => {
            let mut archive = Archive::new(Cursor::new(bytes));
            archive.unpack(dest)?;
            Ok(())
        }
    }
}

/// Write helper kept for future streaming APIs.
#[allow(dead_code)]
pub fn write_bytes(path: &Path, data: &[u8]) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut f = File::create(path)?;
    f.write_all(data)?;
    Ok(())
}
