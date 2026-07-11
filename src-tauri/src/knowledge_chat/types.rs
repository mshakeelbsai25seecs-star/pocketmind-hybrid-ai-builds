use crate::knowledge_chat::partitions::{KcPartitionId, KcSearchScope};
use crate::knowledge_chat::query_intent::QueryIntent;
use serde::{Deserialize, Serialize};

pub const KC_VECTOR_DIMENSIONS: usize = 128;
pub const KC_EMBEDDING_KIND: &str = "kc_lexical_hash_v1";
pub const KC_DENSE_KIND: &str = "kc_local_dense_v1";
pub const KC_MAX_FILES_PER_SCAN: usize = 15_000;
pub const KC_MAX_FILE_BYTES: u64 = 100 * 1024 * 1024;
pub const KC_MAX_CHARS_PER_FILE: usize = 200_000;
pub const KC_DEFAULT_EMBEDDING_MODEL: &str = "";
pub const KC_CANDIDATE_POOL_LIMIT: usize = 160;
pub const KC_FTS_RESULT_LIMIT: usize = 120;
pub const KC_RERANK_POOL_LIMIT: usize = 48;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum KcRetrievalConfidence {
    High,
    Medium,
    Low,
    None,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum KcAnswerMode {
    Found,
    Partial,
    Evidence,
    NotFound,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum KcCollectionStatus {
    Draft,
    Scanning,
    Indexing,
    Ready,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum KcFileStatus {
    Pending,
    Indexed,
    Skipped,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum KcRetrievalMode {
    Keyword,
    HybridLexical,
    DenseVector,
    HybridDense,
}

/// Per-partition embedding model configuration persisted on a collection.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KcPartitionModelConfig {
    /// Partition key: code, documentation, runbooks, logs_data, or general.
    pub partition_id: String,
    pub embedding_model_path: String,
    /// Embedding profile id ("nomic_v1_5", "bge_m3", "generic").
    pub profile_id: String,
    /// Vector dimension once embedded (populated after first dense build).
    pub vector_dimension: Option<u32>,
}

/// Full partition configuration for a collection.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct KcPartitionConfig {
    /// Folder category string (see `KcFolderCategory`).
    pub folder_category: String,
    pub partitions: Vec<KcPartitionModelConfig>,
}

impl KcPartitionConfig {
    pub fn model_for(&self, partition: KcPartitionId) -> Option<&KcPartitionModelConfig> {
        self.partitions
            .iter()
            .find(|p| p.partition_id.eq_ignore_ascii_case(partition.as_str()))
    }

    pub fn model_path_for(&self, partition: KcPartitionId) -> String {
        self.model_for(partition)
            .map(|p| p.embedding_model_path.clone())
            .unwrap_or_default()
    }

    pub fn is_empty(&self) -> bool {
        self.partitions.is_empty()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KcCollection {
    pub id: String,
    pub name: String,
    pub root_path: String,
    pub status: KcCollectionStatus,
    pub embedding_model_path: String,
    pub dense_status: String,
    pub file_count: i64,
    pub indexed_file_count: i64,
    pub chunk_count: i64,
    pub dense_chunk_count: i64,
    #[serde(default)]
    pub code_entity_count: i64,
    pub indexed_char_count: i64,
    pub last_error: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub last_indexed_at: Option<i64>,
    /// Folder category string (see `KcFolderCategory`).
    pub folder_category: String,
    /// Parsed per-partition embedding configuration.
    pub partition_config: KcPartitionConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KcFileRecord {
    pub id: String,
    pub collection_id: String,
    pub relative_path: String,
    pub absolute_path: String,
    pub name: String,
    pub extension: String,
    pub size_bytes: i64,
    pub modified_at: i64,
    pub content_hash: Option<String>,
    pub status: KcFileStatus,
    pub char_count: i64,
    pub chunk_count: i64,
    pub error_message: Option<String>,
    pub text_fingerprint: Option<String>,
    pub priority_tier: i64,
    #[serde(default)]
    pub code_parse_mode: Option<String>,
    #[serde(default)]
    pub code_entity_count: i64,
    #[serde(default)]
    pub code_language: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KcChunkRecord {
    pub id: String,
    pub collection_id: String,
    pub file_id: String,
    pub file_name: String,
    pub file_path: String,
    pub chunk_index: i64,
    pub title: String,
    pub start_char: i64,
    pub end_char: i64,
    pub text: String,
    pub top_terms: Vec<String>,
    pub has_dense: bool,
    pub parent_text: Option<String>,
    pub section_path: Option<String>,
    pub doc_type: Option<String>,
    pub partition_id: Option<String>,
    pub context_text: Option<String>,
    pub line_start: Option<i32>,
    pub line_end: Option<i32>,
    pub page_start: Option<i32>,
    pub page_end: Option<i32>,
    #[serde(default = "default_source_type")]
    pub source_type: String,
    #[serde(default)]
    pub entity_kind: Option<String>,
    #[serde(default)]
    pub entity_name: Option<String>,
    #[serde(default)]
    pub source_confidence: Option<f64>,
    #[serde(default)]
    pub parse_mode: Option<String>,
}

fn default_source_type() -> String {
    "chunk".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KcScannedFile {
    pub relative_path: String,
    pub absolute_path: String,
    pub name: String,
    pub extension: String,
    pub size_bytes: u64,
    pub modified_at: i64,
    pub supported: bool,
    pub skip_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KcScanResult {
    pub collection_id: String,
    pub root_path: String,
    pub scanned_files: usize,
    pub supported_files: usize,
    pub skipped_files: usize,
    pub ignored_dirs: usize,
    pub truncated: bool,
    pub permission_denied_files: usize,
    pub walk_errors: usize,
    pub files: Vec<KcScannedFile>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KcIndexProgress {
    pub collection_id: String,
    pub phase: String,
    pub current: usize,
    pub total: usize,
    pub file_name: Option<String>,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KcFileIssue {
    pub relative_path: String,
    pub status: String,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KcIndexResult {
    pub collection_id: String,
    /// Files indexed in this run only.
    pub indexed_files: usize,
    pub skipped_files: usize,
    pub failed_files: usize,
    pub unchanged_files: usize,
    /// Total files in the collection after refresh.
    pub total_files: i64,
    /// Total files with status `indexed` after refresh.
    pub total_indexed_files: i64,
    pub chunk_count: usize,
    pub dense_chunk_count: usize,
    pub indexed_char_count: usize,
    pub warnings: Vec<String>,
    pub file_issues: Vec<KcFileIssue>,
    pub status: KcCollectionStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KcQaCorpusBootstrapResult {
    pub collection_id: String,
    pub collection_name: String,
    pub root_path: String,
    pub scanned_files: usize,
    pub indexed_files: usize,
    pub chunk_count: usize,
    pub dense_chunk_count: usize,
    pub status: KcCollectionStatus,
    pub message: String,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KcQueryRewriteResult {
    pub original_query: String,
    pub retrieval_query: String,
    pub expansions: Vec<String>,
    pub vague: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KcIntentMatch {
    pub intent_id: String,
    pub pattern: String,
    pub answer: String,
    pub source_hint: Option<String>,
    pub score: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct KcSearchFilters {
    /// Hard filter: chunk doc_type must match one of these values.
    pub doc_types: Option<Vec<String>>,
    /// Soft boost during reranking (does not exclude other doc types).
    pub preferred_doc_types: Option<Vec<String>>,
    /// Hard filter: file path must contain at least one substring (OR).
    pub path_contains: Option<Vec<String>>,
    /// Hard filter: file name must contain at least one substring (OR).
    pub file_name_contains: Option<Vec<String>>,
    /// Hard filter: exclude chunks whose path contains any of these substrings.
    pub exclude_path_contains: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KcSearchRequest {
    pub collection_id: String,
    pub query: String,
    pub mode: KcRetrievalMode,
    pub top_k: Option<usize>,
    pub query_dense_vector: Option<Vec<f32>>,
    #[serde(default)]
    pub filters: Option<KcSearchFilters>,
    /// User-selected scope (code / docs / both). Defaults to `both`.
    #[serde(default)]
    pub search_scope: Option<KcSearchScope>,
    /// Per-partition query vectors, keyed by partition id. Populated server-side
    /// after embedding the query with each active partition's model; never sent
    /// by the frontend.
    #[serde(default, skip)]
    pub partition_query_vectors: Vec<(String, Vec<f32>)>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KcSearchHit {
    pub chunk: KcChunkRecord,
    pub retrieval_mode: KcRetrievalMode,
    pub keyword_score: f64,
    pub lexical_score: f64,
    pub dense_score: f64,
    pub fts_score: f64,
    pub rerank_score: f64,
    pub fused_score: f64,
    pub rank: usize,
    /// Query-focused compressed snippet for LLM context (sentence-level extraction).
    pub relevant_snippet: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KcSearchResult {
    pub collection_id: String,
    pub query: String,
    pub retrieval_query: String,
    pub mode: KcRetrievalMode,
    pub hits: Vec<KcSearchHit>,
    pub dense_available: bool,
    pub fts_available: bool,
    pub confidence: KcRetrievalConfidence,
    pub confidence_score: f64,
    pub answer_mode: KcAnswerMode,
    pub sub_queries: Vec<String>,
    pub query_rewrite: KcQueryRewriteResult,
    pub intent_match: Option<KcIntentMatch>,
    pub onnx_reranker_used: bool,
    pub dense_pair_rerank_used: bool,
    /// True when Qwen3 / llama.cpp RANK reranker scored the top hits.
    #[serde(default)]
    pub llama_rerank_used: bool,
    #[serde(default)]
    pub degradation_reasons: Vec<String>,
    /// Scope actually applied to this search.
    #[serde(default)]
    pub search_scope_applied: Option<KcSearchScope>,
    /// Partition ids that were searched (e.g. ["code", "knowledge"]).
    #[serde(default)]
    pub partitions_searched: Vec<String>,
    /// Embedding model path used per searched partition (for diagnostics).
    #[serde(default)]
    pub partition_models_used: Vec<(String, String)>,
    #[serde(default)]
    pub grounded_context: Option<KcGroundedContext>,
    #[serde(default)]
    pub structured_answer: Option<StructuredAnswer>,
    #[serde(default)]
    pub detected_intent: Option<QueryIntent>,
    #[serde(default)]
    pub intent_confidence: Option<f64>,
    /// Compact cheatsheet block for LLM routing (demo folders).
    #[serde(default)]
    pub demo_cheatsheet_block: Option<String>,
    /// Relative paths pinned by demo cheatsheet for file attachment.
    #[serde(default)]
    pub demo_pinned_paths: Vec<String>,
    #[serde(default)]
    pub demo_cheatsheet_active: bool,
    /// Tree-sitter entity bodies for symbols named in the query, ordered by match
    /// priority. Source of truth for extractive code-symbol answers.
    #[serde(default)]
    pub symbol_entities: Vec<KcSymbolEntity>,
    /// True when sibling child hits were collapsed into parent bodies.
    #[serde(default)]
    pub parent_merge_applied: bool,
    /// Filters auto-derived from the query when the client sent none.
    #[serde(default)]
    pub auto_filters_applied: Option<KcSearchFilters>,
    /// Per-component pipeline observability for this search (additive).
    #[serde(default)]
    pub pipeline_trace: Option<crate::knowledge_chat::pipeline_trace::KcPipelineTrace>,
}

/// A code entity (function/class/etc.) whose name matches a symbol in the query.
/// Carries the verbatim Tree-sitter body so the answer stage can quote it directly.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KcSymbolEntity {
    pub file_name: String,
    pub relative_path: String,
    pub entity_kind: String,
    pub entity_name: String,
    pub line_start: i32,
    pub line_end: i32,
    pub parse_mode: String,
    pub body: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StructuredAnswer {
    pub intent: QueryIntent,
    pub answer_text: String,
    pub confidence: f64,
    pub source_file: String,
    #[serde(default)]
    pub line_start: Option<i32>,
    #[serde(default)]
    pub line_end: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KcGroundedContextSource {
    pub file_name: String,
    #[serde(default)]
    pub entity_kind: Option<String>,
    #[serde(default)]
    pub entity_name: Option<String>,
    pub line_start: i32,
    pub line_end: i32,
    pub source_confidence: f64,
    pub text: String,
    #[serde(default)]
    pub parse_mode: Option<String>,
    #[serde(default = "default_source_type")]
    pub source_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KcEvidenceItem {
    pub file_name: String,
    pub label: String,
    #[serde(default)]
    pub line_start: Option<i32>,
    #[serde(default)]
    pub line_end: Option<i32>,
    pub excerpt: String,
    pub source_confidence: f64,
    #[serde(default)]
    pub plain_summary: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KcFileCatalogEntry {
    pub relative_path: String,
    pub file_name: String,
    pub absolute_path: String,
    pub partition_id: String,
    pub size_bytes: i64,
    pub attachable: bool,
    pub summary: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KcFileCatalog {
    pub collection_id: String,
    pub collection_name: String,
    pub root_path: String,
    pub catalog_text: String,
    pub entries: Vec<KcFileCatalogEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KcLoadSelectedFilesResult {
    pub context_block: String,
    pub sources: Vec<KcGroundedContextSource>,
    pub selected_paths: Vec<String>,
    pub omitted_paths: Vec<String>,
}

/// Compact map of the indexed repo: files + their top symbols, for Codebase Explorer mode.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KcRepoMap {
    pub collection_id: String,
    pub collection_name: String,
    pub root_path: String,
    pub map_text: String,
    pub file_count: i64,
    pub symbol_count: i64,
}

/// Symbol-first context assembled for a Codebase Explorer query.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KcCodebaseContext {
    pub repo_map: String,
    pub context_block: String,
    pub sources: Vec<KcGroundedContextSource>,
    pub pinned_symbols: Vec<String>,
    pub pinned_paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KcGroundedContext {
    pub sources: Vec<KcGroundedContextSource>,
    pub context_block: String,
    #[serde(default)]
    pub blocked_reason: Option<String>,
    pub min_confidence_used: f64,
    pub allow_generation: bool,
    #[serde(default)]
    pub evidence_items: Vec<KcEvidenceItem>,
    #[serde(default)]
    pub evidence_answer: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KcCreateCollectionRequest {
    pub name: String,
    pub root_path: String,
    pub embedding_model_path: Option<String>,
    /// Folder category string (see `KcFolderCategory`). Defaults to `mixed`.
    #[serde(default)]
    pub folder_category: Option<String>,
    /// Embedding model for the code partition (defaults to discovered Nomic).
    #[serde(default)]
    pub code_model_path: Option<String>,
    /// Embedding model for the knowledge partition (defaults to discovered BGE-M3).
    #[serde(default)]
    pub knowledge_model_path: Option<String>,
}

/// Result of a lightweight pre-create scan that estimates partition mix.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KcPartitionMix {
    pub root_path: String,
    pub code_files: usize,
    pub documentation_files: usize,
    pub runbooks_files: usize,
    pub logs_data_files: usize,
    pub general_files: usize,
    pub total_supported: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KcEmbedTextsRequest {
    pub model_path: String,
    pub texts: Vec<String>,
    pub context_size: Option<u32>,
    pub batch_size: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KcEmbedTextsResult {
    pub vectors: Vec<Vec<f32>>,
    pub model_path: String,
    pub vector_dimension: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KcEmbeddingValidation {
    pub ok: bool,
    pub message: String,
    pub model_path: String,
    pub runtime_path: Option<String>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KcIndexOptions {
    pub rebuild: Option<bool>,
    pub build_dense: Option<bool>,
    pub embedding_model_path: Option<String>,
    pub incremental: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum KcEvalMode {
    Generic,
    Soc,
    All,
}

/// Health for a single embedding partition within a collection.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KcPartitionHealth {
    pub partition_id: String,
    pub embedding_model_path: String,
    pub profile_id: String,
    pub model_resolved: bool,
    pub chunk_count: i64,
    pub dense_chunk_count: i64,
    pub dense_coverage_pct: f64,
    pub vector_dimension: Option<i64>,
    pub hnsw_ready: bool,
    pub hnsw_vector_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KcCollectionHealth {
    pub collection_id: String,
    pub status: KcCollectionStatus,
    pub file_count: i64,
    pub indexed_file_count: i64,
    pub chunk_count: i64,
    pub dense_chunk_count: i64,
    pub dense_coverage_pct: f64,
    pub fts_populated: bool,
    pub indexed_files: i64,
    pub skipped_files: i64,
    pub failed_files: i64,
    pub pending_files: i64,
    pub ocr_needed_files: Vec<String>,
    pub failed_file_samples: Vec<String>,
    pub skipped_file_samples: Vec<String>,
    pub last_error: Option<String>,
    pub hnsw_ready: bool,
    pub hnsw_vector_count: i64,
    pub onnx_reranker_configured: bool,
    pub onnx_reranker_enabled: bool,
    pub pdf_ocr_available: bool,
    pub folder_category: String,
    pub partitions: Vec<KcPartitionHealth>,
    /// True when a collection still relies on a single legacy model for both
    /// partitions and would benefit from a dual-model rebuild.
    pub dual_model_reindex_recommended: bool,
    pub code_entity_count: i64,
    pub tree_sitter_files: i64,
    pub heuristic_files: i64,
    pub unsupported_language_files: i64,
    pub parse_failed_files: i64,
    pub code_entity_rebuild_required: bool,
    pub code_parse_summary: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KcSystemReadiness {
    pub db_ready: bool,
    pub embedding_model_resolved: bool,
    pub embedding_model_path: String,
    pub llama_server_available: bool,
    pub pdf_ocr_available: bool,
    pub onnx_reranker_configured: bool,
    pub deployment_data_root: String,
    pub warnings: Vec<String>,
    /// Default code-partition embedding model resolved on disk.
    pub code_model_resolved: bool,
    pub code_model_path: String,
    /// Default knowledge-partition embedding model resolved on disk.
    pub knowledge_model_resolved: bool,
    pub knowledge_model_path: String,
    /// True when a Qwen3 / llama.cpp RANK reranker GGUF is on disk.
    #[serde(default)]
    pub llama_rerank_configured: bool,
    /// Resolved path to the llama RANK reranker GGUF (empty when missing).
    #[serde(default)]
    pub llama_rerank_model_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KcEvalCase {
    pub id: String,
    pub question: String,
    pub expected_files: Vec<String>,
    pub expected_terms: Vec<String>,
    /// Search scope this case exercises. `None` defaults to `Both` at run time.
    #[serde(default)]
    pub search_scope: Option<KcSearchScope>,
    /// File-name substrings that must NOT appear in the top hits (scope guard).
    #[serde(default)]
    pub forbidden_files: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KcEvalCaseResult {
    pub case_id: String,
    pub question: String,
    pub hit_count: usize,
    pub recall_at_k: f64,
    pub term_hit_rate: f64,
    /// Fraction of top-k hits whose file matches `expected_files` (Ragas-style context precision).
    #[serde(default)]
    pub context_precision_at_k: f64,
    /// Fraction of `expected_terms` supported by retrieved hit text (lexical faithfulness).
    #[serde(default)]
    pub lexical_faithfulness: f64,
    pub mrr: f64,
    pub top_file: Option<String>,
    pub confidence: KcRetrievalConfidence,
    pub passed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KcEvalResult {
    pub collection_id: String,
    pub eval_mode: String,
    pub production_parity: bool,
    pub cases_run: usize,
    pub cases_passed: usize,
    pub average_recall_at_k: f64,
    pub average_term_hit_rate: f64,
    #[serde(default)]
    pub average_context_precision_at_k: f64,
    #[serde(default)]
    pub average_lexical_faithfulness: f64,
    pub average_mrr: f64,
    pub results: Vec<KcEvalCaseResult>,
}
