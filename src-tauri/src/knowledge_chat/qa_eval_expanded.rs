//! Expanded QA corpus eval: paraphrases and adversarial phrasing for intent + structured answers.

use crate::knowledge_chat::intent_classifier::classify_with_confidence;
use crate::knowledge_chat::query_intent::QueryIntent;
use crate::knowledge_chat::types::KcEvalCase;

fn qa_case(id: &str, question: &str, expected_files: &[&str], expected_terms: &[&str]) -> KcEvalCase {
    KcEvalCase {
        id: id.to_string(),
        question: question.to_string(),
        expected_files: expected_files.iter().map(|s| s.to_string()).collect(),
        expected_terms: expected_terms.iter().map(|s| s.to_string()).collect(),
        search_scope: None,
        forbidden_files: Vec::new(),
    }
}

/// Paraphrase and adversarial variants of the five standard QA corpus questions.
pub fn qa_corpus_paraphrase_cases() -> Vec<KcEvalCase> {
    vec![
        qa_case(
            "qa-paraphrase-handlesend-1",
            "Explain handleSend in ChatView.tsx",
            &["ChatView.tsx"],
            &["handleSend", "input"],
        ),
        qa_case(
            "qa-paraphrase-handlesend-2",
            "Walk me through what handleSend does",
            &["ChatView.tsx"],
            &["handleSend"],
        ),
        qa_case(
            "qa-paraphrase-api-timeout",
            "Which env var sets the API timeout?",
            &["config_loader.py"],
            &["NEXUS_API_TIMEOUT", "timeout"],
        ),
        qa_case(
            "qa-paraphrase-e402",
            "What does error E-402 indicate?",
            &["error-codes.json"],
            &["E-402", "embedding"],
        ),
        qa_case(
            "qa-paraphrase-vpn-step",
            "First step for VPN brute force alert?",
            &["vpn-incident-response.md"],
            &["Contain", "VPN"],
        ),
        qa_case(
            "qa-paraphrase-onboarding",
            "How many business days for new hire onboarding?",
            &["onboarding-guide.md"],
            &["five", "business"],
        ),
        qa_case(
            "qa-adversarial-handlesend",
            "In ChatView.tsx what is handleSend responsible for?",
            &["ChatView.tsx"],
            &["handleSend"],
        ),
        qa_case(
            "qa-adversarial-env",
            "Tell me the environment variable name for API timeout configuration",
            &["config_loader.py"],
            &["NEXUS_API_TIMEOUT"],
        ),
    ]
}

pub fn qa_all_eval_questions() -> Vec<String> {
    let mut out: Vec<String> = super::qa_standard_cases::qa_corpus_standard_cases()
        .into_iter()
        .map(|c| c.question)
        .collect();
    out.extend(
        qa_corpus_paraphrase_cases()
            .into_iter()
            .map(|c| c.question),
    );
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::knowledge_chat::qa_corpus::qa_corpus_source_path;
    use crate::knowledge_chat::qa_standard_cases::qa_corpus_standard_cases;
    use crate::knowledge_chat::structured_answer::try_structured_answer;
    use crate::knowledge_chat::types::{KcChunkRecord, KcRetrievalMode, KcSearchHit};

    fn fixture_hit(file: &str, partition: &str, text: &str, confidence: f64) -> KcSearchHit {
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
                line_start: Some(1),
                line_end: Some(20),
                page_start: None,
                page_end: None,
                source_type: "chunk".into(),
                entity_kind: None,
                entity_name: None,
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

    fn load_fixture(relative: &str) -> String {
        std::fs::read_to_string(qa_corpus_source_path().join(relative)).unwrap_or_default()
    }

    #[test]
    fn qa_paraphrase_cases_extend_standard_suite() {
        let standard = qa_corpus_standard_cases();
        let paraphrase = qa_corpus_paraphrase_cases();
        assert!(paraphrase.len() >= 8);
        assert!(standard.len() + paraphrase.len() >= 13);
    }

    #[test]
    fn qa_intent_classifier_recall_gate() {
        let questions = qa_all_eval_questions();
        assert!(!questions.is_empty());
        let structured = questions
            .iter()
            .filter(|q| {
                let c = classify_with_confidence(q);
                c.intent != QueryIntent::General && c.confidence >= 0.55
            })
            .count();
        let rate = structured as f64 / questions.len() as f64;
        assert!(
            rate >= 0.85,
            "intent recall {:.0}% below 85% gate ({structured}/{})",
            rate * 100.0,
            questions.len()
        );
    }

    #[test]
    fn qa_structured_answer_paraphrase_gate() {
        let scenarios: [(&str, &str, &str, &str, f64); 4] = [
            (
                "what are the imports in config_loader.py",
                "code/config_loader.py",
                "config_loader.py",
                "code",
                0.65,
            ),
            (
                "Which env var sets the API timeout?",
                "code/config_loader.py",
                "config_loader.py",
                "code",
                0.57,
            ),
            (
                "What does error E-402 indicate?",
                "data/error-codes.json",
                "error-codes.json",
                "logs_data",
                0.85,
            ),
            (
                "First step for VPN brute force alert?",
                "runbooks/vpn-incident-response.md",
                "vpn-incident-response.md",
                "runbooks",
                0.56,
            ),
        ];
        let mut passed = 0usize;
        for (question, rel, file, partition, confidence) in scenarios {
            let text = load_fixture(rel);
            assert!(!text.is_empty(), "missing fixture {rel}");
            let hits = vec![fixture_hit(file, partition, &text, confidence)];
            if try_structured_answer(question, &hits)
                .map(|a| a.confidence >= 0.5)
                .unwrap_or(false)
            {
                passed += 1;
            }
        }
        assert!(
            passed as f64 / scenarios.len() as f64 >= 0.85,
            "structured answer gate failed: {passed}/{}",
            scenarios.len()
        );
    }
}
