//! Render PDF pages to PNG for vision multimodal (Chat / PocketCode).

use crate::error::{AppError, AppResult};
use crate::knowledge_chat::pdf_ocr::resolve_python_executable;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PdfPageImage {
    pub page: u32,
    pub mime: String,
    pub base64: String,
}

fn temp_out_dir(pdf_path: &Path) -> PathBuf {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in pdf_path.to_string_lossy().as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    std::env::temp_dir()
        .join("pocketmind-pdf-pages")
        .join(format!("{h:016x}"))
}

/// Render up to `max_pages` PDF pages as PNG and return base64 payloads.
pub fn pdf_page_images(path: &str, max_pages: usize) -> AppResult<Vec<PdfPageImage>> {
    let pdf_path = Path::new(path.trim());
    if !pdf_path.is_file() {
        return Err(AppError::MissingFile(format!("PDF not found: {path}")));
    }
    let ext = pdf_path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if ext != "pdf" {
        return Err(AppError::Unknown("Not a PDF file.".to_string()));
    }

    let limit = max_pages.clamp(1, 6);
    let out_dir = temp_out_dir(pdf_path);
    let _ = std::fs::create_dir_all(&out_dir);

    let Some(python) = resolve_python_executable() else {
        return Err(AppError::Unknown(
            "Python is required to render PDF pages for vision. Install Python with PyMuPDF (pip install pymupdf), or use a text-extractable PDF.".to_string(),
        ));
    };

    let script = r#"
import sys
from pathlib import Path
try:
    import fitz
except Exception:
    sys.stderr.write("pymupdf_missing\n")
    sys.exit(2)
try:
    pdf = Path(sys.argv[1])
    outdir = Path(sys.argv[2])
    limit = max(1, min(int(sys.argv[3]), 6))
    if not pdf.is_file():
        sys.exit(1)
    outdir.mkdir(parents=True, exist_ok=True)
    for old in outdir.glob("p*.png"):
        try:
            old.unlink()
        except Exception:
            pass
    doc = fitz.open(pdf)
    n = min(len(doc), limit)
    for i in range(n):
        page = doc.load_page(i)
        pix = page.get_pixmap(matrix=fitz.Matrix(1.5, 1.5), alpha=False)
        out = outdir / ("p%03d.png" % (i + 1))
        pix.save(out)
    print(n)
except Exception as e:
    sys.stderr.write(str(e))
    sys.exit(1)
"#;

    let mut cmd = std::process::Command::new(&python);
    crate::process_util::no_window_std(&mut cmd);
    let output = cmd
        .args([
            "-c",
            script,
            &pdf_path.to_string_lossy(),
            &out_dir.to_string_lossy(),
            &limit.to_string(),
        ])
        .output()
        .map_err(|e| AppError::Unknown(format!("Failed to run PDF page renderer: {e}")))?;

    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        if err.contains("pymupdf_missing") {
            return Err(AppError::Unknown(
                "PyMuPDF is not installed. Run: pip install pymupdf — then retry PDF vision pages.".to_string(),
            ));
        }
        return Err(AppError::Unknown(format!(
            "PDF page render failed: {}",
            err.trim().chars().take(400).collect::<String>()
        )));
    }

    let mut pages = Vec::new();
    let mut entries: Vec<_> = std::fs::read_dir(&out_dir)
        .map_err(|e| AppError::Unknown(format!("Cannot read PDF page dir: {e}")))?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("png"))
        .collect();
    entries.sort();
    for (idx, p) in entries.into_iter().take(limit).enumerate() {
        let bytes = std::fs::read(&p).map_err(|e| AppError::Unknown(format!("Cannot read page PNG: {e}")))?;
        if bytes.is_empty() || bytes.len() > 8 * 1024 * 1024 {
            continue;
        }
        pages.push(PdfPageImage {
            page: (idx as u32) + 1,
            mime: "image/png".to_string(),
            base64: base64::engine::general_purpose::STANDARD.encode(&bytes),
        });
    }

    if pages.is_empty() {
        return Err(AppError::Unknown(
            "No PDF pages were rendered. The file may be empty or encrypted.".to_string(),
        ));
    }
    Ok(pages)
}
