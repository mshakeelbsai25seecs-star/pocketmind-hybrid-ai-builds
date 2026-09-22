//! Optional post-install llama.cpp backend download (CUDA / Vulkan / CPU).
//! Store MSIX stays CPU-only; users can fetch GPU runtimes into the data root.

use crate::deployment::preferred_data_root;
use crate::error::{AppError, AppResult};
use serde::Serialize;
use std::path::PathBuf;

#[cfg(windows)]
use std::io::{BufRead, BufReader};
#[cfg(windows)]
use std::process::{Command, Stdio};
#[cfg(windows)]
use std::thread;

#[derive(Debug, Clone, Serialize)]
pub struct LlamaRuntimeInstallResult {
    pub ok: bool,
    pub backend: String,
    pub install_dir: String,
    pub server_path: Option<String>,
    pub message: String,
    pub log_tail: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct LlamaRuntimeInstallProgress {
    pub backend: String,
    pub phase: String,
    pub message: String,
    pub percent: Option<u32>,
    pub file: Option<String>,
    pub downloaded: Option<u64>,
    pub total: Option<u64>,
}

fn resolve_install_script() -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            candidates.push(parent.join("scripts").join("install_llama_cpp_runtimes.ps1"));
            candidates.push(parent.join("resources").join("scripts").join("install_llama_cpp_runtimes.ps1"));
            candidates.push(
                parent
                    .join("..")
                    .join("scripts")
                    .join("install_llama_cpp_runtimes.ps1"),
            );
        }
    }
    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("scripts")
            .join("install_llama_cpp_runtimes.ps1"),
    );
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("scripts").join("install_llama_cpp_runtimes.ps1"));
        let mut cur = Some(cwd.as_path());
        while let Some(p) = cur {
            candidates.push(p.join("scripts").join("install_llama_cpp_runtimes.ps1"));
            cur = p.parent();
        }
    }
    if let Some(found) = candidates.into_iter().find(|p| p.is_file()) {
        return Some(found);
    }

    // Store/MSIX may not ship the .ps1 next to the exe — materialize the embedded copy.
    const EMBEDDED: &str = include_str!("../../scripts/install_llama_cpp_runtimes.ps1");
    let dest = preferred_data_root()
        .join("scripts")
        .join("install_llama_cpp_runtimes.ps1");
    if let Some(parent) = dest.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if std::fs::write(&dest, EMBEDDED).is_ok() {
        return Some(dest);
    }
    None
}

fn backend_server_path(root: &PathBuf, backend: &str) -> PathBuf {
    #[cfg(windows)]
    {
        root.join("bin")
            .join("llama.cpp")
            .join(backend)
            .join("llama-server.exe")
    }
    #[cfg(not(windows))]
    {
        root.join("bin")
            .join("llama.cpp")
            .join(backend)
            .join("llama-server")
    }
}

fn emit_progress(window: &tauri::Window, backend: &str, phase: &str, message: &str, percent: Option<u32>) {
    let _ = window.emit(
        "llama-runtime-install-progress",
        LlamaRuntimeInstallProgress {
            backend: backend.to_string(),
            phase: phase.to_string(),
            message: message.to_string(),
            percent,
            file: None,
            downloaded: None,
            total: None,
        },
    );
}

fn parse_and_emit_progress_line(window: &tauri::Window, backend: &str, line: &str) {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return;
    }
    if let Some(json) = trimmed.strip_prefix("##PM_PROGRESS##") {
        let json = json.trim();
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(json) {
            let phase = value
                .get("phase")
                .and_then(|v| v.as_str())
                .unwrap_or("download")
                .to_string();
            let message = value
                .get("message")
                .and_then(|v| v.as_str())
                .unwrap_or(trimmed)
                .to_string();
            let percent = value
                .get("percent")
                .and_then(|v| v.as_u64())
                .map(|n| n.min(100) as u32);
            let file = value
                .get("file")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let downloaded = value.get("downloaded").and_then(|v| v.as_u64());
            let total = value.get("total").and_then(|v| v.as_u64());
            let _ = window.emit(
                "llama-runtime-install-progress",
                LlamaRuntimeInstallProgress {
                    backend: backend.to_string(),
                    phase,
                    message,
                    percent,
                    file,
                    downloaded,
                    total,
                },
            );
            return;
        }
    }
    // Plain installer log line — still useful status for the UI.
    emit_progress(window, backend, "log", trimmed, None);
}

