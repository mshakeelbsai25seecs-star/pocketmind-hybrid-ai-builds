use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::collections::BTreeSet;
use std::process::Stdio;
use std::sync::Arc;

use serde_json::Value;
use futures::StreamExt;
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, Mutex};

use crate::error::{AppError, AppResult};
use super::runtime_discovery::{self, RuntimeCandidate};
use super::{InferenceBackend, GenerationChunk, GenerationParams, GenerationRequest};

pub struct LlamaCppBackend {
    process: Arc<Mutex<Option<Child>>>,
    model_loaded: Arc<Mutex<bool>>,
    loaded_model_path: Arc<Mutex<Option<String>>>,
    loaded_runtime_signature: Arc<Mutex<Option<String>>>,
    loaded_mmproj: Arc<Mutex<Option<String>>>,
    port: u16,
}

/// True for non-primary multi-part GGUF shards (…-00002-of-00005.gguf).
fn is_secondary_gguf_shard(file_name: &str) -> bool {
    let lower = file_name.to_ascii_lowercase();
    let Some(of_pos) = lower.rfind("-of-") else {
        return false;
    };
    let before = &lower[..of_pos];
    let Some(dash) = before.rfind('-') else {
        return false;
    };
    let num = &before[dash + 1..];
    if num.is_empty() || !num.chars().all(|c| c.is_ascii_digit()) {
        return false;
    }
    num.parse::<u32>().unwrap_or(1) != 1
}

/// If this is a primary shard (…-00001-of-NNNN), list missing sibling shard filenames.
fn missing_gguf_shard_siblings(path: &Path) -> Vec<String> {
    let Some(file_name) = path.file_name().and_then(|s| s.to_str()) else {
        return Vec::new();
    };
    let lower = file_name.to_ascii_lowercase();
    let Some(of_pos) = lower.rfind("-of-") else {
        return Vec::new();
    };
    let after = &lower[of_pos + 4..];
    let total_str = after.split(|c: char| !c.is_ascii_digit()).next().unwrap_or("");
    let Ok(total) = total_str.parse::<u32>() else {
        return Vec::new();
    };
    if total <= 1 {
        return Vec::new();
    }
    let before = &lower[..of_pos];
    let Some(dash) = before.rfind('-') else {
        return Vec::new();
    };
    let num = &before[dash + 1..];
    if num.parse::<u32>().unwrap_or(0) != 1 {
        return Vec::new();
    }
    let prefix = &file_name[..dash + 1];
    let suffix = &file_name[of_pos..];
    let width = num.len();
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let mut missing = Vec::new();
    for i in 2..=total {
        let shard = format!("{prefix}{i:0width$}{suffix}", width = width);
        if !parent.join(&shard).is_file() {
            missing.push(shard);
        }
    }
    missing
}

/// Strip shard + quant suffixes so mmproj names can share a clean base stem.
fn strip_gguf_quant_suffix(stem: &str) -> String {
    let mut s = stem.to_string();
    // e.g. ...-00001-of-00002 / ...-split-00001-of-00003
    if let Some(idx) = s.to_ascii_lowercase().rfind("-0000") {
        // keep only if it looks like -0000N-of-0000M
        let tail = &s[idx..];
        if tail.to_ascii_lowercase().contains("-of-") {
            s.truncate(idx);
        }
    }
    if let Some(idx) = s.to_ascii_lowercase().rfind("-split-0000") {
        s.truncate(idx);
    }
    const SUFFIXES: &[&str] = &[
        "-UD-Q2_K_XL", "-UD-Q3_K_XL", "-UD-Q4_K_XL", "-UD-Q5_K_XL", "-UD-Q6_K_XL", "-UD-Q8_K_XL",
        "-UD-IQ1_S", "-UD-IQ1_M", "-UD-IQ2_M", "-UD-IQ2_XXS", "-UD-IQ3_XXS", "-UD-TQ1_0",
        "-Q2_K_L", "-Q2_K", "-Q3_K_S", "-Q3_K_M", "-Q3_K_L", "-Q4_0", "-Q4_1", "-Q4_K_S", "-Q4_K_M",
        "-Q4_K_L", "-Q5_0", "-Q5_1", "-Q5_K_S", "-Q5_K_M", "-Q6_K", "-Q8_0", "-IQ4_NL",
        "-IQ4_XS", "-IQ3_M", "-IQ3_XXS", "-IQ3_XS", "-F16", "-BF16",
        ".Q2_K", ".Q3_K_S", ".Q3_K_M", ".Q3_K_L", ".Q4_0", ".Q4_1", ".Q4_K_S", ".Q4_K_M",
        ".Q5_0", ".Q5_1", ".Q5_K_S", ".Q5_K_M", ".Q6_K", ".Q8_0",
    ];
    let upper = s.to_ascii_uppercase();
    for suf in SUFFIXES {
        let suf_u = suf.to_ascii_uppercase();
        if upper.ends_with(&suf_u) {
            s.truncate(s.len().saturating_sub(suf.len()));
            break;
        }
    }
    s
}

