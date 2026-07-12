use crate::knowledge_chat::query_intent::{
    classify_query_intent, extract_camel_symbols, extract_error_code, extract_file_hint,
    is_file_imports_question, is_list_symbols_question, is_locate_definition_question, QueryIntent,
};

#[derive(Debug, Clone)]
pub struct IntentClassification {
    pub intent: QueryIntent,
    pub confidence: f64,
}

/// Weighted pattern classifier — offline, no ML runtime. Returns intent + confidence for routing.
pub fn classify_with_confidence(query: &str) -> IntentClassification {
    let intent = classify_query_intent(query);
    let confidence = score_intent_confidence(query, intent);
    IntentClassification { intent, confidence }
}

fn score_intent_confidence(query: &str, intent: QueryIntent) -> f64 {
    if intent == QueryIntent::General {
        return 0.0;
    }

    let q = query.to_lowercase();
    let mut score: f64 = 0.45;

    match intent {
        QueryIntent::ErrorCode => {
            if extract_error_code(query).is_some() {
                score += 0.35;
            }
            if q.contains("error code") {
                score += 0.15;
            }
        }
        QueryIntent::EnvVar => {
            if q.contains("environment variable")
                || q.contains("env var")
                || q.contains("from the environment")
                || q.contains("from environment")
            {
                score += 0.30;
            }
            if q.contains("timeout") && (q.contains("default") || q.contains("environ")) {
                score += 0.25;
            }
            if query.contains("NEXUS_") {
                score += 0.20;
            }
        }
        QueryIntent::RunbookStep => {
            if q.contains("first step") {
                score += 0.30;
            }
            if q.contains("what should i do") || q.contains("what do i do") {
                score += 0.20;
            }
            if q.contains("who approves") || q.contains("password reset") {
                score += 0.25;
            }
        }
        QueryIntent::Timeline => {
            if q.contains("how long") || q.contains("how many days") {
                score += 0.30;
            }
            if (q.contains("how many") && q.contains("day")) || q.contains("business day") {
                score += 0.30;
            }
            if q.contains("onboarding") {
                score += 0.15;
            }
        }
        QueryIntent::ListSymbolsInFile => {
            if is_list_symbols_question(&q) {
                score += 0.25;
            }
            if extract_file_hint(query).is_some() {
                score += 0.20;
            }
        }
        QueryIntent::FileImports => {
            if is_file_imports_question(&q) {
                score += 0.30;
            }
            if extract_file_hint(query).is_some() {
                score += 0.15;
            }
        }
        QueryIntent::LocateDefinition => {
            if is_locate_definition_question(&q) {
                score += 0.25;
            }
            if !extract_camel_symbols(query).is_empty() || extract_file_hint(query).is_some() {
                score += 0.15;
            }
        }
        QueryIntent::ExplainSymbol => {
            if !extract_camel_symbols(query).is_empty() {
                score += 0.25;
            }
            if extract_file_hint(query).is_some() {
                score += 0.15;
            }
            if q.contains("explain") || q.contains("what does") || q.contains("walk me through") {
                score += 0.10;
            }
            if q.contains("function") || q.contains("jwt") || q.contains("responsible") {
                score += 0.15;
            }
        }
        QueryIntent::General => {}
    }

    score.clamp(0.0, 0.99)
}

pub fn is_high_confidence_structured(classification: &IntentClassification) -> bool {
    classification.intent != QueryIntent::General && classification.confidence >= 0.55
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn e402_high_confidence() {
        let c = classify_with_confidence("What does error code E-402 mean?");
        assert_eq!(c.intent, QueryIntent::ErrorCode);
        assert!(c.confidence >= 0.7);
    }

    #[test]
    fn paraphrase_explain_symbol_confidence() {
        let c = classify_with_confidence("Explain handleSend in ChatView.tsx");
        assert_eq!(c.intent, QueryIntent::ExplainSymbol);
        assert!(c.confidence >= 0.55);
    }

    #[test]
    fn list_symbols_confidence() {
        let c = classify_with_confidence("What functions are defined in ChatView.tsx?");
        assert_eq!(c.intent, QueryIntent::ListSymbolsInFile);
        assert!(c.confidence >= 0.55);
    }

    #[test]
    fn locate_definition_confidence() {
        let c = classify_with_confidence("Where is handleSend defined?");
        assert_eq!(c.intent, QueryIntent::LocateDefinition);
        assert!(c.confidence >= 0.55);
    }
}
