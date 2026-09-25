use serde::{Serialize, Deserialize};
use sysinfo::{System, get_current_pid, Disks};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GPUInfo {
    pub name: String,
    pub vendor: String,
    pub vram_total_bytes: u64,
    pub vram_used_bytes: u64,
    pub is_cuda_capable: bool,
    pub is_metal_capable: bool,
    pub is_vulkan_capable: bool,
    pub compute_score: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CPUInfo {
    pub brand: String,
    pub cores_physical: usize,
    pub cores_logical: usize,
    pub frequency_mhz: u64,
    pub usage_percent: f32,
    pub architecture: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryInfo {
    pub total_bytes: u64,
    pub used_bytes: u64,
    pub free_bytes: u64,
    pub available_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StorageInfo {
    pub total_bytes: u64,
    pub free_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SystemInfo {
    pub os_name: String,
    pub os_version: String,
    pub cpu: CPUInfo,
    pub memory: MemoryInfo,
    pub gpus: Vec<GPUInfo>,
    pub storage: StorageInfo,
    pub process_memory_bytes: u64,
    pub app_version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelRecommendation {
    pub name: String,
    pub params_billions: f32,
    pub quant: String,
    pub size_gb: f32,
    pub estimated_tok_sec: f32,
    pub confidence: String,
    pub required_vram_gb: f32,
    pub required_ram_gb: f32,
}

pub struct HardwareMonitor {
    system: System,
}

impl HardwareMonitor {
    pub fn new() -> Self {
        let system = System::new_all();
        Self { system }
    }

    pub fn refresh(&mut self) {
        self.system.refresh_all();
    }

    pub fn get_system_info(&mut self) -> SystemInfo {
        self.refresh();
        
        self.system.refresh_cpu();
        let cpus = self.system.cpus();
        let logical = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or_else(|_| cpus.len());
        let physical = self.system.physical_core_count().unwrap_or(logical);
        let cpu = CPUInfo {
            brand: cpus.first().map(|c| c.brand().to_string()).unwrap_or_else(|| "Unknown".to_string()),
            cores_physical: physical,
            cores_logical: logical,
            frequency_mhz: cpus.first().map(|c| c.frequency()).unwrap_or(0),
            usage_percent: if cpus.is_empty() { 0.0 } else { cpus.iter().map(|c| c.cpu_usage()).sum::<f32>() / cpus.len() as f32 },
            architecture: std::env::consts::ARCH.to_string(),
        };

        let total_mem = self.system.total_memory();
        let used_mem = self.system.used_memory();
        let free_mem = total_mem.saturating_sub(used_mem);
        // sysinfo's available_memory() can report 0 on some macOS builds; fall back
        // so Runtime Manager does not show "Unknown" for system RAM.
        let available_mem = match self.system.available_memory() {
            0 => free_mem,
            n => n,
        };
        let memory = MemoryInfo {
            total_bytes: total_mem,
            used_bytes: used_mem,
            free_bytes: free_mem,
            available_bytes: available_mem,
        };

        let mut storage = StorageInfo { total_bytes: 0, free_bytes: 0 };
        let disks = Disks::new_with_refreshed_list();
        for disk in &disks {
            storage.total_bytes += disk.total_space();
            storage.free_bytes += disk.available_space();
        }

        SystemInfo {
            os_name: System::name().unwrap_or_default(),
            os_version: System::os_version().unwrap_or_default(),
            cpu,
            memory,
            gpus: self.detect_gpus(),
            storage,
            process_memory_bytes: self.get_process_memory(),
            app_version: env!("CARGO_PKG_VERSION").to_string(),
        }
    }

    fn detect_gpus(&self) -> Vec<GPUInfo> {
        let mut gpus = Vec::new();
        
        #[cfg(any(target_os = "windows", target_os = "linux"))]
        {
            if let Ok(nvml) = nvml_wrapper::Nvml::init() {
                let count = nvml.device_count().unwrap_or(0);
                for i in 0..count {
                    if let Ok(device) = nvml.device_by_index(i) {
                        if let (Ok(name), Ok(mem_info)) = (device.name(), device.memory_info()) {
                            let name_clone = name.clone();
                            gpus.push(GPUInfo {
                                name,
                                vendor: "NVIDIA".to_string(),
                                vram_total_bytes: mem_info.total,
                                vram_used_bytes: mem_info.used,
                                is_cuda_capable: true,
                                is_metal_capable: false,
                                is_vulkan_capable: true,
                                compute_score: Self::estimate_nvidia_score(&name_clone),
                            });
                        }
                    }
                }
            }
        }

        #[cfg(windows)]
        {
            for (name, vram_total) in Self::detect_dxgi_adapters() {
                let name_lower = name.to_lowercase();
                let already = gpus.iter().any(|g| {
                    g.name.eq_ignore_ascii_case(&name)
                        || (g.is_cuda_capable && name_lower.contains("nvidia"))
                });
                if already {
                    continue;
                }
                let vendor = if name_lower.contains("amd") || name_lower.contains("radeon") {
                    "AMD"
                } else if name_lower.contains("intel") {
                    "Intel"
                } else if name_lower.contains("nvidia") {
                    "NVIDIA"
                } else {
                    "Unknown"
                };
                gpus.push(GPUInfo {
                    name: name.clone(),
                    vendor: vendor.to_string(),
                    vram_total_bytes: vram_total,
                    vram_used_bytes: 0,
                    // DXGI often finds NVIDIA when NVML is unavailable (lab lockdown /
                    // missing nvml.dll). Treat NVIDIA adapters as CUDA-capable so
                    // Automatic Optimizer does not fall through to CPU-only.
                    is_cuda_capable: vendor == "NVIDIA",
                    is_metal_capable: false,
                    is_vulkan_capable: true,
                    compute_score: if vendor == "AMD" { 2500 } else if vendor == "NVIDIA" { 4000 } else { 1500 },
                });
            }
        }

        #[cfg(target_os = "macos")]
        {
            gpus.extend(Self::detect_macos_gpus(self.system.total_memory()));
        }

        if gpus.is_empty() {
            if std::env::var("CUDA_VISIBLE_DEVICES").is_ok() {
                gpus.push(GPUInfo {
                    name: "Unknown CUDA Device".to_string(),
                    vendor: "Unknown".to_string(),
                    vram_total_bytes: 0,
                    vram_used_bytes: 0,
                    is_cuda_capable: true,
                    is_metal_capable: false,
                    is_vulkan_capable: false,
                    compute_score: 1000,
                });
            }
        }

        gpus
    }

    #[cfg(windows)]
    fn detect_dxgi_adapters() -> Vec<(String, u64)> {
        use windows::Win32::Graphics::Dxgi::{
            CreateDXGIFactory1, IDXGIAdapter1, IDXGIFactory1, DXGI_ADAPTER_DESC1,
        };

        unsafe {
            let factory: IDXGIFactory1 = match CreateDXGIFactory1() {
                Ok(f) => f,
                Err(_) => return Vec::new(),
            };
            let mut adapters = Vec::new();
            let mut index = 0u32;
            loop {
                let adapter: IDXGIAdapter1 = match factory.EnumAdapters1(index) {
                    Ok(a) => a,
                    Err(_) => break,
                };
                index += 1;
                // windows 0.54 uses an out-parameter for GetDesc1 (not a returned struct).
                let mut desc = std::mem::zeroed::<DXGI_ADAPTER_DESC1>();
                if adapter.GetDesc1(&mut desc).is_err() {
                    continue;
                }
                let name = String::from_utf16_lossy(
                    &desc
                        .Description
                        .iter()
                        .take_while(|&&c| c != 0)
                        .copied()
                        .collect::<Vec<_>>(),
                )
                .trim()
                .to_string();
                let vram = desc.DedicatedVideoMemory as u64;
                if vram == 0 || name.is_empty() {
                    continue;
                }
                // Skip Microsoft Basic Render Driver / software adapters.
                let lower = name.to_ascii_lowercase();
                if lower.contains("basic render") || lower.contains("microsoft basic") {
                    continue;
                }
                adapters.push((name, vram));
            }
            adapters
        }
    }

    /// Detect macOS GPUs with realistic VRAM / Metal expectations.
    ///
    /// Apple Silicon uses unified memory (system RAM ≈ usable "VRAM").
    /// Intel/AMD GPUs report a much smaller dedicated or dynamic VRAM; treating
    /// total system RAM as VRAM on those machines makes 8B models look like they
    /// "fit" when they do not.
    #[cfg(target_os = "macos")]
    fn detect_macos_gpus(total_system_memory: u64) -> Vec<GPUInfo> {
        use std::process::Command;
        let mut gpus = Vec::new();
        let apple_silicon = Self::is_apple_silicon_cpu();

        if let Ok(output) = {
            let mut cmd = Command::new("system_profiler");
            crate::process_util::no_window_std(&mut cmd);
            cmd.args(["SPDisplaysDataType", "-json"]).output()
        } {
            if let Ok(json) = serde_json::from_slice::<serde_json::Value>(&output.stdout) {
                if let Some(arr) = json.get("SPDisplaysDataType").and_then(|v| v.as_array()) {
                    for display in arr {
                        let name = display
                            .get("sppci_model")
                            .and_then(|v| v.as_str())
                            .unwrap_or(if apple_silicon {
                                "Apple Silicon GPU"
                            } else {
                                "Unknown GPU"
                            })
                            .to_string();
                        let name_lower = name.to_lowercase();
                        let looks_apple_gpu = name_lower.contains("apple")
                            || name_lower.contains("m1")
                            || name_lower.contains("m2")
                            || name_lower.contains("m3")
                            || name_lower.contains("m4");
                        let unified = apple_silicon || looks_apple_gpu;
                        let reported_vram = Self::parse_macos_vram_bytes(display);
                        let vram_total_bytes = if unified {
                            total_system_memory
                        } else {
                            reported_vram.unwrap_or(0)
                        };
                        let vendor = if unified {
                            "Apple".to_string()
                        } else if name_lower.contains("amd") || name_lower.contains("radeon") {
                            "AMD".to_string()
                        } else if name_lower.contains("intel") {
                            "Intel".to_string()
                        } else if name_lower.contains("nvidia") {
                            "NVIDIA".to_string()
                        } else {
                            "Unknown".to_string()
                        };
                        let metal_api = display
                            .get("spdisplays_mtlgpufamilysupport")
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_ascii_lowercase().contains("metal"))
                            .unwrap_or(false);
                        let discrete_amd_or_nvidia = vendor == "AMD" || vendor == "NVIDIA";
                        // Metal LLM offload: Apple Silicon always; discrete Metal GPUs with
                        // enough VRAM can be usable once a real Metal runtime is bundled.
                        // Tiny Intel iGPUs (~1.5 GB shared) are not treated as Metal-ready.
                        let is_metal_capable = unified
                            || (metal_api
                                && discrete_amd_or_nvidia
                                && vram_total_bytes >= 2 * 1024 * 1024 * 1024);
                        let compute_score = if unified {
                            Self::estimate_apple_score()
                        } else if discrete_amd_or_nvidia {
                            2500
                        } else {
                            500
                        };
                        // Skip display-only rows that are not a GPU model
                        // (e.g. LCD entries nested under a discrete GPU).
                        if name == "Unknown GPU" && vram_total_bytes == 0 && !metal_api {
                            continue;
                        }
                        gpus.push(GPUInfo {
                            name,
                            vendor,
                            vram_total_bytes,
                            vram_used_bytes: 0,
                            is_cuda_capable: false,
                            is_metal_capable,
                            is_vulkan_capable: false,
                            compute_score,
                        });
                    }
                }
            }
        }

        if gpus.is_empty() {
            gpus.push(GPUInfo {
                name: if apple_silicon {
                    "Apple Silicon GPU".to_string()
                } else {
                    "macOS GPU".to_string()
                },
                vendor: if apple_silicon {
                    "Apple".to_string()
                } else {
                    "Unknown".to_string()
                },
                vram_total_bytes: if apple_silicon { total_system_memory } else { 0 },
                vram_used_bytes: 0,
                is_cuda_capable: false,
                is_metal_capable: apple_silicon,
                is_vulkan_capable: false,
                compute_score: if apple_silicon {
                    Self::estimate_apple_score()
                } else {
                    500
                },
            });
        }
        gpus
    }

    #[cfg(target_os = "macos")]
    fn is_apple_silicon_cpu() -> bool {
        use std::process::Command;
        if let Ok(output) = {
            let mut cmd = Command::new("sysctl");
            crate::process_util::no_window_std(&mut cmd);
            cmd.args(["-n", "machdep.cpu.brand_string"]).output()
        } {
            let brand = String::from_utf8_lossy(&output.stdout).to_lowercase();
            if brand.contains("apple") {
                return true;
            }
        }
        cfg!(target_arch = "aarch64")
    }

    #[cfg(target_os = "macos")]
    fn parse_macos_vram_bytes(display: &serde_json::Value) -> Option<u64> {
        const KEYS: &[&str] = &[
            "spdisplays_vram",
            "_spdisplays_vram",
            "spdisplays_vram_shared",
            "spdisplays_vramrecommended",
        ];
        // Prefer dedicated VRAM keys before shared/dynamic iGPU figures.
        for key in KEYS {
            if let Some(raw) = display.get(*key).and_then(|v| v.as_str()) {
                if let Some(bytes) = Self::parse_memory_size_to_bytes(raw) {
                    if *key != "spdisplays_vram_shared" {
                        return Some(bytes);
                    }
                }
            }
        }
        if let Some(raw) = display
            .get("spdisplays_vram_shared")
            .and_then(|v| v.as_str())
        {
            return Self::parse_memory_size_to_bytes(raw);
        }
        None
    }

    #[cfg(target_os = "macos")]
    fn parse_memory_size_to_bytes(raw: &str) -> Option<u64> {
        let cleaned = raw.trim().to_lowercase().replace(',', "");
        let mut num = String::new();
        let mut unit = String::new();
        for ch in cleaned.chars() {
            if ch.is_ascii_digit() || ch == '.' {
                num.push(ch);
            } else if ch.is_ascii_alphabetic() {
                unit.push(ch);
            }
        }
        let value: f64 = num.parse().ok()?;
        let mult = match unit.as_str() {
            "gb" | "g" | "gib" => 1_073_741_824.0,
            "mb" | "m" | "mib" => 1_048_576.0,
            "kb" | "k" | "kib" => 1024.0,
            "b" | "" => 1.0,
            _ => return None,
        };
        Some((value * mult) as u64)
    }

    #[cfg(target_os = "macos")]
    fn estimate_apple_score() -> u32 {
        use std::process::Command;
        if let Ok(output) = {
            let mut cmd = Command::new("sysctl");
            crate::process_util::no_window_std(&mut cmd);
            cmd.args(["-n", "machdep.cpu.brand_string"]).output()
        } {
            let brand = String::from_utf8_lossy(&output.stdout);
            if brand.contains("M4") { return 9000; }
            if brand.contains("M3") { return 8000; }
            if brand.contains("M2") { return 6000; }
            if brand.contains("M1") { return 4000; }
            if brand.contains("Pro") || brand.contains("Max") || brand.contains("Ultra") {
                return 10000;
            }
        }
        4000
    }

    fn estimate_nvidia_score(name: &str) -> u32 {
        let name_lower = name.to_lowercase();
        match () {
            _ if name_lower.contains("4090") => 25000,
            _ if name_lower.contains("3090") => 20000,
            _ if name_lower.contains("4080") => 18000,
            _ if name_lower.contains("4070") => 14000,
            _ if name_lower.contains("4060") => 10000,
            _ if name_lower.contains("3070") => 12000,
            _ if name_lower.contains("3060") => 8000,
            _ if name_lower.contains("3050") => 5000,
            _ if name_lower.contains("2080") => 10000,
            _ if name_lower.contains("2060") => 7000,
            _ if name_lower.contains("1660") => 5000,
            _ if name_lower.contains("1080") => 8000,
            _ if name_lower.contains("1060") => 5000,
            _ => 3000,
        }
    }

    fn get_process_memory(&self) -> u64 {
        let pid = get_current_pid().unwrap_or_else(|_| sysinfo::Pid::from(0));
        if let Some(process) = self.system.process(pid) {
            process.memory()
        } else {
            0
        }
    }

    pub fn recommend_models(&self, info: &SystemInfo) -> Vec<ModelRecommendation> {
        let mut recs = Vec::new();
        let ram_gb = info.memory.total_bytes as f32 / (1024.0 * 1024.0 * 1024.0);
        let has_gpu = info.gpus.iter().any(|g| g.is_cuda_capable || g.is_metal_capable);
        let vram_gb = info.gpus.first().map(|g| g.vram_total_bytes as f32 / (1024.0 * 1024.0 * 1024.0)).unwrap_or(0.0);

        let mut add = |name: &str, params: f32, quant: &str, size: f32, tok_sec: f32, conf: &str, req_vram: f32, req_ram: f32| {
            recs.push(ModelRecommendation {
                name: name.to_string(),
                params_billions: params,
                quant: quant.to_string(),
                size_gb: size,
                estimated_tok_sec: tok_sec,
                confidence: conf.to_string(),
                required_vram_gb: req_vram,
                required_ram_gb: req_ram,
            });
        };

        if has_gpu && vram_gb >= 24.0 {
            add("Llama-3.1-70B-Q4_K_M", 70.0, "Q4_K_M", 40.0, 22.0, "comfortable", 20.0, 48.0);
            add("Llama-3.1-8B-Q8_0", 8.0, "Q8_0", 8.5, 65.0, "maximum-speed", 8.0, 16.0);
        } else if has_gpu && vram_gb >= 12.0 {
            add("Llama-3.1-8B-Q8_0", 8.0, "Q8_0", 8.5, 55.0, "comfortable", 8.0, 16.0);
            add("Llama-3.1-70B-Q4_K_M", 70.0, "Q4_K_M", 40.0, 6.0, "slow", 20.0, 48.0);
            add("Mixtral-8x7B-Q4_K_M", 47.0, "Q4_K_M", 28.0, 18.0, "comfortable", 10.0, 32.0);
        } else if has_gpu && vram_gb >= 8.0 {
            add("Llama-3.1-8B-Q4_K_M", 8.0, "Q4_K_M", 4.7, 45.0, "comfortable", 5.0, 12.0);
            add("Llama-3.1-8B-Q8_0", 8.0, "Q8_0", 8.5, 25.0, "possible", 8.0, 16.0);
        } else if ram_gb >= 32.0 {
            add("Llama-3.1-8B-Q4_K_M", 8.0, "Q4_K_M", 4.7, 12.0, "comfortable", 0.0, 8.0);
            add("Llama-3.1-70B-Q4_K_M", 70.0, "Q4_K_M", 40.0, 2.0, "very-slow", 0.0, 48.0);
        } else if ram_gb >= 16.0 {
            add("Llama-3.1-8B-Q4_K_M", 8.0, "Q4_K_M", 4.7, 8.0, "comfortable", 0.0, 8.0);
            add("Phi-3-medium-Q4_K_M", 14.0, "Q4_K_M", 8.0, 10.0, "comfortable", 0.0, 12.0);
        } else if ram_gb >= 8.0 {
            add("Phi-3-mini-Q4_K_M", 3.8, "Q4_K_M", 2.2, 15.0, "comfortable", 0.0, 4.0);
            add("Llama-3.1-8B-Q2_K", 8.0, "Q2_K", 2.8, 6.0, "possible", 0.0, 5.0);
        } else {
            add("Phi-3-mini-Q2_K", 3.8, "Q2_K", 1.4, 8.0, "comfortable", 0.0, 3.0);
            add("TinyLlama-1.1B-Q4_K_M", 1.1, "Q4_K_M", 0.7, 25.0, "maximum-speed", 0.0, 2.0);
        }

        recs
    }
}
