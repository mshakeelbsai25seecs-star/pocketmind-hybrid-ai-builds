//! Standard QA corpus questions used for Knowledge Chat regression checks.

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

pub fn qa_corpus_standard_cases() -> Vec<KcEvalCase> {
    vec![
        qa_case(
            "qa-handlesend",
            "What does handleSend do in ChatView.tsx?",
            &["ChatView.tsx"],
            &["handleSend", "setInput", "input"],
        ),
        qa_case(
            "qa-api-timeout",
            "What environment variable controls the API timeout?",
            &["config_loader.py"],
            &["NEXUS_API_TIMEOUT", "timeout"],
        ),
        qa_case(
            "qa-jwt-validation",
            "What Rust function validates JWT tokens?",
            &["auth_service.rs"],
            &["validate_jwt_token", "jwt"],
        ),
        qa_case(
            "qa-architecture-layers",
            "What are the three layers in the NexusAI architecture?",
            &["architecture.md"],
            &["Presentation", "Orchestration", "Inference"],
        ),
        qa_case(
            "qa-e402",
            "What does error code E-402 mean?",
            &["error-codes.json"],
            &["E-402", "embedding", "model"],
        ),
        qa_case(
            "qa-vpn-first-step",
            "What is the first step for a VPN brute-force alert?",
            &["vpn-incident-response.md"],
            &["Contain", "Block", "VPN"],
        ),
        qa_case(
            "qa-password-approver",
            "Who approves an emergency password reset?",
            &["password-reset-sop.md"],
            &["manager", "SOC lead"],
        ),
        qa_case(
            "qa-alice-log",
            "What error appears in app-2026-06-26.log for user alice?",
            &["app-2026-06-26.log"],
            &["alice", "E-402"],
        ),
        qa_case(
            "qa-onboarding-duration",
            "How long does new-hire onboarding take?",
            &["onboarding-guide.md"],
            &["five", "business", "days"],
        ),
        qa_case(
            "qa-acme-industry",
            "What industry does Acme Corp operate in?",
            &["company-overview.txt"],
            &["cybersecurity"],
        ),
    ]
}

/// Cross-file code navigation questions used to compare Folder Q&A vs Codebase Explorer mode.
///
/// These are engineering-style questions (message flow, symbol lookup, multi-file
/// relationships) that Codebase Explorer's repo map + symbol pinning should answer
/// more reliably than pure chunk retrieval.
pub fn codebase_navigation_cases() -> Vec<KcEvalCase> {
    vec![
        qa_case(
            "ce-message-flow",
            "How does a message get from ChatView.tsx to the backend?",
            &["ChatView.tsx"],
            &["handleSend", "invoke", "add_message"],
        ),
        qa_case(
            "ce-auth-and-config",
            "Which files handle authentication and configuration loading?",
            &["auth_service.rs", "config_loader.py"],
            &["validate_jwt_token", "NEXUS_API_TIMEOUT"],
        ),
        qa_case(
            "ce-chatview-functions",
            "What functions are defined in ChatView.tsx?",
            &["ChatView.tsx"],
            &["handleSend", "handleKeyDown"],
        ),
        qa_case(
            "ce-jwt-flow",
            "How are JWT tokens validated in the Rust auth service?",
            &["auth_service.rs"],
            &["validate_jwt_token", "jwt"],
        ),
        qa_case(
            "ce-timeout-usage",
            "Where is the API timeout read from the environment and what is its default?",
            &["config_loader.py"],
            &["NEXUS_API_TIMEOUT", "timeout", "30"],
        ),
    ]
}

