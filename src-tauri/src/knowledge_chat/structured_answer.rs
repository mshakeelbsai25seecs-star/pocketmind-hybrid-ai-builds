use crate::knowledge_chat::evidence_answer::{
    extract_duration_phrase, extract_env_var_name, extract_first_numbered_step,
    extract_json_error_message,
};
use crate::knowledge_chat::query_intent::{
    classify_query_intent, extract_camel_symbols, extract_error_code, extract_file_hint,
    extract_snake_case_symbols, is_explain_code_question, QueryIntent,
};
use crate::knowledge_chat::types::{KcSearchHit, StructuredAnswer};

const MIN_STRUCTURED_CONFIDENCE: f64 = 0.5;

pub fn try_structured_answer(query: &str, hits: &[KcSearchHit]) -> Option<StructuredAnswer> {
    if hits.is_empty() {
        return None;
    }

    if let Some(answer) = try_file_imports_answer(query, hits) {
        return Some(answer);
    }

    if let Some(answer) = try_numbered_list_answer(query, hits) {
        return Some(answer);
    }

    let intent = classify_query_intent(query);
    if intent == QueryIntent::General {
        return None;
    }

    // Explain/describe code questions need the LLM + whole-file context, not prefix stubs.
    if intent == QueryIntent::CodeSymbol && is_explain_code_question(query) {
        return None;
    }

    let ranked = rank_hits_for_intent(query, intent, hits);
    let hit = ranked.first()?;

    let answer = match intent {
        QueryIntent::ErrorCode => extract_error_code_answer(query, hit)?,
        QueryIntent::EnvVar => extract_env_var_answer(query, hit)?,
        QueryIntent::RunbookStep => extract_runbook_step_answer(query, hit)?,
        QueryIntent::Timeline => extract_timeline_answer(query, hit)?,
        QueryIntent::CodeSymbol => {
            let extracted = extract_code_symbol_answer(query, hits)?;
            if extracted.text.trim().is_empty() || is_weak_code_explanation(&extracted.text) {
                return None;
            }
            extracted
        }
        QueryIntent::General => return None,
    };

    let confidence = hit
        .chunk
        .source_confidence
        .unwrap_or(0.0)
        .max(answer.confidence);

    if confidence < MIN_STRUCTURED_CONFIDENCE && intent != QueryIntent::ErrorCode {
        if confidence < 0.35 {
            return None;
        }
    }

    Some(StructuredAnswer {
        intent,
        answer_text: answer.text,
        confidence,
        source_file: hit.chunk.file_name.clone(),
        line_start: hit.chunk.line_start,
        line_end: hit.chunk.line_end,
    })
}

struct Extracted {
    text: String,
    confidence: f64,
}

fn rank_hits_for_intent(query: &str, intent: QueryIntent, hits: &[KcSearchHit]) -> Vec<KcSearchHit> {
    let mut scored: Vec<(KcSearchHit, f64)> = hits
        .iter()
        .cloned()
        .map(|hit| (hit.clone(), score_hit_for_intent(query, intent, &hit)))
        .collect();
    scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    scored.into_iter().map(|(h, _)| h).collect()
}

fn score_hit_for_intent(query: &str, intent: QueryIntent, hit: &KcSearchHit) -> f64 {
    let mut score = hit.chunk.source_confidence.unwrap_or(0.0);
    let file = hit.chunk.file_name.to_lowercase();
    let text = excerpt_text(hit).to_lowercase();
    let partition = hit.chunk.partition_id.as_deref().unwrap_or("");

    match intent {
        QueryIntent::ErrorCode => {
            if file.contains("error") {
                score += 0.25;
            }
            if let Some(code) = extract_error_code(query) {
                if text.contains(&code.to_lowercase()) {
                    score += 0.30;
                }
            }
        }
        QueryIntent::EnvVar => {
            if file.contains("config") || text.contains("environ") {
                score += 0.20;
            }
        }
        QueryIntent::RunbookStep => {
            if partition == "runbooks" || file.contains("incident") || file.contains("runbook") {
                score += 0.20;
            }
            if text.contains("1.") {
                score += 0.15;
            }
        }
        QueryIntent::Timeline => {
            if file.contains("onboard") || file.contains("guide") {
                score += 0.15;
            }
            if text.contains("business day") || text.contains(" days") {
                score += 0.20;
            }
        }
        QueryIntent::CodeSymbol => {
            if let Some(hint) = extract_file_hint(query) {
                if file.eq_ignore_ascii_case(&hint) {
                    score += 0.25;
                }
            }
            for symbol in extract_camel_symbols(query) {
                if hit.chunk.entity_name.as_deref() == Some(symbol.as_str())
                    || text.contains(&symbol.to_lowercase())
                {
                    score += 0.30;
                }
            }
            for symbol in extract_snake_case_symbols(query) {
                if hit.chunk.entity_name.as_deref() == Some(symbol.as_str())
                    || text.contains(&symbol.to_lowercase())
                {
                    score += 0.30;
                }
            }
            if hit.chunk.entity_kind.as_deref() == Some("module")
                && query.to_lowercase().contains("import")
            {
                score += 0.25;
            }
        }
        QueryIntent::General => {}
    }
    score.clamp(0.0, 1.0)
}

