//! PocketCode PDF text prep: extract text layer, OCR with Unlimited/auto when needed,
//! store searchable markdown under the workspace sidecar (not in the project folder).

use crate::error::{AppError, AppResult};
use crate::file_context::extract_pdf_enhanced;
use crate::knowledge_chat::pdf_ocr::{ocr_pdf_to_markdown_sync, pdf_needs_ocr, pdf_ocr_available};
use pocketcode_workspace::WorkspaceSidecar;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

const MAX_PDFS_PER_PREPARE: usize = 80;
const SKIP_DIR_NAMES: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    ".pocketmind-index",
    ".pocketcode-index",
    "__pycache__",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PdfPrepareItem {
    pub path: String,
    pub status: String,
    pub engine: String,
    pub chars: usize,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PdfPrepareReport {
    pub workspace_root: String,
    pub pdf_count: usize,
    pub ready: usize,
    pub ocr_used: usize,
    pub failed: usize,
    pub skipped: usize,
    pub items: Vec<PdfPrepareItem>,
    pub summary: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct OcrManifest {
    /// relative pdf path → sidecar file name under ocr/
    entries: BTreeMap<String, ManifestEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ManifestEntry {
    sidecar: String,
    status: String,
    engine: String,
    chars: usize,
    source_mtime_secs: u64,
    source_size: u64,
}

fn standardize_rel(path: &str) -> String {
    path.replace('\\', "/")
}

fn sidecar_name_for_rel(rel: &str) -> String {
    let safe = standardize_rel(rel)
        .replace('\\', "__")
        .replace('/', "__")
        .chars()
        .map(|c| match c {
            'a'..='z' | 'A'..='Z' | '0'..='9' | '-' | '_' | '.' => c,
            _ => '_',
        })
        .collect::<String>();
    format!("{safe}.md")
}

fn source_stamp(path: &Path) -> (u64, u64) {
    let meta = fs::metadata(path).ok();
    let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);
    let mtime = meta
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    (mtime, size)
}

fn load_manifest(ocr_dir: &Path) -> OcrManifest {
    let path = ocr_dir.join("manifest.json");
    fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn save_manifest(ocr_dir: &Path, manifest: &OcrManifest) -> AppResult<()> {
    fs::create_dir_all(ocr_dir)
        .map_err(|e| AppError::Unknown(format!("Cannot create OCR sidecar dir: {e}")))?;
    let path = ocr_dir.join("manifest.json");
    let raw = serde_json::to_string_pretty(manifest)
        .map_err(|e| AppError::Unknown(format!("Cannot serialize OCR manifest: {e}")))?;
    fs::write(&path, raw).map_err(|e| AppError::Unknown(format!("Cannot write OCR manifest: {e}")))?;
    Ok(())
}

fn list_pdfs(workspace_root: &Path) -> Vec<(String, PathBuf)> {
    let mut out = Vec::new();
    for entry in WalkDir::new(workspace_root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| {
            if e.file_type().is_dir() {
                let name = e.file_name().to_string_lossy();
                return !SKIP_DIR_NAMES.iter().any(|s| name.eq_ignore_ascii_case(s));
            }
            true
        })
        .flatten()
    {
        if !entry.file_type().is_file() {
            continue;
        }
        let ext = entry
            .path()
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if ext != "pdf" {
            continue;
        }
        let abs = entry.path().to_path_buf();
        let rel = abs
            .strip_prefix(workspace_root)
            .map(|p| standardize_rel(&p.to_string_lossy()))
            .unwrap_or_else(|_| standardize_rel(&abs.to_string_lossy()));
        out.push((rel, abs));
        if out.len() >= MAX_PDFS_PER_PREPARE {
            break;
        }
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

fn write_sidecar(ocr_dir: &Path, name: &str, body: &str) -> AppResult<PathBuf> {
    fs::create_dir_all(ocr_dir)
        .map_err(|e| AppError::Unknown(format!("Cannot create OCR sidecar dir: {e}")))?;
    let path = ocr_dir.join(name);
    fs::write(&path, body).map_err(|e| AppError::Unknown(format!("Cannot write OCR sidecar: {e}")))?;
    Ok(path)
}

/// Ensure one PDF has extractable/OCR text in the workspace sidecar. Returns markdown body.
pub fn ensure_pdf_text(workspace_root: &Path, rel_or_abs: &str) -> AppResult<(String, PdfPrepareItem)> {
    let sidecar = WorkspaceSidecar::for_workspace(workspace_root)
        .map_err(|e| AppError::Unknown(e.to_string()))?;
    let root = sidecar.workspace_root.clone();
    let ocr_dir = sidecar.ocr_dir();

    let candidate = PathBuf::from(rel_or_abs.trim());
    let abs = if candidate.is_absolute() {
        candidate
    } else {
        root.join(rel_or_abs.trim())
    };
    if !abs.is_file() {
        return Err(AppError::MissingFile(format!(
            "PDF not found: {}",
            rel_or_abs.trim()
        )));
    }
    let rel = abs
        .strip_prefix(&root)
        .map(|p| standardize_rel(&p.to_string_lossy()))
        .unwrap_or_else(|_| standardize_rel(&abs.to_string_lossy()));
    if !rel.to_ascii_lowercase().ends_with(".pdf") {
        return Err(AppError::Unknown(format!("Not a PDF: {rel}")));
    }

    let (mtime, size) = source_stamp(&abs);
    let mut manifest = load_manifest(&ocr_dir);
    if let Some(existing) = manifest.entries.get(&rel) {
        if existing.source_mtime_secs == mtime
            && existing.source_size == size
            && existing.status == "ready"
        {
            let path = ocr_dir.join(&existing.sidecar);
            if let Ok(body) = fs::read_to_string(&path) {
                if body.trim().len() >= 40 {
                    return Ok((
                        body,
                        PdfPrepareItem {
                            path: rel,
                            status: "cached".to_string(),
                            engine: existing.engine.clone(),
                            chars: existing.chars,
                            message: "Reused OCR/extract sidecar.".to_string(),
                        },
                    ));
                }
            }
        }
    }

    let (extracted, warnings) = extract_pdf_enhanced(&abs).unwrap_or_else(|_| {
        (
            String::new(),
            vec!["PDF text-layer extract failed.".to_string()],
        )
    });
    let needs_ocr = pdf_needs_ocr(&extracted, &warnings);

    let (body, engine, status, message) = if !needs_ocr && extracted.trim().len() >= 40 {
        let header = format!(
            "# PDF text extract: `{rel}`\n\n_Source: embedded PDF text layer (no OCR)._ \n\n"
        );
        (
            format!("{header}{}", extracted.trim()),
            "text-layer".to_string(),
            "ready".to_string(),
            "Used embedded PDF text layer.".to_string(),
        )
    } else if pdf_ocr_available() || crate::unlimited_ocr::unlimited_model_on_disk() {
        match ocr_pdf_to_markdown_sync(&abs.to_string_lossy()) {
            Ok(md) if md.trim().len() >= 40 => {
                let header = format!(
                    "# PDF OCR: `{rel}`\n\n_Source: Unlimited-OCR (preferred) → Docling/legacy fallback._ \n\n"
                );
                (
                    format!("{header}{}", md.trim()),
                    "unlimited-auto".to_string(),
                    "ready".to_string(),
                    "OCR completed (Unlimited/auto).".to_string(),
                )
            }
            Ok(_) => (
                format!("# PDF OCR failed: `{rel}`\n\nNo usable OCR text.\n"),
                "none".to_string(),
                "failed".to_string(),
                "OCR produced too little text.".to_string(),
            ),
            Err(e) => (
                format!("# PDF OCR failed: `{rel}`\n\n{e}\n"),
                "none".to_string(),
                "failed".to_string(),
                e.to_string(),
            ),
        }
    } else if extracted.trim().len() >= 20 {
        let header = format!(
            "# PDF text extract (sparse): `{rel}`\n\n_OCR engines unavailable; using sparse text layer._ \n\n"
        );
        (
            format!("{header}{}", extracted.trim()),
            "text-layer-sparse".to_string(),
            "ready".to_string(),
            "OCR unavailable; used sparse embedded text.".to_string(),
        )
    } else {
        (
            format!(
                "# PDF not readable: `{rel}`\n\n\
                 This PDF needs OCR but no engine is ready.\n\
                 Install Unlimited-OCR weights (Settings → Scanned PDFs / Support models) with CUDA, \
                 or Python + Docling/Tesseract (`scripts/soc_pdf_ocr.py`).\n"
            ),
            "none".to_string(),
            "failed".to_string(),
            "No OCR engine available for scanned PDF.".to_string(),
        )
    };

    let name = sidecar_name_for_rel(&rel);
    write_sidecar(&ocr_dir, &name, &body)?;
    let chars = body.chars().count();
    manifest.entries.insert(
        rel.clone(),
        ManifestEntry {
            sidecar: name,
            status: status.clone(),
            engine: engine.clone(),
            chars,
            source_mtime_secs: mtime,
            source_size: size,
        },
    );
    save_manifest(&ocr_dir, &manifest)?;

    Ok((
        body,
        PdfPrepareItem {
            path: rel,
            status,
            engine,
            chars,
            message,
        },
    ))
}

/// Walk workspace PDFs and ensure OCR/extract sidecars exist (app data only).
pub fn prepare_workspace_pdfs(workspace_root: &Path) -> AppResult<PdfPrepareReport> {
    let sidecar = WorkspaceSidecar::for_workspace(workspace_root)
        .map_err(|e| AppError::Unknown(e.to_string()))?;
    let root = sidecar.workspace_root.clone();
    let pdfs = list_pdfs(&root);
    let pdf_count = pdfs.len();
    let mut items = Vec::new();
    let mut ready = 0usize;
    let mut ocr_used = 0usize;
    let mut failed = 0usize;
    let mut skipped = 0usize;

    for (rel, _abs) in pdfs {
        match ensure_pdf_text(&root, &rel) {
            Ok((_body, item)) => {
                if item.status == "ready" || item.status == "cached" {
                    ready += 1;
                } else if item.status == "failed" {
                    failed += 1;
                } else {
                    skipped += 1;
                }
                if item.engine.contains("unlimited")
                    || item.engine.contains("ocr")
                    || item.engine == "unlimited-or-auto"
                    || item.engine == "unlimited-auto"
                {
                    ocr_used += 1;
                }
                items.push(item);
            }
            Err(e) => {
                failed += 1;
                items.push(PdfPrepareItem {
                    path: rel,
                    status: "failed".to_string(),
                    engine: "none".to_string(),
                    chars: 0,
                    message: e.to_string(),
                });
            }
        }
    }

    let summary = if pdf_count == 0 {
        "No PDF files found in this workspace.".to_string()
    } else {
        format!(
            "Prepared {ready}/{pdf_count} PDF(s) for PocketCode (OCR used on {ocr_used}; failed {failed}). \
             Text is stored in the app sidecar — read_file/grep on .pdf paths use it. \
             Unlimited-OCR is preferred when configured (Settings → Scanned PDFs)."
        )
    };

    Ok(PdfPrepareReport {
        workspace_root: root.to_string_lossy().to_string(),
        pdf_count,
        ready,
        ocr_used,
        failed,
        skipped,
        items,
        summary,
    })
}

/// Resolve sidecar markdown path for a workspace-relative PDF, if ready.
pub fn pdf_sidecar_path(workspace_root: &Path, rel: &str) -> Option<PathBuf> {
    let sidecar = WorkspaceSidecar::for_workspace(workspace_root).ok()?;
    let rel = standardize_rel(rel.trim());
    let manifest = load_manifest(&sidecar.ocr_dir());
    let entry = manifest.entries.get(&rel)?;
    if entry.status != "ready" && entry.status != "cached" {
        // still try reading file if present
    }
    let path = sidecar.ocr_dir().join(&entry.sidecar);
    if path.is_file() {
        Some(path)
    } else {
        None
    }
}

/// Absolute path to the OCR corpus directory for ripgrep (may not exist yet).
pub fn ocr_corpus_dir(workspace_root: &Path) -> Option<PathBuf> {
    let sidecar = WorkspaceSidecar::for_workspace(workspace_root).ok()?;
    let dir = sidecar.ocr_dir();
    if dir.is_dir() {
        Some(dir)
    } else {
        None
    }
}

/// Map an OCR sidecar filename back to the original relative PDF path.
pub fn pdf_rel_for_sidecar_name(workspace_root: &Path, sidecar_file_name: &str) -> Option<String> {
    let sidecar = WorkspaceSidecar::for_workspace(workspace_root).ok()?;
    let manifest = load_manifest(&sidecar.ocr_dir());
    let name = Path::new(sidecar_file_name)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(sidecar_file_name);
    manifest
        .entries
        .iter()
        .find(|(_, e)| e.sidecar == name)
        .map(|(rel, _)| rel.clone())
}
