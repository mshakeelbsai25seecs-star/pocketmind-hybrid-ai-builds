//! Shared llama-server runtime discovery and GPU/CPU offload policy.
//!
//! This module is the single source of truth for:
//! - finding `llama-server` binaries across the supported folder layouts,
//! - ordering candidates with the same NVIDIA/Vulkan/CPU priority for chat,
//!   Knowledge Chat embeddings, and diagnostics, and
//! - estimating how many model layers can be offloaded to the GPU.
//!
//! Chat inference ([`crate::llm::local`]), Knowledge Chat embeddings
//! ([`crate::knowledge_chat::embeddings`]), and runtime diagnostics
//! ([`crate::commands`]) all build on these helpers so device selection behaves
//! identically everywhere.

use std::collections::BTreeSet;
use std::env;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicI32, Ordering};

use crate::error::{AppError, AppResult};
use crate::hardware::HardwareMonitor;

/// GPU layers the chat backend is currently using (0 = none / CPU). Set by
/// [`crate::llm::local`] on successful model load and cleared on unload. Read by
/// the Knowledge Chat embedding pool to avoid fighting chat for the same VRAM.
static CHAT_GPU_LAYERS_ACTIVE: AtomicI32 = AtomicI32::new(0);

/// Desired `--gpu-layers` for Knowledge Chat embedding servers, mirroring
/// `deploy.gpu_layers`. `-1` means auto (full offload first, then fall back).
/// `i32::MIN` is the "unset" sentinel so we can default to auto until the
/// deployment config has been loaded at least once.
static EMBED_GPU_LAYERS: AtomicI32 = AtomicI32::new(i32::MIN);

pub fn set_chat_gpu_layers_active(layers: i32) {
    CHAT_GPU_LAYERS_ACTIVE.store(layers, Ordering::Relaxed);
}

pub fn chat_gpu_layers_active() -> i32 {
    CHAT_GPU_LAYERS_ACTIVE.load(Ordering::Relaxed)
}

/// True when chat is actively holding GPU layers, so embeddings should be
/// conservative about additional GPU offload.
pub fn chat_holds_gpu() -> bool {
    chat_gpu_layers_active() > 0
}

/// Record the deployment's desired embedding GPU-layer policy (from
/// `deploy.gpu_layers`). Called whenever the deployment config is loaded.
pub fn set_embed_gpu_layers(layers: i32) {
    EMBED_GPU_LAYERS.store(layers, Ordering::Relaxed);
}

/// Resolve the embedding GPU-layer policy, defaulting to auto (`-1`) until a
/// deployment config has been loaded.
pub fn embed_gpu_layers() -> i32 {
    let value = EMBED_GPU_LAYERS.load(Ordering::Relaxed);
    if value == i32::MIN { -1 } else { value }
}

/// A discovered llama-server runtime and how it should be used.
#[derive(Debug, Clone)]
pub struct RuntimeCandidate {
    pub path: PathBuf,
    /// `cuda` | `vulkan` | `metal` | `cpu` | `auto` | `path` | `explicit`.
    pub mode: &'static str,
    pub label: String,
    /// When true, this runtime must be launched with `--gpu-layers 0`.
    pub force_cpu: bool,
}

impl RuntimeCandidate {
    pub fn new(path: PathBuf, mode: &'static str, force_cpu: bool) -> Self {
        let label = format!("{} runtime ({})", mode.to_uppercase(), path.display());
        Self { path, mode, label, force_cpu }
    }
}

pub fn binary_name() -> &'static str {
    if cfg!(target_os = "windows") { "llama-server.exe" } else { "llama-server" }
}

fn macos_arch_tag() -> &'static str {
    if cfg!(target_arch = "aarch64") { "arm64" }
    else if cfg!(target_arch = "x86_64") { "x64" }
    else { "unknown" }
}

fn is_native_macos_runtime(path: &Path) -> bool {
    if !cfg!(target_os = "macos") { return true; }
    let lower = path.display().to_string().to_lowercase();
    let arch = macos_arch_tag();
    if lower.contains("/macos-arm64-") || lower.contains("\\macos-arm64-") { return arch == "arm64"; }
    if lower.contains("/macos-x64-") || lower.contains("\\macos-x64-") { return arch == "x64"; }
    true
}