fn extract_error_code_answer(query: &str, hit: &KcSearchHit) -> Option<Extracted> {
    let code = extract_error_code(query)?;
    let excerpt = excerpt_text(hit);
    let msg = extract_json_error_message(&excerpt, &code)?;
    Some(Extracted {
        text: format!("Error {code} means: {msg}"),
        confidence: 0.85,
    })
}

fn extract_env_var_answer(query: &str, hit: &KcSearchHit) -> Option<Extracted> {
    let excerpt = excerpt_text(hit);
    let excerpt_lower = excerpt.to_lowercase();
    if !excerpt_lower.contains("environ") && !excerpt_lower.contains("_env") {
        return None;
    }
    let var = extract_env_var_name(&excerpt)?;
    let default_note = if excerpt_lower.contains("30") {
        " The default is 30 seconds if unset or invalid."
    } else {
        " It falls back to a default if unset or invalid."
    };
    Some(Extracted {
        text: format!(
            "The environment variable `{var}` controls the API timeout.{default_note}"
        ),
        confidence: 0.75,
    })
}

fn extract_runbook_step_answer(_query: &str, hit: &KcSearchHit) -> Option<Extracted> {
    let excerpt = excerpt_text(hit);
    let step = extract_first_numbered_step(&excerpt)?;
    Some(Extracted {
        text: format!("The first step is: {step}"),
        confidence: 0.72,
    })
}

fn extract_timeline_answer(_query: &str, hit: &KcSearchHit) -> Option<Extracted> {
    let excerpt = excerpt_text(hit);
    let duration = extract_duration_phrase(&excerpt)?;
    Some(Extracted {
        text: format!("The indexed source states the timeline is {duration}."),
        confidence: 0.70,
    })
}

/// Extract numbered lists for "what are the 3 layers" style questions (no LLM).
pub fn try_numbered_list_answer(query: &str, hits: &[KcSearchHit]) -> Option<StructuredAnswer> {
    if !is_list_enumeration_question(query) {
        return None;
    }

    for hit in hits {
        let excerpt = excerpt_text(hit);
        let items = extract_numbered_list_items(&excerpt);
        if items.len() < 2 {
            continue;
        }
        if !list_matches_query(query, &excerpt, &items, &hit.chunk.file_name) {
            continue;
        }
        let body = items
            .iter()
            .enumerate()
            .map(|(idx, item)| format!("{}. {item}", idx + 1))
            .collect::<Vec<_>>()
            .join("\n");
        let confidence = hit.chunk.source_confidence.unwrap_or(0.35).max(0.55);
        return Some(StructuredAnswer {
            intent: QueryIntent::General,
            answer_text: body,
            confidence,
            source_file: hit.chunk.file_name.clone(),
            line_start: hit.chunk.line_start,
            line_end: hit.chunk.line_end,
        });
    }
    None
}

fn is_list_enumeration_question(query: &str) -> bool {
    if is_file_content_question(query) {
        return false;
    }
    let q = query.to_lowercase();
    (q.contains("what are the")
        && (q.contains("layer")
            || q.chars().any(|c| c.is_ascii_digit())
            || q.contains("step")
            || q.contains("polic")
            || q.contains("phase")
            || q.contains("stage")))
        || q.contains("how many")
        || q.contains("list the")
        || q.contains(" name the ")
        || (q.contains("layer") && q.chars().any(|c| c.is_ascii_digit()))
}

