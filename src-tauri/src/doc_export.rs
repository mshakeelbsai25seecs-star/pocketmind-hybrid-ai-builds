//! Offline document creation: LLM → DocSpec JSON → Python DOCX/PPTX/PDF exporters.

use crate::error::{AppError, AppResult};
use crate::knowledge_chat::pdf_ocr::resolve_python_executable;
use crate::llm::{ChatMessage, GenerationParams, GenerationRequest};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use tauri::State;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DocFormat {
    Docx,
    Pptx,
    Pdf,
}

impl DocFormat {
    pub fn as_str(&self) -> &'static str {
        match self {
            DocFormat::Docx => "docx",
            DocFormat::Pptx => "pptx",
            DocFormat::Pdf => "pdf",
        }
    }

    pub fn parse(value: &str) -> AppResult<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "docx" | "doc" | "word" => Ok(DocFormat::Docx),
            "pptx" | "ppt" | "powerpoint" => Ok(DocFormat::Pptx),
            "pdf" => Ok(DocFormat::Pdf),
            other => Err(AppError::Unknown(format!(
                "Unsupported document format: {other}"
            ))),
        }
    }

    pub fn extension(&self) -> &'static str {
        self.as_str()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocExportResult {
    pub ok: bool,
    pub path: String,
    pub format: String,
    pub title: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocSpecResult {
    pub ok: bool,
    pub format: String,
    pub spec: Value,
    pub preview_markdown: String,
    pub message: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct GenerateDocumentRequest {
    pub brief: String,
    pub format: String,
    pub backend: String,
    pub model_path: Option<String>,
    #[serde(default)]
    pub params: Option<GenerationParams>,
    /// Optional existing markdown/content to reshape into a DocSpec (chat export).
    #[serde(default)]
    pub source_markdown: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ExportDocumentRequest {
    pub spec: Value,
    pub format: String,
    pub output_path: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct GenerateAndExportRequest {
    pub brief: String,
    pub format: String,
    pub output_path: String,
    pub backend: String,
    pub model_path: Option<String>,
    #[serde(default)]
    pub params: Option<GenerationParams>,
    #[serde(default)]
    pub source_markdown: Option<String>,
}

pub fn resolve_doc_export_worker() -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(value) = std::env::var("NEXUS_DATA_ROOT") {
        candidates.push(PathBuf::from(value).join("scripts").join("doc_export_worker.py"));
    }
    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("scripts")
            .join("doc_export_worker.py"),
    );
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            candidates.push(parent.join("resources").join("doc_export_worker.py"));
            candidates.push(parent.join("resources").join("doc_export").join("doc_export_worker.py"));
            let mut walk = parent.to_path_buf();
            for _ in 0..6 {
                candidates.push(walk.join("scripts").join("doc_export_worker.py"));
                candidates.push(walk.join("resources").join("doc_export_worker.py"));
                if !walk.pop() {
                    break;
                }
            }
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        let mut walk = cwd;
        for _ in 0..6 {
            candidates.push(walk.join("scripts").join("doc_export_worker.py"));
            candidates.push(walk.join("resources").join("doc_export_worker.py"));
            if !walk.pop() {
                break;
            }
        }
    }
    candidates
        .into_iter()
        .find(|p| p.is_file())
        .and_then(|p| p.canonicalize().ok().or(Some(p)))
}

fn resolve_doc_export_python() -> Option<PathBuf> {
    if let Some(path) = crate::tooling::python_path() {
        if path.is_file() {
            return Some(path);
        }
    }
    resolve_python_executable()
}

fn extract_json_object(text: &str) -> AppResult<Value> {
    let trimmed = text.trim();
    if let Ok(v) = serde_json::from_str::<Value>(trimmed) {
        if v.is_object() {
            return Ok(v);
        }
    }
    // Fenced ```json ... ```
    if let Some(start) = trimmed.find('{') {
        if let Some(end) = trimmed.rfind('}') {
            if end > start {
                let slice = &trimmed[start..=end];
                if let Ok(v) = serde_json::from_str::<Value>(slice) {
                    if v.is_object() {
                        return Ok(v);
                    }
                }
            }
        }
    }
    Err(AppError::Unknown(
        "Model did not return valid DocSpec JSON. Try again or simplify the brief.".to_string(),
    ))
}

fn validate_spec(mut spec: Value, format: &DocFormat) -> AppResult<Value> {
    let obj = spec
        .as_object_mut()
        .ok_or_else(|| AppError::Unknown("DocSpec must be a JSON object".to_string()))?;
    obj.insert(
        "format".to_string(),
        Value::String(format.as_str().to_string()),
    );
    if !obj.contains_key("title") {
        obj.insert("title".to_string(), Value::String("Untitled".to_string()));
    }
    match format {
        DocFormat::Pptx => {
            if !obj.contains_key("slides") {
                // Allow sections → slides conversion in Python; ensure something exists
                if !obj.contains_key("sections") {
                    return Err(AppError::Unknown(
                        "PPTX DocSpec needs slides[] or sections[]".to_string(),
                    ));
                }
            }
        }
        DocFormat::Docx | DocFormat::Pdf => {
            if !obj.contains_key("sections")
                && !obj.contains_key("body_markdown")
                && !obj.contains_key("slides")
            {
                return Err(AppError::Unknown(
                    "Document DocSpec needs sections[], body_markdown, or slides[]".to_string(),
                ));
            }
        }
    }
    Ok(spec)
}

fn spec_to_preview_markdown(spec: &Value) -> String {
    let title = spec
        .get("title")
        .and_then(|v| v.as_str())
        .unwrap_or("Document");
    let mut out = format!("# {title}\n\n");
    if let Some(sub) = spec.get("subtitle").and_then(|v| v.as_str()) {
        if !sub.is_empty() {
            out.push_str(&format!("_{sub}_\n\n"));
        }
    }
    if let Some(sections) = spec.get("sections").and_then(|v| v.as_array()) {
        for section in sections {
            if let Some(h) = section.get("heading").and_then(|v| v.as_str()) {
                if !h.is_empty() {
                    out.push_str(&format!("## {h}\n\n"));
                }
            }
            if let Some(body) = section
                .get("body_markdown")
                .or_else(|| section.get("body"))
                .and_then(|v| v.as_str())
            {
                out.push_str(body);
                out.push_str("\n\n");
            }
            if let Some(bullets) = section.get("bullets").and_then(|v| v.as_array()) {
                for b in bullets {
                    if let Some(t) = b.as_str() {
                        out.push_str(&format!("- {t}\n"));
                    }
                }
                out.push('\n');
            }
        }
    }
    if let Some(slides) = spec.get("slides").and_then(|v| v.as_array()) {
        for (i, slide) in slides.iter().enumerate() {
            let st = slide
                .get("title")
                .and_then(|v| v.as_str())
                .unwrap_or("Slide");
            out.push_str(&format!("## Slide {}: {}\n\n", i + 1, st));
            if let Some(bullets) = slide.get("bullets").and_then(|v| v.as_array()) {
                for b in bullets {
                    if let Some(t) = b.as_str() {
                        out.push_str(&format!("- {t}\n"));
                    }
                }
                out.push('\n');
            }
        }
    }
    out
}

fn heuristic_spec_from_markdown(markdown: &str, format: &DocFormat, title_hint: &str) -> Value {
    let title = if title_hint.trim().is_empty() {
        markdown
            .lines()
            .find(|l| l.trim_start().starts_with("# "))
            .map(|l| l.trim_start().trim_start_matches('#').trim().to_string())
            .unwrap_or_else(|| "Exported document".to_string())
    } else {
        title_hint.trim().to_string()
    };

    match format {
        DocFormat::Pptx => {
            let mut slides = Vec::new();
            let mut current_title = title.clone();
            let mut bullets: Vec<String> = Vec::new();
            let flush = |slides: &mut Vec<Value>, t: &str, b: &mut Vec<String>| {
                if b.is_empty() && t.is_empty() {
                    return;
                }
                slides.push(serde_json::json!({
                    "title": t,
                    "bullets": b.clone(),
                    "notes": ""
                }));
                b.clear();
            };
            for line in markdown.lines() {
                let t = line.trim();
                if t.starts_with("# ") || t.starts_with("## ") {
                    flush(&mut slides, &current_title, &mut bullets);
                    current_title = t.trim_start_matches('#').trim().to_string();
                } else if let Some(rest) = t.strip_prefix("- ").or_else(|| t.strip_prefix("* ")) {
                    bullets.push(rest.to_string());
                } else if !t.is_empty() {
                    bullets.push(t.to_string());
                }
            }
            flush(&mut slides, &current_title, &mut bullets);
            if slides.is_empty() {
                slides.push(serde_json::json!({
                    "title": title,
                    "bullets": ["See source content"],
                    "notes": ""
                }));
            }
            serde_json::json!({
                "format": "pptx",
                "title": title,
                "slides": slides
            })
        }
        DocFormat::Docx | DocFormat::Pdf => {
            serde_json::json!({
                "format": format.as_str(),
                "title": title,
                "sections": [{
                    "heading": "",
                    "body_markdown": markdown,
                    "bullets": []
                }]
            })
        }
    }
}

fn build_docspec_prompt(brief: &str, format: &DocFormat, source: Option<&str>) -> (String, String) {
    let schema = match format {
        DocFormat::Pptx => r#"{"format":"pptx","title":"...","subtitle":"...","slides":[{"title":"...","bullets":["..."],"notes":"..."}]}"#,
        DocFormat::Docx => r#"{"format":"docx","title":"...","subtitle":"...","sections":[{"heading":"...","body_markdown":"...","bullets":["..."],"table":{"headers":["A","B"],"rows":[["1","2"]]}}],"tables":[]}"#,
        DocFormat::Pdf => r#"{"format":"pdf","title":"...","sections":[{"heading":"...","body_markdown":"...","bullets":["..."]}]}"#,
    };
    let system = format!(
        "You are a document structuring assistant. Reply with ONLY valid JSON matching this schema (no markdown fences, no commentary):\n{schema}\n\
         Use clear professional language. Keep content substantive but concise."
    );
    let user = if let Some(src) = source {
        format!(
            "Reshape the following content into a {fmt} DocSpec JSON.\n\nBrief/context: {brief}\n\n---\nCONTENT:\n{src}",
            fmt = format.as_str(),
            brief = if brief.trim().is_empty() {
                "Export as a polished document"
            } else {
                brief
            },
            src = src.chars().take(24_000).collect::<String>()
        )
    } else {
        format!(
            "Create a {fmt} DocSpec JSON for this brief:\n\n{brief}",
            fmt = format.as_str(),
            brief = brief.trim()
        )
    };
    (system, user)
}

pub fn run_python_exporter(spec: &Value, format: &DocFormat, output_path: &Path) -> AppResult<DocExportResult> {
    let worker = resolve_doc_export_worker().ok_or_else(|| {
        AppError::Unknown("Could not find scripts/doc_export_worker.py".to_string())
    })?;
    let python = resolve_doc_export_python().ok_or_else(|| {
        AppError::Unknown("Python 3 is required for document export.".to_string())
    })?;

    if let Some(parent) = output_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| AppError::Unknown(format!("Could not create output dir: {e}")))?;
    }

    let spec_json = serde_json::to_string(spec)
        .map_err(|e| AppError::Unknown(format!("DocSpec serialize: {e}")))?;

    let mut cmd = Command::new(&python);
    crate::process_util::no_window_std(&mut cmd);
    cmd.arg(&worker)
        .arg("--format")
        .arg(format.as_str())
        .arg("--output")
        .arg(output_path)
        .arg("--spec")
        .arg("-")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // no_window applied above

    let mut child = cmd
        .spawn()
        .map_err(|e| AppError::Unknown(format!("Failed to start doc exporter: {e}")))?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(spec_json.as_bytes())
            .map_err(|e| AppError::Unknown(format!("Failed to write DocSpec to exporter: {e}")))?;
    }
    let output = child
        .wait_with_output()
        .map_err(|e| AppError::Unknown(format!("Doc exporter wait failed: {e}")))?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let json_line = stdout
        .lines()
        .rev()
        .find(|l| l.trim_start().starts_with('{'))
        .unwrap_or(&stdout);
    let status: Value = serde_json::from_str(json_line).map_err(|e| {
        AppError::Unknown(format!(
            "Invalid exporter JSON ({e}): {json_line}. stderr: {stderr}"
        ))
    })?;
    if !status.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) {
        let err = status
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or("export failed");
        return Err(AppError::Unknown(err.to_string()));
    }
    let path = status
        .get("path")
        .and_then(|v| v.as_str())
        .unwrap_or(&output_path.to_string_lossy())
        .to_string();
    let title = status
        .get("title")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    Ok(DocExportResult {
        ok: true,
        path,
        format: format.as_str().to_string(),
        title,
        message: format!("Saved {} document.", format.as_str().to_uppercase()),
    })
}