pub fn candidate_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();

    if let Ok(dir) = env::current_dir() {
        let mut cur = Some(dir.as_path());
        while let Some(p) = cur {
            roots.push(p.to_path_buf());
            cur = p.parent();
        }
    }

    if let Ok(exe) = env::current_exe() {
        if let Some(parent) = exe.parent() {
            let mut cur = Some(parent);
            while let Some(p) = cur {
                roots.push(p.to_path_buf());
                cur = p.parent();
            }
        }
    }

    roots.sort();
    roots.dedup();
    roots
}

/// True when an NVIDIA driver is present (so CUDA runtimes should be preferred).
pub fn has_nvidia_driver() -> bool {
    std::process::Command::new("nvidia-smi")
        .arg("-L")
        .output()
        .map(|out| out.status.success())
        .unwrap_or(false)
}

fn runtime_candidates_for_root(root: &Path, binary: &str) -> Vec<RuntimeCandidate> {
    let base_dirs = [
        root.join("bin").join("llama.cpp"),
        root.join("resources").join("llama.cpp"),
        root.join("Resources").join("llama.cpp"),
        root.join("llama.cpp"),
        root.to_path_buf(),
    ];

    let mut out = Vec::new();
    for base in base_dirs {
        let mac_arch = macos_arch_tag();
        let cuda = base.join("cuda").join(binary);
        let vulkan = base.join("vulkan").join(binary);
        let metal = base.join("metal").join(binary);
        let macos_arch_metal = base.join(format!("macos-{mac_arch}-metal")).join(binary);
        let macos_arch_cpu = base.join(format!("macos-{mac_arch}-cpu")).join(binary);
        let macos_metal = base.join("macos-metal").join(binary);
        let macos_cpu = base.join("macos-cpu").join(binary);
        let cpu = base.join("cpu").join(binary);
        let generic = base.join(binary);
        let named_cuda = base.join(if cfg!(target_os = "windows") { "llama-server-cuda.exe" } else { "llama-server-cuda" });
        let named_vulkan = base.join(if cfg!(target_os = "windows") { "llama-server-vulkan.exe" } else { "llama-server-vulkan" });
        let named_metal = base.join(if cfg!(target_os = "windows") { "llama-server-metal.exe" } else { "llama-server-metal" });
        let named_cpu = base.join(if cfg!(target_os = "windows") { "llama-server-cpu.exe" } else { "llama-server-cpu" });

        for (path, mode, force_cpu) in [
            (cuda, "cuda", false),
            (vulkan, "vulkan", false),
            (metal, "metal", false),
            (macos_arch_metal, "metal", false),
            (macos_metal, "metal", false),
            (cpu, "cpu", true),
            (macos_arch_cpu, "cpu", true),
            (macos_cpu, "cpu", true),
            (named_cuda, "cuda", false),
            (named_vulkan, "vulkan", false),
            (named_metal, "metal", false),
            (named_cpu, "cpu", true),
            (generic, "auto", false),
        ] {
            if path.is_file() { out.push(RuntimeCandidate::new(path, mode, force_cpu)); }
        }
    }
    out
}

/// Enumerate every llama-server runtime available on this machine, honoring the
/// `NEXUS_LLAMA_SERVER` / `LLAMA_SERVER_PATH` overrides and the system `PATH`.
///
/// When `gpu_layers == 0` the explicit/PATH candidates are flagged `force_cpu`.
pub fn all_runtime_candidates(gpu_layers: i32) -> Vec<RuntimeCandidate> {
    let binary = binary_name();

    for key in ["NEXUS_LLAMA_SERVER", "LLAMA_SERVER_PATH"] {
        if let Ok(value) = env::var(key) {
            let path = PathBuf::from(value.trim_matches('"'));
            if path.is_file() {
                return vec![RuntimeCandidate::new(path, "explicit", gpu_layers == 0)];
            }
        }
    }

    let mut all = Vec::<RuntimeCandidate>::new();
    for root in candidate_roots() {
        all.extend(runtime_candidates_for_root(&root, binary));
    }

    if let Some(paths) = env::var_os("PATH") {
        for dir in env::split_paths(&paths) {
            let candidate = dir.join(binary);
            if candidate.is_file() { all.push(RuntimeCandidate::new(candidate, "path", gpu_layers == 0)); }
        }
    }

    all.sort_by(|a, b| a.path.cmp(&b.path));
    all.dedup_by(|a, b| a.path == b.path);
    if cfg!(target_os = "macos") {
        all.retain(|c| is_native_macos_runtime(&c.path));
    }
    all
}