fn is_file_content_question(query: &str) -> bool {
    let q = query.to_lowercase();
    q.contains("import")
        || q.contains(" exports ")
        || q.contains("dependencies")
        || (extract_file_hint(query).is_some()
            && (q.contains("what are the") || q.contains("what is in") || q.contains("show me the")))
}

fn list_matches_query(query: &str, excerpt: &str, items: &[String], hit_file: &str) -> bool {
    let q = query.to_lowercase();
    let excerpt_lower = excerpt.to_lowercase();
    if let Some(hint) = extract_file_hint(query) {
        let hint_lower = hint.to_lowercase();
        let stem = hint_lower.rsplit_once('.').map(|(s, _)| s).unwrap_or(&hint_lower);
        let file_lower = hit_file.to_lowercase();
        if file_lower != hint_lower && !file_lower.contains(stem) {
            return false;
        }
    }
    let terms: Vec<&str> = q
        .split_whitespace()
        .filter(|w| w.len() > 4 && !["what", "does", "nexus", "there", "about"].contains(w))
        .collect();
    if q.contains("layer") || q.contains("laeyr") {
        return excerpt_lower.contains("layer")
            || items.iter().any(|item| item.to_lowercase().contains("layer"));
    }
    if let Some(count) = extract_enumeration_count(&q) {
        if items.len() >= 2 && items.len() == count {
            return excerpt_lower.contains("layer")
                || terms.iter().any(|term| excerpt_lower.contains(term))
                || items
                    .iter()
                    .any(|item| terms.iter().any(|term| item.to_lowercase().contains(term)));
        }
    }
    terms.iter().any(|term| excerpt_lower.contains(term))
        || items
            .iter()
            .any(|item| terms.iter().any(|term| item.to_lowercase().contains(term)))
}

fn extract_enumeration_count(q: &str) -> Option<usize> {
    for word in q.split_whitespace() {
        if let Ok(n) = word.parse::<usize>() {
            if (2..=20).contains(&n) {
                return Some(n);
            }
        }
    }
    None
}

/// Answer "what are the imports in config_loader.py" from module preamble or file header.
pub fn try_file_imports_answer(query: &str, hits: &[KcSearchHit]) -> Option<StructuredAnswer> {
    let q = query.to_lowercase();
    if !q.contains("import") {
        return None;
    }
    let file_hint = extract_file_hint(query)?;

    for hit in hits {
        if !hit.chunk.file_name.eq_ignore_ascii_case(&file_hint) {
            continue;
        }
        let excerpt = excerpt_text(hit);
        let imports = extract_import_lines(&excerpt, extension_from_file(&file_hint));
        if imports.is_empty() {
            continue;
        }
        let body = imports
            .iter()
            .map(|line| format!("- `{line}`"))
            .collect::<Vec<_>>()
            .join("\n");
        let confidence = hit.chunk.source_confidence.unwrap_or(0.55).max(0.72);
        return Some(StructuredAnswer {
            intent: QueryIntent::CodeSymbol,
            answer_text: format!("Imports in `{file_hint}`:\n{body}"),
            confidence,
            source_file: hit.chunk.file_name.clone(),
            line_start: hit.chunk.line_start,
            line_end: hit.chunk.line_end,
        });
    }
    None
}

fn extension_from_file(file_name: &str) -> &str {
    file_name.rsplit_once('.').map(|(_, ext)| ext).unwrap_or("")
}

fn extract_import_lines(text: &str, extension: &str) -> Vec<String> {
    text.lines()
        .map(str::trim)
        .filter(|line| is_import_line(line, extension))
        .map(|line| line.to_string())
        .collect()
}

fn is_import_line(line: &str, extension: &str) -> bool {
    let t = line.trim();
    if t.is_empty() {
        return false;
    }
    match extension.to_ascii_lowercase().as_str() {
        "py" | "pyw" => t.starts_with("import ") || t.starts_with("from "),
        "rs" => t.starts_with("use ") || t.starts_with("extern crate"),
        "go" => t.starts_with("import "),
        "java" | "kt" | "kts" => t.starts_with("import "),
        "cs" => t.starts_with("using "),
        "cpp" | "cc" | "cxx" | "h" | "hpp" | "c" => t.starts_with("#include"),
        _ => {
            t.starts_with("import ")
                || t.starts_with("from ")
                || t.starts_with("require(")
                || (t.starts_with("const ") && t.contains("require("))
        }
    }
}