/// Download a llama.cpp backend into `{data_root}/bin/llama.cpp/{backend}/`.
/// `backend`: "cuda" | "vulkan" | "cpu"
#[tauri::command]
pub async fn install_llama_runtime_backend(
    window: tauri::Window,
    backend: String,
) -> AppResult<LlamaRuntimeInstallResult> {
    let backend = backend.trim().to_ascii_lowercase();
    if !matches!(backend.as_str(), "cuda" | "vulkan" | "cpu") {
        return Err(AppError::Unknown(format!(
            "Unsupported runtime backend '{backend}'. Use cuda, vulkan, or cpu."
        )));
    }

    #[cfg(not(windows))]
    {
        let _ = window;
        return Err(AppError::Unknown(format!(
            "In-app {backend} runtime download is Windows-only. On this OS, place llama-server under bin/llama.cpp/{backend}/."
        )));
    }

    #[cfg(windows)]
    {
        let script = resolve_install_script().ok_or_else(|| {
            AppError::Unknown(
                "Could not find scripts/install_llama_cpp_runtimes.ps1 next to the app. Reinstall PocketMind or run the script from the repo."
                    .to_string(),
            )
        })?;
        let data_root = preferred_data_root();
        std::fs::create_dir_all(data_root.join("bin").join("llama.cpp")).map_err(|e| {
            AppError::Unknown(format!("Could not create runtime folder under {}: {e}", data_root.display()))
        })?;
        let temp_root = data_root.join(".llama_runtime_tmp");
        std::fs::create_dir_all(&temp_root).ok();

        emit_progress(
            &window,
            &backend,
            "start",
            &format!("Starting {backend} llama.cpp runtime install…"),
            Some(1),
        );

        let mut args = vec![
            "-NoProfile".to_string(),
            "-ExecutionPolicy".to_string(),
            "Bypass".to_string(),
            "-File".to_string(),
            script.to_string_lossy().to_string(),
            "-ProjectPath".to_string(),
            data_root.to_string_lossy().to_string(),
            "-TempRoot".to_string(),
            temp_root.to_string_lossy().to_string(),
        ];
        match backend.as_str() {
            "cuda" => {
                args.push("-SkipVulkan".into());
                args.push("-SkipCpu".into());
            }
            "vulkan" => {
                args.push("-SkipCuda".into());
                args.push("-SkipCpu".into());
            }
            "cpu" => {
                args.push("-SkipCuda".into());
                args.push("-SkipVulkan".into());
            }
            _ => {}
        }

        let mut cmd = Command::new("powershell.exe");
        crate::process_util::no_window_std(&mut cmd);
        let mut child = cmd
            .args(&args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| AppError::Unknown(format!("Failed to start runtime installer: {e}")))?;

        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let window_out = window.clone();
        let backend_out = backend.clone();
        let out_handle = thread::spawn(move || {
            let mut buf = String::new();
            if let Some(pipe) = stdout {
                let reader = BufReader::new(pipe);
                for line in reader.lines().flatten() {
                    parse_and_emit_progress_line(&window_out, &backend_out, &line);
                    buf.push_str(&line);
                    buf.push('\n');
                }
            }
            buf
        });
        let window_err = window.clone();
        let backend_err = backend.clone();
        let err_handle = thread::spawn(move || {
            let mut buf = String::new();
            if let Some(pipe) = stderr {
                let reader = BufReader::new(pipe);
                for line in reader.lines().flatten() {
                    parse_and_emit_progress_line(&window_err, &backend_err, &line);
                    buf.push_str(&line);
                    buf.push('\n');
                }
            }
            buf
        });

        let status = child
            .wait()
            .map_err(|e| AppError::Unknown(format!("Runtime installer wait failed: {e}")))?;
        let stdout = out_handle.join().unwrap_or_default();
        let stderr = err_handle.join().unwrap_or_default();
        let combined = format!("{stdout}\n{stderr}");
        let log_tail: String = combined
            .chars()
            .rev()
            .take(1200)
            .collect::<String>()
            .chars()
            .rev()
            .collect();

        let server = backend_server_path(&data_root, &backend);
        let ok = server.is_file() && status.success();
        let install_dir = data_root
            .join("bin")
            .join("llama.cpp")
            .join(&backend)
            .to_string_lossy()
            .to_string();

        if !ok {
            emit_progress(
                &window,
                &backend,
                "error",
                "CUDA/GPU runtime install failed.",
                None,
            );
            return Err(AppError::Unknown(format!(
                "CUDA/GPU runtime install did not produce {}.\n{}",
                server.display(),
                if log_tail.trim().is_empty() {
                    "Installer exited with an error. Check NVIDIA drivers and free disk space on the data drive."
                        .to_string()
                } else {
                    log_tail.clone()
                }
            )));
        }

        emit_progress(
            &window,
            &backend,
            "complete",
            &format!("{backend} llama.cpp runtime installed."),
            Some(100),
        );

        Ok(LlamaRuntimeInstallResult {
            ok: true,
            backend: backend.clone(),
            install_dir,
            server_path: Some(server.to_string_lossy().to_string()),
            message: format!(
                "{backend} llama.cpp runtime installed. Select NVIDIA CUDA (or Automatic Optimizer) in Hardware & Runtime, then retry chat."
            ),
            log_tail,
        })
    }
}
