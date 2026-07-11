use crate::error::{AppError, AppResult};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Mutex, OnceLock};

const MAX_CONCURRENT_OCR: usize = 2;

fn ocr_semaphore() -> &'static Mutex<usize> {
    static SEMAPHORE: OnceLock<Mutex<usize>> = OnceLock::new();
    SEMAPHORE.get_or_init(|| Mutex::new(0))
}

pub fn pdf_needs_ocr(text: &str, warnings: &[String]) -> bool {
    if warnings.iter().any(|w| w.to_lowercase().contains("ocr")) {
        return true;
    }
    let alpha = text.chars().filter(|c| c.is_alphabetic()).count();
    alpha < 120
}

pub fn pdf_ocr_available() -> bool {
    resolve_pdf_ocr_script().is_some() && resolve_python_executable().is_some()
}

pub fn resolve_pdf_ocr_script() -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(value) = std::env::var("NEXUS_DATA_ROOT") {
        candidates.push(PathBuf::from(value).join("scripts").join("soc_pdf_ocr.py"));
    }
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("scripts").join("soc_pdf_ocr.py"));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            candidates.push(parent.join("scripts").join("soc_pdf_ocr.py"));
            candidates.push(
                parent
                    .join("..")
                    .join("..")
                    .join("scripts")
                    .join("soc_pdf_ocr.py"),
            );
        }
    }
    candidates.push(PathBuf::from("scripts").join("soc_pdf_ocr.py"));
    candidates.into_iter().find(|path| path.is_file())
}

fn resolve_python_executable() -> Option<PathBuf> {
    for candidate in ["python", "python3", "py"] {
        if std::process::Command::new(candidate)
            .arg("--version")
            .output()
            .map(|output| output.status.success())
            .unwrap_or(false)
        {
            return Some(PathBuf::from(candidate));
        }
    }
    None
}

fn ocr_cache_dir() -> PathBuf {
    let base = crate::deployment::process_cache_dir().join("ocr");
    let _ = std::fs::create_dir_all(&base);
    base
}

fn cache_key_for_pdf(pdf_path: &Path) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(pdf_path.to_string_lossy().as_bytes());
    if let Ok(meta) = std::fs::metadata(pdf_path) {
        hasher.update(meta.len().to_le_bytes());
        if let Ok(modified) = meta.modified() {
            if let Ok(duration) = modified.duration_since(std::time::UNIX_EPOCH) {
                hasher.update(duration.as_secs().to_le_bytes());
            }
        }
    }
    format!("{:x}", hasher.finalize())
}

/// Synchronous OCR for use inside the parallel indexer.
pub fn ocr_pdf_to_markdown_sync(pdf_path: &str) -> AppResult<String> {
    let pdf = PathBuf::from(pdf_path.trim().trim_matches('"'));
    if !pdf.is_file() {
        return Err(AppError::Unknown(format!(
            "PDF file does not exist: {}",
            pdf.display()
        )));
    }

    let cache_path = ocr_cache_dir().join(format!("{}.md", cache_key_for_pdf(&pdf)));
    if cache_path.is_file() {
        if let Ok(existing) = std::fs::read_to_string(&cache_path) {
            if existing.trim().len() >= 48 {
                return Ok(existing);
            }
        }
    }

    let _slot = OcrSlot::acquire()?;

    let script = resolve_pdf_ocr_script().ok_or_else(|| {
        AppError::Unknown(
            "Could not find scripts/soc_pdf_ocr.py. Install Python dependencies or place the script under scripts/.".to_string(),
        )
    })?;
    let python = resolve_python_executable().ok_or_else(|| {
        AppError::Unknown(
            "Python is required for PDF OCR. Install Python 3 and retry, or pre-OCR PDFs to markdown.".to_string(),
        )
    })?;

    let output_dir = crate::deployment::process_temp_dir().join(format!(
        "nexus-kc-ocr-{}",
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir_all(&output_dir)
        .map_err(|e| AppError::Unknown(format!("Could not create OCR temp dir: {e}")))?;

    let stem = pdf
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("document");
    let output_md = output_dir.join(format!("{stem}-kc-ocr.md"));

    let output = std::process::Command::new(&python)
        .arg(&script)
        .arg(&pdf)
        .arg("--output")
        .arg(&output_md)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| AppError::Unknown(format!("Failed to run PDF OCR script: {e}")))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let _ = std::fs::remove_dir_all(&output_dir);
        return Err(AppError::Unknown(format!(
            "PDF OCR script failed: {}",
            stderr.trim()
        )));
    }

    if !output_md.is_file() {
        let _ = std::fs::remove_dir_all(&output_dir);
        return Err(AppError::Unknown(
            "PDF OCR completed but no markdown output was produced.".to_string(),
        ));
    }

    let markdown = std::fs::read_to_string(&output_md)
        .map_err(|e| AppError::Unknown(format!("Could not read OCR markdown: {e}")))?;
    let _ = std::fs::remove_dir_all(&output_dir);

    if markdown.trim().len() < 48 {
        return Err(AppError::Unknown(
            "PDF OCR produced too little text for indexing.".to_string(),
        ));
    }

    let _ = std::fs::write(&cache_path, &markdown);
    Ok(markdown)
}

/// OCR a PDF to markdown via `scripts/soc_pdf_ocr.py` for Knowledge Chat indexing.
pub async fn ocr_pdf_to_markdown(pdf_path: &str) -> AppResult<String> {
    ocr_pdf_to_markdown_sync(pdf_path)
}

pub fn ocr_sidecar_path(pdf_path: &Path) -> PathBuf {
    ocr_cache_dir().join(format!("{}.md", cache_key_for_pdf(pdf_path)))
}

struct OcrSlot;

impl OcrSlot {
    fn acquire() -> AppResult<Self> {
        let mut guard = ocr_semaphore()
            .lock()
            .map_err(|_| AppError::Unknown("OCR semaphore poisoned.".to_string()))?;
        if *guard >= MAX_CONCURRENT_OCR {
            return Err(AppError::Unknown(
                "PDF OCR concurrency limit reached. Retry indexing shortly.".to_string(),
            ));
        }
        *guard += 1;
        Ok(Self)
    }
}

impl Drop for OcrSlot {
    fn drop(&mut self) {
        if let Ok(mut guard) = ocr_semaphore().lock() {
            *guard = guard.saturating_sub(1);
        }
    }
}
