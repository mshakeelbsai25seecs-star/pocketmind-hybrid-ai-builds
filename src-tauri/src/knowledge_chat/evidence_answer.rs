use crate::knowledge_chat::context_bundle::MIN_LLM_BUNDLE_CONFIDENCE;
use crate::knowledge_chat::query_intent::is_explain_code_question;
use crate::knowledge_chat::types::{KcEvidenceItem, KcSearchHit};

const MAX_EVIDENCE_ITEMS: usize = 12;
const MAX_EXCERPT_CHARS: usize = 2000;

pub fn build_evidence_items(query: &str, hits: &[KcSearchHit]) -> Vec<KcEvidenceItem> {
    let mut sorted: Vec<&KcSearchHit> = hits
        .iter()
        .filter(|hit| hit.chunk.source_confidence.unwrap_or(0.0) >= MIN_LLM_BUNDLE_CONFIDENCE)
        .collect();
    sorted.sort_by(|a, b| {
        b.chunk
            .source_confidence
            .unwrap_or(0.0)
            .partial_cmp(&a.chunk.source_confidence.unwrap_or(0.0))
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    sorted
        .into_iter()
        .take(MAX_EVIDENCE_ITEMS)
        .map(|hit| evidence_item_from_hit(query, hit))
        .collect()
}

pub fn format_evidence_answer(query: &str, items: &[KcEvidenceItem]) -> Option<String> {
    if items.is_empty() {
        return None;
    }

    // File-level "what does X.ts do?" → one synthesized overview instead of thin
    // per-snippet "Defines the const …" lines.
    if is_explain_code_question(query) && file_focused_query(query) {
        if let Some(synthesized) = synthesize_file_evidence_overview(query, items) {
            return Some(synthesized);
        }
    }

    let mut sections = Vec::new();
    for item in items {
        let anchor = match item.line_start {
            Some(start) if start > 0 => {
                if let Some(end) = item.line_end {
                    if end > start {
                        format!(" (L{start}–L{end})")
                    } else {
                        format!(" (L{start})")
                    }
                } else {
                    format!(" (L{start})")
                }
            }
            _ => String::new(),
        };
        let header = format!("Based on {}{}:", item.file_name, anchor);
        let excerpt = if item.excerpt.contains('\n') || item.excerpt.len() > 80 {
            format!("```\n{}\n```", item.excerpt.trim())
        } else {
            format!("> {}", item.excerpt.trim())
        };
        let meaning = item
            .plain_summary
            .clone()
            .unwrap_or_else(|| "See excerpt above.".to_string());
        sections.push(format!(
            "{header}\n\n{excerpt}\n\n**What this means:** {meaning}"
        ));
    }
    let intro = if items.len() == 1 {
        "Here is the most relevant indexed source for your question.".to_string()
    } else {
        format!(
            "Here are {} indexed source excerpt(s) for your question (confidence >= {:.0}%). Each block includes the code and a short interpretation.",
            items.len(),
            MIN_LLM_BUNDLE_CONFIDENCE * 100.0,
        )
    };
    Some(format!("{intro}\n\n{}", sections.join("\n\n---\n\n")))
}

fn file_focused_query(query: &str) -> bool {
    query.split_whitespace().any(|token| {
        let cleaned = token.trim_matches(|c: char| !c.is_alphanumeric() && c != '.' && c != '_' && c != '-');
        cleaned.contains('.')
            && cleaned
                .rsplit_once('.')
                .map(|(_, ext)| {
                    matches!(
                        ext.to_ascii_lowercase().as_str(),
                        "ts" | "tsx" | "js" | "jsx" | "py" | "rs" | "go" | "java" | "kt" | "cs"
                    )
                })
                .unwrap_or(false)
    })
}

fn synthesize_file_evidence_overview(query: &str, items: &[KcEvidenceItem]) -> Option<String> {
    let file = items.first()?.file_name.clone();
    if !items.iter().all(|i| i.file_name.eq_ignore_ascii_case(&file)) {
        // Mixed files — keep the multi-section layout.
        return None;
    }
    let mut lines = Vec::new();
    lines.push(format!("## Purpose\n\n`{file}` — overview from indexed symbols for: {query}"));
    lines.push("## Key symbols\n".to_string());
    for item in items.iter().take(10) {
        let anchor = item
            .line_start
            .map(|s| {
                if let Some(e) = item.line_end.filter(|e| *e > s) {
                    format!(" (L{s}–L{e})")
                } else {
                    format!(" (L{s})")
                }
            })
            .unwrap_or_default();
        let meaning = item
            .plain_summary
            .clone()
            .unwrap_or_else(|| "see excerpt".to_string());
        lines.push(format!("- **{}**{anchor}: {meaning}", item.label));
    }
    lines.push("## Evidence excerpts\n".to_string());
    for item in items.iter().take(6) {
        let excerpt = item.excerpt.trim();
        if excerpt.is_empty() {
            continue;
        }
        lines.push(format!("### {}\n\n```\n{excerpt}\n```", item.label));
    }
    lines.push(format!("[Source: {file}]"));
    Some(lines.join("\n"))
}

fn evidence_item_from_hit(query: &str, hit: &KcSearchHit) -> KcEvidenceItem {
    let excerpt = excerpt_for_hit(hit);
    let label = label_for_hit(hit);
    KcEvidenceItem {
        file_name: hit.chunk.file_name.clone(),
        label,
        line_start: hit.chunk.line_start,
        line_end: hit.chunk.line_end,
        excerpt: excerpt.clone(),
        source_confidence: hit.chunk.source_confidence.unwrap_or(0.0),
        plain_summary: Some(template_summary(query, hit, &excerpt)),
    }
}

fn excerpt_for_hit(hit: &KcSearchHit) -> String {
    let body = hit
        .chunk
        .context_text
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .or_else(|| {
            hit.relevant_snippet
                .as_deref()
                .filter(|s| !s.trim().is_empty())
        })
        .unwrap_or(hit.chunk.text.as_str());
    trim_chars(body, MAX_EXCERPT_CHARS)
}

fn label_for_hit(hit: &KcSearchHit) -> String {
    if let (Some(kind), Some(name)) = (&hit.chunk.entity_kind, &hit.chunk.entity_name) {
        return format!("{kind} {name}");
    }
    hit.chunk
        .section_path
        .clone()
        .or_else(|| Some(hit.chunk.title.clone()))
        .unwrap_or_else(|| hit.chunk.file_name.clone())
}

fn template_summary(query: &str, hit: &KcSearchHit, excerpt: &str) -> String {
    let q = query.to_lowercase();
    let file = hit.chunk.file_name.to_lowercase();
    let partition = hit.chunk.partition_id.as_deref().unwrap_or("");
    let excerpt_lower = excerpt.to_lowercase();

    if let Some(code) = extract_error_code(query) {
        if excerpt.contains(&code) {
            if let Some(msg) = extract_json_error_message(excerpt, &code) {
                return format!("Error {code} means: {msg}");
            }
        }
    }

    if q.contains("environment variable") || q.contains("env var") || q.contains("timeout") {
        if excerpt_lower.contains("environ") || excerpt_lower.contains("_env") {
            if let Some(var) = extract_env_var_name(excerpt) {
                return format!(
                    "Reads `{var}` from the environment; falls back to a default if unset or invalid."
                );
            }
        }
        if q.contains("load_api_timeout") || excerpt_lower.contains("load_api_timeout") {
            if let Some(var) = extract_env_var_name(excerpt) {
                return format!(
                    "Reads `{var}` from the environment; falls back to a default if unset or invalid."
                );
            }
            return "Reads an API timeout from the environment, with a default fallback and minimum bound.".to_string();
        }
    }

    if is_explain_code_question(query) {
        if let Some(name) = hit.chunk.entity_name.as_deref().filter(|n| is_plausible_entity_name(n)) {
            if query.to_lowercase().contains(&name.to_lowercase()) {
                if excerpt_lower.contains("environ") && excerpt_lower.contains("timeout") {
                    return "Reads the API timeout environment variable, with a default fallback and minimum bound.".to_string();
                }
            }
        }
    }

    if is_procedural_question(&q) {
        if partition == "runbooks" || file.contains("runbook") || file.contains("sop") || file.contains("incident") {
            if let Some(step) = extract_first_numbered_step(excerpt) {
                return format!("First step: {step}");
            }
        }
    }

    if is_timeline_question(&q) {
        if let Some(duration) = extract_duration_phrase(excerpt) {
            return format!("The indexed guide states the timeline is {duration}.");
        }
    }

    if let Some(name) = hit.chunk.entity_name.as_deref().filter(|n| is_plausible_entity_name(n)) {
        let kind = hit.chunk.entity_kind.as_deref().unwrap_or("symbol");
        let name_l = name.to_lowercase();
        if name_l.contains("subscribe") || excerpt_lower.contains("listeners.add") {
            return format!("`{name}` registers a listener and returns an unsubscribe callback.");
        }
        if name_l.contains("notify") || name_l.contains("emit") || excerpt_lower.contains("foreach") {
            return format!("`{name}` invokes every registered listener (broadcast/notify).");
        }
        if name_l.contains("listener") || excerpt_lower.contains("new set") {
            return format!("`{name}` stores the set of registered listener callbacks.");
        }
        // Prefer a slightly richer one-liner from the excerpt body.
        let first_code = excerpt
            .lines()
            .map(str::trim)
            .find(|l| {
                !l.is_empty()
                    && !l.starts_with("//")
                    && !l.starts_with("/*")
                    && !l.starts_with('*')
                    && !l.starts_with("This ")
            })
            .unwrap_or("");
        if first_code.len() > 24 {
            let clipped: String = first_code.chars().take(140).collect();
            return format!("`{name}` ({kind}): `{clipped}`");
        }
        return format!("`{name}` is a {kind} in `{}`.", hit.chunk.file_name);
    }

    if is_symbol_in_text(query, excerpt) {
        return "The source excerpt above defines or describes the symbol you asked about.".to_string();
    }

    "The excerpt above is the most relevant indexed passage for your question.".to_string()
}

fn is_procedural_question(q: &str) -> bool {
    q.contains("first step")
        || q.contains("what should i do")
        || q.contains("what do i do")
        || q.contains("how do i respond")
        || q.contains("how should i")
}

fn is_timeline_question(q: &str) -> bool {
    q.contains("how long")
        || q.contains("how many days")
        || q.contains("duration")
        || q.contains("take to")
}

fn is_plausible_entity_name(name: &str) -> bool {
    let lower = name.to_lowercase();
    const BLOCKED: &[&str] = &[
        "content", "input", "text", "message", "data", "result", "value", "error", "response",
        "output", "item", "state", "props", "event", "index", "count", "type", "name", "self",
    ];
    if BLOCKED.contains(&lower.as_str()) {
        return false;
    }
    name.len() >= 5
        && (name.contains('_')
            || name.chars().any(|c| c.is_uppercase()) && name.chars().any(|c| c.is_lowercase()))
}

fn extract_error_code(query: &str) -> Option<String> {
    query
        .split_whitespace()
        .find(|w| w.to_uppercase().starts_with("E-"))
        .map(|w| w.to_uppercase())
}

pub fn extract_json_error_message(excerpt: &str, code: &str) -> Option<String> {
    let pattern = format!("\"{code}\"");
    let idx = excerpt.find(&pattern)?;
    let tail = excerpt.get(idx + pattern.len()..)?;
    let after_key = tail.trim_start();
    let after_colon = after_key.strip_prefix(':').unwrap_or(after_key).trim_start();
    let msg = if after_colon.starts_with('"') {
        let inner = &after_colon[1..];
        let end = inner.find('"').unwrap_or(inner.len().min(200));
        inner[..end].trim().to_string()
    } else {
        after_colon
            .chars()
            .take(120)
            .collect::<String>()
            .trim()
            .trim_matches(',')
            .to_string()
    };
    if msg.is_empty() {
        None
    } else {
        Some(msg)
    }
}

pub fn extract_env_var_name(excerpt: &str) -> Option<String> {
    // Prefer quoted string literals (actual env keys), not DEFAULT_* constants.
    if let Some(token) = first_quoted_screaming_snake(excerpt) {
        return Some(token);
    }
    for needle in ["environ.get(", "os.environ.get(", "getenv(", "os.getenv("] {
        if let Some(idx) = excerpt.find(needle) {
            let after = &excerpt[idx + needle.len()..];
            if let Some(token) = first_screaming_snake_in(after) {
                return Some(token);
            }
        }
    }
    first_screaming_snake_in(excerpt)
}

fn is_screaming_snake(token: &str) -> bool {
    token.len() >= 4
        && token.contains('_')
        && token.chars().all(|c| c.is_ascii_uppercase() || c == '_')
}

fn first_quoted_screaming_snake(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() {
        let quote = bytes[i];
        if quote == b'"' || quote == b'\'' {
            i += 1;
            let start = i;
            while i < bytes.len() && bytes[i] != quote {
                i += 1;
            }
            if i > start {
                let token = &text[start..i];
                if is_screaming_snake(token) {
                    return Some(token.to_string());
                }
            }
        }
        i += 1;
    }
    None
}

fn first_screaming_snake_in(text: &str) -> Option<String> {
    for token in text.split(|c: char| !c.is_ascii_uppercase() && c != '_') {
        if is_screaming_snake(token) {
            return Some(token.to_string());
        }
    }
    None
}

pub fn extract_first_numbered_step(excerpt: &str) -> Option<String> {
    for line in excerpt.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("1.") || trimmed.starts_with("1)") {
            let step = trimmed.trim_start_matches(|c: char| c.is_ascii_digit() || c == '.' || c == ')' || c == ' ');
            if step.len() >= 8 {
                return Some(step.chars().take(200).collect());
            }
        }
    }
    None
}

pub fn extract_duration_phrase(excerpt: &str) -> Option<String> {
    let cleaned = excerpt.replace("**", "");
    let lower = cleaned.to_lowercase();
    if lower.contains("business day") {
        if let Some(idx) = lower.find("business day") {
            let start = lower[..idx]
                .rfind(|c: char| !c.is_alphanumeric() && c != ' ')
                .map(|i| i + 1)
                .unwrap_or(0);
            let phrase: String = cleaned[start..]
                .chars()
                .take(80)
                .collect::<String>()
                .trim()
                .trim_matches(|c: char| c == '*' || c == '.')
                .to_string();
            if !phrase.is_empty() {
                return Some(phrase);
            }
        }
    }
    for word in excerpt.split_whitespace() {
        if word.chars().any(|c| c.is_ascii_digit()) && word.to_lowercase().contains("day") {
            return Some(word.to_string());
        }
    }
    None
}

fn is_symbol_in_text(query: &str, excerpt: &str) -> bool {
    for word in query.split(|c: char| !c.is_alphanumeric() && c != '_') {
        if word.len() > 4
            && word.chars().any(|c| c.is_uppercase())
            && word.chars().any(|c| c.is_lowercase())
            && excerpt.contains(word)
        {
            return true;
        }
    }
    false
}

fn trim_chars(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    format!("{}…", text.chars().take(max).collect::<String>().trim())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::knowledge_chat::types::{KcChunkRecord, KcRetrievalMode, KcSearchHit};

    fn doc_hit(file: &str, partition: &str, text: &str) -> KcSearchHit {
        KcSearchHit {
            chunk: KcChunkRecord {
                id: "1".into(),
                collection_id: "c".into(),
                file_id: "f".into(),
                file_name: file.into(),
                file_path: file.into(),
                chunk_index: 0,
                title: file.into(),
                start_char: 0,
                end_char: 0,
                text: text.into(),
                top_terms: vec![],
                has_dense: true,
                parent_text: None,
                section_path: None,
                doc_type: Some(partition.into()),
                partition_id: Some(partition.into()),
                context_text: None,
                line_start: None,
                line_end: None,
                page_start: None,
                page_end: None,
                source_type: "chunk".into(),
                entity_kind: None,
                entity_name: None,
                source_confidence: Some(0.35),
                parse_mode: None,
            },
            retrieval_mode: KcRetrievalMode::HybridDense,
            keyword_score: 40.0,
            lexical_score: 50.0,
            dense_score: 30.0,
            fts_score: 2.0,
            rerank_score: 0.4,
            fused_score: 0.4,
            rank: 1,
            relevant_snippet: None,
        }
    }

    #[test]
    fn vpn_first_step_summary() {
        let text = "## Steps\n\n1. **Contain** — Block the source IP on the VPN gateway.\n2. Triage";
        let hit = doc_hit("vpn-incident-response.md", "runbooks", text);
        let item = evidence_item_from_hit("What is the first step for a VPN brute-force alert?", &hit);
        assert!(item.plain_summary.as_ref().unwrap().contains("Contain"));
    }

    #[test]
    fn formats_multi_source_evidence_answer() {
        let items = vec![KcEvidenceItem {
            file_name: "ChatView.tsx".into(),
            label: "function handleSend".into(),
            line_start: Some(10),
            line_end: Some(16),
            excerpt: "const handleSend = async () => {".into(),
            source_confidence: 0.55,
            plain_summary: Some("Sends the trimmed message.".into()),
        }];
        let answer = format_evidence_answer("what does handleSend do", &items).unwrap();
        assert!(answer.contains("What this means"));
        assert!(answer.contains("handleSend"));
    }
}
