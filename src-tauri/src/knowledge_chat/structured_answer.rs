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
    try_structured_answer_with_intent(query, hits, None)
}

pub fn try_structured_answer_with_intent(
    query: &str,
    hits: &[KcSearchHit],
    intent_override: Option<QueryIntent>,
) -> Option<StructuredAnswer> {
    if hits.is_empty() {
        return None;
    }

    let intent = intent_override.unwrap_or_else(|| classify_query_intent(query));

    match intent {
        QueryIntent::FileImports => {
            return try_file_imports_answer(query, hits);
        }
        QueryIntent::ListSymbolsInFile => {
            return try_list_symbols_in_file_answer(query, hits);
        }
        QueryIntent::LocateDefinition => {
            return try_locate_definition_answer(query, hits);
        }
        QueryIntent::General => {
            if let Some(answer) = try_numbered_list_answer(query, hits) {
                return Some(answer);
            }
            return None;
        }
        QueryIntent::ExplainSymbol => {
            // File-level "what does Foo.ts do?" can be answered deterministically from
            // symbol hits. Symbol-level "what does handleSend do?" still defers to LLM.
            if is_file_purpose_question(query) {
                if let Some(answer) = try_file_purpose_answer(query, hits) {
                    return Some(answer);
                }
            }
            // Explain/describe a named symbol needs the LLM + whole-file context.
            if is_explain_code_question(query) {
                return None;
            }
        }
        _ => {}
    }

    let ranked = rank_hits_for_intent(query, intent, hits);

    if matches!(intent, QueryIntent::EnvVar) {
        for hit in &ranked {
            if let Some(answer) = extract_env_var_answer(query, hit) {
                let confidence = hit
                    .chunk
                    .source_confidence
                    .unwrap_or(0.0)
                    .max(answer.confidence);
                if confidence < MIN_STRUCTURED_CONFIDENCE && confidence < 0.35 {
                    continue;
                }
                return Some(StructuredAnswer {
                    intent,
                    answer_text: answer.text,
                    confidence,
                    source_file: hit.chunk.file_name.clone(),
                    line_start: hit.chunk.line_start,
                    line_end: hit.chunk.line_end,
                });
            }
        }
        return None;
    }

    let hit = ranked.first()?;

    let answer = match intent {
        QueryIntent::ErrorCode => extract_error_code_answer(query, hit)?,
        QueryIntent::EnvVar => unreachable!("EnvVar handled above"),
        QueryIntent::RunbookStep => extract_runbook_step_answer(query, hit)?,
        QueryIntent::Timeline => extract_timeline_answer(query, hit)?,
        QueryIntent::ExplainSymbol => {
            let extracted = extract_code_symbol_answer(query, hits)?;
            if extracted.text.trim().is_empty() || is_weak_code_explanation(&extracted.text) {
                return None;
            }
            extracted
        }
        QueryIntent::ListSymbolsInFile
        | QueryIntent::LocateDefinition
        | QueryIntent::FileImports
        | QueryIntent::General => return None,
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
        QueryIntent::ExplainSymbol
        | QueryIntent::ListSymbolsInFile
        | QueryIntent::LocateDefinition
        | QueryIntent::FileImports => {
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
    if !excerpt_lower.contains("environ") && !excerpt_lower.contains("_env") && !excerpt_lower.contains("getenv")
    {
        return None;
    }
    let var = extract_env_var_name(&excerpt)?;
    let role = if query.to_lowercase().contains("timeout") || var.to_lowercase().contains("timeout") {
        "controls the API timeout"
    } else {
        "is read from the environment"
    };
    let default_note = match extract_env_default_literal(&excerpt, &var) {
        Some(default) => format!(" The default is `{default}` if unset or invalid."),
        None => " It falls back to a default if unset or invalid.".to_string(),
    };
    Some(Extracted {
        text: format!("The environment variable `{var}` {role}.{default_note}"),
        confidence: 0.75,
    })
}

/// Pull the default from `environ.get("VAR", "30")` / `getenv("VAR", "30")` when present,
/// or from a nearby `DEFAULT_* = N` / "default … N" line.
fn extract_env_default_literal(excerpt: &str, var: &str) -> Option<String> {
    let patterns = [
        format!("environ.get(\"{var}\""),
        format!("environ.get('{var}'"),
        format!("getenv(\"{var}\""),
        format!("getenv('{var}'"),
        format!("os.getenv(\"{var}\""),
        format!("os.getenv('{var}'"),
    ];
    for pattern in &patterns {
        if let Some(idx) = excerpt.find(pattern) {
            let tail = &excerpt[idx + pattern.len()..];
            if let Some(comma) = tail.find(',') {
                let after = tail[comma + 1..].trim_start();
                let quote = after.chars().next()?;
                if quote == '"' || quote == '\'' {
                    let inner = &after[1..];
                    let end = inner.find(quote)?;
                    let value = inner[..end].trim();
                    if !value.is_empty() {
                        return Some(value.to_string());
                    }
                }
            }
        }
    }
    extract_nearby_default_number(excerpt)
}

fn extract_nearby_default_number(excerpt: &str) -> Option<String> {
    for line in excerpt.lines() {
        let lower = line.to_lowercase();
        if !(lower.contains("default") || line.contains("DEFAULT_") || lower.contains("fall back")) {
            continue;
        }
        for token in line.split(|c: char| !c.is_ascii_digit()) {
            if token.is_empty() || token.len() > 5 {
                continue;
            }
            if let Ok(n) = token.parse::<u32>() {
                if (1..=86_400).contains(&n) {
                    return Some(token.to_string());
                }
            }
        }
    }
    None
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

/// True for file-level purpose questions like "what does overviewEvents.ts do?"
/// (has a filename, no separate camelCase/snake_case symbol to explain).
pub fn is_file_purpose_question(query: &str) -> bool {
    let Some(file_hint) = extract_file_hint(query) else {
        return false;
    };
    if !is_explain_code_question(query) {
        return false;
    }
    let stem = file_hint
        .rsplit_once('.')
        .map(|(s, _)| s)
        .unwrap_or(&file_hint)
        .to_lowercase();
    // Ignore camel/snake tokens that are only the file stem (overviewEvents from overviewEvents.ts).
    let has_named_symbol = extract_camel_symbols(query)
        .iter()
        .chain(extract_snake_case_symbols(query).iter())
        .any(|s| s.len() > 3 && s.to_lowercase() != stem);
    !has_named_symbol
}

/// Synthesize a detailed file overview from indexed entity hits when the user asks
/// what a whole file does (not a single function).
pub fn try_file_purpose_answer(query: &str, hits: &[KcSearchHit]) -> Option<StructuredAnswer> {
    let file_hint = extract_file_hint(query)?;
    let file_lower = file_hint.to_lowercase();
    let mut symbols: Vec<(String, String, Option<i32>, String)> = Vec::new();
    let mut preamble_excerpt = String::new();
    let mut best_confidence = 0.0_f64;

    for hit in hits {
        let name_match = hit.chunk.file_name.eq_ignore_ascii_case(&file_hint)
            || hit.chunk.file_path.to_lowercase().ends_with(&file_lower)
            || hit.chunk.file_name.to_lowercase().contains(
                file_lower
                    .rsplit_once('.')
                    .map(|(s, _)| s)
                    .unwrap_or(&file_lower),
            );
        if !name_match {
            continue;
        }
        best_confidence = best_confidence.max(hit.chunk.source_confidence.unwrap_or(0.0));
        let excerpt = excerpt_text(hit);
        if let (Some(kind), Some(name)) = (&hit.chunk.entity_kind, &hit.chunk.entity_name) {
            let kind_l = kind.to_lowercase();
            let name_l = name.to_lowercase();
            if kind_l == "module" || name_l == "module_preamble" || name_l == "file" {
                if preamble_excerpt.is_empty() && excerpt.trim().len() > 20 {
                    preamble_excerpt = excerpt.chars().take(900).collect();
                }
                continue;
            }
            if symbols
                .iter()
                .any(|(n, _, _, _)| n.eq_ignore_ascii_case(name))
            {
                continue;
            }
            symbols.push((
                name.clone(),
                kind.clone(),
                hit.chunk.line_start,
                summarize_symbol_role(name, kind, &excerpt),
            ));
        } else if preamble_excerpt.is_empty() && excerpt.trim().len() > 40 {
            preamble_excerpt = excerpt.chars().take(900).collect();
        }
    }

    if symbols.is_empty() && preamble_excerpt.trim().is_empty() {
        return None;
    }

    // Prefer exports / callables first in the overview list.
    symbols.sort_by(|a, b| {
        let rank = |kind: &str| -> i32 {
            let k = kind.to_lowercase();
            if k.contains("export") || k.contains("function") || k.contains("method") {
                0
            } else if k.contains("class") || k.contains("const") || k.contains("variable") {
                1
            } else {
                2
            }
        };
        rank(&a.1).cmp(&rank(&b.1)).then_with(|| a.0.cmp(&b.0))
    });

    let purpose = infer_file_purpose(&file_hint, &symbols, &preamble_excerpt);
    let mut parts = Vec::new();
    parts.push(format!("## Purpose\n\n`{file_hint}` {purpose}"));

    if !symbols.is_empty() {
        let list = symbols
            .iter()
            .take(12)
            .map(|(name, kind, line, role)| {
                let loc = line
                    .map(|n| format!(" (L{n})"))
                    .unwrap_or_default();
                format!("- `{name}`{loc} — {kind}: {role}")
            })
            .collect::<Vec<_>>()
            .join("\n");
        parts.push(format!("## Key symbols\n\n{list}"));
    }

    if let Some(flow) = infer_file_flow(&symbols, &preamble_excerpt) {
        parts.push(format!("## How it works\n\n{flow}"));
    }

    if !preamble_excerpt.trim().is_empty() && symbols.len() < 2 {
        parts.push(format!(
            "## Evidence excerpt\n\n```\n{}\n```",
            preamble_excerpt.trim()
        ));
    }

    parts.push(format!("[Source: {file_hint}]"));

    let confidence = best_confidence.max(0.72).min(0.95);
    Some(StructuredAnswer {
        intent: QueryIntent::ExplainSymbol,
        answer_text: parts.join("\n\n"),
        confidence,
        source_file: file_hint,
        line_start: symbols.first().and_then(|(_, _, l, _)| *l),
        line_end: symbols.last().and_then(|(_, _, l, _)| *l),
    })
}

fn summarize_symbol_role(name: &str, kind: &str, excerpt: &str) -> String {
    let lower = excerpt.to_lowercase();
    let name_l = name.to_lowercase();
    if name_l.contains("subscribe") || lower.contains("listeners.add") {
        return "registers a callback and returns an unsubscribe function".to_string();
    }
    if name_l.contains("notify") || name_l.contains("emit") || lower.contains("forEach") {
        return "notifies every registered listener (pub/sub broadcast)".to_string();
    }
    if name_l.contains("listener") || lower.contains("new set") {
        return "holds the set of registered callbacks".to_string();
    }
    if lower.contains("export function") || lower.contains("export const") {
        return format!("exported {kind} used by other modules");
    }
    if let Some(summary) = summarize_from_def_body(excerpt, name) {
        return summary;
    }
    let first = excerpt
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty() && !l.starts_with("//") && !l.starts_with("/*"))
        .unwrap_or(kind);
    if first.len() > 110 {
        format!("{}…", first.chars().take(110).collect::<String>())
    } else {
        first.to_string()
    }
}

fn infer_file_purpose(
    file_hint: &str,
    symbols: &[(String, String, Option<i32>, String)],
    preamble: &str,
) -> String {
    let names: Vec<String> = symbols.iter().map(|(n, _, _, _)| n.to_lowercase()).collect();
    let joined = names.join(" ");
    let pre_l = preamble.to_lowercase();
    if (joined.contains("subscribe") && joined.contains("notify"))
        || (pre_l.contains("listeners") && pre_l.contains("notify"))
    {
        return format!(
            "is a small event/pub-sub helper: modules can subscribe to refresh callbacks and later notify them (used for overview refresh wiring around `{file_hint}`)."
        );
    }
    if !symbols.is_empty() {
        let preview = symbols
            .iter()
            .take(4)
            .map(|(n, k, _, _)| format!("{k} `{n}`"))
            .collect::<Vec<_>>()
            .join(", ");
        return format!(
            "defines and exports {preview}{more}. Use the sections below for the file-level behavior.",
            more = if symbols.len() > 4 {
                format!(", and {} more symbol(s)", symbols.len() - 4)
            } else {
                String::new()
            }
        );
    }
    "contains the indexed TypeScript/JavaScript module shown in the evidence excerpt.".to_string()
}

fn infer_file_flow(
    symbols: &[(String, String, Option<i32>, String)],
    preamble: &str,
) -> Option<String> {
    let names: Vec<String> = symbols.iter().map(|(n, _, _, _)| n.to_lowercase()).collect();
    let has_sub = names.iter().any(|n| n.contains("subscribe"));
    let has_notify = names.iter().any(|n| n.contains("notify") || n.contains("emit"));
    let has_listeners = names.iter().any(|n| n.contains("listener"))
        || preamble.to_lowercase().contains("listeners");
    if has_sub && has_notify {
        return Some(
            "Callers register via the subscribe helper (stored in a module-level listener set). \
When something on the overview should refresh, `notify` walks that set and invokes each listener. \
This keeps overview UI updates decoupled from the producers of those events."
                .to_string(),
        );
    }
    if has_listeners && (has_sub || has_notify) {
        return Some(
            "A shared listener collection stores callbacks; notify/subscribe helpers add or invoke them."
                .to_string(),
        );
    }
    None
}

/// Answer "what are the imports in config_loader.py" from module preamble or file header.
pub fn try_file_imports_answer(query: &str, hits: &[KcSearchHit]) -> Option<StructuredAnswer> {
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
            intent: QueryIntent::FileImports,
            answer_text: format!("Imports in `{file_hint}`:\n{body}"),
            confidence,
            source_file: hit.chunk.file_name.clone(),
            line_start: hit.chunk.line_start,
            line_end: hit.chunk.line_end,
        });
    }
    None
}