/// Generate a validated DocSpec using the active chat backend (local / remote / enterprise).
pub async fn generate_document_spec_inner(
    state: &State<'_, crate::commands::AppState>,
    req: GenerateDocumentRequest,
) -> AppResult<DocSpecResult> {
    let format = DocFormat::parse(&req.format)?;
    let brief = req.brief.trim().to_string();
    let source = req
        .source_markdown
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());

    if brief.is_empty() && source.is_none() {
        return Err(AppError::Unknown(
            "Enter a brief or provide content to export.".to_string(),
        ));
    }

    let (system, user) = build_docspec_prompt(&brief, &format, source);
    let mut params = req.params.unwrap_or_default();
    if params.max_tokens < 1024 {
        params.max_tokens = 2048;
    }
    if params.temperature > 0.6 {
        params.temperature = 0.35;
    }

    let gen_req = GenerationRequest {
        prompt: user.clone(),
        system_prompt: Some(system.clone()),
        params,
        model_path: req.model_path.clone(),
        backend: req.backend.clone(),
        messages: vec![
            ChatMessage {
                role: "system".to_string(),
                content: system,
                ..Default::default()
            },
            ChatMessage {
                role: "user".to_string(),
                content: user,
                ..Default::default()
            },
        ],
        images: vec![],
        tools: vec![],
        tool_choice: None,
    };

    let text = match crate::commands::complete_generation(state, gen_req).await {
        Ok(t) => t,
        Err(e) => {
            // Offline reshape fallback when LLM unavailable and source provided
            if let Some(src) = source {
                let spec = validate_spec(
                    heuristic_spec_from_markdown(src, &format, &brief),
                    &format,
                )?;
                return Ok(DocSpecResult {
                    ok: true,
                    format: format.as_str().to_string(),
                    preview_markdown: spec_to_preview_markdown(&spec),
                    message: format!(
                        "Built DocSpec without LLM ({e}). You can still export."
                    ),
                    spec,
                });
            }
            return Err(e);
        }
    };

    let parsed = match extract_json_object(&text) {
        Ok(v) => v,
        Err(e) => {
            if let Some(src) = source {
                let spec = validate_spec(
                    heuristic_spec_from_markdown(src, &format, &brief),
                    &format,
                )?;
                return Ok(DocSpecResult {
                    ok: true,
                    format: format.as_str().to_string(),
                    preview_markdown: spec_to_preview_markdown(&spec),
                    message: format!("Model JSON invalid ({e}); used structured fallback."),
                    spec,
                });
            }
            return Err(e);
        }
    };
    let spec = validate_spec(parsed, &format)?;
    Ok(DocSpecResult {
        ok: true,
        format: format.as_str().to_string(),
        preview_markdown: spec_to_preview_markdown(&spec),
        message: "DocSpec ready.".to_string(),
        spec,
    })
}

