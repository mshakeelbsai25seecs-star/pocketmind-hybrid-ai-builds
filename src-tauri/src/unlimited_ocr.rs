//! Optional Baidu Unlimited-OCR sidecar (CUDA Transformers worker).

use crate::error::{AppError, AppResult};
use crate::knowledge_chat::pdf_ocr::resolve_python_executable;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Stdio;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UnlimitedOcrProbe {
    pub ok: bool,
    pub python: String,
    pub torch: bool,
    pub transformers: bool,
    pub pymupdf: bool,
    pub cuda: bool,
    pub model_dir: String,
    pub model_ready: bool,
    pub available: bool,
    pub warning: Option<String>,
    pub worker_found: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UnlimitedOcrRunResult {
    pub ok: bool,
    pub engine: String,
    pub text: String,
    pub output_path: Option<String>,
    pub pages: usize,
    pub message: String,
}

pub fn unlimited_ocr_model_dir() -> PathBuf {
    let dir = crate::deployment::preferred_data_root()
        .join("models")
        .join("ocr")
        .join("unlimited-ocr");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

pub fn resolve_unlimited_ocr_worker() -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(value) = std::env::var("NEXUS_DATA_ROOT") {
        candidates.push(PathBuf::from(value).join("scripts").join("unlimited_ocr_worker.py"));
    }
    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("scripts")
            .join("unlimited_ocr_worker.py"),
    );
    if let Ok(cwd) = std::env::current_dir() {
        let mut walk = cwd;
        for _ in 0..6 {
            candidates.push(walk.join("scripts").join("unlimited_ocr_worker.py"));
            if !walk.pop() {
                break;
            }
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            let mut walk = parent.to_path_buf();
            for _ in 0..6 {
                candidates.push(walk.join("scripts").join("unlimited_ocr_worker.py"));
                if !walk.pop() {
                    break;
                }
            }
        }
    }
    candidates
        .into_iter()
        .find(|p| p.is_file())
        .and_then(|p| p.canonicalize().ok().or(Some(p)))
}

