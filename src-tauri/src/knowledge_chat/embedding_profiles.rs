//! Embedding model profiles.
//!
//! Each profile encapsulates the asymmetric query/document formatting an
//! embedding model family expects plus its preferred context size and pooling
//! mode. Index-time and query-time formatting MUST go through the same profile
//! so vectors stay comparable inside a partition.
//!
//! - `nomic_v1_5`: Nomic embed text, asymmetric `search_query:` / `search_document:` prefixes, mean pooling.
//! - `bge_m3`: BAAI BGE-M3, no instruction prefix, mean pooling.
//! - `qwen3`: Qwen3-Embedding, `Instruct:`/`Query:` on queries only, **last-token** pooling.
//! - `generic`: unknown models, no prefix, mean pooling (safe default).

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EmbeddingProfileId {
    NomicV15,
    BgeM3,
    /// Qwen3-Embedding family (last-token pooling, instruct query format).
    Qwen3,
    Generic,
}

/// Sentence-embedding pooling strategy. Must match how the model was trained.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PoolingMode {
    Mean,
    Last,
    Cls,
}

impl PoolingMode {
    /// llama.cpp `--pooling` argument value.
    pub fn as_llama_arg(&self) -> &'static str {
        match self {
            PoolingMode::Mean => "mean",
            PoolingMode::Last => "last",
            PoolingMode::Cls => "cls",
        }
    }
}

pub struct EmbeddingProfile {
    pub query_prefix: &'static str,
    pub doc_prefix: &'static str,
    pub context_size: u32,
    pub pooling: PoolingMode,
}

impl EmbeddingProfileId {
    pub fn as_str(&self) -> &'static str {
        match self {
            EmbeddingProfileId::NomicV15 => "nomic_v1_5",
            EmbeddingProfileId::BgeM3 => "bge_m3",
            EmbeddingProfileId::Qwen3 => "qwen3",
            EmbeddingProfileId::Generic => "generic",
        }
    }

    pub fn from_value(value: &str) -> EmbeddingProfileId {
        match value.trim().to_ascii_lowercase().as_str() {
            "nomic_v1_5" | "nomic" => EmbeddingProfileId::NomicV15,
            "bge_m3" | "bge-m3" | "bgem3" => EmbeddingProfileId::BgeM3,
            "qwen3" | "qwen3_embedding" | "qwen" => EmbeddingProfileId::Qwen3,
            _ => EmbeddingProfileId::Generic,
        }
    }

    pub fn profile(&self) -> EmbeddingProfile {
        match self {
            EmbeddingProfileId::NomicV15 => EmbeddingProfile {
                query_prefix: "search_query: ",
                doc_prefix: "search_document: ",
                context_size: 2048,
                pooling: PoolingMode::Mean,
            },
            EmbeddingProfileId::BgeM3 => EmbeddingProfile {
                query_prefix: "",
                doc_prefix: "",
                context_size: 8192,
                pooling: PoolingMode::Mean,
            },
            EmbeddingProfileId::Qwen3 => EmbeddingProfile {
                // Qwen3-Embedding: instruction on the query side only; documents raw.
                // Last-token pooling is mandatory for correct vectors.
                query_prefix: "Instruct: Given a search query, retrieve relevant passages that answer the query\nQuery:",
                doc_prefix: "",
                context_size: 8192,
                pooling: PoolingMode::Last,
            },
            EmbeddingProfileId::Generic => EmbeddingProfile {
                query_prefix: "",
                doc_prefix: "",
                context_size: 2048,
                pooling: PoolingMode::Mean,
            },
        }
    }

    pub fn pooling(&self) -> PoolingMode {
        self.profile().pooling
    }
}

/// Infer the profile from a model file path/name. Defaults to `generic` when
/// the family is not recognized.
pub fn resolve_profile_for_model(model_path: &str) -> EmbeddingProfileId {
    let lower = model_path.to_ascii_lowercase();
    if lower.contains("qwen3") && (lower.contains("embed") || lower.contains("embedding")) {
        EmbeddingProfileId::Qwen3
    } else if lower.contains("bge-m3") || lower.contains("bge_m3") || lower.contains("bgem3") {
        EmbeddingProfileId::BgeM3
    } else if lower.contains("nomic") && lower.contains("embed") {
        EmbeddingProfileId::NomicV15
    } else {
        EmbeddingProfileId::Generic
    }
}

