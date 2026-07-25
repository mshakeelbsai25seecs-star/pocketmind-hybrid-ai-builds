//! Resolve vendored Code Workspace tooling (ripgrep, Python, Node).
//! Host PATH tools for other languages are resolved by `sandbox_runners`.

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use crate::deployment;

#[derive(Debug, Clone, Serialize)]
pub struct ToolingStatus {
    pub rg_path: Option<String>,
    pub python_path: Option<String>,
    pub node_path: Option<String>,
    pub rg_ok: bool,
    pub python_ok: bool,
    pub node_ok: bool,
    pub message: String,
}

fn host_target() -> &'static str {
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    { "x86_64-pc-windows-msvc" }
    #[cfg(all(target_os = "windows", target_arch = "aarch64"))]
    { "aarch64-pc-windows-msvc" }
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    { "x86_64-apple-darwin" }
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    { "aarch64-apple-darwin" }
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    { "x86_64-unknown-linux-musl" }
    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    { "aarch64-unknown-linux-gnu" }
    #[cfg(not(any(
        all(target_os = "windows", target_arch = "x86_64"),
        all(target_os = "windows", target_arch = "aarch64"),
        all(target_os = "macos", target_arch = "x86_64"),
        all(target_os = "macos", target_arch = "aarch64"),
        all(target_os = "linux", target_arch = "x86_64"),
        all(target_os = "linux", target_arch = "aarch64"),
    )))]
    { "unknown" }
}

fn resource_tooling_root() -> PathBuf {
    // Dev: src-tauri/resources/tooling next to CARGO_MANIFEST_DIR
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources").join("tooling");
    if manifest.exists() {
        return manifest;
    }
    // Packaged: beside executable
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let candidate = dir.join("resources").join("tooling");
            if candidate.exists() {
                return candidate;
            }
            let candidate2 = dir.join("tooling");
            if candidate2.exists() {
                return candidate2;
            }
        }
    }
    manifest
}

fn runtime_tooling_root() -> PathBuf {
    deployment::preferred_data_root().join("tooling")
}

fn bin_name(tool: &str) -> &'static str {
    match tool {
        "ripgrep" => {
            if cfg!(windows) { "rg.exe" } else { "rg" }
        }
        "python" => {
            if cfg!(windows) { "python.exe" } else { "python" }
        }
        "node" => {
            if cfg!(windows) { "node.exe" } else { "node" }
        }
        _ => "unknown",
    }
}

fn versions_for(tool: &str) -> &'static str {
    match tool {
        "ripgrep" => "15.2.0",
        "python" => "3.12.9",
        "node" => "24.18.0",
        _ => "0",
    }
}

fn target_aliases(primary: &str) -> Vec<&'static str> {
    match primary {
        "x86_64-unknown-linux-musl" => {
            vec!["x86_64-unknown-linux-musl", "x86_64-unknown-linux-gnu"]
        }
        "x86_64-unknown-linux-gnu" => {
            vec!["x86_64-unknown-linux-gnu", "x86_64-unknown-linux-musl"]
        }
        "x86_64-pc-windows-msvc" => vec!["x86_64-pc-windows-msvc"],
        "aarch64-pc-windows-msvc" => vec!["aarch64-pc-windows-msvc"],
        "x86_64-apple-darwin" => vec!["x86_64-apple-darwin"],
        "aarch64-apple-darwin" => vec!["aarch64-apple-darwin"],
        "aarch64-unknown-linux-gnu" => vec!["aarch64-unknown-linux-gnu"],
        _ => vec!["unknown"],
    }
}

fn find_binary(tool: &str) -> Option<PathBuf> {
    let name = bin_name(tool);
    let ver = versions_for(tool);
    let targets = target_aliases(host_target());
    for target in targets {
        let candidates = [
            runtime_tooling_root().join(tool).join(ver).join(target).join(name),
            resource_tooling_root().join(tool).join(ver).join(target).join(name),
        ];
        for c in candidates {
            if c.is_file() {
                return Some(c);
            }
        }
        // python-build-standalone layout may keep nested bin/python3.12
        if tool == "python" {
            for nested in ["python3.12", "python3", "bin/python3.12", "bin/python3", "bin/python"] {
                let c = runtime_tooling_root()
                    .join(tool)
                    .join(ver)
                    .join(target)
                    .join(nested);
                if c.is_file() {
                    return Some(c);
                }
                let c2 = resource_tooling_root()
                    .join(tool)
                    .join(ver)
                    .join(target)
                    .join(nested);
                if c2.is_file() {
                    return Some(c2);
                }
            }
        }
    }
    // Dev override: PATH (never required in production)
    which_in_path(name)
}

fn which_in_path(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let candidate = dir.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        let to = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_dir_recursive(&entry.path(), &to)?;
        } else {
            fs::copy(entry.path(), to)?;
        }
    }
    Ok(())
}

/// Copy resource tooling into writable runtime-data/tooling.
pub fn repair_tooling() -> Result<ToolingStatus, String> {
    for tool in ["ripgrep", "python", "node"] {
        let ver = versions_for(tool);
        for target in target_aliases(host_target()) {
            let src = resource_tooling_root().join(tool).join(ver).join(target);
            if !src.exists() {
                continue;
            }
            let dst = runtime_tooling_root().join(tool).join(ver).join(target);
            let _ = fs::remove_dir_all(&dst);
            copy_dir_recursive(&src, &dst).map_err(|e| e.to_string())?;
        }
    }
    Ok(status())
}

pub fn rg_path() -> Option<PathBuf> {
    find_binary("ripgrep")
}

pub fn python_path() -> Option<PathBuf> {
    find_binary("python")
}

pub fn node_path() -> Option<PathBuf> {
    find_binary("node")
}

pub fn status() -> ToolingStatus {
    let rg = rg_path();
    let py = python_path();
    let node = node_path();
    let rg_ok = rg.as_ref().map(|p| p.is_file()).unwrap_or(false);
    let python_ok = py.as_ref().map(|p| p.is_file()).unwrap_or(false);
    let node_ok = node.as_ref().map(|p| p.is_file()).unwrap_or(false);
    let message = if rg_ok && python_ok && node_ok {
        "Bundled tooling ready.".to_string()
    } else {
        format!(
            "Tooling incomplete (rg={}, python={}, node={}). Run scripts/fetch-tooling then Repair tooling.",
            rg_ok, python_ok, node_ok
        )
    };
    ToolingStatus {
        rg_path: rg.map(|p| p.display().to_string()),
        python_path: py.map(|p| p.display().to_string()),
        node_path: node.map(|p| p.display().to_string()),
        rg_ok,
        python_ok,
        node_ok,
        message,
    }
}