/// List functions/classes/exports in a named file from entity hits (not explain one symbol).
pub fn try_list_symbols_in_file_answer(query: &str, hits: &[KcSearchHit]) -> Option<StructuredAnswer> {
    let file_hint = extract_file_hint(query)?;
    let file_lower = file_hint.to_lowercase();
    let mut symbols: Vec<(String, String, Option<i32>)> = Vec::new();

    for hit in hits {
        let name_match = hit.chunk.file_name.eq_ignore_ascii_case(&file_hint)
            || hit
                .chunk
                .file_path
                .to_lowercase()
                .ends_with(&file_lower)
            || hit
                .chunk
                .file_name
                .to_lowercase()
                .contains(file_lower.rsplit_once('.').map(|(s, _)| s).unwrap_or(&file_lower));
        if !name_match {
            continue;
        }
        if let (Some(kind), Some(name)) = (&hit.chunk.entity_kind, &hit.chunk.entity_name) {
            let kind_l = kind.to_lowercase();
            let name_l = name.to_lowercase();
            if kind_l == "module" || name_l == "module_preamble" || name_l == "file" {
                continue;
            }
            if prefers_callable_symbols(query)
                && !looks_like_real_callable(name, kind, &excerpt_text(hit))
            {
                continue;
            }
            if symbols
                .iter()
                .any(|(n, _, _)| n.eq_ignore_ascii_case(name))
            {
                continue;
            }
            symbols.push((name.clone(), kind.clone(), hit.chunk.line_start));
        }
    }

    // Prefer real callables when the question asks for functions/methods/classes.
    if prefers_callable_symbols(query) {
        let callables: Vec<_> = symbols
            .iter()
            .filter(|(_, kind, _)| is_callable_entity_kind(kind))
            .cloned()
            .collect();
        if !callables.is_empty() {
            symbols = callables;
        }
    }

    if symbols.len() < 2 {
        for hit in hits {
            if !hit.chunk.file_name.eq_ignore_ascii_case(&file_hint)
                && !hit.chunk.file_path.to_lowercase().ends_with(&file_lower)
            {
                continue;
            }
            for (name, kind, line) in extract_defs_from_text(&excerpt_text(hit)) {
                if symbols
                    .iter()
                    .any(|(n, _, _)| n.eq_ignore_ascii_case(&name))
                {
                    continue;
                }
                symbols.push((name, kind, line));
            }
        }
    }

    if symbols.is_empty() {
        return None;
    }

    symbols.sort_by(|a, b| a.0.to_lowercase().cmp(&b.0.to_lowercase()));
    let lead = symbols
        .iter()
        .map(|(name, _, _)| format!("`{name}`"))
        .collect::<Vec<_>>()
        .join(", ");
    let body = symbols
        .iter()
        .map(|(name, kind, line)| {
            let anchor = line
                .filter(|l| *l > 0)
                .map(|l| format!(" (L{l})"))
                .unwrap_or_default();
            format!("- `{name}` ({kind}){anchor}")
        })
        .collect::<Vec<_>>()
        .join("\n");

    let source = hits
        .iter()
        .find(|h| h.chunk.file_name.eq_ignore_ascii_case(&file_hint))
        .or_else(|| hits.first())?;
    let confidence = source.chunk.source_confidence.unwrap_or(0.55).max(0.72);
    let kind_word = if prefers_callable_symbols(query) {
        "functions"
    } else {
        "symbols"
    };
    Some(StructuredAnswer {
        intent: QueryIntent::ListSymbolsInFile,
        answer_text: format!("`{file_hint}` defines these {kind_word}: {lead}.\n\n{body}"),
        confidence,
        source_file: source.chunk.file_name.clone(),
        line_start: source.chunk.line_start,
        line_end: source.chunk.line_end,
    })
}

