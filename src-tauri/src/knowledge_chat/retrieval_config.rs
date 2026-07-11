//! Centralized retrieval tunables for Knowledge Chat.
//!
//! Previously the RRF constant, rerank pool sizes, dense prefetch limits and
//! rerank blend weights were scattered as module-level `const`s across
//! `search.rs`, `dense_ann.rs`, `dense_rerank.rs` and `onnx_rerank.rs`. This module
//! makes them one struct with per-deployment-profile defaults so the whole retrieval
//! pipeline (fusion, prefetch, dense pair, Qwen RANK, ONNX/phrase) reads from one place
//! and can be swapped without touching each stage.
//!
//! Final neural rerank priority (when each stage is enabled and its model is present):
//! 1. Qwen3-Reranker GGUF via llama.cpp RANK (`enable_llama_rerank`)
//! 2. ONNX cross-encoder (`enable_onnx_rerank`)
//! 3. Phrase/title lexical boosts

use crate::database::Database;
use crate::product::{self, KC_DEPLOYMENT_SERVER};

#[derive(Debug, Clone)]
pub struct RetrievalConfig {
    pub profile: String,
    /// Reciprocal Rank Fusion damping constant.
    pub rrf_k: f64,
    /// Upper bound on the candidate pool carried into reranking.
    pub rerank_pool_limit: usize,
    /// Dense ANN prefetch breadth (approximate HNSW path).
    pub dense_prefetch_limit: usize,
    /// Dense prefetch breadth on the exact (linear) path used for small corpora.
    pub dense_prefetch_limit_exact: usize,
    /// How many top hits the dense pair reranker re-embeds and scores.
    pub dense_pair_rerank_top_n: usize,
    /// How many top hits the final neural reranker (Qwen RANK or ONNX) rescoring covers.
    pub onnx_rerank_top_n: usize,
    /// Dense pair rerank blend: weight kept from the prior score.
    pub dense_pair_blend_self: f64,
    /// Dense pair rerank blend: weight given to the new dense score.
    pub dense_pair_blend_new: f64,
    /// Final neural rerank blend: weight kept from the prior score (Qwen RANK / ONNX).
    pub onnx_blend_self: f64,
    /// Final neural rerank blend: weight given to the new cross-encoder score.
    pub onnx_blend_new: f64,
    pub enable_dense_pair_rerank: bool,
    /// Primary final reranker: Qwen3-Reranker GGUF (llama.cpp `--reranking`).
    /// When the GGUF is missing, search continues with ONNX / phrase fallbacks.
    pub enable_llama_rerank: bool,
    /// Secondary neural fallback when Qwen RANK did not apply.
    pub enable_onnx_rerank: bool,
}

impl RetrievalConfig {
    /// Defaults tuned for accuracy over latency: wider candidate pools and
    /// Qwen RANK (then ONNX) final-rerank coverage (same breadth as the server profile).
    pub fn demo() -> Self {
        Self {
            profile: product::KC_DEPLOYMENT_DEMO.to_string(),
            rrf_k: 60.0,
            rerank_pool_limit: 128,
            dense_prefetch_limit: 128,
            dense_prefetch_limit_exact: 256,
            dense_pair_rerank_top_n: 64,
            onnx_rerank_top_n: 96,
            dense_pair_blend_self: 0.52,
            dense_pair_blend_new: 0.48,
            onnx_blend_self: 0.4,
            onnx_blend_new: 0.6,
            enable_dense_pair_rerank: true,
            enable_llama_rerank: true,
            enable_onnx_rerank: true,
        }
    }

    /// Wider pools for a server deployment with more headroom. Blend weights are
    /// unchanged; breadth matches the accuracy-first demo defaults.
    pub fn server() -> Self {
        Self {
            profile: KC_DEPLOYMENT_SERVER.to_string(),
            ..Self::demo()
        }
    }

    pub fn for_profile(profile: &str) -> Self {
        if profile == KC_DEPLOYMENT_SERVER {
            Self::server()
        } else {
            Self::demo()
        }
    }

    pub fn from_db(db: &Database) -> Self {
        let cfg = product::load_product_config(db);
        Self::for_profile(&cfg.knowledge_chat_deployment_profile)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accuracy_defaults_keep_rerank_enabled_with_wide_pools() {
        let cfg = RetrievalConfig::demo();
        assert!(cfg.enable_dense_pair_rerank);
        assert!(
            cfg.enable_llama_rerank,
            "Qwen RANK is the primary final reranker and must stay on by default"
        );
        assert!(cfg.enable_onnx_rerank, "ONNX remains an enabled fallback");
        assert!(cfg.dense_pair_rerank_top_n >= 64);
        assert!(cfg.rerank_pool_limit >= 128);
        assert_eq!(RetrievalConfig::server().dense_pair_rerank_top_n, cfg.dense_pair_rerank_top_n);
        assert!(RetrievalConfig::server().enable_llama_rerank);
    }
}
