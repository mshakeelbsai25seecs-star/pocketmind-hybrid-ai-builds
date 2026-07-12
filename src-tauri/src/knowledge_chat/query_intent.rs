use serde::{Deserialize, Deserializer, Serialize};

/// Closed-enum query / answer intents (snake_case wire format).
/// Legacy `code_symbol` deserializes as [`QueryIntent::ExplainSymbol`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum QueryIntent {
    ExplainSymbol,
    ListSymbolsInFile,
    LocateDefinition,
    FileImports,
    EnvVar,
    ErrorCode,
    RunbookStep,
    Timeline,
    General,
}

impl<'de> Deserialize<'de> for QueryIntent {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = String::deserialize(deserializer)?;
        Ok(parse_query_intent_label(&raw).unwrap_or(QueryIntent::General))
    }
}

/// Parse a snake_case intent label; maps legacy `code_symbol` → `explain_symbol`.
pub fn parse_query_intent_label(raw: &str) -> Option<QueryIntent> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "explain_symbol" | "code_symbol" => Some(QueryIntent::ExplainSymbol),
        "list_symbols_in_file" => Some(QueryIntent::ListSymbolsInFile),
        "locate_definition" => Some(QueryIntent::LocateDefinition),
        "file_imports" => Some(QueryIntent::FileImports),
        "env_var" => Some(QueryIntent::EnvVar),
        "error_code" => Some(QueryIntent::ErrorCode),
        "runbook_step" => Some(QueryIntent::RunbookStep),
        "timeline" => Some(QueryIntent::Timeline),
        "general" => Some(QueryIntent::General),
        _ => None,
    }
}

pub fn query_intent_label(intent: QueryIntent) -> &'static str {
    match intent {
        QueryIntent::ExplainSymbol => "explain_symbol",
        QueryIntent::ListSymbolsInFile => "list_symbols_in_file",
        QueryIntent::LocateDefinition => "locate_definition",
        QueryIntent::FileImports => "file_imports",
        QueryIntent::EnvVar => "env_var",
        QueryIntent::ErrorCode => "error_code",
        QueryIntent::RunbookStep => "runbook_step",
        QueryIntent::Timeline => "timeline",
        QueryIntent::General => "general",
    }
}

/// Code-oriented intents that share CodeSymbol-like scope / MMR / filters.
pub fn is_code_oriented_intent(intent: QueryIntent) -> bool {
    matches!(
        intent,
        QueryIntent::ExplainSymbol
            | QueryIntent::ListSymbolsInFile
            | QueryIntent::LocateDefinition
            | QueryIntent::FileImports
            | QueryIntent::EnvVar
    )
}

/// High-precision rule vetoes that beat the LLM when ultra-clear.
pub fn veto_query_intent(query: &str) -> Option<QueryIntent> {
    let q = query.to_lowercase();

    if extract_error_code(query).is_some() || q.contains("error code") {
        return Some(QueryIntent::ErrorCode);
    }

    if is_env_var_question(query) {
        return Some(QueryIntent::EnvVar);
    }

    // /what functions|methods|classes are (defined|exported) in .+\.(tsx?|py|rs)/i
    if regex_list_symbols_veto(&q) {
        return Some(QueryIntent::ListSymbolsInFile);
    }

    None
}

fn regex_list_symbols_veto(q: &str) -> bool {
    let has_list_verb = (q.contains("what functions")
        || q.contains("what methods")
        || q.contains("what classes")
        || q.contains("which functions")
        || q.contains("which methods")
        || q.contains("which classes")
        || q.contains("list functions")
        || q.contains("list methods")
        || q.contains("list classes")
        || q.contains("list the functions")
        || q.contains("list the methods")
        || q.contains("list the classes")
        || q.contains("exports from")
        || q.contains("what are the exports"))
        && (q.contains("defined in")
            || q.contains("exported in")
            || q.contains("exported from")
            || q.contains(" in ")
            || q.contains(" from "));

    if !has_list_verb && !is_list_symbols_question(q) {
        return false;
    }
    extract_file_hint(q).is_some()
}

