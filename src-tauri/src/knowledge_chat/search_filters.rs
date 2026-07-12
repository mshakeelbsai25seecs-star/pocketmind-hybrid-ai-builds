//! Derive hard/soft [`KcSearchFilters`] from the user query when the client
//! did not supply explicit filters. Reduces semantic drift (e.g. scoping to
//! `ChatView.tsx` when the question names that file).

use crate::knowledge_chat::query_intent::{
    classify_query_intent, extract_camel_symbols, extract_file_hint, extract_snake_case_symbols,
    is_code_oriented_intent, QueryIntent,
};
use crate::knowledge_chat::types::KcSearchFilters;

const CODE_EXTENSIONS: &[&str] = &[
    "ts", "tsx", "js", "jsx", "py", "rs", "go", "java", "cs", "cpp", "c", "h", "rb", "php", "kt",
    "sql", "swift",
];

/// True when filters are absent or contain no usable constraints.
pub fn filters_are_empty(filters: &Option<KcSearchFilters>) -> bool {
    let Some(f) = filters else {
        return true;
    };
    let empty_list = |v: &Option<Vec<String>>| {
        v.as_ref()
            .map(|items| items.iter().all(|s| s.trim().is_empty()))
            .unwrap_or(true)
    };
    empty_list(&f.doc_types)
        && empty_list(&f.preferred_doc_types)
        && empty_list(&f.path_contains)
        && empty_list(&f.file_name_contains)
        && empty_list(&f.exclude_path_contains)
}

/// Build filters from query cues. Returns `None` when nothing useful was found.
pub fn derive_search_filters(query: &str) -> Option<KcSearchFilters> {
    derive_search_filters_with_intent(query, None)
}

/// Same as [`derive_search_filters`], but honors an optional Stage-A intent override.
pub fn derive_search_filters_with_intent(
    query: &str,
    intent_override: Option<QueryIntent>,
) -> Option<KcSearchFilters> {
    let q = query.trim();
    if q.is_empty() {
        return None;
    }

    let mut filters = KcSearchFilters::default();
    let mut any = false;
    let intent = intent_override.unwrap_or_else(|| classify_query_intent(q));

    if let Some(file) = extract_file_hint(q) {
        let name = file.rsplit(['/', '\\']).next().unwrap_or(&file).to_string();
        if !name.is_empty() {
            filters.file_name_contains = Some(vec![name.clone()]);
            any = true;
        }
        if file.contains('/') || file.contains('\\') {
            filters.path_contains = Some(vec![file.clone()]);
            any = true;
        }
        let ext = name
            .rsplit('.')
            .next()
            .unwrap_or("")
            .to_ascii_lowercase();
        let is_code_ext = CODE_EXTENSIONS.iter().any(|e| *e == ext.as_str());
        if is_code_ext || is_code_oriented_intent(intent) {
            filters.doc_types = Some(vec!["code".to_string()]);
            any = true;
        }
    } else {
        let has_symbol =
            !extract_camel_symbols(q).is_empty() || !extract_snake_case_symbols(q).is_empty();
        if is_code_oriented_intent(intent) && has_symbol {
            // Soft preferred_doc_types is unused on the hot path; hard-scope to code
            // so symbol questions do not drift into runbooks/docs.
            filters.doc_types = Some(vec!["code".to_string()]);
            any = true;
        }
    }

    // Path-like tokens without a clear file extension (e.g. `src/components`).
    for token in q.split_whitespace() {
        let cleaned = token.trim_matches(|c: char| !c.is_alphanumeric() && !"/\\._-".contains(c));
        if (cleaned.contains('/') || cleaned.contains('\\'))
            && cleaned.len() > 3
            && extract_file_hint(cleaned).is_none()
        {
            let mut paths = filters.path_contains.unwrap_or_default();
            if !paths.iter().any(|p| p.eq_ignore_ascii_case(cleaned)) {
                paths.push(cleaned.to_string());
                any = true;
            }
            filters.path_contains = Some(paths);
        }
    }

    if any {
        Some(filters)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derives_file_name_and_code_doc_type_for_handlesend() {
        let f = derive_search_filters("What does handleSend do in ChatView.tsx?").expect("filters");
        let names = f.file_name_contains.expect("file name");
        assert!(names.iter().any(|n| n.eq_ignore_ascii_case("ChatView.tsx")));
        assert_eq!(f.doc_types.as_deref(), Some(["code".to_string()].as_slice()));
    }

    #[test]
    fn prefers_code_without_file_hint() {
        let f = derive_search_filters("Explain handleSend").expect("filters");
        assert!(f.file_name_contains.is_none());
        assert_eq!(f.doc_types.as_deref(), Some(["code".to_string()].as_slice()));
    }

    #[test]
    fn empty_query_yields_none() {
        assert!(derive_search_filters("   ").is_none());
        assert!(derive_search_filters("what is the company policy?").is_none());
    }

    #[test]
    fn prefers_code_for_list_symbols_intent() {
        let f = derive_search_filters("What functions are defined in ChatView.tsx?").expect("filters");
        assert_eq!(f.doc_types.as_deref(), Some(["code".to_string()].as_slice()));
    }

    #[test]
    fn intent_override_forces_code_scope() {
        let f = derive_search_filters_with_intent(
            "Tell me about timeouts",
            Some(QueryIntent::ExplainSymbol),
        );
        // No symbol/file → may still be None; override alone without cues is ok.
        let f2 = derive_search_filters_with_intent(
            "Explain handleSend",
            Some(QueryIntent::ListSymbolsInFile),
        )
        .expect("filters");
        assert_eq!(f2.doc_types.as_deref(), Some(["code".to_string()].as_slice()));
        let _ = f;
    }

    #[test]
    fn trailing_sentence_period_does_not_scope_to_fake_file() {
        assert!(derive_search_filters(
            "What Rust function validates JWT tokens? I need a function name."
        )
        .is_none());
    }
}
