//! Lightweight GGUF file integrity checks shared by downloads, imports, and
//! embedding/rerank discovery. Rejects Hugging Face HTML error pages and other
//! non-model payloads that were saved with a `.gguf` extension.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

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

/// Sum primary GGUF size plus sibling shards when multi-part (`*-00001-of-000NN`).
pub fn model_total_bytes(path: &str) -> u64 {
    let primary = PathBuf::from(path.trim().trim_matches('"'));
    if !primary.is_file() {
        return 0;
    }
    let Some(file_name) = primary.file_name().and_then(|s| s.to_str()) else {
        return primary.metadata().map(|m| m.len()).unwrap_or(0);
    };
    let lower = file_name.to_ascii_lowercase();
    let Some(of_pos) = lower.rfind("-of-") else {
        return primary.metadata().map(|m| m.len()).unwrap_or(0);
    };
    let after = &lower[of_pos + 4..];
    let total_str = after.split(|c: char| !c.is_ascii_digit()).next().unwrap_or("");
    let Ok(total) = total_str.parse::<u32>() else {
        return primary.metadata().map(|m| m.len()).unwrap_or(0);
    };
    if total <= 1 {
        return primary.metadata().map(|m| m.len()).unwrap_or(0);
    }
    let before = &lower[..of_pos];
    let Some(dash) = before.rfind('-') else {
        return primary.metadata().map(|m| m.len()).unwrap_or(0);
    };
    let prefix = &file_name[..dash + 1];
    let suffix = &file_name[of_pos..];
    let num_part = &before[dash + 1..];
    let width = num_part.len();
    let parent = primary.parent().unwrap_or_else(|| Path::new("."));
    let mut size = 0u64;
    let mut found = 0u32;
    for i in 1..=total {
        let shard = format!("{prefix}{i:0width$}{suffix}", width = width);
        let shard_path = parent.join(&shard);
        if shard_path.is_file() {
            if let Ok(meta) = shard_path.metadata() {
                size = size.saturating_add(meta.len());
                found += 1;
            }
        }
    }
    if found == 0 {
        primary.metadata().map(|m| m.len()).unwrap_or(0)
    } else {
        size
    }
}

/// Read transformer block/layer count from GGUF metadata (`*.block_count`).
pub fn gguf_block_count(path: &str) -> Option<u32> {
    let path = Path::new(path.trim().trim_matches('"'));
    if !path.is_file() {
        return None;
    }
    read_gguf_block_count(path).ok()
}

fn read_u32_le<R: Read>(r: &mut R) -> std::io::Result<u32> {
    let mut buf = [0u8; 4];
    r.read_exact(&mut buf)?;
    Ok(u32::from_le_bytes(buf))
}

fn read_u64_le<R: Read>(r: &mut R) -> std::io::Result<u64> {
    let mut buf = [0u8; 8];
    r.read_exact(&mut buf)?;
    Ok(u64::from_le_bytes(buf))
}

fn read_gguf_string<R: Read>(r: &mut R) -> std::io::Result<String> {
    let len = read_u64_le(r)? as usize;
    let mut buf = vec![0u8; len];
    r.read_exact(&mut buf)?;
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

fn skip_gguf_value<R: Read + Seek>(r: &mut R, value_type: u32) -> std::io::Result<()> {
    match value_type {
        0 | 1 | 5 | 7 => {
            r.seek(SeekFrom::Current(4))?;
        }
        2 | 3 => {
            r.seek(SeekFrom::Current(2))?;
        }
        4 => {
            r.seek(SeekFrom::Current(4))?;
        }
        6 => {
            r.seek(SeekFrom::Current(4))?;
        }
        8 => {
            let _ = read_gguf_string(r)?;
        }
        9 => {
            let elem_type = read_u32_le(r)?;
            let count = read_u64_le(r)? as usize;
            for _ in 0..count {
                skip_gguf_value(r, elem_type)?;
            }
        }
        10 => {
            r.seek(SeekFrom::Current(8))?;
        }
        11 => {
            r.seek(SeekFrom::Current(8))?;
        }
        12 => {
            r.seek(SeekFrom::Current(8))?;
        }
        _ => {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("unknown GGUF value type {value_type}"),
            ));
        }
    }
    Ok(())
}

fn read_gguf_u32_value<R: Read + Seek>(r: &mut R, value_type: u32) -> std::io::Result<Option<u32>> {
    match value_type {
        4 => Ok(Some(read_u32_le(r)?)),
        10 => Ok(Some(read_u64_le(r)? as u32)),
        _ => {
            skip_gguf_value(r, value_type)?;
            Ok(None)
        }
    }
}

fn read_gguf_block_count(path: &Path) -> std::io::Result<u32> {
    let mut file = File::open(path)?;
    let mut magic = [0u8; 4];
    file.read_exact(&mut magic)?;
    if &magic != b"GGUF" {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "not GGUF",
        ));
    }
    let _version = read_u32_le(&mut file)?;
    let _tensor_count = read_u64_le(&mut file)?;
    let kv_count = read_u64_le(&mut file)? as usize;

    let mut block_count: Option<u32> = None;
    for _ in 0..kv_count {
        let key = read_gguf_string(&mut file)?;
        let value_type = read_u32_le(&mut file)?;
        if key.ends_with(".block_count") || key == "block_count" {
            if let Some(v) = read_gguf_u32_value(&mut file, value_type)? {
                block_count = Some(v);
            }
        } else {
            skip_gguf_value(&mut file, value_type)?;
        }
    }
    block_count.ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::NotFound, "block_count not found")
    })
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
