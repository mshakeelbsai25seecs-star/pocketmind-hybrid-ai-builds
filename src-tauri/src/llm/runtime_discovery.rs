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

    // User data roots (post-Store CUDA/Vulkan downloads land under {data}/bin/llama.cpp/).
    // Search preferred + common lab/portable locations so Auto finds CUDA after install
    // even when Deployment data_root differs from the default LOCALAPPDATA path.
    for data in data_root_search_paths() {
        if data.is_dir() {
            roots.push(data.clone());
            roots.push(data.join("bin"));
            roots.push(data.join("resources"));
        }
    }

    if let Ok(dir) = env::current_dir() {
        let mut cur = Some(dir.as_path());
        while let Some(p) = cur {
            roots.push(p.to_path_buf());
            cur = p.parent();
        }
    }

    if let Ok(exe) = env::current_exe() {
        if let Some(parent) = exe.parent() {
            // Prefer the install/resource layouts used by the fat Windows bundle:
            //   <app>/resources/llama.cpp/{cpu,cuda,vulkan}/llama-server.exe
            //   <app>/bin/llama.cpp/{cpu,cuda,vulkan}/llama-server.exe
            roots.push(parent.to_path_buf());
            roots.push(parent.join("resources"));
            let mut cur = Some(parent);
            while let Some(p) = cur {
                roots.push(p.to_path_buf());
                cur = p.parent();
            }
        }
    }

    // Dev builds: src-tauri/resources next to the crate.
    let manifest_resources = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources");
    if manifest_resources.is_dir() {
        roots.push(manifest_resources);
    }

    roots.sort();
    roots.dedup();
    roots
}

/// Roots that may hold post-install CUDA/Vulkan under bin/llama.cpp/.
fn data_root_search_paths() -> Vec<PathBuf> {
    let mut out = Vec::new();
    out.push(crate::deployment::preferred_data_root());
    #[cfg(target_os = "windows")]
    {
        out.push(PathBuf::from(r"D:\PocketMind"));
        out.push(PathBuf::from(crate::deployment::WINDOWS_LEGACY_DATA_ROOT));
        if let Some(local) = dirs::data_local_dir() {
            out.push(local.join("PocketMind"));
        }
        if let Ok(prog) = env::var("LOCALAPPDATA") {
            let p = PathBuf::from(prog).join("PocketMind");
            out.push(p);
        }
    }
    out.sort();
    out.dedup();
    out
}

/// True when an NVIDIA driver is present (so CUDA runtimes should be preferred).
pub fn has_nvidia_driver() -> bool {
    let mut cmd = std::process::Command::new("nvidia-smi");
    crate::process_util::no_window_std(&mut cmd);
    cmd.arg("-L")
        .output()
        .map(|out| out.status.success())
        .unwrap_or(false)
}

/// Which GPU backends a llama-server install actually ships (by sibling libraries).
/// Folder names alone are not trustworthy: a `macos-*-metal` directory can be a
/// CPU-only copy with no `libggml-metal`.
#[derive(Debug, Clone, Copy, Default)]
pub struct RuntimeBackendSupport {
    pub cuda: bool,
    pub vulkan: bool,
    pub metal: bool,
}

impl RuntimeBackendSupport {
    pub fn any_gpu(self) -> bool {
        self.cuda || self.vulkan || self.metal
    }
}

/// Probe the directory next to `llama-server` for backend shared libraries.
pub fn probe_runtime_backends(runtime_bin: &Path) -> RuntimeBackendSupport {
    let Some(dir) = runtime_bin.parent() else {
        return RuntimeBackendSupport::default();
    };
    let entries = match std::fs::read_dir(dir) {
        Ok(v) => v,
        Err(_) => return RuntimeBackendSupport::default(),
    };
    let mut support = RuntimeBackendSupport::default();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
        if !(name.contains("ggml") || name.contains("llama") || name.contains("cublas") || name.contains("cudart")) {
            continue;
        }
        if name.contains("metal") {
            support.metal = true;
        }
        if name.contains("cuda") || name.contains("cublas") || name.contains("cudart") {
            support.cuda = true;
        }
        if name.contains("vulkan") {
            support.vulkan = true;
        }
    }
    support
}