/// Locate a paired mmproj next to a GGUF (offline vision).
pub fn find_mmproj_for_model(model_path: &str) -> Option<String> {
    let p = Path::new(model_path);
    let parent = p.parent()?;
    let stem = p.file_stem()?.to_str()?;
    let stem_l = stem.to_ascii_lowercase();
    // Skip looking for a projector next to an mmproj file itself.
    if stem_l.contains("mmproj") {
        return None;
    }
    let base = strip_gguf_quant_suffix(stem);
    let candidates = [
        parent.join(format!("{stem}.mmproj")),
        parent.join(format!("{stem}.mmproj.gguf")),
        parent.join(format!("{stem}-mmproj-f16.gguf")),
        parent.join(format!("{stem}-mmproj-Q8_0.gguf")),
        parent.join(format!("mmproj-{stem}-f16.gguf")),
        parent.join(format!("mmproj-{stem}.gguf")),
        parent.join(format!("{base}-mmproj-f16.gguf")),
        parent.join(format!("mmproj-{base}-f16.gguf")),
        parent.join(format!("mmproj-{base}-F16.gguf")),
        parent.join(format!("mmproj-{base}-bf16.gguf")),
        parent.join(format!("mmproj-{base}-BF16.gguf")),
        parent.join(format!("mmproj-{base}-Q8_0.gguf")),
        parent.join(format!("mmproj-{base}.gguf")),
        // Prefer uniquely renamed projectors (see ModelManager mmproj download).
        // Generic mmproj-F16.gguf is last-resort when only one VL model is present.
        parent.join("mmproj.gguf"),
        parent.join("mmproj-F16.gguf"),
        parent.join("mmproj-f16.gguf"),
        parent.join("mmproj-BF16.gguf"),
        parent.join("mmproj-bf16.gguf"),
        parent.join("mmproj-model-f16.gguf"),
    ];
    for c in candidates {
        if c.is_file() {
            return Some(c.to_string_lossy().to_string());
        }
    }
    // Prefer *mmproj*.gguf files whose name shares tokens with the model stem
    // (important when several VL models share one models folder).
    if let Ok(rd) = std::fs::read_dir(parent) {
        let tokens: Vec<String> = stem_l
            .split(|c: char| !c.is_ascii_alphanumeric())
            .filter(|t| {
                t.len() >= 2
                    && *t != "instruct"
                    && *t != "gguf"
                    && *t != "f16"
                    && *t != "bf16"
            })
            .map(|t| t.to_string())
            .collect();
        let mut found: Vec<(usize, PathBuf)> = rd
            .flatten()
            .map(|e| e.path())
            .filter(|path| {
                path.is_file()
                    && path
                        .file_name()
                        .and_then(|n| n.to_str())
                        .map(|n| n.to_ascii_lowercase().contains("mmproj"))
                        .unwrap_or(false)
            })
            .map(|path| {
                let name = path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("")
                    .to_ascii_lowercase();
                let score = tokens.iter().filter(|t| name.contains(t.as_str())).count();
                (score, path)
            })
            .collect();
        found.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
        // Accept best match with shared tokens, or the sole mmproj in the folder
        // (e.g. LLaVA's generic mmproj-model-f16.gguf).
        if let Some((score, path)) = found.first() {
            if *score > 0 || found.len() == 1 {
                return Some(path.to_string_lossy().to_string());
            }
        }
    }
    None
}

#[derive(Debug, Clone)]
struct LaunchPlan {
    runtime: RuntimeCandidate,
    gpu_layers: i32,
    context_size: u32,
    batch_size: u32,
    flash_attention: bool,
    label: String,
}

impl LlamaCppBackend {
    pub fn new() -> Self {
        Self {
            process: Arc::new(Mutex::new(None)),
            model_loaded: Arc::new(Mutex::new(false)),
            loaded_model_path: Arc::new(Mutex::new(None)),
            loaded_runtime_signature: Arc::new(Mutex::new(None)),
            loaded_mmproj: Arc::new(Mutex::new(None)),
            // Use a free per-process port instead of a fixed port. This prevents PocketMind Hybrid AI
            // from accidentally talking to an old leftover llama-server.exe instance.
            port: Self::find_free_port().unwrap_or(18082),
        }
    }

    pub async fn current_mmproj_path(&self) -> Option<String> {
        self.loaded_mmproj.lock().await.clone()
    }

    fn find_free_port() -> Option<u16> {
        TcpListener::bind("127.0.0.1:0")
            .ok()
            .and_then(|listener| listener.local_addr().ok().map(|addr| addr.port()))
    }

    fn requested_signature(path: &str, params: &GenerationParams) -> String {
        let mm = find_mmproj_for_model(path).unwrap_or_default();
        format!(
            "{}|mmproj={}|gpu={}|ctx={}|batch={}|flash={}|threads={}",
            path,
            mm,
            params.gpu_layers,
            params.context_size,
            params.batch_size,
            params.flash_attention,
            params.threads
        )
    }

    fn effective_context_size(params: &GenerationParams, model_size: u64, total_ram: u64, available_ram: u64, force_cpu: bool) -> u32 {
        let requested = params.context_size.clamp(512, 32768);
        let one_gb = 1024u64 * 1024 * 1024;
        let huge_model = model_size > 50u64 * one_gb;
        let extremely_low_total_ram = total_ram > 0 && model_size > total_ram.saturating_mul(95).saturating_div(100);
        let low_available_ram = available_ram > 0 && model_size > available_ram.saturating_mul(85).saturating_div(100);

        // Do not silently force every CPU fallback down to 2048. Small offline SOC models
        // often run on CPU but still need 4K-8K context for validator reports and RAG snippets.
        if extremely_low_total_ram {
            requested.min(2048).max(512)
        } else if low_available_ram {
            requested.min(4096).max(512)
        } else if huge_model {
            requested.min(4096).max(2048)
        } else if force_cpu {
            requested.min(8192).max(512)
        } else {
            requested.clamp(2048, 8192)
        }
    }

