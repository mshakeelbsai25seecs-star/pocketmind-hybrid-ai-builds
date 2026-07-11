/// Contextual retrieval prefixes (Anthropic-style) without requiring an LLM at index time.
/// Prepends document location context to parent/embed text so dense and FTS match topic phrasing.

pub struct ContextualIndexInput<'a> {
    pub file_name: &'a str,
    pub relative_path: Option<&'a str>,
    pub section_path: &'a str,
    pub title: &'a str,
    pub doc_type: &'a str,
    pub partition_id: &'a str,
}

pub fn build_contextual_prefix(input: &ContextualIndexInput<'_>) -> String {
    let location = input
        .relative_path
        .filter(|p| !p.is_empty())
        .unwrap_or(input.file_name);
    let section = if input.section_path.trim().is_empty() {
        input.title.trim()
    } else {
        input.section_path.trim()
    };
    format!(
        "This excerpt is from {location} ({}, {} partition), section \"{}\":",
        input.doc_type, input.partition_id, section
    )
}

pub fn build_embed_text(prefix: &str, body: &str) -> String {
    let body = body.trim();
    if body.is_empty() {
        return prefix.trim().to_string();
    }
    format!("{prefix}\n{body}")
}

/// One-line deterministic summary for contextual indexing (no LLM required).
pub fn build_deterministic_summary(section: &str, body: &str) -> String {
    let section = section.trim();
    let sentence = first_meaningful_sentence(body);
    if sentence.is_empty() {
        if section.is_empty() {
            return String::new();
        }
        return format!("Topic: {section}.");
    }
    if section.is_empty() {
        return format!("Summary: {sentence}");
    }
    format!("Summary ({section}): {sentence}")
}

/// Optional LLM hook: when `llm_summaries` is true, callers may pass generated text;
/// otherwise uses deterministic summary. Pass `None` to skip enrichment.
pub fn build_enriched_embed_text(
    prefix: &str,
    body: &str,
    section: &str,
    llm_summaries: bool,
    llm_summary: Option<&str>,
) -> String {
    let summary = if llm_summaries {
        llm_summary
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| build_deterministic_summary(section, body))
    } else {
        String::new()
    };

    if summary.is_empty() {
        return build_embed_text(prefix, body);
    }
    let body = body.trim();
    if body.is_empty() {
        return format!("{prefix}\n{summary}");
    }
    format!("{prefix}\n{summary}\n{body}")
}

fn first_meaningful_sentence(body: &str) -> String {
    let cleaned = body.replace('\r', "\n");
    for line in cleaned.lines() {
        let line = line.trim();
        if line.len() < 12 {
            continue;
        }
        if line.starts_with('#') || line.starts_with("//") || line.starts_with("/*") {
            continue;
        }
        let end = line.find('.').map(|i| i + 1).unwrap_or(line.len().min(160));
        return line[..end.min(line.len())].trim().to_string();
    }
    cleaned
        .split_whitespace()
        .take(24)
        .collect::<Vec<_>>()
        .join(" ")
}

pub fn build_entity_contextual_prefix(
    file_name: &str,
    entity_kind: &str,
    entity_name: &str,
    language: &str,
) -> String {
    format!(
        "This {entity_kind} `{entity_name}` is defined in {file_name} ({language} source file):"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefix_includes_location() {
        let prefix = build_contextual_prefix(&ContextualIndexInput {
            file_name: "config_loader.py",
            relative_path: Some("code/config_loader.py"),
            section_path: "load_api_timeout",
            title: "load_api_timeout",
            doc_type: "code",
            partition_id: "code",
        });
        assert!(prefix.contains("config_loader"));
        assert!(prefix.contains("load_api_timeout"));
    }

    #[test]
    fn deterministic_summary_from_body() {
        let summary = build_deterministic_summary(
            "load_api_timeout",
            "def load_api_timeout():\n    return int(os.getenv('NEXUS_API_TIMEOUT', '30'))",
        );
        assert!(summary.contains("load_api_timeout") || summary.contains("NEXUS"));
    }
}
