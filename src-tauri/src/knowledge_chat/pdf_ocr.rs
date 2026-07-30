use crate::error::{AppError, AppResult};
use crate::ocr_settings::{load_ocr_image_rag_config, OcrEngine};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Mutex, OnceLock};
const MAX_CONCURRENT_OCR: usize = 2;
/// Bump when OCR CLI args / engines change so stale sidecars are not reused incorrectly.
const OCR_CACHE_NAMESPACE: &str = "v2";

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

pub fn python_available() -> bool {
    resolve_python_executable().is_some()
}

pub fn resolve_pdf_ocr_script() -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(value) = std::env::var("NEXUS_DATA_ROOT") {
        candidates.push(PathBuf::from(value).join("scripts").join("soc_pdf_ocr.py"));
    }
    // Dev builds: src-tauri/ → repo root/scripts/
    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("scripts")
            .join("soc_pdf_ocr.py"),
    );
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("scripts").join("soc_pdf_ocr.py"));
        // Walk up a few parents (cwd may be src-tauri/ or target/debug/).
        let mut walk = cwd;
        for _ in 0..5 {
            candidates.push(walk.join("scripts").join("soc_pdf_ocr.py"));
            if !walk.pop() {
                break;
            }
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            candidates.push(parent.join("scripts").join("soc_pdf_ocr.py"));
            let mut walk = parent.to_path_buf();
            for _ in 0..6 {
                candidates.push(walk.join("scripts").join("soc_pdf_ocr.py"));
                if !walk.pop() {
                    break;
                }
            }
        }
    }
    candidates.push(PathBuf::from("scripts").join("soc_pdf_ocr.py"));
    candidates
        .into_iter()
        .find(|path| path.is_file())
        .and_then(|path| path.canonicalize().ok().or(Some(path)))
}

pub fn resolve_python_executable() -> Option<PathBuf> {
    // Prefer real interpreters; skip Windows Store python stubs that "succeed"
    // --version but cannot run scripts.
    for candidate in ["python3", "python", "py"] {
        let mut probe = std::process::Command::new(candidate);
        crate::process_util::no_window_std(&mut probe);
        let Ok(output) = probe
            .args(["-c", "import sys; print(sys.executable)"])
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .output()
        else {
            continue;
        };
        if !output.status.success() {
            continue;
        }
        let exe = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if exe.is_empty() {
            continue;
        }
        let lower = exe.to_ascii_lowercase();
        if lower.contains("windowsapps") || lower.contains("microsoft\\windowsapps") {
            continue;
        }
        return Some(PathBuf::from(candidate));
    }
    None
}