    fn build_launch_plans(path: &str, params: &GenerationParams, runtimes: Vec<RuntimeCandidate>) -> Vec<LaunchPlan> {
        let mut plans = Vec::<LaunchPlan>::new();
        let model_size = runtime_discovery::model_size_bytes(path);
        let (total_ram, available_ram, _free_vram, _gpu_count) = runtime_discovery::hardware_memory_snapshot();
        let low_ram = available_ram > 0 && model_size > available_ram.saturating_mul(85).saturating_div(100);

        for runtime in runtimes {
            let layers = runtime_discovery::gpu_layer_attempts(path, params.gpu_layers, runtime.force_cpu);
            for gpu_layers in layers {
                let force_cpu = runtime.force_cpu || gpu_layers == 0;
                let context_size = Self::effective_context_size(params, model_size, total_ram, available_ram, force_cpu);
                let batch_size = if force_cpu || low_ram { params.batch_size.min(128).max(32) } else { params.batch_size.clamp(128, 512) };
                let flash_attention = params.flash_attention && !force_cpu;
                let mode = if force_cpu { "cpu" } else { runtime.mode };
                let label = if params.gpu_layers < 0 {
                    format!("auto {mode} runtime with {gpu_layers} GPU layers, context {context_size}, batch {batch_size}")
                } else {
                    format!("{mode} runtime with {gpu_layers} GPU layers, context {context_size}, batch {batch_size}")
                };
                plans.push(LaunchPlan { runtime: runtime.clone(), gpu_layers, context_size, batch_size, flash_attention, label });
            }
        }

        // If the machine has very little RAM relative to the model, make sure the final fallback
        // is as conservative as possible. It may still fail if hardware is insufficient, but it
        // should fail with a clear error instead of leaving a stuck server process.
        if total_ram > 0 && model_size > total_ram.saturating_mul(95).saturating_div(100) {
            if let Some(cpu_runtime) = plans.iter().find(|p| p.gpu_layers == 0).map(|p| p.runtime.clone()) {
                plans.push(LaunchPlan {
                    runtime: cpu_runtime,
                    gpu_layers: 0,
                    context_size: 1024,
                    batch_size: 64,
                    flash_attention: false,
                    label: "emergency low-memory CPU fallback with context 1024 and batch 64".to_string(),
                });
            }
        }

        let mut seen = BTreeSet::<String>::new();
        plans.retain(|p| seen.insert(format!("{}|{}|{}|{}", p.runtime.path.display(), p.gpu_layers, p.context_size, p.batch_size)));
        plans
    }


    fn chat_template_for_model(path: &str) -> Option<&'static str> {
        let name = Path::new(path)
            .file_name()
            .and_then(|v| v.to_str())
            .unwrap_or("")
            .to_lowercase();

        if name.contains("medgemma") || name.contains("gemma") { return Some("gemma"); }
        if name.contains("phi-3") || name.contains("phi3") { return Some("phi3"); }
        if name.contains("llama-3") || name.contains("llama3") || name.contains("llama-3.1") { return Some("llama3"); }
        if name.contains("mistral") { return Some("mistral-v1"); }
        None
    }

    fn build_args(&self, path: &str, params: &GenerationParams, plan: &LaunchPlan) -> Vec<String> {
        let ctx = plan.context_size.clamp(512, 32768);
        let batch = plan.batch_size.clamp(32, 2048);

        let mut args = vec![
            "-m".to_string(), path.to_string(),
            "--ctx-size".to_string(), ctx.to_string(),
            "--batch-size".to_string(), batch.to_string(),
            "--port".to_string(), self.port.to_string(),
            "--host".to_string(), "127.0.0.1".to_string(),
            "--parallel".to_string(), "1".to_string(),
            "--no-ui".to_string(),
        ];

        if params.threads > 0 {
            args.push("--threads".to_string());
            args.push(params.threads.to_string());
        }

        args.push("--gpu-layers".to_string());
        args.push(plan.gpu_layers.max(0).to_string());

        if plan.flash_attention {
            args.push("--flash-attn".to_string());
            args.push("on".to_string());
        }
        if let Some(scale) = params.rope_scaling {
            args.push("--rope-scale".to_string());
            args.push(scale.to_string());
        }

        if let Some(mmproj) = find_mmproj_for_model(path) {
            args.push("--mmproj".to_string());
            args.push(mmproj);
        }

        // Do not force llama.cpp chat templates here. PocketMind Hybrid AI builds prompts itself and
        // uses the /completion endpoint so the selected model always receives the
        // actual latest user instruction. When mmproj is loaded and images are attached,
        // generate_stream uses /v1/chat/completions instead.

        args
    }

    async fn wait_until_ready(&self) -> AppResult<()> {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(3))
            .build()
            .map_err(|e| AppError::InferenceError(format!("Failed to create health-check client: {e}")))?;

        let health_url = format!("http://127.0.0.1:{}/health", self.port);
        let models_url = format!("http://127.0.0.1:{}/v1/models", self.port);

        for _ in 0..180 {
            if let Ok(resp) = client.get(&health_url).send().await {
                if resp.status().is_success() { return Ok(()); }
            }
            if let Ok(resp) = client.get(&models_url).send().await {
                if resp.status().is_success() { return Ok(()); }
            }

            if let Ok(mut proc_lock) = self.process.try_lock() {
                if let Some(child) = proc_lock.as_mut() {
                    if let Ok(Some(status)) = child.try_wait() {
                        let detail = take_child_stdio_tail(child).await;
                        *proc_lock = None;
                        return Err(AppError::InferenceError(match detail {
                            Some(log) if !log.is_empty() => format!(
                                "llama-server exited before becoming ready. Exit status: {status}.\n\nllama-server output:\n{log}"
                            ),
                            _ => format!(
                                "llama-server exited before becoming ready. Exit status: {status}. Try CPU mode, a smaller model, context 2048, batch 128, and confirm the GGUF matches this llama.cpp build."
                            ),
                        }));
                    }
                }
            }

            tokio::time::sleep(tokio::time::Duration::from_millis(1000)).await;
        }

        Err(AppError::InferenceError(
            "llama-server started but did not become ready within 180 seconds. Try a smaller model first, set GPU layers to 0, context to 2048, batch to 128, and confirm the GGUF is supported by your llama.cpp build.".to_string()
        ))
    }
}

/// Capture a short tail of llama-server stderr/stdout after a failed spawn.
async fn take_child_stdio_tail(child: &mut Child) -> Option<String> {
    use tokio::io::AsyncReadExt;
    let mut combined = String::new();
    if let Some(mut stderr) = child.stderr.take() {
        let mut buf = Vec::new();
        let _ = tokio::time::timeout(std::time::Duration::from_millis(400), stderr.read_to_end(&mut buf)).await;
        combined.push_str(&String::from_utf8_lossy(&buf));
    }
    if let Some(mut stdout) = child.stdout.take() {
        let mut buf = Vec::new();
        let _ = tokio::time::timeout(std::time::Duration::from_millis(400), stdout.read_to_end(&mut buf)).await;
        if !buf.is_empty() {
            if !combined.is_empty() {
                combined.push('\n');
            }
            combined.push_str(&String::from_utf8_lossy(&buf));
        }
    }
    let trimmed = combined.trim();
    if trimmed.is_empty() {
        None
    } else {
        // Keep the last ~2.5 KB so OOM/Vulkan lines remain visible.
        let chars: Vec<char> = trimmed.chars().collect();
        if chars.len() > 2500 {
            Some(chars[chars.len() - 2500..].iter().collect())
        } else {
            Some(trimmed.to_string())
        }
    }
}