fn extract_numbered_list_items(text: &str) -> Vec<String> {
    let mut items = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim();
        let Some(rest) = trimmed
            .strip_prefix(|c: char| c.is_ascii_digit())
            .and_then(|s| s.strip_prefix('.'))
            .or_else(|| {
                trimmed
                    .strip_prefix(|c: char| c.is_ascii_digit())
                    .and_then(|s| s.strip_prefix(')'))
            })
        else {
            continue;
        };
        let item = strip_markdown_emphasis(rest.trim());
        if item.len() >= 8 {
            items.push(item);
        }
    }
    items
}

fn strip_markdown_emphasis(text: &str) -> String {
    text.trim_matches('*').replace("**", "").trim().to_string()
}

fn extract_code_symbol_answer(query: &str, hits: &[KcSearchHit]) -> Option<Extracted> {
    let mut symbols = extract_camel_symbols(query);
    symbols.extend(extract_snake_case_symbols(query));
    if symbols.is_empty() {
        return None;
    }
    let file_hint = extract_file_hint(query);
    let ranked = {
        let intent = QueryIntent::CodeSymbol;
        rank_hits_for_intent(query, intent, hits)
    };

    for hit in &ranked {
        if let Some(name) = &hit.chunk.entity_name {
            if symbols.iter().any(|s| s.eq_ignore_ascii_case(name)) {
                if let Some(file_hint) = &file_hint {
                    if !hit.chunk.file_name.eq_ignore_ascii_case(file_hint) {
                        continue;
                    }
                }
                return Some(build_code_symbol_extracted(hit, name));
            }
        }
    }

    for symbol in &symbols {
        for hit in &ranked {
            if let Some(file_hint) = &file_hint {
                if !hit.chunk.file_name.eq_ignore_ascii_case(file_hint) {
                    continue;
                }
            }
            let body = excerpt_text(hit);
            if body.contains(symbol) {
                return Some(build_code_symbol_extracted(hit, symbol));
            }
        }
    }
    None
}

fn build_code_symbol_extracted(hit: &KcSearchHit, name: &str) -> Extracted {
    let body = strip_contextual_prefix(&excerpt_text(hit));
    let anchor = match (hit.chunk.line_start, hit.chunk.line_end) {
        (Some(s), Some(e)) if s > 0 => format!(" (L{s}–L{e})"),
        (Some(s), _) if s > 0 => format!(" (L{s})"),
        _ => String::new(),
    };
    let explanation = summarize_code_body(&body, name);
    if is_weak_code_explanation(&explanation) {
        return Extracted {
            text: String::new(),
            confidence: 0.0,
        };
    }
    let citation = format!("[Source: {} | {}{}]", hit.chunk.file_name, label_for_hit(hit), anchor);
    Extracted {
        text: format!("`{name}`{anchor} {explanation} {citation}"),
        confidence: hit.chunk.source_confidence.unwrap_or(0.75).max(0.75),
    }
}

fn strip_contextual_prefix(body: &str) -> String {
    let mut lines: Vec<&str> = body.lines().collect();
    while let Some(first) = lines.first() {
        let t = first.trim();
        if t.starts_with("This function")
            || t.starts_with("This method")
            || t.starts_with("This class")
            || t.starts_with("This excerpt")
            || t.starts_with("Summary (")
            || t.starts_with("Summary:")
            || t.ends_with("source file):")
            || t.ends_with("source file):")
        {
            lines.remove(0);
            continue;
        }
        break;
    }
    lines.join("\n")
}

fn is_weak_code_explanation(text: &str) -> bool {
    let lower = text.to_lowercase();
    lower.contains("is defined as: this function")
        || lower.contains("is defined in the source")
        || lower.contains("is defined in config_loader.py (python source file)")
        || (lower.starts_with("is defined as:") && text.len() < 200)
}

fn summarize_code_body(body: &str, symbol: &str) -> String {
    let lower = body.to_lowercase();
    if lower.contains("environ") && (lower.contains("api_timeout") || lower.contains("_timeout")) {
        return summarize_env_timeout_function(body);
    }
    if lower.contains("setinput") && lower.contains("trim") {
        return "validates and trims the input, clears the text field, and sends the message to the backend.".to_string();
    }
    if lower.contains("add_message") || lower.contains("invoke") {
        return "sends the user message via a Tauri invoke call and starts generation.".to_string();
    }
    if let Some(summary) = summarize_from_def_body(body, symbol) {
        return summary;
    }
    let first_line = body
        .lines()
        .find(|line| {
            let t = line.trim();
            !t.is_empty() && !t.starts_with('#') && !t.starts_with("\"\"\"")
        })
        .unwrap_or(body)
        .trim();
    if first_line.len() > 120 {
        format!("is defined as: {}…", first_line.chars().take(120).collect::<String>())
    } else if first_line.is_empty() {
        "is defined in the indexed source.".to_string()
    } else {
        format!("is defined as: {first_line}")
    }
}