/// Order discovered runtimes by the platform-aware device priority used for chat.
pub fn ordered_runtime_candidates(gpu_layers: i32) -> AppResult<Vec<RuntimeCandidate>> {
    let all = all_runtime_candidates(gpu_layers);
    if all.is_empty() {
        return Err(AppError::InferenceError(missing_runtime_message()));
    }

    let nvidia_ok = has_nvidia_driver();
    let wants_gpu = gpu_layers != 0;
    let mut ordered = Vec::<RuntimeCandidate>::new();

    if wants_gpu {
        if cfg!(target_os = "macos") {
            ordered.extend(all.iter().filter(|c| c.mode == "metal").cloned());
        } else if nvidia_ok {
            ordered.extend(all.iter().filter(|c| c.mode == "cuda").cloned());
        }
        ordered.extend(all.iter().filter(|c| c.mode == "vulkan").cloned());
        if !cfg!(target_os = "macos") && !nvidia_ok {
            ordered.extend(all.iter().filter(|c| c.mode == "cuda").cloned());
        }
        ordered.extend(all.iter().filter(|c| c.mode == "auto" || c.mode == "path" || c.mode == "explicit").cloned());
        ordered.extend(all.iter().filter(|c| c.mode == "cpu").map(|c| { let mut x = c.clone(); x.force_cpu = true; x }));
    } else {
        ordered.extend(all.iter().filter(|c| c.mode == "cpu").map(|c| { let mut x = c.clone(); x.force_cpu = true; x }));
        ordered.extend(all.iter().filter(|c| c.mode == "auto" || c.mode == "path" || c.mode == "explicit").map(|c| { let mut x = c.clone(); x.force_cpu = true; x }));
        ordered.extend(all.iter().filter(|c| c.mode == "metal" || c.mode == "vulkan" || c.mode == "cuda").map(|c| { let mut x = c.clone(); x.force_cpu = true; x }));
    }

    ordered.dedup_by(|a, b| a.path == b.path && a.force_cpu == b.force_cpu);
    Ok(ordered)
}

/// Resolve the single best llama-server binary for the requested offload policy.
pub fn resolve_llama_server_binary(gpu_layers: i32) -> AppResult<PathBuf> {
    let ordered = ordered_runtime_candidates(gpu_layers)?;
    ordered
        .into_iter()
        .next()
        .map(|c| c.path)
        .ok_or_else(|| AppError::InferenceError(missing_runtime_message()))
}

fn missing_runtime_message() -> String {
    let binary = binary_name();
    format!(
        "{binary} was not found. NexusAI supports a universal runtime layout:\n\n\
Windows:\n\
bin\\llama.cpp\\cpu\\{binary}       CPU fallback runtime\n\
bin\\llama.cpp\\cuda\\{binary}      NVIDIA CUDA runtime\n\
bin\\llama.cpp\\vulkan\\{binary}    AMD/Intel/NVIDIA Vulkan runtime\n\n\
macOS:\n\
bin/llama.cpp/macos-arm64-metal/{binary}  Apple Silicon Metal runtime\n\
bin/llama.cpp/macos-arm64-cpu/{binary}    Apple Silicon CPU fallback\n\n\
You can also place a single {binary} in bin/llama.cpp for auto mode, or set NEXUS_LLAMA_SERVER."
    )
}

// ---------------------------------------------------------------------------
// GPU offload estimation (shared by chat and Knowledge Chat embeddings)
// ---------------------------------------------------------------------------