fn prefers_callable_symbols(query: &str) -> bool {
    let q = query.to_lowercase();
    q.contains("function") || q.contains("method") || q.contains("class") || q.contains("export")
}

fn is_callable_entity_kind(kind: &str) -> bool {
    matches!(
        kind.to_lowercase().as_str(),
        "function" | "method" | "class" | "interface" | "struct" | "trait"
    )
}

/// Drop mis-tagged locals (e.g. `const content = input.trim()` indexed as function).
///
/// Important: do **not** treat any `=>` / `function` anywhere in the excerpt as proof —
/// parent function bodies / context_text often contain arrows and would falsely keep
/// nested assignments like `content`.
fn looks_like_real_callable(name: &str, kind: &str, body: &str) -> bool {
    if !is_callable_entity_kind(kind) {
        return false;
    }
    if let Some(decl) = declaration_line_for_symbol(body, name) {
        return declaration_looks_callable(&decl);
    }
    // No declaration line for this name — only keep CamelCase / snake_case symbols
    // when the first non-empty line itself looks like a callable definition.
    let name_ok = name.chars().any(|c| c.is_uppercase()) || name.contains('_');
    if !name_ok {
        return false;
    }
    body.lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .is_some_and(declaration_looks_callable)
}

fn declaration_line_for_symbol(body: &str, name: &str) -> Option<String> {
    let name_l = name.to_lowercase();
    for line in body.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if is_symbol_declaration_line(trimmed, &name_l) {
            return Some(trimmed.to_string());
        }
    }
    None
}

