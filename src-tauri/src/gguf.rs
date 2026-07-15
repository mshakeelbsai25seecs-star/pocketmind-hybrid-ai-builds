//! Lightweight GGUF file integrity checks shared by downloads, imports, and
//! embedding/rerank discovery. Rejects Hugging Face HTML error pages and other
//! non-model payloads that were saved with a `.gguf` extension.

use std::fs::File;
use std::io::Read;
use std::path::Path;

/// Minimum size in bytes for a plausible quantized GGUF (rejects empty stubs and
/// tiny HTML landing pages often saved as `.gguf` after a bad browser download).
pub const MIN_PLAUSIBLE_GGUF_BYTES: u64 = 1_048_576; // 1 MiB

/// True when `path` has a `.gguf` extension, exists as a file, and starts with the
/// GGUF magic header (`GGUF`). Extension-only checks are not enough — failed
/// downloads frequently save HTML as `.gguf`.
pub fn is_valid_gguf_file(path: &Path) -> bool {
    validate_gguf_file(path).is_ok()
}

/// Validate that `path` is a real GGUF model file. Returns a user-facing error
/// message when the file is missing, too small, or not a GGUF payload.
pub fn validate_gguf_file(path: &Path) -> Result<(), String> {
    if !path.is_file() {
        return Err(format!("Model file does not exist: {}", path.display()));
    }
    let ext_ok = path
        .extension()
        .and_then(|v| v.to_str())
        .map(|e| e.eq_ignore_ascii_case("gguf"))
        .unwrap_or(false);
    if !ext_ok {
        return Err("Model must be a .gguf file.".to_string());
    }

    let meta = std::fs::metadata(path).map_err(|e| format!("Could not read model file: {e}"))?;
    if meta.len() < MIN_PLAUSIBLE_GGUF_BYTES {
        return Err(format!(
            "File \"{}\" is only {} bytes — too small to be a real GGUF model. \
It is usually a failed Hugging Face HTML download. Delete it and re-download the \
`.gguf` from the repo's Files tab (use a link that ends with `/resolve/main/...gguf`).",
            path.file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("model.gguf"),
            meta.len()
        ));
    }

    let mut file = File::open(path).map_err(|e| format!("Could not open model file: {e}"))?;
    let mut magic = [0u8; 4];
    file.read_exact(&mut magic)
        .map_err(|e| format!("Could not read model header: {e}"))?;
    if &magic != b"GGUF" {
        let preview = String::from_utf8_lossy(&magic);
        return Err(format!(
            "File \"{}\" is not a valid GGUF (header was {:?}, expected \"GGUF\"). \
If you downloaded from Hugging Face, you likely saved an HTML page instead of the model. \
Delete this file and download via a direct `/resolve/main/...gguf` URL.",
            path.file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("model.gguf"),
            preview.trim()
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_temp(name: &str) -> std::path::PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("nexusai-gguf-test-{nanos}-{name}"))
    }

    #[test]
    fn rejects_html_stub() {
        let path = unique_temp("fake.gguf");
        let mut f = File::create(&path).unwrap();
        f.write_all(b"<!doctype html><html>not a model</html>").unwrap();
        assert!(!is_valid_gguf_file(&path));
        assert!(validate_gguf_file(&path).unwrap_err().contains("too small"));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn accepts_gguf_magic_with_size() {
        let path = unique_temp("ok.gguf");
        let mut f = File::create(&path).unwrap();
        f.write_all(b"GGUF").unwrap();
        f.write_all(&vec![0u8; MIN_PLAUSIBLE_GGUF_BYTES as usize]).unwrap();
        assert!(is_valid_gguf_file(&path));
        let _ = std::fs::remove_file(&path);
    }
}
