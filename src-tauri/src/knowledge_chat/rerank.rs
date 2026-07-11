use crate::knowledge_chat::types::KcSearchHit;

const DIAGRAM_PLACEHOLDER: &str = "visual table-of-contents or diagram page";

pub fn rerank_hits(query: &str, hits: &mut [KcSearchHit]) {
    let lower = query.to_lowercase();
    let phrases = extract_phrases(&lower);
    let employee_termination = is_employee_termination_query(&lower);

    for hit in hits.iter_mut() {
        let mut bonus = 0.0f64;
        let haystack = format!(
            "{} {} {} {}",
            hit.chunk.file_name,
            hit.chunk.title,
            hit.chunk.section_path.as_deref().unwrap_or(""),
            hit.chunk.context_text.as_deref().unwrap_or(&hit.chunk.text)
        )
        .to_lowercase();

        if haystack.contains(DIAGRAM_PLACEHOLDER) {
            bonus -= 0.35;
        }

        for phrase in &phrases {
            if haystack.contains(phrase) {
                bonus += 0.06;
            }
        }

        if haystack.contains(&lower) {
            bonus += 0.08;
        }

        if hit.chunk.doc_type.as_deref() == Some("markdown") || hit.chunk.doc_type.as_deref() == Some("document") {
            bonus += 0.02;
        }

        if employee_termination {
            if haystack.contains("employee")
                || haystack.contains("offboarding")
                || haystack.contains("human resources")
                || haystack.contains("termination policy")
                || haystack.contains("termination procedure")
            {
                bonus += 0.18;
            }
            if (haystack.contains("rebuild")
                || haystack.contains("eradication")
                || haystack.contains("compromised")
                || haystack.contains("hardened network")
                || haystack.contains("restoration process"))
                && !haystack.contains("employee")
                && !haystack.contains("offboarding")
            {
                bonus -= 0.28;
            }
        }

        hit.rerank_score += bonus;
    }

    hits.sort_by(|a, b| {
        b.rerank_score
            .partial_cmp(&a.rerank_score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    for (idx, hit) in hits.iter_mut().enumerate() {
        hit.rank = idx + 1;
    }
}

fn is_employee_termination_query(query: &str) -> bool {
    query.contains("termination")
        && (query.contains("process")
            || query.contains("procedure")
            || query.contains("employee")
            || query.contains("company")
            || query.contains("document")
            || query.contains("policy")
            || query.contains("policies"))
}

fn extract_phrases(query: &str) -> Vec<String> {
    let words: Vec<&str> = query.split_whitespace().collect();
    let mut phrases = Vec::new();
    for size in (2..=4).rev() {
        for window in words.windows(size) {
            phrases.push(window.join(" "));
        }
    }
    phrases
}