/// Resolve the pooling mode for a model file path (used when spawning the
/// embedding server, which only knows the model path).
pub fn pooling_for_model(model_path: &str) -> PoolingMode {
    resolve_profile_for_model(model_path).pooling()
}

/// Format a query string for the given profile (applies the query-side prefix).
pub fn format_query(profile: EmbeddingProfileId, query: &str) -> String {
    let spec = profile.profile();
    let q = query.trim();
    if spec.query_prefix.is_empty() {
        return q.to_string();
    }
    // Qwen3 uses "Query:" without a trailing space in the official template;
    // keep a single space after other prefixes for readability.
    if profile == EmbeddingProfileId::Qwen3 {
        format!("{}{}", spec.query_prefix, q)
    } else {
        format!("{}{}", spec.query_prefix, q)
    }
}

/// Format a document/chunk for the given profile (applies the document-side prefix).
/// The body layout (`file | title | section | snippet`) is shared across profiles
/// so index-time and rerank-time documents match exactly.
pub fn format_document(
    profile: EmbeddingProfileId,
    file_name: &str,
    title: &str,
    section_path: &str,
    snippet: &str,
) -> String {
    let spec = profile.profile();
    format!(
        "{}{} | {} | {} | {}",
        spec.doc_prefix,
        file_name.trim(),
        title.trim(),
        section_path.trim(),
        snippet
    )
}

pub fn context_size_for(profile: EmbeddingProfileId) -> u32 {
    profile.profile().context_size
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nomic_uses_asymmetric_prefixes() {
        assert_eq!(
            format_query(EmbeddingProfileId::NomicV15, "vpn triage"),
            "search_query: vpn triage"
        );
        let doc = format_document(EmbeddingProfileId::NomicV15, "a.md", "T", "S", "body");
        assert!(doc.starts_with("search_document: "));
        assert_eq!(EmbeddingProfileId::NomicV15.pooling(), PoolingMode::Mean);
    }

    #[test]
    fn bge_m3_has_no_prefix() {
        assert_eq!(format_query(EmbeddingProfileId::BgeM3, "vpn triage"), "vpn triage");
        let doc = format_document(EmbeddingProfileId::BgeM3, "a.md", "T", "S", "body");
        assert_eq!(doc, "a.md | T | S | body");
        assert_eq!(context_size_for(EmbeddingProfileId::BgeM3), 8192);
    }

    #[test]
    fn qwen3_uses_instruct_query_and_last_pooling() {
        let q = format_query(EmbeddingProfileId::Qwen3, "handleSend");
        assert!(q.starts_with("Instruct:"));
        assert!(q.contains("Query:handleSend") || q.contains("Query: handleSend") || q.ends_with("handleSend"));
        assert_eq!(EmbeddingProfileId::Qwen3.pooling(), PoolingMode::Last);
        assert_eq!(pooling_for_model("Qwen3-Embedding-8B-Q4_K_M.gguf"), PoolingMode::Last);
        let doc = format_document(EmbeddingProfileId::Qwen3, "a.ts", "f", "s", "body");
        assert!(!doc.starts_with("Instruct:"));
        assert!(doc.starts_with("a.ts |"));
    }

    #[test]
    fn profile_detection_from_path() {
        assert_eq!(
            resolve_profile_for_model("/m/nomic-embed-text-v1.5.Q4_K_M.gguf"),
            EmbeddingProfileId::NomicV15
        );
        assert_eq!(
            resolve_profile_for_model("/m/bge-m3-q8_0.gguf"),
            EmbeddingProfileId::BgeM3
        );
        assert_eq!(
            resolve_profile_for_model("/m/Qwen3-Embedding-8B-Q4_K_M.gguf"),
            EmbeddingProfileId::Qwen3
        );
        assert_eq!(
            resolve_profile_for_model("/m/some-random-model.gguf"),
            EmbeddingProfileId::Generic
        );
    }

    #[test]
    fn profile_id_round_trips() {
        for id in [
            EmbeddingProfileId::NomicV15,
            EmbeddingProfileId::BgeM3,
            EmbeddingProfileId::Qwen3,
            EmbeddingProfileId::Generic,
        ] {
            assert_eq!(EmbeddingProfileId::from_value(id.as_str()), id);
        }
    }
}