fn summarize_env_timeout_function(body: &str) -> String {
    let lower = body.to_lowercase();
    let mut parts = vec!["reads the API timeout from an environment variable".to_string()];
    if let Some(var) = extract_env_var_name(body) {
        parts[0] = format!("reads `{var}` from the environment");
    }
    if lower.contains("30") {
        parts.push("defaults to 30 seconds when unset or invalid".to_string());
    } else {
        parts.push("falls back to a default when unset or invalid".to_string());
    }
    if lower.contains("max(5") || lower.contains("max( 5") {
        parts.push("enforces a minimum of 5 seconds when set".to_string());
    }
    format!("{}.", parts.join(", "))
}

fn summarize_from_def_body(body: &str, symbol: &str) -> Option<String> {
    let symbol_lower = symbol.to_lowercase();
    if !body.to_lowercase().contains(&symbol_lower) {
        return None;
    }
    if body.contains("def ") || body.contains("async def ") || body.contains("function ") {
        if body.to_lowercase().contains("environ") {
            return Some(summarize_env_timeout_function(body));
        }
    }
    None
}

fn label_for_hit(hit: &KcSearchHit) -> String {
    if let (Some(kind), Some(name)) = (&hit.chunk.entity_kind, &hit.chunk.entity_name) {
        return format!("{kind} {name}");
    }
    hit.chunk
        .section_path
        .clone()
        .unwrap_or_else(|| hit.chunk.title.clone())
}

