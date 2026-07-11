#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QueryIntent {
    CodeSymbol,
    ErrorCode,
    EnvVar,
    RunbookStep,
    Timeline,
    General,
}

pub fn classify_query_intent(query: &str) -> QueryIntent {
    let q = query.to_lowercase();

    if extract_error_code(query).is_some() || q.contains("error code") {
        return QueryIntent::ErrorCode;
    }

    if q.contains("environment variable")
        || q.contains("env var")
        || q.contains("environ")
        || query
            .split_whitespace()
            .any(|w| w.chars().filter(|c| c.is_ascii_uppercase() || *c == '_').count() >= 4 && w.contains('_'))
    {
        return QueryIntent::EnvVar;
    }

    if q.contains("first step")
        || q.contains("what should i do")
        || q.contains("what do i do")
        || q.contains("how do i respond")
        || q.contains("how should i")
        || (q.contains("vpn") && q.contains("alert"))
    {
        return QueryIntent::RunbookStep;
    }

    if q.contains("how long")
        || q.contains("how many days")
        || q.contains("duration")
        || q.contains("take to")
        || q.contains("onboarding")
    {
        return QueryIntent::Timeline;
    }

    if is_code_symbol_question(&q)
        || extract_camel_symbols(query).iter().any(|s| s.len() > 4)
        || extract_snake_case_symbols(query).iter().any(|s| s.len() > 4)
    {
        return QueryIntent::CodeSymbol;
    }

    QueryIntent::General
}

pub fn intent_match_strength(query: &str, intent: QueryIntent) -> f64 {
    if intent == QueryIntent::General {
        return 0.0;
    }
    let classified = classify_query_intent(query);
    if classified != intent {
        return 0.0;
    }
    let mut strength: f64 = 0.55;
    if extract_error_code(query).is_some() {
        strength += 0.25;
    }
    if extract_file_hint(query).is_some() {
        strength += 0.10;
    }
    if !extract_camel_symbols(query).is_empty() || !extract_snake_case_symbols(query).is_empty() {
        strength += 0.10;
    }
    strength.clamp(0.0, 1.0)
}

pub fn is_structured_intent(intent: QueryIntent) -> bool {
    !matches!(intent, QueryIntent::General)
}

pub fn extract_error_code(query: &str) -> Option<String> {
    query
        .split_whitespace()
        .find(|w| w.to_uppercase().starts_with("E-"))
        .map(|w| w.trim_matches(|c: char| !c.is_ascii_alphanumeric() && c != '-').to_uppercase())
}

pub fn extract_file_hint(query: &str) -> Option<String> {
    for token in query.split_whitespace() {
        if token.contains('.') && token.chars().any(|c| c.is_alphabetic()) {
            let cleaned = token.trim_matches(|c: char| !c.is_alphanumeric() && c != '.' && c != '_' && c != '-');
            if cleaned.contains('.') {
                return Some(cleaned.to_string());
            }
        }
    }
    None
}

pub fn extract_camel_symbols(query: &str) -> Vec<String> {
    query
        .split(|c: char| !c.is_alphanumeric() && c != '_')
        .filter(|word| {
            word.len() > 4
                && word.chars().any(|c| c.is_uppercase())
                && word.chars().any(|c| c.is_lowercase())
        })
        .map(|s| s.to_string())
        .collect()
}

pub fn is_explain_code_question(q: &str) -> bool {
    let q = q.to_lowercase();
    q.contains("explain")
        || q.contains("describe")
        || q.contains("walk me through")
        || q.contains("what does")
        || q.contains("how does")
        || q.contains("what is the logic")
        || q.contains("what happens when")
        || q.contains("purpose of")
}

pub fn extract_snake_case_symbols(query: &str) -> Vec<String> {
    query
        .split(|c: char| !c.is_alphanumeric() && c != '_')
        .filter(|word| {
            word.len() > 4
                && word.contains('_')
                && word.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
                && word.chars().filter(|c| c.is_ascii_alphabetic()).count() >= 3
        })
        .map(|s| s.to_string())
        .collect()
}

pub fn is_code_symbol_question(q: &str) -> bool {
    q.contains("what does")
        || q.contains("how does")
        || q.contains("explain")
        || q.contains("describe")
        || q.contains("walk me through")
        || q.contains("show me")
        || q.contains("what is the logic")
        || q.contains("how does")
        || q.contains("what happens when")
        || q.contains("purpose of")
        || (q.contains("import") && extract_file_hint(q).is_some())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_qa_intents() {
        assert_eq!(
            classify_query_intent("What does handleSend do in ChatView.tsx?"),
            QueryIntent::CodeSymbol
        );
        assert_eq!(
            classify_query_intent("What environment variable controls the API timeout?"),
            QueryIntent::EnvVar
        );
        assert_eq!(
            classify_query_intent("What does error code E-402 mean?"),
            QueryIntent::ErrorCode
        );
        assert_eq!(
            classify_query_intent("What is the first step for a VPN brute-force alert?"),
            QueryIntent::RunbookStep
        );
        assert_eq!(
            classify_query_intent("How long does new-hire onboarding take?"),
            QueryIntent::Timeline
        );
    }

    #[test]
    fn classifies_code_symbol_paraphrases() {
        assert_eq!(
            classify_query_intent("Explain handleSend in ChatView.tsx"),
            QueryIntent::CodeSymbol
        );
        assert_eq!(
            classify_query_intent("Walk me through handleSend"),
            QueryIntent::CodeSymbol
        );
    }

    #[test]
    fn classifies_imports_question_as_code_symbol() {
        assert_eq!(
            classify_query_intent("what are the imports in config_loader.py"),
            QueryIntent::CodeSymbol
        );
    }

    #[test]
    fn extracts_snake_case_symbols() {
        let symbols = extract_snake_case_symbols("explain load_api_timeout in config_loader.py");
        assert!(symbols.iter().any(|s| s == "load_api_timeout"));
    }
}