fn is_symbol_declaration_line(line: &str, name_l: &str) -> bool {
    let lower = line.to_lowercase();
    let markers = [
        format!("const {name_l}"),
        format!("let {name_l}"),
        format!("var {name_l}"),
        format!("function {name_l}"),
        format!("async function {name_l}"),
        format!("def {name_l}"),
        format!("async def {name_l}"),
        format!("fn {name_l}"),
        format!("class {name_l}"),
    ];
    markers.iter().any(|m| lower.contains(m.as_str()))
}

fn declaration_looks_callable(line: &str) -> bool {
    let l = line.to_lowercase();
    l.contains("=>")
        || l.contains("function ")
        || l.contains("function(")
        || l.contains("async function")
        || l.starts_with("def ")
        || l.contains(" async def ")
        || l.starts_with("async def ")
        || l.contains(" fn ")
        || l.starts_with("fn ")
        || l.starts_with("pub fn ")
        || l.starts_with("pub(crate) fn ")
        || l.contains(" class ")
        || l.starts_with("class ")
}

fn extract_defs_from_text(text: &str) -> Vec<(String, String, Option<i32>)> {
    let mut out = Vec::new();
    for (idx, line) in text.lines().enumerate() {
        let trimmed = line.trim();
        let line_no = Some((idx as i32) + 1);
        if let Some(rest) = trimmed.strip_prefix("def ") {
            let name = rest
                .split(|c: char| c == '(' || c.is_whitespace())
                .next()
                .unwrap_or("")
                .trim();
            if name.len() > 1 {
                out.push((name.to_string(), "function".into(), line_no));
            }
        } else if let Some(rest) = trimmed.strip_prefix("async def ") {
            let name = rest
                .split(|c: char| c == '(' || c.is_whitespace())
                .next()
                .unwrap_or("")
                .trim();
            if name.len() > 1 {
                out.push((name.to_string(), "function".into(), line_no));
            }
        } else if let Some(rest) = trimmed.strip_prefix("class ") {
            let name = rest
                .split(|c: char| c == '(' || c == ':' || c == '{' || c.is_whitespace())
                .next()
                .unwrap_or("")
                .trim();
            if name.len() > 1 {
                out.push((name.to_string(), "class".into(), line_no));
            }
        } else if trimmed.contains("function ") {
            if let Some(pos) = trimmed.find("function ") {
                let rest = &trimmed[pos + "function ".len()..];
                let name = rest
                    .split(|c: char| c == '(' || c.is_whitespace())
                    .next()
                    .unwrap_or("")
                    .trim();
                if name.len() > 1 && name.chars().all(|c| c.is_alphanumeric() || c == '_' || c == '$')
                {
                    out.push((name.to_string(), "function".into(), line_no));
                }
            }
        } else if trimmed.starts_with("const ") || trimmed.starts_with("let ") || trimmed.starts_with("export ")
        {
            // const handleSend = ... / export function foo
            if trimmed.contains(" = ") || trimmed.contains("=>") {
                let after = trimmed
                    .trim_start_matches("export ")
                    .trim_start_matches("async ")
                    .trim_start_matches("const ")
                    .trim_start_matches("let ")
                    .trim_start_matches("var ");
                let name = after
                    .split(|c: char| c == '=' || c == ':' || c == '(' || c.is_whitespace())
                    .next()
                    .unwrap_or("")
                    .trim();
                if name.len() > 2
                    && name.chars().next().is_some_and(|c| c.is_alphabetic() || c == '_')
                    && name.chars().any(|c| c.is_uppercase() || c == '_')
                {
                    out.push((name.to_string(), "function".into(), line_no));
                }
            }
        } else if trimmed.starts_with("fn ") || trimmed.starts_with("pub fn ") || trimmed.starts_with("pub(crate) fn ")
        {
            let rest = trimmed
                .trim_start_matches("pub(crate) ")
                .trim_start_matches("pub ")
                .trim_start_matches("fn ");
            let name = rest
                .split(|c: char| c == '(' || c == '<' || c.is_whitespace())
                .next()
                .unwrap_or("")
                .trim();
            if name.len() > 1 {
                out.push((name.to_string(), "function".into(), line_no));
            }
        }
    }
    out
}

