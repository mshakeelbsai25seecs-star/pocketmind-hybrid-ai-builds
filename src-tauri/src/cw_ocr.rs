//! Offline OCR for PocketCode screenshots (Tesseract on PATH; optional PowerShell WinOCR).

use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::process::Stdio;
use tokio::process::Command;

const OCR_MAX_CHARS: usize = 12_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OcrResult {
    pub text: String,
    pub engine: String,
    pub ok: bool,
    pub message: String,
}

fn truncate(s: String) -> String {
    if s.len() <= OCR_MAX_CHARS {
        return s;
    }
    let mut out = s.chars().take(OCR_MAX_CHARS).collect::<String>();
    out.push_str("\n…[OCR truncated]");
    out
}

fn preferred_ocr_engine() -> crate::ocr_settings::OcrEngine {
    if let Ok(engine) = std::env::var("NEXUS_OCR_ENGINE") {
        return crate::ocr_settings::OcrEngine::parse(&engine);
    }
    if let Ok(db) = crate::database::Database::new() {
        let cfg = crate::ocr_settings::load_ocr_image_rag_config(&db, false);
        return crate::ocr_settings::OcrEngine::parse(&cfg.ocr_engine);
    }
    crate::ocr_settings::OcrEngine::Auto
}

async fn try_unlimited_ocr(path: &Path) -> Option<OcrResult> {
    let path_buf = path.to_path_buf();
    let result = tokio::task::spawn_blocking(move || {
        crate::unlimited_ocr::ocr_with_unlimited(&path_buf)
    })
    .await
    .ok()?
    .ok()?;
    if !result.ok || result.text.trim().is_empty() {
        return None;
    }
    Some(OcrResult {
        text: truncate(result.text),
        engine: result.engine,
        ok: true,
        message: result.message,
    })
}

/// OCR an image file. Optional Unlimited-OCR → Tesseract → Windows OCR.
pub async fn ocr_image(path: &str) -> AppResult<OcrResult> {
    let p = Path::new(path.trim());
    if !p.is_file() {
        return Ok(OcrResult {
            text: String::new(),
            engine: "none".to_string(),
            ok: false,
            message: format!("Image file not found: {path}"),
        });
    }
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !matches!(ext.as_str(), "png" | "jpg" | "jpeg" | "bmp" | "tif" | "tiff" | "webp" | "gif") {
        return Ok(OcrResult {
            text: String::new(),
            engine: "none".to_string(),
            ok: false,
            message: format!("Unsupported image type: .{ext}"),
        });
    }

    let engine = preferred_ocr_engine();
    let try_unlimited = matches!(
        engine,
        crate::ocr_settings::OcrEngine::Unlimited | crate::ocr_settings::OcrEngine::Auto
    ) && (matches!(engine, crate::ocr_settings::OcrEngine::Unlimited)
        || crate::unlimited_ocr::unlimited_model_on_disk());

    if try_unlimited {
        if let Some(r) = try_unlimited_ocr(p).await {
            return Ok(r);
        }
        if matches!(engine, crate::ocr_settings::OcrEngine::Unlimited) {
            // Fall through to legacy with a clear label path below.
        }
    }

    if !matches!(engine, crate::ocr_settings::OcrEngine::Unlimited) || try_unlimited {
        if let Some(r) = try_tesseract(p).await {
            return Ok(r);
        }
        if let Some(r) = try_windows_ocr(p).await {
            return Ok(r);
        }
    }

    Ok(OcrResult {
        text: String::new(),
        engine: "none".to_string(),
        ok: false,
        message: if matches!(engine, crate::ocr_settings::OcrEngine::Unlimited) {
            "Unlimited-OCR failed or unavailable. Install CUDA + weights (Settings → Scanned PDFs), or switch OCR engine to Auto/Legacy.".to_string()
        } else {
            "No local OCR engine found. Install Tesseract OCR and ensure `tesseract` is on PATH, or use an org/online vision model.".to_string()
        },
    })
}

async fn try_tesseract(path: &Path) -> Option<OcrResult> {
    let mut cmd = Command::new("tesseract");
    cmd.arg(path)
        .arg("stdout")
        .arg("-l")
        .arg("eng")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let output = cmd.output().await.ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if text.is_empty() {
        return Some(OcrResult {
            text: String::new(),
            engine: "tesseract".to_string(),
            ok: false,
            message: "Tesseract returned no text (image may be graphical with no readable text).".to_string(),
        });
    }
    Some(OcrResult {
        text: truncate(text),
        engine: "tesseract".to_string(),
        ok: true,
        message: "OCR via Tesseract.".to_string(),
    })
}

/// Best-effort Windows OCR via PowerShell + Windows.Media.Ocr (may be unavailable).
async fn try_windows_ocr(path: &Path) -> Option<OcrResult> {
    #[cfg(not(target_os = "windows"))]
    {
        let _ = path;
        return None;
    }
    #[cfg(target_os = "windows")]
    {
        let path_str = path.to_string_lossy().replace('\'', "''");
        let script = format!(
            r#"
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType=WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Media.Ocr, ContentType=WindowsRuntime]
function Await($WinRtTask, $ResultType) {{
  $asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {{ $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' }} | Select-Object -First 1
  $netTask = $asTask.MakeGenericMethod($ResultType).Invoke($null, @($WinRtTask))
  $netTask.Wait(-1) | Out-Null
  $netTask.Result
}}
$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync('{path_str}')) ([Windows.Storage.StorageFile])
$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if ($null -eq $engine) {{ throw 'No OCR engine' }}
$result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
$result.Text
"#
        );
        let mut cmd = Command::new("powershell");
        cmd.args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
        let output = tokio::time::timeout(
            std::time::Duration::from_secs(45),
            cmd.output(),
        )
        .await
        .ok()?
        .ok()?;
        if !output.status.success() {
            return None;
        }
        let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if text.is_empty() {
            return None;
        }
        Some(OcrResult {
            text: truncate(text),
            engine: "windows_ocr".to_string(),
            ok: true,
            message: "OCR via Windows.Media.Ocr.".to_string(),
        })
    }
}

/// Read image bytes as base64 for multimodal APIs.
pub fn image_to_base64(path: &str) -> AppResult<(String, String)> {
    let p = Path::new(path.trim());
    if !p.is_file() {
        return Err(AppError::MissingFile(format!("Image not found: {path}")));
    }
    let bytes = std::fs::read(p).map_err(|e| AppError::Unknown(format!("Cannot read image: {e}")))?;
    if bytes.len() > 8 * 1024 * 1024 {
        return Err(AppError::Unknown("Image too large (max 8MB).".to_string()));
    }
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("png")
        .to_ascii_lowercase();
    let mime = match ext.as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        _ => "application/octet-stream",
    };
    use base64::Engine as _;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok((mime.to_string(), b64))
}