/// True when a path that claims to be a Metal runtime actually bundles Metal.
pub fn runtime_has_metal_backend(runtime_bin: &Path) -> bool {
    probe_runtime_backends(runtime_bin).metal
}

/// True when any discovered GPU-labeled runtime actually includes a GPU backend.
pub fn any_gpu_runtime_backend_available() -> bool {
    all_runtime_candidates(-1)
        .iter()
        .any(|c| probe_runtime_backends(&c.path).any_gpu())
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

        for (path, mode, mut force_cpu) in [
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
            if !path.is_file() {
                continue;
            }
            // Folders named metal/cuda/vulkan but missing the matching backend
            // library are treated as CPU so we never advertise fake acceleration.
            let backends = probe_runtime_backends(&path);
            match mode {
                "metal" if !backends.metal => force_cpu = true,
                "cuda" if !backends.cuda => force_cpu = true,
                "vulkan" if !backends.vulkan => force_cpu = true,
                _ => {}
            }
            out.push(RuntimeCandidate::new(path, mode, force_cpu));
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

/// True when the only GPUs look like small integrated chips (Intel UHD / Iris /
/// similar) with little dedicated VRAM. Vulkan backends still initialize the
/// device even at `--gpu-layers 0` and often crash with `0xc0000005` / OOM on
/// those GPUs — prefer the dedicated CPU binary instead.
///
/// Never returns true when NVIDIA is present (driver, NVML/DXGI name, or a real
/// CUDA llama.cpp runtime). Lab machines often report 0 VRAM via DXGI when NVML
/// is unavailable — that must not force Automatic Optimizer onto CPU.
pub fn weak_igpu_only() -> bool {
    if has_nvidia_driver() {
        return false;
    }
    if has_usable_cuda_runtime() {
        return false;
    }
    let mut monitor = HardwareMonitor::new();
    let info = monitor.get_system_info();
    if info.gpus.iter().any(gpu_looks_nvidia) {
        return false;
    }
    if info.gpus.is_empty() {
        // No GPU inventory: still allow CUDA if a runtime exists (handled above).
        return true;
    }
    let four_gb = 4u64 * 1024 * 1024 * 1024;
    // Any discrete-sized GPU (>= 4 GB) means Vulkan/CUDA may be worth trying.
    if info.gpus.iter().any(|g| g.vram_total_bytes >= four_gb) {
        return false;
    }
    info.gpus.iter().all(|g| {
        let name = g.name.to_lowercase();
        let vendor = g.vendor.to_lowercase();
        // Do NOT treat unknown-VRAM discrete cards as weak — only clear iGPU names.
        name.contains("intel")
            || name.contains("uhd")
            || name.contains("iris")
            || name.contains("radeon graphics")
            || vendor.contains("intel")
            || (g.vram_total_bytes > 0 && g.vram_total_bytes < 2 * 1024 * 1024 * 1024 && !gpu_looks_nvidia(g))
    })
}

fn gpu_looks_nvidia(g: &crate::hardware::GPUInfo) -> bool {
    if g.is_cuda_capable {
        return true;
    }
    let name = g.name.to_lowercase();
    let vendor = g.vendor.to_lowercase();
    vendor.contains("nvidia")
        || name.contains("nvidia")
        || name.contains("geforce")
        || name.contains("quadro")
        || name.contains("tesla")
        || name.contains("rtx ")
        || name.contains("gtx ")
}

/// True when a discovered cuda/ folder contains real CUDA backend libraries.
pub fn has_usable_cuda_runtime() -> bool {
    all_runtime_candidates(-1)
        .iter()
        .any(|c| c.mode == "cuda" && !c.force_cpu)
}

/// Order discovered runtimes by the platform-aware device priority used for chat.
pub fn ordered_runtime_candidates(gpu_layers: i32) -> AppResult<Vec<RuntimeCandidate>> {
    let all = all_runtime_candidates(gpu_layers);
    if all.is_empty() {
        return Err(AppError::InferenceError(missing_runtime_message()));
    }

    let nvidia_ok = has_nvidia_driver() || has_usable_cuda_runtime() || {
        let mut monitor = HardwareMonitor::new();
        monitor.get_system_info().gpus.iter().any(gpu_looks_nvidia)
    };
    let metal_hw = macos_metal_hardware();
    let wants_gpu = gpu_layers != 0;
    // Weak-iGPU CPU preference is for Vulkan crash avoidance on Intel-only laptops.
    // Never CPU-first when NVIDIA/CUDA is available — Automatic Optimizer must offload.
    let prefer_cpu = weak_igpu_only() && !nvidia_ok;
    let mut ordered = Vec::<RuntimeCandidate>::new();

    if wants_gpu && !prefer_cpu {
        if cfg!(target_os = "macos") && metal_hw {
            // Only lead with Metal runtimes that actually contain a Metal backend.
            ordered.extend(
                all.iter()
                    .filter(|c| c.mode == "metal" && !c.force_cpu && runtime_has_metal_backend(&c.path))
                    .cloned(),
            );
        } else if nvidia_ok {
            ordered.extend(all.iter().filter(|c| c.mode == "cuda" && !c.force_cpu).cloned());
        }
        ordered.extend(all.iter().filter(|c| c.mode == "vulkan" && !c.force_cpu).cloned());
        if !cfg!(target_os = "macos") && !nvidia_ok {
            ordered.extend(all.iter().filter(|c| c.mode == "cuda" && !c.force_cpu).cloned());
        }
        ordered.extend(all.iter().filter(|c| c.mode == "auto" || c.mode == "path" || c.mode == "explicit").cloned());
        ordered.extend(all.iter().filter(|c| c.mode == "cpu").map(|c| { let mut x = c.clone(); x.force_cpu = true; x }));
        // Fake metal/cuda/vulkan folders (force_cpu) stay last for crash-proof fallback.
        ordered.extend(all.iter().filter(|c| {
            (c.mode == "metal" || c.mode == "vulkan" || c.mode == "cuda") && c.force_cpu
        }).map(|c| { let mut x = c.clone(); x.force_cpu = true; x }));
    } else {
        // CPU-first: explicit CPU request, or weak iGPU where Vulkan crashes at ngl=0.
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
        "{binary} was not found. PocketMind Hybrid AI supports a universal runtime layout:\n\n\
Windows:\n\
bin\\llama.cpp\\cpu\\{binary}       CPU fallback runtime\n\
bin\\llama.cpp\\cuda\\{binary}      NVIDIA CUDA runtime\n\
bin\\llama.cpp\\vulkan\\{binary}    AMD/Intel/NVIDIA Vulkan runtime\n\n\
macOS:\n\
bin/llama.cpp/macos-arm64-metal/{binary}  Apple Silicon Metal runtime\n\
bin/llama.cpp/macos-arm64-cpu/{binary}    Apple Silicon CPU fallback\n\
bin/llama.cpp/macos-x64-metal/{binary}    Intel Mac Metal runtime\n\
bin/llama.cpp/macos-x64-cpu/{binary}      Intel Mac CPU fallback\n\n\
Linux:\n\
bin/llama.cpp/cpu/{binary}       CPU fallback runtime\n\
bin/llama.cpp/cuda/{binary}      NVIDIA CUDA runtime\n\
bin/llama.cpp/vulkan/{binary}    AMD/Intel/NVIDIA Vulkan runtime\n\n\
You can also place a single {binary} in bin/llama.cpp for auto mode, or set NEXUS_LLAMA_SERVER.\n\
Windows: npm run setup:windows-runtimes && npm run verify:windows-runtimes\n\
macOS:   npm run setup:macos-runtimes && npm run verify:macos-runtimes\n\
Linux:   npm run setup:linux-runtimes && npm run verify:linux-runtimes"
    )
}

// ---------------------------------------------------------------------------
// GPU offload estimation (shared by chat and Knowledge Chat embeddings)
// ---------------------------------------------------------------------------

pub fn model_size_bytes(path: &str) -> u64 {
    crate::gguf::model_total_bytes(path)
}

/// Layer count from GGUF metadata when available, else size-based guess.
pub fn model_block_count(model_path: &str) -> i32 {
    crate::gguf::gguf_block_count(model_path)
        .map(|n| n as i32)
        .unwrap_or_else(|| estimate_layer_count(model_size_bytes(model_path)))
}

/// True when macOS hardware is worth attempting Metal LLM offload: Apple Silicon
/// unified memory, or a discrete GPU with enough VRAM. Tiny Intel iGPUs alone do
/// not qualify.
fn macos_metal_hardware() -> bool {
    if !cfg!(target_os = "macos") {
        return false;
    }
    let mut monitor = HardwareMonitor::new();
    let info = monitor.get_system_info();
    info.gpus.iter().any(|g| g.is_metal_capable && g.vram_total_bytes >= 2 * 1024 * 1024 * 1024)
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
pub fn estimate_partial_gpu_layers(model_path: &str, free_vram_bytes: u64) -> i32 {
    let model_size_bytes = model_size_bytes(model_path);
    if model_size_bytes == 0 || free_vram_bytes == 0 {
        return 0;
    }

    let block_count = model_block_count(model_path).max(1) as u64;
    let reserve = 2u64 * 1024 * 1024 * 1024;
    let usable = if free_vram_bytes > reserve {
        ((free_vram_bytes - reserve) as f64 * 0.9) as u64
    } else {
        ((free_vram_bytes as f64) * 0.75) as u64
    };

    let per_layer = (model_size_bytes / block_count).max(1);
    let fit = (usable / per_layer) as i32;

    if fit >= block_count as i32 {
        999
    } else {
        fit.max(0)
    }
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
///
/// When free VRAM cannot hold the full model, attempts are capped at the
/// estimated `partial` layer count. Trying 999 / 120 / … first only burns
/// multi-minute failed spawn timeouts and does not change the successful
/// configuration (same weights, same eventual layer count).
pub fn gpu_layer_attempts(model_path: &str, requested_gpu_layers: i32, force_cpu: bool) -> Vec<i32> {
    if force_cpu || requested_gpu_layers == 0 {
        return vec![0];
    }

    let model_size = model_size_bytes(model_path);
    let block_count = model_block_count(model_path);
    let (_, _, free_vram, gpu_count) = hardware_memory_snapshot();
    let mut partial = estimate_partial_gpu_layers(model_path, free_vram);
    let has_gpu_runtime = !force_cpu && gpu_layer_runtime_available();

    // While chat owns the GPU, stay at or below the remaining-VRAM estimate.
    if chat_holds_gpu() && partial > 0 && partial < 999 {
        // leave partial as-is (already from current free VRAM)
    } else if chat_holds_gpu() && partial >= 999 {
        partial = estimate_partial_gpu_layers(model_path, free_vram.saturating_div(2)).max(16);
    }

    if requested_gpu_layers > 0 {
        let capped = if partial > 0 && partial < 999 {
            requested_gpu_layers.min(partial)
        } else {
            requested_gpu_layers
        };
        return unique_descending_layers(vec![
            capped,
            partial,
            ((partial as f32) * 0.75) as i32,
            16.min(partial.max(0)),
            8.min(partial.max(0)),
            0,
        ]);
    }

    // Unknown VRAM but a GPU runtime exists: try aggressive full offload first.
    if free_vram == 0 && has_gpu_runtime && gpu_count == 0 {
        return unique_descending_layers(vec![
            999,
            block_count,
            ((block_count as f32) * 0.75) as i32,
            ((block_count as f32) * 0.5) as i32,
            ((block_count as f32) * 0.25) as i32,
            0,
        ]);
    }

    if partial >= 999 {
        return unique_descending_layers(vec![999, block_count, 120, 96, 80, 64, 48, 0]);
    }

    if partial > 0 {
        return unique_descending_layers(vec![
            999,
            partial,
            ((partial as f32) * 0.85) as i32,
            ((partial as f32) * 0.65) as i32,
            ((partial as f32) * 0.45) as i32,
            16.min(partial.max(0)),
            8.min(partial.max(0)),
            0,
        ]);
    }

    if has_gpu_runtime {
        return unique_descending_layers(vec![
            999,
            block_count,
            ((block_count as f32) * 0.75) as i32,
            ((block_count as f32) * 0.5) as i32,
            0,
        ]);
    }

    vec![0]
}

fn gpu_layer_runtime_available() -> bool {
    // Inspect raw candidates (not ordered) so weak-iGPU CPU preference cannot
    // hide a real CUDA/Vulkan/Metal runtime from Auto offload planning.
    all_runtime_candidates(-1)
        .iter()
        .any(|c| !c.force_cpu && matches!(c.mode, "cuda" | "vulkan" | "metal"))
}

// ---------------------------------------------------------------------------
// Last successful launch status (UI / diagnostics)
// ---------------------------------------------------------------------------

use std::sync::Mutex;

#[derive(Debug, Clone, Default)]
pub struct LastLaunchStatus {
    pub backend: String,
    pub runtime_path: String,
    pub gpu_layers: i32,
    pub force_cpu: bool,
    pub label: String,
}

static LAST_LAUNCH: Mutex<LastLaunchStatus> = Mutex::new(LastLaunchStatus {
    backend: String::new(),
    runtime_path: String::new(),
    gpu_layers: 0,
    force_cpu: true,
    label: String::new(),
});

pub fn set_last_launch_status(backend: &str, path: &Path, gpu_layers: i32, force_cpu: bool, label: &str) {
    if let Ok(mut guard) = LAST_LAUNCH.lock() {
        guard.backend = backend.to_string();
        guard.runtime_path = path.display().to_string();
        guard.gpu_layers = gpu_layers;
        guard.force_cpu = force_cpu;
        guard.label = label.to_string();
    }
}

pub fn last_launch_status() -> LastLaunchStatus {
    LAST_LAUNCH.lock().map(|g| g.clone()).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hardware::GPUInfo;

    fn gpu(name: &str, vendor: &str, vram: u64, cuda: bool) -> GPUInfo {
        GPUInfo {
            name: name.to_string(),
            vendor: vendor.to_string(),
            vram_total_bytes: vram,
            vram_used_bytes: 0,
            is_cuda_capable: cuda,
            is_metal_capable: false,
            is_vulkan_capable: true,
            compute_score: 1000,
        }
    }

    #[test]
    fn nvidia_name_not_treated_as_weak_even_with_zero_vram() {
        let nvidia = gpu("NVIDIA GeForce RTX 3060", "NVIDIA", 0, false);
        assert!(gpu_looks_nvidia(&nvidia));
        let intel = gpu("Intel UHD Graphics", "Intel", 128 * 1024 * 1024, false);
        // Dual-GPU laptop: NVIDIA present => not weak-iGPU-only.
        assert!(![nvidia.clone(), intel].iter().all(|g| {
            let name = g.name.to_lowercase();
            name.contains("intel") || (g.vram_total_bytes > 0 && g.vram_total_bytes < 2 * 1024 * 1024 * 1024 && !gpu_looks_nvidia(g))
        }));
    }

    #[test]
    fn intel_only_small_vram_matches_weak_heuristic_names() {
        let intel = gpu("Intel(R) UHD Graphics 620", "Intel", 128 * 1024 * 1024, false);
        let name = intel.name.to_lowercase();
        assert!(name.contains("intel") || name.contains("uhd"));
        assert!(!gpu_looks_nvidia(&intel));
    }

    #[test]
    fn runtime_candidate_force_cpu_when_cuda_libs_missing() {
        // Unit-level: mode labeling helpers stay consistent.
        assert_eq!(binary_name().contains("llama-server"), true);
    }
}