fn python_probe_import(module: &str) -> bool {
    let Some(python) = resolve_python_executable() else {
        return false;
    };
    let code = format!("import {module}");
    let mut probe = std::process::Command::new(python);
    crate::process_util::no_window_std(&mut probe);
    probe
        .args(["-c", &code])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

pub fn docling_importable() -> bool {
    python_probe_import("docling")
}

pub fn opencv_available() -> bool {
    python_probe_import("cv2")
}

fn ocr_cache_dir() -> PathBuf {
    let base = crate::deployment::process_cache_dir().join("ocr");
    let _ = std::fs::create_dir_all(&base);
    base
}

fn cache_key_for_pdf(pdf_path: &Path, engine: &str, preprocess: bool) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(OCR_CACHE_NAMESPACE.as_bytes());
    hasher.update(engine.as_bytes());
    hasher.update(if preprocess { b"pre1" } else { b"pre0" });
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

fn load_engine_preprocess() -> (String, bool) {
    // Best-effort settings without AppState: open a short-lived DB handle via settings file path.
    // Indexer calls may not have db; fall back to env overrides then defaults.
    if let Ok(engine) = std::env::var("NEXUS_OCR_ENGINE") {
        let preprocess = std::env::var("NEXUS_OCR_PREPROCESS")
            .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
            .unwrap_or(true);
        return (OcrEngine::parse(&engine).as_str().to_string(), preprocess);
    }
    if let Ok(db) = crate::database::Database::new() {
        let cfg = load_ocr_image_rag_config(&db, false);
        return (
            OcrEngine::parse(&cfg.ocr_engine).as_str().to_string(),
            cfg.ocr_preprocess,
        );
    }
    (OcrEngine::Auto.as_str().to_string(), true)
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

    let (engine, preprocess) = load_engine_preprocess();
    let cache_path = ocr_cache_dir().join(format!(
        "{}.md",
        cache_key_for_pdf(&pdf, &engine, preprocess)
    ));
    if cache_path.is_file() {
        if let Ok(existing) = std::fs::read_to_string(&cache_path) {
            if existing.trim().len() >= 48 {
                return Ok(existing);
            }
        }
    }

    let _slot = OcrSlot::acquire()?;

    let engine_parsed = OcrEngine::parse(&engine);
    let try_unlimited = matches!(engine_parsed, OcrEngine::Unlimited | OcrEngine::Auto)
        && (matches!(engine_parsed, OcrEngine::Unlimited)
            || crate::unlimited_ocr::unlimited_model_on_disk());

    if try_unlimited {
        match crate::unlimited_ocr::ocr_with_unlimited(&pdf) {
            Ok(r) if r.ok && r.text.trim().len() >= 48 => {
                let _ = std::fs::write(&cache_path, &r.text);
                let raw_path = cache_path.with_extension("raw.md");
                let _ = std::fs::write(&raw_path, &r.text);
                return Ok(r.text);
            }
            Ok(_) | Err(_) => {
                // Fall through to Docling/legacy; Unlimited stay preferred but not hard-fail.
            }
        }
    }

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

    // After Unlimited attempt, Auto/Unlimited fall through as docling→legacy via script.
    let engine_arg = match engine_parsed {
        OcrEngine::Unlimited => "auto",
        other => other.as_str(),
    };
    let mut cmd = std::process::Command::new(&python);
    crate::process_util::no_window_std(&mut cmd);
    cmd.arg(&script)
        .arg(&pdf)
        .arg("--output")
        .arg(&output_md)
        .arg("--engine")
        .arg(engine_arg)
        .arg("--dpi")
        .arg("300");
    if preprocess {
        cmd.arg("--preprocess");
    } else {
        cmd.arg("--no-preprocess");
    }

    // No wall-clock kill: large scanned PDFs (dozens of pages @ 300 DPI) can
    // legitimately take longer than a fixed timeout. Progress is visible via
    // indexer heartbeats while this blocking call runs.
    let mut child = cmd
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| AppError::Unknown(format!("Failed to start PDF OCR script: {e}")))?;

    let mut stderr = String::new();
    if let Some(mut pipe) = child.stderr.take() {
        use std::io::Read;
        let _ = pipe.read_to_string(&mut stderr);
    }

    let status = child
        .wait()
        .map_err(|e| AppError::Unknown(format!("PDF OCR wait failed: {e}")))?;

    if !status.success() {
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
    // Also write raw sidecar for LLM-repair path consumers
    let raw_path = cache_path.with_extension("raw.md");
    let _ = std::fs::write(&raw_path, &markdown);
    Ok(markdown)
}

/// OCR a PDF to markdown via `scripts/soc_pdf_ocr.py` for Knowledge Chat indexing.
pub async fn ocr_pdf_to_markdown(pdf_path: &str) -> AppResult<String> {
    tokio::task::spawn_blocking({
        let path = pdf_path.to_string();
        move || ocr_pdf_to_markdown_sync(&path)
    })
    .await
    .map_err(|e| AppError::Unknown(format!("OCR task join failed: {e}")))?
}

pub fn ocr_sidecar_path(pdf_path: &Path) -> PathBuf {
    let (engine, preprocess) = load_engine_preprocess();
    ocr_cache_dir().join(format!(
        "{}.md",
        cache_key_for_pdf(pdf_path, &engine, preprocess)
    ))
}

struct OcrSlot;

impl OcrSlot {
    /// Wait up to ~30s for a slot instead of failing the whole PDF index immediately.
    fn acquire() -> AppResult<Self> {
        for attempt in 0..60 {
            {
                let mut guard = ocr_semaphore()
                    .lock()
                    .map_err(|_| AppError::Unknown("OCR semaphore poisoned.".to_string()))?;
                if *guard < MAX_CONCURRENT_OCR {
                    *guard += 1;
                    return Ok(Self);
                }
            }
            if attempt + 1 == 60 {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(500));
        }
        Err(AppError::Unknown(
            "PDF OCR is busy (concurrency limit). Retry indexing shortly.".to_string(),
        ))
    }
}

impl Drop for OcrSlot {
    fn drop(&mut self) {
        if let Ok(mut guard) = ocr_semaphore().lock() {
            *guard = guard.saturating_sub(1);
        }
    }
}