#[tauri::command]
pub async fn generate_document_spec(
    state: State<'_, crate::commands::AppState>,
    request: GenerateDocumentRequest,
) -> AppResult<DocSpecResult> {
    generate_document_spec_inner(&state, request).await
}

#[tauri::command]
pub async fn export_document(request: ExportDocumentRequest) -> AppResult<DocExportResult> {
    let format = DocFormat::parse(&request.format)?;
    let spec = validate_spec(request.spec, &format)?;
    let path = PathBuf::from(request.output_path.trim());
    tokio::task::spawn_blocking(move || run_python_exporter(&spec, &format, &path))
        .await
        .map_err(|e| AppError::Unknown(format!("export join: {e}")))?
}

#[tauri::command]
pub async fn generate_and_export_document(
    state: State<'_, crate::commands::AppState>,
    request: GenerateAndExportRequest,
) -> AppResult<DocExportResult> {
    let spec_res = generate_document_spec_inner(
        &state,
        GenerateDocumentRequest {
            brief: request.brief,
            format: request.format.clone(),
            backend: request.backend,
            model_path: request.model_path,
            params: request.params,
            source_markdown: request.source_markdown,
        },
    )
    .await?;
    let format = DocFormat::parse(&request.format)?;
    let path = PathBuf::from(request.output_path.trim());
    let spec = spec_res.spec;
    tokio::task::spawn_blocking(move || run_python_exporter(&spec, &format, &path))
        .await
        .map_err(|e| AppError::Unknown(format!("export join: {e}")))?
}