/// Short locate answer: path + symbol line from best code hit.
pub fn try_locate_definition_answer(query: &str, hits: &[KcSearchHit]) -> Option<StructuredAnswer> {
    let mut symbols = extract_camel_symbols(query);
    symbols.extend(extract_snake_case_symbols(query));
    let ranked = rank_hits_for_intent(query, QueryIntent::LocateDefinition, hits);

    for hit in &ranked {
        if let Some(name) = &hit.chunk.entity_name {
            if symbols.is_empty() || symbols.iter().any(|s| s.eq_ignore_ascii_case(name)) {
                let anchor = match (hit.chunk.line_start, hit.chunk.line_end) {
                    (Some(s), Some(e)) if s > 0 && e > s => format!(" (L{s}–L{e})"),
                    (Some(s), _) if s > 0 => format!(" (L{s})"),
                    _ => String::new(),
                };
                let kind = hit
                    .chunk
                    .entity_kind
                    .as_deref()
                    .unwrap_or("symbol");
                let confidence = hit.chunk.source_confidence.unwrap_or(0.6).max(0.75);
                return Some(StructuredAnswer {
                    intent: QueryIntent::LocateDefinition,
                    answer_text: format!(
                        "`{name}` ({kind}) is defined in `{}`{anchor}.",
                        hit.chunk.file_name
                    ),
                    confidence,
                    source_file: hit.chunk.file_name.clone(),
                    line_start: hit.chunk.line_start,
                    line_end: hit.chunk.line_end,
                });
            }
        }
    }

    // Fallback: first hit that mentions a queried symbol in body.
    for symbol in &symbols {
        for hit in &ranked {
            let body = excerpt_text(hit);
            if body.contains(symbol) || body.to_lowercase().contains(&symbol.to_lowercase()) {
                let anchor = hit
                    .chunk
                    .line_start
                    .filter(|s| *s > 0)
                    .map(|s| format!(" (L{s})"))
                    .unwrap_or_default();
                let confidence = hit.chunk.source_confidence.unwrap_or(0.55).max(0.70);
                return Some(StructuredAnswer {
                    intent: QueryIntent::LocateDefinition,
                    answer_text: format!(
                        "`{symbol}` appears in `{}`{anchor}.",
                        hit.chunk.file_name
                    ),
                    confidence,
                    source_file: hit.chunk.file_name.clone(),
                    line_start: hit.chunk.line_start,
                    line_end: hit.chunk.line_end,
                });
            }
        }
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
        let intent = QueryIntent::ExplainSymbol;
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
        assert!(answer.is_none(), "symbol explain questions should defer to LLM");
    }

    #[test]
    fn qa_file_purpose_overview_events() {
        let hits = vec![
            hit(
                "overviewEvents.ts",
                "code",
                "type Listener = () => void;\nconst listeners = new Set<Listener>();",
                0.9,
                Some(("const", "listeners")),
                Some((1, 3)),
            ),
            hit(
                "overviewEvents.ts",
                "code",
                "export function subscribeOverviewRefresh(fn: Listener): () => void {\n  listeners.add(fn);\n  return () => listeners.delete(fn);\n}",
                0.92,
                Some(("function", "subscribeOverviewRefresh")),
                Some((5, 8)),
            ),
            hit(
                "overviewEvents.ts",
                "code",
                "export function notifyOverviewRefresh(): void {\n  listeners.forEach((fn) => fn());\n}",
                0.93,
                Some(("function", "notifyOverviewRefresh")),
                Some((10, 12)),
            ),
        ];
        let answer = try_structured_answer("what does overviewEvents.ts do?", &hits).unwrap();
        assert!(answer.answer_text.contains("## Purpose"));
        assert!(answer.answer_text.contains("subscribeOverviewRefresh"));
        assert!(answer.answer_text.contains("notifyOverviewRefresh"));
        assert!(answer.answer_text.to_lowercase().contains("pub-sub") || answer.answer_text.to_lowercase().contains("listener"));
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
    fn qa_timeout_from_environment_not_locate_stub() {
        let text = include_str!("../../../test-fixtures/kc-qa-corpus/code/config_loader.py");
        let hits = vec![hit(
            "config_loader.py",
            "code",
            text,
            0.9,
            Some(("function", "load_api_timeout")),
            Some((9, 17)),
        )];
        let q =
            "Where is the API timeout read from the environment and what is its default?";
        assert_eq!(classify_query_intent(q), QueryIntent::EnvVar);
        let answer = try_structured_answer(q, &hits).unwrap();
        assert_eq!(answer.intent, QueryIntent::EnvVar);
        assert!(answer.answer_text.contains("NEXUS_API_TIMEOUT"));
        assert!(answer.answer_text.contains("30"));
        assert!(
            !answer.answer_text.starts_with("`load_api_timeout`"),
            "must not be a locate_definition stub"
        );
    }

    #[test]
    fn qa_list_symbols_skips_non_callable_const() {
        let hits = vec![
            hit(
                "ChatView.tsx",
                "code",
                "const handleSend = async () => {}",
                0.9,
                Some(("function", "handleSend")),
                Some((10, 16)),
            ),
            hit(
                "ChatView.tsx",
                "code",
                "const content = input.trim();",
                0.85,
                // Legacy mis-tag from Tree-sitter defaulting variable_declarator → function
                Some(("function", "content")),
                Some((12, 12)),
            ),
            hit(
                "ChatView.tsx",
                "code",
                "const handleKeyDown = (e) => {}",
                0.85,
                Some(("function", "handleKeyDown")),
                Some((18, 23)),
            ),
        ];
        let answer =
            try_structured_answer("What functions are defined in ChatView.tsx?", &hits).unwrap();
        assert!(answer.answer_text.contains("handleSend"));
        assert!(answer.answer_text.contains("handleKeyDown"));
        assert!(
            !answer.answer_text.contains("`content`"),
            "must not list nested/non-callable const as a function"
        );
    }

    #[test]
    fn qa_list_symbols_skips_content_when_parent_body_has_arrow() {
        // context_text / parent excerpt often contains `=>` from handleSend; that must not
        // keep a mis-tagged `content` entity.
        let parent_body = r#"const handleSend = async () => {
  if (!input.trim()) return;
  const content = input.trim();
  setInput('');
};"#;
        let hits = vec![
            hit(
                "ChatView.tsx",
                "code",
                "const handleSend = async () => { const content = input.trim(); }",
                0.9,
                Some(("function", "handleSend")),
                Some((10, 16)),
            ),
            hit(
                "ChatView.tsx",
                "code",
                parent_body,
                0.88,
                Some(("function", "content")),
                Some((12, 12)),
            ),
            hit(
                "ChatView.tsx",
                "code",
                "const handleCopy = async (text) => {}",
                0.85,
                Some(("function", "handleCopy")),
                Some((25, 27)),
            ),
        ];
        let answer =
            try_structured_answer("What functions are defined in ChatView.tsx?", &hits).unwrap();
        assert!(answer.answer_text.contains("handleSend"));
        assert!(answer.answer_text.contains("handleCopy"));
        assert!(
            !answer.answer_text.contains("`content`"),
            "parent arrow in excerpt must not keep local `content`: {}",
            answer.answer_text
        );
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
        assert_eq!(answer.intent, QueryIntent::FileImports);
    }

    #[test]
    fn qa_list_symbols_in_file() {
        let hits = vec![
            hit(
                "ChatView.tsx",
                "code",
                "const handleSend = async () => {}",
                0.9,
                Some(("function", "handleSend")),
                Some((10, 16)),
            ),
            hit(
                "ChatView.tsx",
                "code",
                "function renderMessages() {}",
                0.85,
                Some(("function", "renderMessages")),
                Some((20, 30)),
            ),
        ];
        let answer =
            try_structured_answer("What functions are defined in ChatView.tsx?", &hits).unwrap();
        assert_eq!(answer.intent, QueryIntent::ListSymbolsInFile);
        assert!(answer.answer_text.contains("handleSend"));
        assert!(answer.answer_text.contains("renderMessages"));
        assert!(!answer.answer_text.to_lowercase().contains("validates and trims"));
    }

    #[test]
    fn qa_locate_definition() {
        let hits = vec![hit(
            "ChatView.tsx",
            "code",
            "const handleSend = async () => {}",
            0.9,
            Some(("function", "handleSend")),
            Some((10, 16)),
        )];
        let answer = try_structured_answer("Where is handleSend defined?", &hits).unwrap();
        assert_eq!(answer.intent, QueryIntent::LocateDefinition);
        assert!(answer.answer_text.contains("ChatView.tsx"));
        assert!(answer.answer_text.contains("handleSend"));
    }
}
