use crate::deployment::normalize_path_string;
use crate::error::{AppError, AppResult};
use crate::knowledge_chat::types::{KcScannedFile, KC_MAX_FILES_PER_SCAN, KC_MAX_FILE_BYTES};
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

const IGNORE_DIR_NAMES: &[&str] = &[
    "node_modules",
    ".git",
    ".svn",
    ".hg",
    "target",
    "dist",
    "build",
    "out",
    ".next",
    ".nuxt",
    ".output",
    ".cache",
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    ".venv",
    "venv",
    ".venv-win",
    "env",
    ".env",
    "vendor",
    "bower_components",
    "coverage",
    ".coverage",
    ".idea",
    ".vscode",
    ".cursor",
    ".turbo",
    ".parcel-cache",
    ".gradle",
    ".terraform",
    "Pods",
    "DerivedData",
    ".DS_Store",
    "_meta",
];

const IGNORE_FILE_NAMES: &[&str] = &[
    ".DS_Store",
    "Thumbs.db",
    "desktop.ini",
    // Legacy demo routing artifact — never index even if left on disk.
    "demo_cheatsheet.json",
    "demo_cheatsheet.template.json",
];

const EXTENSIONLESS_SUPPORTED: &[&str] = &[
    "dockerfile",
    "makefile",
    "license",
    "licence",
    "jenkinsfile",
    "vagrantfile",
    "gemfile",
    "rakefile",
    "procfile",
    "cmakelists.txt",
];

const SUPPORTED_EXTENSIONS: &[&str] = &[
    "txt", "md", "markdown", "csv", "json", "jsonl", "xml", "html", "htm", "log",
    "yaml", "yml", "toml", "ini", "pdf", "docx", "pptx", "xlsx", "xlsm",
    "rs", "py", "js", "jsx", "ts", "tsx", "java", "kt", "kts", "cpp", "c", "h",
    "hpp", "cs", "go", "rb", "php", "sql", "css",
];

pub fn normalize_path(value: &str) -> String {
    normalize_path_string(value.trim().trim_matches('"'))
}

pub fn is_supported_extension(ext: &str) -> bool {
    SUPPORTED_EXTENSIONS.contains(&ext.to_lowercase().as_str())
}

pub fn is_supported_file_name(name: &str) -> bool {
    let lower = name.to_lowercase();
    EXTENSIONLESS_SUPPORTED.contains(&lower.as_str())
}

fn should_ignore_dir(name: &str) -> bool {
    let lower = name.to_lowercase();
    IGNORE_DIR_NAMES.iter().any(|item| *item == lower)
}

fn should_ignore_file_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    IGNORE_FILE_NAMES
        .iter()
        .any(|item| item.eq_ignore_ascii_case(&lower) || *item == name)
}

fn canonical_path_string(path: &Path) -> String {
    normalize_path_string(&path.to_string_lossy())
}

pub fn scan_folder(root_path: &str, max_files: Option<usize>) -> AppResult<(Vec<KcScannedFile>, usize, bool, usize, usize)> {
    let clean = normalize_path(root_path);
    if clean.is_empty() {
        return Err(AppError::Unknown("Folder path is required.".to_string()));
    }
    let root = PathBuf::from(&clean);
    if !root.exists() || !root.is_dir() {
        return Err(AppError::Unknown(format!(
            "Selected path is not an existing folder: {clean}"
        )));
    }

    let limit = max_files.unwrap_or(KC_MAX_FILES_PER_SCAN).clamp(1, KC_MAX_FILES_PER_SCAN);
    let mut files = Vec::new();
    let mut permission_denied = 0usize;
    let mut walk_errors = 0usize;
    let mut truncated = false;

    let ignored_dirs = std::cell::Cell::new(0usize);
    let walker = WalkDir::new(&root).follow_links(false).sort_by_file_name();
    for entry in walker.into_iter().filter_entry(|e| {
        if e.file_type().is_dir() {
            let name = e.file_name().to_string_lossy();
            if should_ignore_dir(&name) {
                ignored_dirs.set(ignored_dirs.get() + 1);
                return false;
            }
        }
        true
    }) {
        let entry = match entry {
            Ok(value) => value,
            Err(_) => {
                walk_errors += 1;
                continue;
            }
        };

        if entry.file_type().is_dir() {
            continue;
        }

        if files.len() >= limit {
            truncated = true;
            break;
        }

        let path = entry.path().to_path_buf();
        let name = path
            .file_name()
            .and_then(|v| v.to_str())
            .unwrap_or("unknown")
            .to_string();

        if should_ignore_file_name(&name) {
            continue;
        }

        let metadata = match entry.metadata() {
            Ok(m) => m,
            Err(err) => {
                if err.io_error().map(|e| e.kind()) == Some(std::io::ErrorKind::PermissionDenied) {
                    permission_denied += 1;
                } else {
                    walk_errors += 1;
                }
                continue;
            }
        };

        let ext = extension_of(&path, &name);
        let relative = relative_path(&root, &path);
        if let Some(reason) = crate::knowledge_chat::filter::should_skip_file(&name, &ext, Some(&relative)) {
            files.push(KcScannedFile {
                relative_path: relative,
                absolute_path: canonical_path_string(&path),
                name,
                extension: ext,
                size_bytes: metadata.len(),
                modified_at: modified_timestamp(&metadata),
                supported: false,
                skip_reason: Some(reason),
            });
            continue;
        }

        if metadata.len() > KC_MAX_FILE_BYTES {
            files.push(KcScannedFile {
                relative_path: relative_path(&root, &path),
                absolute_path: canonical_path_string(&path),
                name: name.clone(),
                extension: ext.clone(),
                size_bytes: metadata.len(),
                modified_at: modified_timestamp(&metadata),
                supported: false,
                skip_reason: Some(format!(
                    "File exceeds {:.0} MB local indexing limit.",
                    KC_MAX_FILE_BYTES as f64 / 1_048_576.0
                )),
            });
            continue;
        }

        let ext = extension_of(&path, &name);
        let supported = is_supported_extension(&ext) || is_supported_file_name(&name);
        let relative = relative_path(&root, &path);
        files.push(KcScannedFile {
            relative_path: relative,
            absolute_path: canonical_path_string(&path),
            name: name.clone(),
            extension: ext.clone(),
            size_bytes: metadata.len(),
            modified_at: modified_timestamp(&metadata),
            supported,
            skip_reason: if supported {
                None
            } else {
                Some("Unsupported file type for text extraction.".to_string())
            },
        });
    }

    files.sort_by(|a, b| {
        b.supported
            .cmp(&a.supported)
            .then_with(|| a.relative_path.to_lowercase().cmp(&b.relative_path.to_lowercase()))
    });

    Ok((files, ignored_dirs.get(), truncated, permission_denied, walk_errors))
}

fn relative_path(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .map(|p| canonical_path_string(p))
        .unwrap_or_else(|_| canonical_path_string(path))
}

fn extension_of(path: &Path, name: &str) -> String {
    if let Some(ext) = path.extension().and_then(|v| v.to_str()) {
        return ext.to_lowercase();
    }
    if is_supported_file_name(name) {
        return "txt".to_string();
    }
    String::new()
}

#[cfg(unix)]
fn modified_timestamp(metadata: &std::fs::Metadata) -> i64 {
    metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(not(unix))]
fn modified_timestamp(metadata: &std::fs::Metadata) -> i64 {
    metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}