pub fn model_size_bytes(path: &str) -> u64 {
    std::fs::metadata(path).map(|m| m.len()).unwrap_or(0)
}

/// Returns (total_ram, available_ram, free_vram, gpu_count).
pub fn hardware_memory_snapshot() -> (u64, u64, u64, usize) {
    let mut monitor = HardwareMonitor::new();
    let info = monitor.get_system_info();
    let total_ram = info.memory.total_bytes;
    let available_ram = info.memory.available_bytes;
    let mut total_vram = 0u64;
    let mut used_vram = 0u64;
    let mut gpu_count = 0usize;

    for gpu in info.gpus.iter() {
        if gpu.vram_total_bytes > 0 {
            total_vram = total_vram.saturating_add(gpu.vram_total_bytes);
            used_vram = used_vram.saturating_add(gpu.vram_used_bytes.min(gpu.vram_total_bytes));
            gpu_count += 1;
        }
    }

    (total_ram, available_ram, total_vram.saturating_sub(used_vram), gpu_count)
}

pub fn estimate_layer_count(model_size_bytes: u64) -> i32 {
    let gb = model_size_bytes as f64 / 1_073_741_824.0;
    if gb <= 3.0 { 32 }
    else if gb <= 6.0 { 40 }
    else if gb <= 12.0 { 48 }
    else if gb <= 24.0 { 64 }
    else if gb <= 42.0 { 80 }
    else if gb <= 70.0 { 96 }
    else if gb <= 110.0 { 120 }
    else { 160 }
}

/// Estimate how many layers fit in free VRAM, keeping a safety reserve.
/// Returns 999 when the whole model fits (full offload), 0 when nothing fits.
pub fn estimate_partial_gpu_layers(model_size_bytes: u64, free_vram_bytes: u64) -> i32 {
    if model_size_bytes == 0 || free_vram_bytes == 0 { return 0; }

    let two_gb = 2u64 * 1024 * 1024 * 1024;
    let usable = if free_vram_bytes > two_gb {
        free_vram_bytes.saturating_sub(two_gb)
    } else {
        ((free_vram_bytes as f64) * 0.75) as u64
    };

    if usable >= ((model_size_bytes as f64) * 1.15) as u64 {
        return 999;
    }

    let total_layers = estimate_layer_count(model_size_bytes);
    let ratio = (usable as f64 / model_size_bytes as f64).clamp(0.0, 0.95);
    ((total_layers as f64 * ratio * 0.92).floor() as i32).clamp(0, total_layers.saturating_sub(1))
}

pub fn unique_descending_layers(values: Vec<i32>) -> Vec<i32> {
    let mut set = BTreeSet::<i32>::new();
    for value in values {
        if value >= 0 { set.insert(value); }
    }
    let mut out: Vec<i32> = set.into_iter().collect();
    out.sort_by(|a, b| b.cmp(a));
    out
}

/// Ordered list of `--gpu-layers` values to attempt for a model, from most GPU
/// to CPU-only. `force_cpu` or `requested_gpu_layers == 0` yields `[0]`.
pub fn gpu_layer_attempts(model_path: &str, requested_gpu_layers: i32, force_cpu: bool) -> Vec<i32> {
    if force_cpu || requested_gpu_layers == 0 {
        return vec![0];
    }

    let model_size = model_size_bytes(model_path);
    let (_, _, free_vram, _) = hardware_memory_snapshot();
    let partial = estimate_partial_gpu_layers(model_size, free_vram);

    if requested_gpu_layers > 0 {
        return unique_descending_layers(vec![
            requested_gpu_layers,
            partial,
            ((partial as f32) * 0.75) as i32,
            96, 80, 64, 48, 40, 32, 24, 16, 8, 0,
        ]);
    }

    unique_descending_layers(vec![
        999,
        partial,
        ((partial as f32) * 0.85) as i32,
        ((partial as f32) * 0.65) as i32,
        120, 96, 80, 64, 48, 40, 32, 24, 16, 8, 0,
    ])
}
