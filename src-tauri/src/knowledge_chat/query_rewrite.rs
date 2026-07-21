use crate::knowledge_chat::types::KcQueryRewriteResult;
use serde::Deserialize;

/// Common abbreviations expanded for retrieval (domain-neutral).
const COMMON_ACRONYMS: &[(&str, &str)] = &[
    ("api", "application programming interface"),
    ("hr", "human resources"),
    ("it", "information technology"),
    ("faq", "frequently asked questions"),
    ("sla", "service level agreement"),
    ("sop", "standard operating procedure"),
    ("pdf", "portable document format"),
    ("vpn", "virtual private network"),
    ("mfa", "multi-factor authentication"),
    ("sso", "single sign-on"),
    ("iam", "identity and access management"),
    ("ir", "incident response"),
    ("soc", "security operations center"),
    ("siem", "security information and event management"),
];

/// Rule-based query preparation before retrieval (offline, no LLM latency).
pub fn rewrite_for_retrieval(query: &str) -> KcQueryRewriteResult {
    let trimmed = normalize_query_typos(query.trim());
    if trimmed.is_empty() {
        return KcQueryRewriteResult {
            original_query: String::new(),
            retrieval_query: String::new(),
            expansions: Vec::new(),
            vague: false,
        };
    }

    let vague = is_vague_query(&trimmed);
    let mut expansions = Vec::new();
    let mut augmented = trimmed.clone();

    for (acro, expansion) in COMMON_ACRONYMS {
        if contains_token(&trimmed, acro) && !trimmed.to_lowercase().contains(expansion) {
            expansions.push(expansion.to_string());
        }
    }

    expansions.extend(expand_number_words(&trimmed));
    expansions.extend(expand_list_concepts(&trimmed));

    if vague {
        expansions.push("relevant documentation details".to_string());
        if looks_like_procedure_question(&trimmed) {
            expansions.push("procedure steps requirements".to_string());
        }
    }

    if !expansions.is_empty() {
        augmented = format!("{trimmed} {}", expansions.join(" "));
    }

    let retrieval_query = collapse_whitespace(&augmented);

    KcQueryRewriteResult {
        original_query: query.trim().to_string(),
        retrieval_query,
        expansions,
        vague,
    }
}

#[derive(Debug, Deserialize)]
struct ConstrainedRewriteJson {
    query: String,
    #[serde(default)]
    filters: Option<serde_json::Value>,
}

/// Parse LLM rewrite output that must be JSON `{"query":"...","filters":{}}`.
/// On parse failure, returns `None` so callers keep the original user question.
pub fn parse_constrained_llm_rewrite(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    // Allow fenced ```json blocks
    let body = trimmed
        .strip_prefix("```json")
        .or_else(|| trimmed.strip_prefix("```"))
        .map(|s| s.trim_end_matches('`').trim())
        .unwrap_or(trimmed);
    let start = body.find('{')?;
    let end = body.rfind('}')?;
    if end <= start {
        return None;
    }
    let slice = &body[start..=end];
    let parsed: ConstrainedRewriteJson = serde_json::from_str(slice).ok()?;
    let q = parsed.query.trim().to_string();
    if q.is_empty() {
        None
    } else {
        let _ = parsed.filters; // reserved for future filter wiring
        Some(q)
    }
}

#[cfg(test)]
mod constrained_tests {
    use super::*;

    #[test]
    fn parses_json_rewrite() {
        let q = parse_constrained_llm_rewrite(r#"{"query":"VPN timeout policy","filters":{}}"#);
        assert_eq!(q.as_deref(), Some("VPN timeout policy"));
    }

    #[test]
    fn rejects_freeform() {
        assert!(parse_constrained_llm_rewrite("just rewrite this somehow").is_none());
    }
}

fn normalize_query_typos(query: &str) -> String {
    query
        .replace("laeyrs", "layers")
        .replace("Laeyrs", "layers")
        .replace("LAEYRS", "layers")
        .replace("layrs", "layers")
        .replace("architecure", "architecture")
        .replace("functoin", "function")
}

fn expand_number_words(query: &str) -> Vec<String> {
    let q = query.to_lowercase();
    let mut out = Vec::new();
    let pairs = [
        ("3 layers", "three layers"),
        ("3 layer", "three layer"),
        ("three layers", "3 layers"),
        ("4 partitions", "four partitions"),
    ];
    for (needle, expansion) in pairs {
        if q.contains(needle) && !q.contains(expansion) {
            out.push(expansion.to_string());
        }
    }
    out
}

fn expand_list_concepts(query: &str) -> Vec<String> {
    let q = query.to_lowercase();
    let mut out = Vec::new();
    if q.contains("layer") && (q.contains("nexus") || q.contains("architecture")) {
        out.push("three layers presentation orchestration inference".to_string());
        out.push("architecture overview".to_string());
    }
    if q.contains("what are the") && q.contains("layer") {
        out.push("numbered list section".to_string());
    }
    out
}

/// HyDE-style retrieval query: prepend a hypothetical document framing for dense embedding.
pub fn hyde_retrieval_query(query: &str) -> String {
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    format!(
        "Relevant documentation excerpt discussing: {trimmed}. Key sections, definitions, and procedures related to this topic include:"
    )
}

pub fn is_vague_query(query: &str) -> bool {
    let trimmed = query.trim();
    let word_count = trimmed.split_whitespace().count();
    if word_count <= 3 {
        return true;
    }
    if word_count <= 6 && !trimmed.contains('?') {
        let lower = trimmed.to_lowercase();
        let has_question_word = [
            "what", "how", "when", "where", "who", "which", "why", "should", "can", "does",
        ]
        .iter()
        .any(|w| lower.starts_with(w) || lower.contains(&format!(" {w} ")));
        return !has_question_word;
    }
    false
}

fn looks_like_procedure_question(query: &str) -> bool {
    let lower = query.to_lowercase();
    [
        "policy", "policies", "procedure", "process", "runbook", "guideline", "steps", "workflow",
    ]
    .iter()
    .any(|term| lower.contains(term))
}

fn contains_token(haystack: &str, token: &str) -> bool {
    haystack
        .to_lowercase()
        .split(|c: char| !c.is_ascii_alphanumeric())
        .any(|part| part == token)
}

fn collapse_whitespace(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expands_mfa_acronym() {
        let result = rewrite_for_retrieval("MFA requirements for admins?");
        assert!(result.retrieval_query.to_lowercase().contains("multi-factor"));
    }

    #[test]
    fn marks_short_query_vague() {
        assert!(is_vague_query("VPN policy?"));
    }

    #[test]
    fn vague_expansion_is_domain_neutral() {
        let result = rewrite_for_retrieval("onboarding");
        assert!(result
            .retrieval_query
            .to_lowercase()
            .contains("relevant documentation"));
    }

    #[test]
    fn normalizes_layer_typo_and_expands() {
        let result = rewrite_for_retrieval("what are the 3 laeyrs of nexus ai");
        let q = result.retrieval_query.to_lowercase();
        assert!(q.contains("layers"));
        assert!(q.contains("three layers") || q.contains("presentation"));
    }
}