pub fn classify_query_intent(query: &str) -> QueryIntent {
    if let Some(v) = veto_query_intent(query) {
        return v;
    }

    let q = query.to_lowercase();

    if q.contains("first step")
        || q.contains("what should i do")
        || q.contains("what do i do")
        || q.contains("how do i respond")
        || q.contains("how should i")
        || q.contains("who approves")
        || q.contains("password reset")
        || (q.contains("vpn") && q.contains("alert"))
    {
        return QueryIntent::RunbookStep;
    }

    if q.contains("how long")
        || q.contains("how many days")
        || (q.contains("how many") && q.contains("day"))
        || q.contains("duration")
        || q.contains("take to")
        || q.contains("onboarding")
        || q.contains("business day")
    {
        return QueryIntent::Timeline;
    }

    // Env / timeout+default before locate — "Where is the API timeout read from the
    // environment…" must not win as locate_definition (citation stub only).
    if is_env_var_question(query) {
        return QueryIntent::EnvVar;
    }

    if is_list_symbols_question(&q) && extract_file_hint(query).is_some() {
        return QueryIntent::ListSymbolsInFile;
    }

    if is_file_imports_question(&q) {
        return QueryIntent::FileImports;
    }

    if is_locate_definition_question(&q) {
        return QueryIntent::LocateDefinition;
    }

    if is_explain_symbol_question(&q)
        || extract_camel_symbols(query).iter().any(|s| s.len() > 4)
        || extract_snake_case_symbols(query).iter().any(|s| s.len() > 4)
        || is_named_function_lookup(&q)
    {
        return QueryIntent::ExplainSymbol;
    }

    QueryIntent::General
}

fn is_named_function_lookup(q: &str) -> bool {
    (q.contains("function") || q.contains("method") || q.contains("class"))
        && (q.contains("validat")
            || q.contains("jwt")
            || q.contains("token")
            || q.contains("which")
            || q.contains("what rust")
            || q.contains("what python")
            || q.contains("what ts"))
}

pub fn is_list_symbols_question(q: &str) -> bool {
    let q = q.to_lowercase();
    q.contains("functions defined in")
        || q.contains("methods defined in")
        || q.contains("classes defined in")
        || q.contains("functions in")
        || q.contains("methods in")
        || q.contains("classes in")
        || q.contains("exports from")
        || q.contains("what functions")
        || q.contains("what methods")
        || q.contains("what classes")
        || q.contains("which functions")
        || q.contains("which methods")
        || q.contains("which classes")
        || q.contains("list functions")
        || q.contains("list methods")
        || q.contains("list classes")
        || q.contains("list the symbols")
        || q.contains("list symbols")
        || (q.contains("what are the")
            && (q.contains("function") || q.contains("method") || q.contains("class") || q.contains("export"))
            && extract_file_hint(&q).is_some()
            && !q.contains("import"))
}

pub fn is_file_imports_question(q: &str) -> bool {
    let q = q.to_lowercase();
    (q.contains("import") || q.contains("imports"))
        && extract_file_hint(&q).is_some()
        && !is_list_symbols_question(&q)
}

/// Env-var / timeout-default questions (including "from the environment").
pub fn is_env_var_question(query: &str) -> bool {
    let q = query.to_lowercase();
    if q.contains("environment variable")
        || q.contains("env var")
        || q.contains("from the environment")
        || q.contains("from environment")
        || query.split_whitespace().any(|w| w.starts_with("NEXUS_"))
    {
        return true;
    }
    // "Where is the API timeout read … and what is its default?"
    q.contains("timeout")
        && (q.contains("default") || q.contains("environ") || q.contains("env "))
}

pub fn is_locate_definition_question(q: &str) -> bool {
    if is_env_var_question(q) {
        return false;
    }
    let q = q.to_lowercase();
    q.contains("where is")
        || q.contains("where are")
        || q.contains("which file")
        || q.contains("what file")
        || q.contains("defined in which")
        || (q.contains("where") && (q.contains("defined") || q.contains("declared") || q.contains("located")))
}

pub fn is_explain_symbol_question(q: &str) -> bool {
    is_code_symbol_question(q) && !is_list_symbols_question(q) && !is_file_imports_question(q)
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
            let cleaned = token
                .trim_matches(|c: char| !c.is_alphanumeric() && c != '.' && c != '_' && c != '-');
            if looks_like_filename(cleaned) {
                return Some(cleaned.to_string());
            }
        }
    }
    None
}