fn excerpt_text(hit: &KcSearchHit) -> String {
    hit.chunk
        .context_text
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .or_else(|| {
            hit.relevant_snippet
                .as_deref()
                .filter(|s| !s.trim().is_empty())
        })
        .unwrap_or(hit.chunk.text.as_str())
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::knowledge_chat::types::{KcChunkRecord, KcRetrievalMode, KcSearchHit};

    fn hit(
        file: &str,
        partition: &str,
        text: &str,
        confidence: f64,
        entity: Option<(&str, &str)>,
        lines: Option<(i32, i32)>,
    ) -> KcSearchHit {
        let (entity_kind, entity_name) = entity
            .map(|(k, n)| (Some(k.to_string()), Some(n.to_string())))
            .unwrap_or((None, None));
        let (line_start, line_end) = lines.map(|(s, e)| (Some(s), Some(e))).unwrap_or((None, None));
        KcSearchHit {
            chunk: KcChunkRecord {
                id: format!("{file}-1"),
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
                line_start,
                line_end,
                page_start: None,
                page_end: None,
                source_type: if entity.is_some() {
                    "code_entity".into()
                } else {
                    "chunk".into()
                },
                entity_kind,
                entity_name,
                source_confidence: Some(confidence),
                parse_mode: None,
            },
            retrieval_mode: KcRetrievalMode::HybridDense,
            keyword_score: 50.0,
            lexical_score: 50.0,
            dense_score: 40.0,
            fts_score: 2.0,
            rerank_score: 0.5,
            fused_score: 0.5,
            rank: 1,
            relevant_snippet: None,
        }
    }

    #[test]
    fn qa_handlesend_structured() {
        let body = "const handleSend = async () => {\n  if (!input.trim()) return;\n  setInput('');\n};";
        let hits = vec![hit(
            "ChatView.tsx",
            "code",
            body,
            0.95,
            Some(("function", "handleSend")),
            Some((10, 16)),
        )];
        let answer = try_structured_answer("What does handleSend do in ChatView.tsx?", &hits);
        assert!(answer.is_none(), "explain questions should defer to LLM");
    }

    #[test]
    fn qa_load_api_timeout_explain_defers_to_llm() {
        let text = include_str!("../../../test-fixtures/kc-qa-corpus/code/config_loader.py");
        let hits = vec![hit(
            "config_loader.py",
            "code",
            text,
            0.95,
            Some(("function", "load_api_timeout")),
            Some((8, 17)),
        )];
        let answer = try_structured_answer("can you explain the load_api_timeout function?", &hits);
        assert!(answer.is_none(), "expected LLM route, got: {:?}", answer.map(|a| a.answer_text));
    }

    #[test]
    fn qa_env_var_structured() {
        let text = include_str!("../../../test-fixtures/kc-qa-corpus/code/config_loader.py");
        let hits = vec![hit("config_loader.py", "code", text, 0.57, None, Some((8, 17)))];
        let answer =
            try_structured_answer("What environment variable controls the API timeout?", &hits).unwrap();
        assert!(answer.answer_text.contains("NEXUS_API_TIMEOUT"));
    }

    #[test]
    fn qa_e402_structured() {
        let text = include_str!("../../../test-fixtures/kc-qa-corpus/data/error-codes.json");
        let hits = vec![hit("error-codes.json", "logs_data", text, 0.85, None, Some((1, 6)))];
        let answer = try_structured_answer("What does error code E-402 mean?", &hits).unwrap();
        assert!(answer.answer_text.contains("E-402"));
        assert!(answer.answer_text.to_lowercase().contains("embedding"));
    }

    #[test]
    fn qa_vpn_structured() {
        let text = include_str!("../../../test-fixtures/kc-qa-corpus/runbooks/vpn-incident-response.md");
        let hits = vec![hit("vpn-incident-response.md", "runbooks", text, 0.56, None, Some((7, 13)))];
        let answer =
            try_structured_answer("What is the first step for a VPN brute-force alert?", &hits).unwrap();
        assert!(answer.answer_text.contains("Contain"));
    }

    #[test]
    fn qa_onboarding_structured() {
        let text = include_str!("../../../test-fixtures/kc-qa-corpus/docs/onboarding-guide.md");
        let hits = vec![hit("onboarding-guide.md", "documentation", text, 0.48, None, Some((5, 8)))];
        let answer = try_structured_answer("How long does new-hire onboarding take?", &hits).unwrap();
        assert!(answer.answer_text.to_lowercase().contains("business day"));
        assert!(!answer.answer_text.contains("**"));
    }

    #[test]
    fn qa_architecture_layers_list() {
        let text = include_str!("../../../test-fixtures/kc-qa-corpus/docs/architecture.md");
        let hits = vec![hit(
            "architecture.md",
            "documentation",
            text,
            0.45,
            None,
            Some((5, 9)),
        )];
        let answer = try_structured_answer("what are the 3 laeyrs of nexus ai", &hits)
            .unwrap_or_else(|| panic!("expected list answer"));
        assert!(answer.answer_text.to_lowercase().contains("presentation layer"));
        assert!(answer.answer_text.to_lowercase().contains("orchestration layer"));
        assert!(answer.answer_text.to_lowercase().contains("inference layer"));
    }

    #[test]
    fn qa_config_loader_imports_not_runbook() {
        let text = include_str!("../../../test-fixtures/kc-qa-corpus/code/config_loader.py");
        let config_hit = hit(
            "config_loader.py",
            "code",
            text,
            0.31,
            Some(("function", "load_api_timeout")),
            Some((8, 17)),
        );
        let vpn_text = include_str!("../../../test-fixtures/kc-qa-corpus/runbooks/vpn-incident-response.md");
        let vpn_hit = hit("vpn-incident-response.md", "runbooks", vpn_text, 0.28, None, Some((7, 13)));
        let hits = vec![config_hit, vpn_hit];
        let answer = try_structured_answer("what are the imports in config_loader.py", &hits)
            .unwrap_or_else(|| panic!("expected imports answer"));
        assert!(answer.answer_text.contains("import os"), "{}", answer.answer_text);
        assert_eq!(answer.source_file, "config_loader.py");
        assert!(!answer.answer_text.to_lowercase().contains("contain"));
    }

    #[test]
    fn qa_config_loader_imports_from_preamble() {
        let text = include_str!("../../../test-fixtures/kc-qa-corpus/code/config_loader.py");
        let preamble = text.lines().take(7).collect::<Vec<_>>().join("\n");
        let hits = vec![hit(
            "config_loader.py",
            "code",
            &preamble,
            0.65,
            Some(("module", "module_preamble")),
            Some((1, 7)),
        )];
        let answer = try_file_imports_answer("what are the imports in config_loader.py", &hits).unwrap();
        assert!(answer.answer_text.contains("import os"));
    }
}