fn run_worker_json(args: &[&str], timeout_secs: u64) -> AppResult<serde_json::Value> {
    let worker = resolve_unlimited_ocr_worker().ok_or_else(|| {
        AppError::Unknown(
            "Could not find scripts/unlimited_ocr_worker.py".to_string(),
        )
    })?;
    let python = resolve_python_executable().ok_or_else(|| {
        AppError::Unknown("Python 3 is required for Unlimited-OCR.".to_string())
    })?;
    let model_dir = unlimited_ocr_model_dir();

    let mut cmd = std::process::Command::new(&python);
    cmd.arg(&worker)
        .args(args)
        .arg("--model-dir")
        .arg(&model_dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("NEXUS_UNLIMITED_OCR_DIR", model_dir.to_string_lossy().as_ref());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let (tx, rx) = std::sync::mpsc::channel();
    let handle = std::thread::spawn(move || {
        let _ = tx.send(cmd.output());
    });

    let output = match rx.recv_timeout(std::time::Duration::from_secs(timeout_secs)) {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => {
            let _ = handle.join();
            return Err(AppError::Unknown(format!("Failed to start Unlimited-OCR worker: {e}")));
        }
        Err(_) => {
            return Err(AppError::Unknown(format!(
                "Unlimited-OCR timed out after {timeout_secs}s"
            )));
        }
    };
    let _ = handle.join();

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if stdout.is_empty() {
        return Err(AppError::Unknown(format!(
            "Unlimited-OCR worker produced no JSON. stderr: {stderr}"
        )));
    }
    let json_line = stdout
        .lines()
        .rev()
        .find(|l| l.trim_start().starts_with('{'))
        .unwrap_or(&stdout);
    serde_json::from_str(json_line).map_err(|e| {
        AppError::Unknown(format!(
            "Invalid Unlimited-OCR JSON ({e}): {json_line}. stderr: {stderr}"
        ))
    })
}

pub fn probe_unlimited_ocr() -> UnlimitedOcrProbe {
    let worker_found = resolve_unlimited_ocr_worker().is_some();
    let model_dir = unlimited_ocr_model_dir();
    if !worker_found {
        return UnlimitedOcrProbe {
            ok: false,
            python: String::new(),
            torch: false,
            transformers: false,
            pymupdf: false,
            cuda: false,
            model_dir: model_dir.to_string_lossy().to_string(),
            model_ready: false,
            available: false,
            warning: Some("unlimited_ocr_worker.py not found".to_string()),
            worker_found: false,
        };
    }
    match run_worker_json(&["probe"], 60) {
        Ok(v) => UnlimitedOcrProbe {
            ok: v.get("ok").and_then(|x| x.as_bool()).unwrap_or(false),
            python: v
                .get("python")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string(),
            torch: v.get("torch").and_then(|x| x.as_bool()).unwrap_or(false),
            transformers: v
                .get("transformers")
                .and_then(|x| x.as_bool())
                .unwrap_or(false),
            pymupdf: v.get("pymupdf").and_then(|x| x.as_bool()).unwrap_or(false),
            cuda: v.get("cuda").and_then(|x| x.as_bool()).unwrap_or(false),
            model_dir: v
                .get("model_dir")
                .and_then(|x| x.as_str())
                .unwrap_or(&model_dir.to_string_lossy())
                .to_string(),
            model_ready: v
                .get("model_ready")
                .and_then(|x| x.as_bool())
                .unwrap_or(false),
            available: v
                .get("available")
                .and_then(|x| x.as_bool())
                .unwrap_or(false),
            warning: v
                .get("warning")
                .and_then(|x| x.as_str())
                .map(|s| s.to_string()),
            worker_found: true,
        },
        Err(e) => UnlimitedOcrProbe {
            ok: false,
            python: String::new(),
            torch: false,
            transformers: false,
            pymupdf: false,
            cuda: false,
            model_dir: model_dir.to_string_lossy().to_string(),
            model_ready: false,
            available: false,
            warning: Some(e.to_string()),
            worker_found: true,
        },
    }
}

pub fn download_unlimited_ocr_weights() -> AppResult<UnlimitedOcrProbe> {
    let v = run_worker_json(&["download"], 3600)?;
    if !v.get("ok").and_then(|x| x.as_bool()).unwrap_or(false) {
        let err = v
            .get("error")
            .and_then(|x| x.as_str())
            .unwrap_or("download failed");
        return Err(AppError::Unknown(err.to_string()));
    }
    Ok(probe_unlimited_ocr())
}

pub fn unlimited_ocr_available() -> bool {
    probe_unlimited_ocr().available
}

/// Run Unlimited-OCR on an image or PDF; returns markdown text.
pub fn ocr_with_unlimited(path: &Path) -> AppResult<UnlimitedOcrRunResult> {
    if !path.is_file() {
        return Err(AppError::MissingFile(path.display().to_string()));
    }
    let out_dir = crate::deployment::process_temp_dir().join(format!(
        "uo-{}",
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir_all(&out_dir)
        .map_err(|e| AppError::Unknown(format!("temp dir: {e}")))?;
    let out_md = out_dir.join("ocr.md");
    let input = path.to_string_lossy().to_string();
    let output = out_md.to_string_lossy().to_string();

    let timeout = if path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("pdf"))
        .unwrap_or(false)
    {
        1800
    } else {
        600
    };

    let v = run_worker_json(
        &[
            "ocr",
            "--input",
            &input,
            "--output",
            &output,
            "--mode",
            "gundam",
        ],
        timeout,
    )?;

    if !v.get("ok").and_then(|x| x.as_bool()).unwrap_or(false) {
        let err = v
            .get("error")
            .and_then(|x| x.as_str())
            .unwrap_or("OCR failed");
        let _ = std::fs::remove_dir_all(&out_dir);
        return Err(AppError::Unknown(err.to_string()));
    }

    let text = if out_md.is_file() {
        std::fs::read_to_string(&out_md).unwrap_or_default()
    } else {
        String::new()
    };
    let pages = v.get("pages").and_then(|x| x.as_u64()).unwrap_or(1) as usize;
    Ok(UnlimitedOcrRunResult {
        ok: !text.trim().is_empty(),
        engine: "unlimited-ocr".to_string(),
        text,
        output_path: Some(out_md.to_string_lossy().to_string()),
        pages,
        message: "OCR via Unlimited-OCR.".to_string(),
    })
}

/// Cheap filesystem check (no Python) for Auto fallback routing.
pub fn unlimited_model_on_disk() -> bool {
    let dir = unlimited_ocr_model_dir();
    if (dir.join("config.json")).is_file() {
        return true;
    }
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return false;
    };
    for entry in entries.flatten() {
        let p = entry.path();
        if (p.join("config.json")).is_file() {
            return true;
        }
        if p.is_dir() {
            if let Ok(inner) = std::fs::read_dir(&p) {
                for child in inner.flatten() {
                    if (child.path().join("config.json")).is_file() {
                        return true;
                    }
                }
            }
        }
    }
    false
}

#[tauri::command]
pub async fn probe_unlimited_ocr_status() -> UnlimitedOcrProbe {
    match tokio::task::spawn_blocking(probe_unlimited_ocr).await {
        Ok(p) => p,
        Err(e) => UnlimitedOcrProbe {
            ok: false,
            python: String::new(),
            torch: false,
            transformers: false,
            pymupdf: false,
            cuda: false,
            model_dir: unlimited_ocr_model_dir().to_string_lossy().to_string(),
            model_ready: false,
            available: false,
            warning: Some(format!("probe task failed: {e}")),
            worker_found: resolve_unlimited_ocr_worker().is_some(),
        },
    }
}

#[tauri::command]
pub async fn download_unlimited_ocr_model() -> AppResult<UnlimitedOcrProbe> {
    tokio::task::spawn_blocking(download_unlimited_ocr_weights)
        .await
        .map_err(|e| AppError::Unknown(format!("download task failed: {e}")))?
}