/// True for `ChatView.tsx` / `config_loader.py`, false for sentence tails like `name.`
fn looks_like_filename(name: &str) -> bool {
    let Some((stem, ext)) = name.rsplit_once('.') else {
        return false;
    };
    if stem.is_empty() || ext.is_empty() {
        return false;
    }
    if !(1..=12).contains(&ext.len()) {
        return false;
    }
    if !ext.chars().all(|c| c.is_ascii_alphanumeric()) {
        return false;
    }
    stem.chars().any(|c| c.is_alphanumeric())
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

/// Legacy helper: true for explain / show / describe style code questions (not list/imports).
pub fn is_code_symbol_question(q: &str) -> bool {
    let q = q.to_lowercase();
    if is_list_symbols_question(&q) || is_file_imports_question(&q) {
        return false;
    }
    q.contains("what does")
        || q.contains("how does")
        || q.contains("explain")
        || q.contains("describe")
        || q.contains("walk me through")
        || q.contains("show me")
        || q.contains("what is the logic")
        || q.contains("what happens when")
        || q.contains("purpose of")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_qa_intents() {
        assert_eq!(
            classify_query_intent("What does handleSend do in ChatView.tsx?"),
            QueryIntent::ExplainSymbol
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
            QueryIntent::ExplainSymbol
        );
        assert_eq!(
            classify_query_intent("Walk me through handleSend"),
            QueryIntent::ExplainSymbol
        );
    }

    #[test]
    fn classifies_imports_question_as_file_imports() {
        assert_eq!(
            classify_query_intent("what are the imports in config_loader.py"),
            QueryIntent::FileImports
        );
    }

    #[test]
    fn classifies_list_symbols_in_file() {
        assert_eq!(
            classify_query_intent("What functions are defined in ChatView.tsx?"),
            QueryIntent::ListSymbolsInFile
        );
        assert_eq!(
            classify_query_intent("list the methods in config_loader.py"),
            QueryIntent::ListSymbolsInFile
        );
    }

    #[test]
    fn classifies_locate_definition() {
        assert_eq!(
            classify_query_intent("Where is handleSend defined?"),
            QueryIntent::LocateDefinition
        );
        assert_eq!(
            classify_query_intent("which file defines load_api_timeout"),
            QueryIntent::LocateDefinition
        );
    }

    #[test]
    fn classifies_timeout_from_environment_as_env_var() {
        assert_eq!(
            classify_query_intent(
                "Where is the API timeout read from the environment and what is its default?"
            ),
            QueryIntent::EnvVar
        );
        assert_eq!(
            veto_query_intent(
                "Where is the API timeout read from the environment and what is its default?"
            ),
            Some(QueryIntent::EnvVar)
        );
        // Pure symbol locate still wins when not asking for env/default.
        assert_eq!(
            classify_query_intent("Where is load_api_timeout defined?"),
            QueryIntent::LocateDefinition
        );
    }

    #[test]
    fn veto_forces_list_and_error() {
        assert_eq!(
            veto_query_intent("What functions are defined in ChatView.tsx?"),
            Some(QueryIntent::ListSymbolsInFile)
        );
        assert_eq!(
            veto_query_intent("What does error code E-402 mean?"),
            Some(QueryIntent::ErrorCode)
        );
    }

    #[test]
    fn legacy_code_symbol_deserializes_as_explain() {
        let intent: QueryIntent =
            serde_json::from_str("\"code_symbol\"").expect("deserialize code_symbol");
        assert_eq!(intent, QueryIntent::ExplainSymbol);
        let labeled: QueryIntent =
            serde_json::from_str("\"explain_symbol\"").expect("deserialize explain_symbol");
        assert_eq!(labeled, QueryIntent::ExplainSymbol);
    }

    #[test]
    fn extracts_snake_case_symbols() {
        let symbols = extract_snake_case_symbols("explain load_api_timeout in config_loader.py");
        assert!(symbols.iter().any(|s| s == "load_api_timeout"));
    }

    #[test]
    fn file_hint_ignores_trailing_sentence_period() {
        assert_eq!(
            extract_file_hint(
                "What Rust function validates JWT tokens? I need a function name."
            ),
            None
        );
        assert_eq!(
            extract_file_hint("What does handleSend do in ChatView.tsx?"),
            Some("ChatView.tsx".to_string())
        );
        assert_eq!(
            extract_file_hint("imports in config_loader.py"),
            Some("config_loader.py".to_string())
        );
    }
}