fn drain_child_stdio(child: &mut Child) {
    use tokio::io::AsyncReadExt;
    if let Some(mut stderr) = child.stderr.take() {
        tokio::spawn(async move {
            let mut buf = [0u8; 4096];
            loop {
                match stderr.read(&mut buf).await {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {}
                }
            }
        });
    }
    if let Some(mut stdout) = child.stdout.take() {
        tokio::spawn(async move {
            let mut buf = [0u8; 4096];
            loop {
                match stdout.read(&mut buf).await {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {}
                }
            }
        });
    }
}

fn normalize_word(token: &str) -> String {
    token.trim_matches(|c: char| !c.is_alphanumeric()).to_lowercase()
}

fn collapse_repeated_word_pieces(token: &str) -> String {
    let clean: String = token.chars().filter(|c| c.is_alphabetic()).collect();
    if clean.len() < 4 { return token.to_string(); }
    let lower = clean.to_lowercase();
    for part_len in 2..=(lower.len() / 2) {
        if lower.len() % part_len == 0 {
            let part = &lower[..part_len];
            if part.repeat(lower.len() / part_len) == lower {
                return clean[..part_len].to_string();
            }
        }
    }
    token.to_string()
}

fn remove_duplicate_halves(text: &str) -> String {
    let trimmed = text.trim();
    let len = trimmed.len();
    if len < 80 { return trimmed.to_string(); }
    let half = len / 2;
    let (a, b) = trimmed.split_at(half);
    if normalize_word(a) == normalize_word(b) {
        return a.trim().to_string();
    }
    trimmed.to_string()
}

fn clean_repetition_line(line: &str) -> String {
    let mut out: Vec<String> = Vec::new();
    let mut last_norm = String::new();

    for raw in line.split_whitespace() {
        let token = collapse_repeated_word_pieces(raw);
        let norm = normalize_word(&token);
        if !norm.is_empty() && norm == last_norm {
            continue;
        }
        last_norm = norm;
        out.push(token);
    }

    out.join(" ")
}

fn clean_repetition_artifacts(input: &str) -> String {
    let mut text = input
        .lines()
        .map(clean_repetition_line)
        .collect::<Vec<_>>()
        .join("\n");
    text = remove_duplicate_halves(&text);
    text = text.replace(" .", ".").replace(" ,", ",").replace(" !", "!").replace(" ?", "?");
    text
}


fn clean_template_artifacts(input: &str) -> String {
    let mut text = input.trim().to_string();
    // Some wrong-template generations begin with synthetic dataset labels.
    for prefix in [
        ":mistral_workflow_engine:start",
        "mistral_workflow_engine:start",
        "workflow_definition:start",
        "workflow_engine:start",
    ] {
        if text.to_lowercase().starts_with(prefix) {
            text = text[prefix.len().min(text.len())..].trim_start_matches(|c: char| c == ':' || c.is_whitespace()).to_string();
        }
    }
    text
}


fn role_content(messages: &[super::ChatMessage], role: &str) -> Vec<String> {
    messages
        .iter()
        .filter(|m| m.role == role)
        .map(|m| m.content.trim().to_string())
        .filter(|c| !c.is_empty())
        .collect()
}

fn model_family_from_path(path: &Option<String>) -> &'static str {
    let name = path
        .as_deref()
        .and_then(|p| Path::new(p).file_name())
        .and_then(|v| v.to_str())
        .unwrap_or("")
        .to_lowercase();

    if name.contains("mistral") || name.contains("mixtral") { "mistral" }
    else if name.contains("llama-3") || name.contains("llama3") || name.contains("llama-3.1") { "llama3" }
    else if name.contains("phi-3") || name.contains("phi3") || name.contains("phi-4") || name.contains("phi4") { "phi" }
    else if name.contains("gemma") || name.contains("medgemma") { "gemma" }
    else { "chatml" }
}

