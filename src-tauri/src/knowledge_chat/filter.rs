use crate::knowledge_chat::lexical::clean_text;

pub const MIN_EXTRACTABLE_CHARS: usize = 48;
pub const MIN_EXTRACTABLE_CHARS_CODE: usize = 20;
pub const MIN_EXTRACTABLE_ALPHA_CODE: usize = 6;

const STRUCTURED_TEXT_EXTENSIONS: &[&str] = &[
    "yaml", "yml", "toml", "json", "xml", "html", "md", "markdown",
];

const CODE_EXTENSIONS: &[&str] = &[
    "rs", "ts", "tsx", "js", "jsx", "py", "go", "java", "kt", "kts", "cs", "cpp", "cc", "c", "h",
    "hpp", "swift", "rb", "php", "scala", "sh", "bash", "ps1", "sql", "css", "scss", "less", "vue",
    "svelte",
];

fn uses_code_min_chars(extension: &str) -> bool {
    crate::knowledge_chat::code_languages::is_code_extension(extension)
        || STRUCTURED_TEXT_EXTENSIONS.contains(&extension)
}

const IGNORE_EXTENSIONS: &[&str] = &[
    "exe", "dll", "so", "dylib", "bin", "obj", "o", "a", "lib",
    "zip", "rar", "7z", "tar", "gz", "bz2", "xz", "iso",
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "svg",
    "mp3", "mp4", "wav", "avi", "mov", "mkv",
    "woff", "woff2", "ttf", "eot",
    "map", "min", "pyc", "class", "wasm",
];

const IGNORE_FILE_SUFFIXES: &[&str] = &[
    ".min.js", ".min.css", ".bundle.js", ".chunk.js",
    ".lock", "-lock.json", ".DS_Store",
];

const IGNORE_FILE_NAMES: &[&str] = &[
    "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "cargo.lock",
    "composer.lock", "gemfile.lock", "poetry.lock",
];

const META_FILE_NAMES: &[&str] = &[
    "test_queries.md",
    "test_questions.md",
    "test_manifest.json",
    "readme.md",
];

const META_PATH_SEGMENTS: &[&str] = &["_meta/", "/_meta/"];

/// Index/intake markdown that pollutes retrieval if indexed as knowledge.
pub fn is_meta_knowledge_file(name: &str, relative_path: Option<&str>) -> bool {
    let lower_name = name.to_lowercase();
    if META_FILE_NAMES.iter().any(|item| lower_name == *item) {
        return true;
    }
    if lower_name.contains("index") && (lower_name.ends_with(".md") || lower_name.ends_with(".markdown")) {
        if lower_name.contains("intake") || lower_name.contains("-index") {
            return true;
        }
    }
    if let Some(relative) = relative_path {
        let lower_rel = relative.replace('\\', "/").to_lowercase();
        if META_PATH_SEGMENTS.iter().any(|seg| lower_rel.contains(seg)) {
            return true;
        }
    }
    false
}

/// Chunk text that looks like index scaffolding rather than source knowledge.
pub fn is_meta_chunk_text(text: &str) -> bool {
    let lower = text.to_lowercase();
    lower.contains("generated:")
        || lower.contains("source pdf:")
        || lower.contains("next steps for full indexing")
        || lower.contains("visual table-of-contents or diagram page")
        || lower.contains("suggested test queries")
        || lower.contains("what does error code e-")
        || lower.contains("what environment variable controls")
        || lower.contains("what is the first step when responding")
}

/// Higher priority indexes first (lower number = higher priority).
pub fn priority_tier_for_path(relative_path: &str) -> i64 {
    let lower = relative_path.replace('\\', "/").to_lowercase();
    if lower.contains("/docs/") || lower.contains("/documentation/") || lower.ends_with(".md") {
        return 0;
    }
    if lower.contains("/policy") || lower.contains("/policies/") || lower.contains("/sop") || lower.contains("/runbook") {
        return 0;
    }
    if lower.contains("/log") || lower.contains("/archive/") || lower.contains("/tmp/") {
        return 3;
    }
    if lower.contains("/test/") || lower.contains("/tests/") || lower.contains("/spec/") {
        return 2;
    }
    1
}

