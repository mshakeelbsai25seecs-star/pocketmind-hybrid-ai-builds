use crate::knowledge_chat::context_bundle::{
    self, bundle_options_for_profile, filter_hits_for_bundle, MIN_LLM_BUNDLE_CONFIDENCE,
};
use crate::knowledge_chat::source_confidence::DEFAULT_MIN_SOURCE_CONFIDENCE_GENERATION;
use crate::knowledge_chat::types::{KcGroundedContext, KcSearchHit};
use crate::product::{self, KC_DEPLOYMENT_SERVER};

pub fn build_grounded_context(
    collection_name: &str,
    collection_root: &str,
    hits: &[KcSearchHit],
    pinned_relative_paths: &[String],
    min_strong_confidence: f64,
    min_generation_confidence: f64,
    _char_budget: Option<usize>,
    server_profile: bool,
) -> KcGroundedContext {
    let options = bundle_options_for_profile(collection_name, server_profile);
    let bundle = context_bundle::bundle_hits_for_llm_with_pins(
        hits,
        &options,
        pinned_relative_paths,
        collection_root,
    );
    let bundled_hits = filter_hits_for_bundle(hits);

    let strong_count = bundled_hits
        .iter()
        .filter(|hit| hit.chunk.source_confidence.unwrap_or(0.0) >= min_strong_confidence)
        .count();

    let pinned = !pinned_relative_paths.is_empty();
    let allow_generation = !bundle.sources.is_empty()
        && (pinned
            || bundled_hits.iter().any(|hit| {
                hit.chunk.source_confidence.unwrap_or(0.0)
                    >= min_generation_confidence.max(MIN_LLM_BUNDLE_CONFIDENCE)
            }));

    if bundle.bundled_count == 0 {
        return KcGroundedContext {
            sources: Vec::new(),
            context_block: bundle.context_block,
            blocked_reason: Some(format!(
                "No indexed excerpts or whole files met {:.0}% bundle confidence{}.",
                MIN_LLM_BUNDLE_CONFIDENCE * 100.0,
                if bundle.omitted_oversize.is_empty() {
                    String::new()
                } else {
                    format!("; no attachable content for: {}", bundle.omitted_oversize.join(", "))
                }
            )),
            min_confidence_used: MIN_LLM_BUNDLE_CONFIDENCE,
            allow_generation: false,
            evidence_items: Vec::new(),
            evidence_answer: None,
        };
    }

    let blocked_reason = if allow_generation {
        None
    } else if strong_count == 0 {
        Some(format!(
            "Whole files attached (>= {:.0}%) but none reached strong threshold ({:.0}%).",
            MIN_LLM_BUNDLE_CONFIDENCE * 100.0,
            min_strong_confidence * 100.0
        ))
    } else {
        None
    };

    KcGroundedContext {
        sources: bundle.sources,
        context_block: bundle.context_block,
        blocked_reason,
        min_confidence_used: MIN_LLM_BUNDLE_CONFIDENCE,
        allow_generation,
        evidence_items: Vec::new(),
        evidence_answer: None,
    }
}

pub fn default_thresholds() -> (f64, f64) {
    (
        MIN_LLM_BUNDLE_CONFIDENCE,
        DEFAULT_MIN_SOURCE_CONFIDENCE_GENERATION,
    )
}

pub fn server_profile_from_db(db: &crate::database::Database) -> bool {
    product::load_product_config(db).knowledge_chat_deployment_profile == KC_DEPLOYMENT_SERVER
}