fn plain_history(messages: &[super::ChatMessage]) -> String {
    messages
        .iter()
        .filter(|m| !m.content.trim().is_empty())
        .map(|m| {
            let role = if m.role == "assistant" { "Assistant" } else { "User" };
            format!("{}: {}", role, m.content.trim())
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn latest_user_message(messages: &[super::ChatMessage], fallback: &str) -> String {
    role_content(messages, "user")
        .last()
        .cloned()
        .unwrap_or_else(|| fallback.trim().to_string())
}

fn is_soc_system_prompt(system: &str) -> bool {
    system.contains("Nexus SOC Offline")
}

fn is_knowledge_system_prompt(system: &str) -> bool {
    system.contains("Nexus Data Knowledge Chat")
        || system.contains("Nexus Codebase Explorer")
}

fn is_code_workspace_system_prompt(system: &str) -> bool {
    system.contains("PocketMind Code Workspace")
        || system.contains("CRITICAL OUTPUT FORMAT")
}

fn build_llama3_multiturn(system: &str, messages: &[super::ChatMessage]) -> String {
    let mut out = String::from("<|begin_of_text|>");
    out.push_str(&format!(
        "<|start_header_id|>system<|end_header_id|>\n\n{}<|eot_id|>",
        system.trim()
    ));
    for m in messages {
        let role = if m.role == "assistant" { "assistant" } else { "user" };
        out.push_str(&format!(
            "<|start_header_id|>{}<|end_header_id|>\n\n{}<|eot_id|>",
            role,
            m.content.trim()
        ));
    }
    out.push_str("<|start_header_id|>assistant<|end_header_id|>\n\n");
    out
}

fn build_chatml_multiturn(system: &str, messages: &[super::ChatMessage]) -> String {
    let mut out = format!("<|im_start|>system\n{}<|im_end|>\n", system.trim());
    for m in messages {
        let role = if m.role == "assistant" { "assistant" } else { "user" };
        out.push_str(&format!(
            "<|im_start|>{}\n{}<|im_end|>\n",
            role,
            m.content.trim()
        ));
    }
    out.push_str("<|im_start|>assistant\n");
    out
}

fn build_phi_multiturn(system: &str, messages: &[super::ChatMessage]) -> String {
    let mut out = format!("<|system|>\n{}<|end|>\n", system.trim());
    for m in messages {
        if m.role == "assistant" {
            out.push_str(&format!("<|assistant|>\n{}<|end|>\n", m.content.trim()));
        } else {
            out.push_str(&format!("<|user|>\n{}<|end|>\n", m.content.trim()));
        }
    }
    out.push_str("<|assistant|>\n");
    out
}

fn build_manual_prompt(request: &GenerationRequest, system: &str) -> String {
    // Keep only recent real turns and build the prompt ourselves. This avoids a class of
    // llama-server chat-template problems where the model ignores the latest user prompt
    // and starts generating model-card or dataset boilerplate.
    let history_limit = if is_code_workspace_system_prompt(system) { 24 } else { 10 };
    let mut messages: Vec<super::ChatMessage> = if request.messages.is_empty() {
        vec![super::ChatMessage { role: "user".to_string(), content: request.prompt.trim().to_string(), ..Default::default() }]
    } else {
        request.messages
            .iter()
            .filter(|m| (m.role == "user" || m.role == "assistant") && !m.content.trim().is_empty())
            .rev()
            .take(history_limit)
            .cloned()
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect()
    };

    if messages.is_empty() {
        messages.push(super::ChatMessage { role: "user".to_string(), content: request.prompt.trim().to_string(), ..Default::default() });
    }

    // Code Workspace tool loop needs full multi-turn history in the chat template.
    if is_code_workspace_system_prompt(system) {
        return match model_family_from_path(&request.model_path) {
            "llama3" => build_llama3_multiturn(system, &messages),
            "phi" => build_phi_multiturn(system, &messages),
            "mistral" => {
                let history = plain_history(&messages);
                let latest = latest_user_message(&messages, &request.prompt);
                format!(
                    "<s>[INST] {system}\n\nConversation:\n{history}\n\nLatest:\n{latest}\n\nReply with ONLY one tool JSON object. [/INST]"
                )
            }
            "gemma" => {
                let history = plain_history(&messages);
                let latest = latest_user_message(&messages, &request.prompt);
                format!(
                    "<start_of_turn>user\n{system}\n\nConversation:\n{history}\n\nLatest:\n{latest}\n\nReply with ONLY one tool JSON object.<end_of_turn>\n<start_of_turn>model\n"
                )
            }
            _ => build_chatml_multiturn(system, &messages),
        };
    }

    let latest = latest_user_message(&messages, &request.prompt);
    let history = plain_history(&messages);
    let instruction = if is_soc_system_prompt(system) {
        format!(
            "{system}\n\nConversation:\n{history}\n\nLatest user message:\n{latest}\n\nRespond as Nexus SOC Offline. Follow any OUTPUT FORMAT numbered sections completely. Use professional Fortinet SOC analyst Markdown. Complete every requested section before stopping. Do not invent live FortiSIEM/FortiSOAR integration. Keep production response actions behind human approval."
        )
    } else if is_knowledge_system_prompt(system) {
        // Knowledge Chat sends one grounded user turn (question + retrieved snippets).
        // Do not repeat it as both Conversation history and Latest user message.
        format!(
            "{system}\n\n{latest}\n\nAnswer the question directly in plain Markdown. Do not repeat these instructions."
        )
    } else {
        format!(
            "{system}\n\nConversation:\n{history}\n\nLatest user message:\n{latest}\n\nAnswer the latest user message only."
        )
    };

    match model_family_from_path(&request.model_path) {
        "mistral" => format!("<s>[INST] {} [/INST]", instruction),
        "llama3" => format!(
            "<|begin_of_text|><|start_header_id|>system<|end_header_id|>\n\n{}<|eot_id|><|start_header_id|>user<|end_header_id|>\n\n{}<|eot_id|><|start_header_id|>assistant<|end_header_id|>\n\n",
            system, latest
        ),
        "phi" => format!("<|system|>\n{}<|end|>\n<|user|>\n{}<|end|>\n<|assistant|>\n", system, latest),
        "gemma" => format!("<start_of_turn>user\n{}\n\n{}<end_of_turn>\n<start_of_turn>model\n", system, latest),
        _ => format!("<|im_start|>system\n{}<|im_end|>\n<|im_start|>user\n{}<|im_end|>\n<|im_start|>assistant\n", system, latest),
    }
}

fn strip_unwanted_generation_prefixes(input: &str) -> String {
    let mut text = input.trim().to_string();
    let lower = text.to_lowercase();
    let bad_markers = [
        "workflow engine", "mistral workflow", "workflow_definition", "workflow_engine", "model card", "what is gemma", "gemma: the ai-powered platform", "[asy]", "graphsize=", "\\begin{tikzpicture}", "\\end{verbatim}", "\\node", "\\draw", "\\foreach", "\\begin{tabular}"
    ];
    if bad_markers.iter().any(|m| lower.contains(m)) && !lower.contains("bonjour") {
        // Do not try to rewrite a totally off-topic boilerplate answer. Surface a short
        // deterministic fallback instead of showing garbage to the user.
        text = "I’m ready. Please ask your question again, and I’ll answer it directly.".to_string();
    }
    text
}


fn clean_stream_piece(piece: &str) -> String {
    piece
        .replace("<|assistant|>", "")
        .replace("<|user|>", "")
        .replace("<|system|>", "")
        .replace("<|im_end|>", "")
        .replace("<|im_start|>", "")
        .replace("<end_of_turn>", "")
}

/// Merge one llama-server stream fragment into the assembled response and return the
/// incremental delta that should be shown to the user. Handles cumulative chunks,
/// duplicate re-sends, and partial token overlap at chunk boundaries.
fn ingest_stream_piece(full_text: &mut String, piece: &str) -> Option<String> {
    if piece.is_empty() {
        return None;
    }

    let delta = if full_text.is_empty() {
        full_text.push_str(piece);
        piece.to_string()
    } else if piece.starts_with(full_text.as_str()) {
        let suffix = piece[full_text.len()..].to_string();
        *full_text = piece.to_string();
        suffix
    } else if full_text.ends_with(piece) {
        return None;
    } else {
        let overlap = (1..=full_text.len().min(piece.len()))
            .rev()
            .find(|&len| full_text.as_bytes().ends_with(&piece.as_bytes()[..len]))
            .unwrap_or(0);
        let suffix = if overlap > 0 && overlap < piece.len() {
            piece[overlap..].to_string()
        } else {
            piece.to_string()
        };
        if suffix.is_empty() {
            return None;
        }
        full_text.push_str(&suffix);
        suffix
    };

    let cleaned = clean_stream_piece(&delta);
    if cleaned.is_empty() { None } else { Some(cleaned) }
}

fn normalize_stream_compare(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn remove_trailing_self_questions(input: &str) -> String {
    let mut text = input.trim().to_string();
    let lower = text.to_lowercase();
    for marker in [
        "can you also",
        "would you like me to",
        "let me know if you",
        "in future messages",
        "next question:",
        "question:",
        "q:",
    ] {
        if let Some(idx) = lower.find(marker) {
            if idx > 40 {
                text = text[..idx].trim_end_matches(|c: char| c.is_whitespace() || c == '-' || c == ':' || c == ',' || c == '.').to_string();
                break;
            }
        }
    }
    text
}

#[async_trait::async_trait]
impl InferenceBackend for LlamaCppBackend {
    async fn load_model(&self, path: &str, params: &GenerationParams) -> AppResult<()> {
        if path.trim().is_empty() {
            return Err(AppError::InferenceError("No local GGUF model is selected. Open Models, import/scan a .gguf file, then click Use.".to_string()));
        }
        // Strip Windows \\?\ verbatim prefix from stored paths — llama-server rejects it.
        let path_buf = {
            let raw = PathBuf::from(path.trim());
            let s = raw.to_string_lossy();
            #[cfg(target_os = "windows")]
            {
                if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
                    PathBuf::from(format!(r"\\{rest}"))
                } else if let Some(rest) = s.strip_prefix(r"\\?\") {
                    PathBuf::from(rest)
                } else {
                    raw
                }
            }
            #[cfg(not(target_os = "windows"))]
            {
                let _ = s;
                raw
            }
        };
        let path = path_buf.to_string_lossy().to_string();
        if !path_buf.is_file() {
            return Err(AppError::InferenceError(format!(
                "Selected model file was not found: {path}. Re-import the .gguf from Models (Import .gguf / Scan Folder), then click Use in Chat. If you used Stop & clear during a download, the file was removed — download again."
            )));
        }
        if is_secondary_gguf_shard(
            path_buf
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or(""),
        ) {
            return Err(AppError::InferenceError(
                "This file is a secondary GGUF shard (not 00001-of-N). Select the primary shard (*-00001-of-*.gguf) in Models — llama.cpp loads the other parts automatically from the same folder.".to_string(),
            ));
        }
        let missing_shards = missing_gguf_shard_siblings(&path_buf);
        if !missing_shards.is_empty() {
            return Err(AppError::InferenceError(format!(
                "Multi-part model is incomplete. Missing shard file(s) next to the primary GGUF: {}. Keep all parts in the same folder, then Use the *-00001-of-*.gguf file.",
                missing_shards.join(", ")
            )));
        }

        let requested_signature = Self::requested_signature(&path, params);
        {
            let loaded = self.model_loaded.lock().await;
            let loaded_path = self.loaded_model_path.lock().await;
            let loaded_signature = self.loaded_runtime_signature.lock().await;
            let process_alive = self.process.lock().await.as_mut().map(|child| child.try_wait().ok().flatten().is_none()).unwrap_or(false);
            if *loaded && process_alive && loaded_path.as_deref() == Some(path.as_str()) && loaded_signature.as_deref() == Some(requested_signature.as_str()) {
                return Ok(());
            }
        }

        let runtime_candidates = runtime_discovery::ordered_runtime_candidates(params.gpu_layers)?;
        let launch_plans = Self::build_launch_plans(&path, params, runtime_candidates);
        let mut errors = Vec::<String>::new();

        for plan in launch_plans {
            let mut proc_lock = self.process.lock().await;
            if let Some(ref mut child) = *proc_lock {
                let _ = child.kill().await;
            }
            *proc_lock = None;
            drop(proc_lock);

            let args = self.build_args(&path, params, &plan);
            let mut cmd = Command::new(&plan.runtime.path);
            cmd.args(&args).stdout(Stdio::piped()).stderr(Stdio::piped());
            if let Some(parent) = plan.runtime.path.parent() {
                cmd.current_dir(parent);
            }

            match cmd.spawn() {
                Ok(child) => {
                    // Failure paths read the pipes in wait_until_ready / take_child_stdio_tail.
                    // Once healthy we drain them so the process cannot block on a full buffer.
                    *self.process.lock().await = Some(child);
                    match self.wait_until_ready().await {
                        Ok(_) => {
                            if let Ok(mut proc_lock) = self.process.try_lock() {
                                if let Some(alive) = proc_lock.as_mut() {
                                    drain_child_stdio(alive);
                                }
                            }
                            let mut loaded = self.model_loaded.lock().await;
                            let mut loaded_path = self.loaded_model_path.lock().await;
                            let mut loaded_signature = self.loaded_runtime_signature.lock().await;
                            let mut loaded_mmproj = self.loaded_mmproj.lock().await;
                            *loaded = true;
                            *loaded_path = Some(path.clone());
                            *loaded_signature = Some(requested_signature.clone());
                            *loaded_mmproj = find_mmproj_for_model(&path);
                            // Record GPU usage so Knowledge Chat embeddings can avoid
                            // competing for the same VRAM (0 when this plan is CPU-only).
                            let active = if plan.runtime.force_cpu || plan.gpu_layers == 0 { 0 } else { plan.gpu_layers };
                            runtime_discovery::set_chat_gpu_layers_active(active);
                            return Ok(());
                        }
                        Err(e) => {
                            let mut proc_lock = self.process.lock().await;
                            if let Some(ref mut child) = *proc_lock { let _ = child.kill().await; }
                            *proc_lock = None;
                            errors.push(format!("{} failed to become ready: {}", plan.label, e));
                        }
                    }
                }
                Err(e) => {
                    errors.push(format!("{} could not start: {}", plan.label, e));
                }
            }
        }

        Err(AppError::InferenceError(format!(
            "PocketMind Hybrid AI could not start the selected model after automatic GPU/CPU fallback. It tried full GPU offload first when Auto mode was enabled, then reduced GPU layers, then CPU fallback. The model may require more combined RAM/VRAM, a smaller quantization, or a matching llama.cpp runtime (CUDA/Vulkan on Windows/Linux or Metal on macOS). Details:\n{}",
            errors.join("\n")
        )))
    }

    async fn generate_stream(&self, request: GenerationRequest, tx: mpsc::Sender<GenerationChunk>) -> AppResult<()> {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(600))
            .build()
            .map_err(|e| AppError::InferenceError(format!("Failed to create generation client: {e}")))?;

        let base_system = "You are PocketMind Hybrid AI. Answer the latest user message directly and briefly. Use plain Markdown. Do not invent follow-ups or repeat yourself.";
        let system = match &request.system_prompt {
            Some(sys) if !sys.trim().is_empty()
                && (is_soc_system_prompt(sys) || is_knowledge_system_prompt(sys) || is_code_workspace_system_prompt(sys)) =>
            {
                sys.trim().to_string()
            }
            Some(sys) if !sys.trim().is_empty() => format!("{}\n\n{}", base_system, sys.trim()),
            _ => base_system.to_string(),
        };

        let mmproj_ready = self.loaded_mmproj.lock().await.is_some();
        let use_multimodal = mmproj_ready && !request.images.is_empty();

        let temperature = request.params.temperature.clamp(0.05, 0.75);
        let top_p = request.params.top_p.clamp(0.10, 0.85);
        let repeat_penalty = request.params.repetition_penalty.clamp(1.18, 1.60);
        let max_tokens = if is_soc_system_prompt(&system) {
            request.params.max_tokens.clamp(256, 1536)
        } else {
            request.params.max_tokens.clamp(32, 1024)
        };

        let (url, body) = if use_multimodal {
            let mut messages = vec![serde_json::json!({"role": "system", "content": system})];
            let user_text = if request.messages.is_empty() {
                request.prompt.trim().to_string()
            } else {
                request
                    .messages
                    .iter()
                    .rev()
                    .find(|m| m.role == "user")
                    .map(|m| m.content.trim().to_string())
                    .unwrap_or_else(|| request.prompt.trim().to_string())
            };
            let mut parts: Vec<Value> = Vec::new();
            if !user_text.is_empty() {
                parts.push(serde_json::json!({"type": "text", "text": user_text}));
            }
            for img in &request.images {
                let mime = if img.mime.trim().is_empty() { "image/png" } else { img.mime.trim() };
                let url = format!("data:{mime};base64,{}", img.base64.trim());
                parts.push(serde_json::json!({
                    "type": "image_url",
                    "image_url": { "url": url }
                }));
            }
            messages.push(serde_json::json!({"role": "user", "content": parts}));
            (
                format!("http://127.0.0.1:{}/v1/chat/completions", self.port),
                serde_json::json!({
                    "messages": messages,
                    "stream": true,
                    "temperature": temperature,
                    "top_p": top_p,
                    "max_tokens": max_tokens,
                }),
            )
        } else {
            let mut messages = vec![serde_json::json!({"role": "system", "content": system})];
            if request.messages.is_empty() {
                messages.push(serde_json::json!({"role": "user", "content": request.prompt.trim()}));
            } else {
                for m in request.messages.iter().take(24) {
                    let role = match m.role.as_str() {
                        "assistant" => "assistant",
                        "system" => "system",
                        _ => "user",
                    };
                    let content = m.content.trim();
                    if !content.is_empty() {
                        messages.push(serde_json::json!({"role": role, "content": content}));
                    }
                }
            }
            let _ = messages;
            let prompt = build_manual_prompt(&request, &system);
            (
                format!("http://127.0.0.1:{}/completion", self.port),
                serde_json::json!({
                    "prompt": prompt,
                    "stream": true,
                    "temperature": temperature,
                    "top_k": request.params.top_k,
                    "top_p": top_p,
                    "min_p": 0.08,
                    "repeat_penalty": repeat_penalty,
                    "repeat_last_n": 512,
                    "frequency_penalty": 0.45,
                    "presence_penalty": 0.0,
                    "n_predict": max_tokens,
                    "cache_prompt": false,
                    "stop": [
                        "<end_of_turn>", "</s>", "<|eot_id|>", "<|end|>", "<|im_end|>",
                        "[INST]", "[/INST]", "\nUser:", "\nuser:", "\nLatest user message:",
                        "\nQuestion:", "\nQ:", "Can you also", "Would you like me to", "Let me know if you",
                        "[asy]", "graphsize=", "\\begin{tikzpicture}", "\\end{verbatim}",
                        "\\node", "\\draw", "\\foreach", "\\begin{tabular}"
                    ]
                }),
            )
        };
        let response = client
            .post(&url)
            .json(&body)
            .send()
            .await
            .map_err(|e| AppError::InferenceError(format!("Local llama-server is unreachable: {e}")))?;

        if !response.status().is_success() {
            let status = response.status();
            let text = response.text().await.unwrap_or_default();
            return Err(AppError::InferenceError(format!("llama-server rejected the request ({status}): {text}")));
        }

        let mut stream = response.bytes_stream();
        let mut pending = String::new();
        let mut full_text = String::new();
        let mut tokens_generated: u32 = 0;

        while let Some(chunk) = stream.next().await {
            let bytes = chunk.map_err(|e| AppError::InferenceError(format!("Streaming from llama-server failed: {e}")))?;
            pending.push_str(&String::from_utf8_lossy(&bytes));

            while let Some(pos) = pending.find('\n') {
                let line = pending[..pos].trim().to_string();
                pending = pending[pos + 1..].to_string();
                if line.is_empty() { continue; }

                let data = line.strip_prefix("data:").unwrap_or(&line).trim();
                if data == "[DONE]" { continue; }

                let Ok(json) = serde_json::from_str::<Value>(data) else { continue; };
                let piece = json
                    .get("content")
                    .and_then(|v| v.as_str())
                    .or_else(|| json.get("response").and_then(|v| v.as_str()))
                    .or_else(|| json
                        .get("choices")
                        .and_then(|c| c.get(0))
                        .and_then(|c| c.get("delta"))
                        .and_then(|d| d.get("content"))
                        .and_then(|v| v.as_str()))
                    .or_else(|| json
                        .get("choices")
                        .and_then(|c| c.get(0))
                        .and_then(|c| c.get("text"))
                        .and_then(|v| v.as_str()))
                    .unwrap_or("");

                if let Some(cleaned_piece) = ingest_stream_piece(&mut full_text, piece) {
                    tokens_generated = tokens_generated.saturating_add(1);
                    let _ = tx.send(GenerationChunk {
                        text: cleaned_piece,
                        finish_reason: None,
                        tokens_generated: 1,
                        tokens_per_sec: 0.0,
                        tool_calls: None,
                    reasoning: None,
}).await;
                }
            }
        }

        if !pending.trim().is_empty() {
            let data = pending.trim().strip_prefix("data:").unwrap_or(pending.trim()).trim();
            if let Ok(json) = serde_json::from_str::<Value>(data) {
                if let Some(piece) = json.get("content").and_then(|v| v.as_str()).or_else(|| json.get("response").and_then(|v| v.as_str())) {
                    if let Some(cleaned_piece) = ingest_stream_piece(&mut full_text, piece) {
                        tokens_generated = tokens_generated.saturating_add(1);
                        let _ = tx.send(GenerationChunk { text: cleaned_piece, finish_reason: None, tokens_generated: 1, tokens_per_sec: 0.0, tool_calls: None,
                    reasoning: None,
}).await;
                    }
                }
            }
        }

        let mut final_text = clean_repetition_artifacts(&full_text);
        final_text = clean_template_artifacts(&final_text);
        final_text = strip_unwanted_generation_prefixes(&final_text);
        final_text = remove_trailing_self_questions(&final_text);

        if final_text.trim().is_empty() {
            let _ = tx.send(GenerationChunk {
                text: "[The selected model returned an empty response. Try a shorter prompt, lower creativity, or run Model Health Check.]".to_string(),
                finish_reason: Some("stop".to_string()),
                tokens_generated,
                tokens_per_sec: 0.0,
                tool_calls: None,
                    reasoning: None,
}).await;
        } else if normalize_stream_compare(&final_text) != normalize_stream_compare(&full_text) {
            let _ = tx.send(GenerationChunk {
                text: final_text,
                finish_reason: Some("stop".to_string()),
                tokens_generated,
                tokens_per_sec: 0.0,
                tool_calls: None,
                    reasoning: None,
}).await;
        } else {
            let _ = tx.send(GenerationChunk {
                text: "".to_string(),
                finish_reason: Some("stop".to_string()),
                tokens_generated,
                tokens_per_sec: 0.0,
                tool_calls: None,
                    reasoning: None,
}).await;
        }

        Ok(())
    }

    async fn unload_model(&self) -> AppResult<()> {
        let mut proc_lock = self.process.lock().await;
        if let Some(ref mut child) = *proc_lock {
            let _ = child.kill().await;
        }
        *proc_lock = None;
        let mut loaded = self.model_loaded.lock().await;
        let mut loaded_path = self.loaded_model_path.lock().await;
        let mut loaded_signature = self.loaded_runtime_signature.lock().await;
        *loaded = false;
        *loaded_path = None;
        *loaded_signature = None;
        *self.loaded_mmproj.lock().await = None;
        runtime_discovery::set_chat_gpu_layers_active(0);
        Ok(())
    }

    fn is_loaded(&self) -> bool {
        self.model_loaded.try_lock().map(|v| *v).unwrap_or(false)
    }

    fn backend_name(&self) -> &'static str { "llama.cpp" }

    fn estimate_tokens_per_sec(&self, params_b: u32, quant: &str, hardware: &crate::hardware::SystemInfo) -> f32 {
        let has_gpu = hardware.gpus.iter().any(|g| g.is_cuda_capable || g.is_metal_capable || g.is_vulkan_capable);
        let base = match params_b {
            0..=3 => if has_gpu { 80.0 } else { 20.0 },
            4..=8 => if has_gpu { 45.0 } else { 8.0 },
            9..=14 => if has_gpu { 25.0 } else { 5.0 },
            15..=30 => if has_gpu { 15.0 } else { 2.5 },
            31..=70 => if has_gpu { 8.0 } else { 1.0 },
            _ => if has_gpu { 3.0 } else { 0.5 },
        };

        let q_factor = match quant {
            "Q2_K" => 1.3,
            "Q3_K" => 1.15,
            "Q4_K" | "Q4_0" | "Q4_K_M" => 1.0,
            "Q5_K" | "Q5_0" => 0.9,
            "Q6_K" => 0.8,
            "Q8_0" => 0.7,
            _ => 1.0,
        };

        let ram_gb = hardware.memory.total_bytes as f32 / 1e9;
        let ram_factor = if ram_gb < 8.0 { 0.6 } else if ram_gb < 16.0 { 0.85 } else { 1.0 };

        base * q_factor * ram_factor
    }
}