pub fn should_skip_file(name: &str, extension: &str, relative_path: Option<&str>) -> Option<String> {
    let lower_name = name.to_lowercase();
    let ext = extension.to_lowercase();

    if is_meta_knowledge_file(&lower_name, relative_path) {
        return Some("Skipped index/test metadata file.".to_string());
    }

    if lower_name.ends_with("-ocr-test.md") || lower_name.ends_with("-ocr-test.markdown") {
        return Some("Skipped OCR test/draft markdown.".to_string());
    }

    if let Some(relative) = relative_path {
        let lower_rel = relative.replace('\\', "/").to_lowercase();
        if lower_rel.contains("11_import_ready/")
            && (lower_name.ends_with("-ocr.md") || lower_name.ends_with("-ocr.markdown"))
        {
            return Some("Skipped staged OCR duplicate in import_ready folder.".to_string());
        }
    }

    if IGNORE_FILE_NAMES.iter().any(|item| lower_name == *item) {
        return Some("Skipped lock/metadata file.".to_string());
    }

    if IGNORE_EXTENSIONS.contains(&ext.as_str()) {
        return Some(format!("Skipped binary/media extension '.{ext}'."));
    }

    for suffix in IGNORE_FILE_SUFFIXES {
        if lower_name.ends_with(suffix) {
            return Some(format!("Skipped generated/noisy file pattern '{suffix}'."));
        }
    }

    if lower_name.starts_with('.') && ext != "md" && ext != "json" && ext != "yaml" && ext != "yml" {
        return Some("Skipped hidden/system dotfile.".to_string());
    }

    None
}

pub fn is_usable_extracted_text(text: &str) -> Result<(), String> {
    is_usable_extracted_text_for_extension(text, "")
}

pub fn is_usable_extracted_text_for_extension(text: &str, extension: &str) -> Result<(), String> {
    let cleaned = clean_text(text);
    let ext = extension.to_lowercase();
    let (min_chars, min_alpha) = if uses_code_min_chars(&ext) {
        (MIN_EXTRACTABLE_CHARS_CODE, MIN_EXTRACTABLE_ALPHA_CODE)
    } else {
        (MIN_EXTRACTABLE_CHARS, 20)
    };
    if cleaned.chars().count() < min_chars {
        return Err(format!(
            "Extracted text too short for reliable indexing (minimum {min_chars} characters)."
        ));
    }
    let alpha = cleaned.chars().filter(|c| c.is_alphabetic()).count();
    if alpha < min_alpha {
        return Err("Extracted content appears non-textual or empty.".to_string());
    }
    Ok(())
}

/// Benign indexing outcomes that should mark a file skipped, not failed.
pub fn should_treat_index_message_as_skip(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    lower.starts_with("skipped ")
        || lower.contains("too short")
        || lower.contains("non-textual")
        || lower.contains("no searchable text")
        || lower.contains("no extraction result")
}

pub fn normalized_text_fingerprint(text: &str) -> String {
    use sha2::{Digest, Sha256};
    let normalized = clean_text(text).to_lowercase();
    let mut hasher = Sha256::new();
    hasher.update(normalized.as_bytes());
    format!("{:x}", hasher.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skips_meta_manifest_files() {
        assert!(is_meta_knowledge_file("TEST_MANIFEST.json", None));
        assert!(is_meta_knowledge_file("test_queries.md", Some("_meta\\test_queries.md")));
    }

    #[test]
    fn detects_meta_chunk_text() {
        assert!(is_meta_chunk_text("Generated: intake summary for indexing"));
        assert!(!is_meta_chunk_text("Escalate VPN brute force with successful login to tier 2."));
    }

    #[test]
    fn classifies_benign_index_messages_as_skip() {
        assert!(should_treat_index_message_as_skip(
            "Extracted text too short for reliable indexing (minimum 48 characters)."
        ));
        assert!(should_treat_index_message_as_skip("Skipped lock/metadata file."));
        assert!(!should_treat_index_message_as_skip("PDF OCR script failed: timeout"));
    }
}