#[tauri::command]
pub async fn probe_doc_export() -> serde_json::Value {
    let worker = resolve_doc_export_worker();
    let python = resolve_doc_export_python();
    let mut packages = serde_json::Map::new();
    if let Some(py) = &python {
        for pkg in ["docx", "pptx", "reportlab", "fpdf"] {
            let mut probe = Command::new(py);
            crate::process_util::no_window_std(&mut probe);
            let ok = probe
                .args(["-c", &format!("import {pkg}")])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .map(|s| s.success())
                .unwrap_or(false);
            packages.insert(pkg.to_string(), Value::Bool(ok));
        }
    }
    let worker_found = worker.is_some();
    let worker_path = worker
        .as_ref()
        .map(|p| p.to_string_lossy().to_string());
    serde_json::json!({
        "worker_found": worker_found,
        "worker_path": worker_path,
        "python_found": python.is_some(),
        "packages": packages,
        "ready": worker_found
            && python.is_some()
            && packages.get("docx").and_then(|v| v.as_bool()).unwrap_or(false)
            && packages.get("pptx").and_then(|v| v.as_bool()).unwrap_or(false)
            && (packages.get("reportlab").and_then(|v| v.as_bool()).unwrap_or(false)
                || packages.get("fpdf").and_then(|v| v.as_bool()).unwrap_or(false)),
    })
}

#[tauri::command]
pub async fn install_doc_export_support() -> AppResult<serde_json::Value> {
    let python = resolve_doc_export_python().ok_or_else(|| {
        AppError::Unknown(
            "Python 3 is required for document export. Install Python or run Repair tooling in Diagnostics."
                .to_string(),
        )
    })?;
    let packages = ["python-docx", "python-pptx", "reportlab"];
    let mut errors: Vec<String> = Vec::new();
    for pkg in packages {
        let mut cmd = Command::new(&python);
        crate::process_util::no_window_std(&mut cmd);
        let output = cmd
            .args(["-m", "pip", "install", pkg])
            .output()
            .map_err(|e| AppError::Unknown(format!("Failed to run pip for {pkg}: {e}")))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            errors.push(format!("{pkg}: {}", if stderr.is_empty() { "install failed" } else { stderr.as_str() }));
        }
    }
    let probe = probe_doc_export().await;
    if !errors.is_empty() {
        return Err(AppError::Unknown(format!(
            "Some exporter packages failed: {}. Probe: {}",
            errors.join(" | "),
            probe.get("ready").and_then(|v| v.as_bool()).unwrap_or(false)
        )));
    }
    Ok(probe)
}