/// Combined suite for comparing both Knowledge Chat modes: 10 standard + 5 cross-file cases.
pub fn codebase_explorer_eval_cases() -> Vec<KcEvalCase> {
    let mut cases = qa_corpus_standard_cases();
    cases.extend(codebase_navigation_cases());
    cases
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::knowledge_chat::qa_corpus::qa_corpus_source_path;
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
        let root = qa_corpus_source_path();
        std::fs::read_to_string(root.join(relative)).unwrap_or_default()
    }

    #[test]
    fn qa_suite_has_standard_questions() {
        let cases = qa_corpus_standard_cases();
        assert_eq!(cases.len(), 10);
        assert!(cases.iter().any(|c| c.id == "qa-handlesend"));
        assert!(cases.iter().any(|c| c.id == "qa-acme-industry"));
    }

    #[test]
    fn codebase_navigation_suite_has_cross_file_cases() {
        let nav = codebase_navigation_cases();
        assert_eq!(nav.len(), 5);
        // At least one question must span multiple files (true cross-file navigation).
        assert!(nav.iter().any(|c| c.expected_files.len() > 1));
        assert!(nav.iter().all(|c| c.id.starts_with("ce-")));

        let combined = codebase_explorer_eval_cases();
        assert_eq!(combined.len(), 15);
    }

    #[test]
    fn qa_corpus_structured_answers_without_llm() {
        let structured_ids = [
            "qa-api-timeout",
            "qa-e402",
            "qa-vpn-first-step",
            "qa-onboarding-duration",
        ];
        let cases = qa_corpus_standard_cases()
            .into_iter()
            .filter(|c| structured_ids.contains(&c.id.as_str()))
            .collect::<Vec<_>>();
        for case in &cases {
            let (file, partition, confidence) = match case.id.as_str() {
                "qa-api-timeout" => ("config_loader.py", "code", 0.57),
                "qa-e402" => ("error-codes.json", "logs_data", 0.85),
                "qa-vpn-first-step" => ("vpn-incident-response.md", "runbooks", 0.56),
                "qa-onboarding-duration" => ("onboarding-guide.md", "documentation", 0.48),
                _ => panic!("unknown case"),
            };
            let relative = match case.id.as_str() {
                "qa-api-timeout" => "code/config_loader.py",
                "qa-e402" => "data/error-codes.json",
                "qa-vpn-first-step" => "runbooks/vpn-incident-response.md",
                "qa-onboarding-duration" => "docs/onboarding-guide.md",
                _ => "",
            };
            let text = load_fixture(relative);
            assert!(!text.is_empty(), "missing fixture for {}", case.id);
            let hits = vec![fixture_hit(file, partition, &text, confidence)];
            let answer = try_structured_answer(&case.question, &hits)
                .unwrap_or_else(|| panic!("no structured answer for {}", case.id));
            assert!(
                answer.confidence >= 0.5,
                "{} confidence too low: {}",
                case.id,
                answer.confidence
            );
            let answer_lower = answer.answer_text.to_lowercase();
            match case.id.as_str() {
                "qa-api-timeout" => {
                    assert!(answer.answer_text.contains("NEXUS_API_TIMEOUT"));
                }
                "qa-e402" => {
                    assert!(answer.answer_text.contains("E-402"));
                    assert!(answer_lower.contains("embedding"));
                }
                "qa-vpn-first-step" => {
                    assert!(answer_lower.contains("contain"));
                }
                "qa-onboarding-duration" => {
                    assert!(answer_lower.contains("business day"));
                }
                _ => {}
            }
        }
    }

    #[test]
    fn qa_paraphrase_intents_structured() {
        let cases = [
            ("What does error E-402 indicate?", "data/error-codes.json", "logs_data", 0.85),
        ];
        for (question, rel, partition, confidence) in cases {
            let text = load_fixture(rel);
            let file = rel.rsplit('/').next().unwrap_or(rel);
            let hits = vec![fixture_hit(file, partition, &text, confidence)];
            let answer = try_structured_answer(question, &hits)
                .unwrap_or_else(|| panic!("no structured answer for {question}"));
            assert!(answer.confidence >= 0.5, "{question}");
        }
    }
}
