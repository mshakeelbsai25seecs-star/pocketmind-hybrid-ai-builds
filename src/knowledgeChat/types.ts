export type KcCollectionStatus = 'draft' | 'scanning' | 'indexing' | 'ready' | 'failed';
export type KcFileStatus = 'pending' | 'indexed' | 'skipped' | 'error';
export type KcRetrievalMode = 'keyword' | 'hybrid_lexical' | 'dense_vector' | 'hybrid_dense';
export type KcRetrievalConfidence = 'high' | 'medium' | 'low' | 'none';
export type KcAnswerMode = 'found' | 'partial' | 'evidence' | 'not_found';
export type KcEvidenceMode = 'concise' | 'evidence_explanation';
export type KcSearchScope =
  | 'all'
  | 'code'
  | 'documentation'
  | 'runbooks'
  | 'logs_data'
  | 'general'
  | 'docs'
  | 'both';
export type KcFolderCategory =
  | 'mixed'
  | 'source_code_repo'
  | 'documentation_library'
  | 'security_runbooks'
  | 'data_and_logs';

export interface KcPartitionModelConfig {
  partition_id: string;
  embedding_model_path: string;
  profile_id: string;
  vector_dimension?: number | null;
}

export interface KcPartitionConfig {
  folder_category: string;
  partitions: KcPartitionModelConfig[];
}

export interface KcCollection {
  id: string;
  name: string;
  root_path: string;
  status: KcCollectionStatus;
  embedding_model_path: string;
  dense_status: string;
  file_count: number;
  indexed_file_count: number;
  chunk_count: number;
  dense_chunk_count: number;
  code_entity_count?: number;
  indexed_char_count: number;
  last_error?: string | null;
  created_at: number;
  updated_at: number;
  last_indexed_at?: number | null;
  folder_category: string;
  partition_config: KcPartitionConfig;
  image_rag_opt_in?: boolean;
  allow_cloud_media?: boolean;
}

export interface KcFileRecord {
  id: string;
  collection_id: string;
  relative_path: string;
  absolute_path: string;
  name: string;
  extension: string;
  size_bytes: number;
  modified_at: number;
  content_hash?: string | null;
  status: KcFileStatus;
  char_count: number;
  chunk_count: number;
  error_message?: string | null;
  text_fingerprint?: string | null;
  priority_tier?: number;
}

export interface KcChunkRecord {
  id: string;
  collection_id: string;
  file_id: string;
  file_name: string;
  file_path: string;
  chunk_index: number;
  title: string;
  start_char: number;
  end_char: number;
  text: string;
  top_terms: string[];
  has_dense: boolean;
  parent_text?: string | null;
  section_path?: string | null;
  doc_type?: string | null;
  partition_id?: string | null;
  context_text?: string | null;
  line_start?: number | null;
  line_end?: number | null;
  page_start?: number | null;
  page_end?: number | null;
  source_type?: string;
  entity_kind?: string | null;
  entity_name?: string | null;
  source_confidence?: number | null;
  parse_mode?: string | null;
}

export interface KcScannedFile {
  relative_path: string;
  absolute_path: string;
  name: string;
  extension: string;
  size_bytes: number;
  modified_at: number;
  supported: boolean;
  skip_reason?: string | null;
}

export interface KcScanResult {
  collection_id: string;
  root_path: string;
  scanned_files: number;
  supported_files: number;
  skipped_files: number;
  ignored_dirs: number;
  truncated: boolean;
  permission_denied_files: number;
  walk_errors: number;
  files: KcScannedFile[];
}

export interface KcIndexProgress {
  collection_id: string;
  phase: string;
  current: number;
  total: number;
  file_name?: string | null;
  message: string;
  detail?: string | null;
  files_done?: number | null;
  files_failed?: number | null;
  updated_at_ms?: number | null;
  elapsed_ms?: number | null;
  /** running | finished | failed */
  state?: string | null;
}

export interface KcFileIssue {
  relative_path: string;
  status: string;
  message?: string | null;
}

export interface KcIndexResult {
  collection_id: string;
  indexed_files: number;
  skipped_files: number;
  failed_files: number;
  unchanged_files: number;
  total_files: number;
  total_indexed_files: number;
  chunk_count: number;
  dense_chunk_count: number;
  indexed_char_count: number;
  warnings: string[];
  file_issues: KcFileIssue[];
  status: KcCollectionStatus;
}

export interface KcSearchHit {
  chunk: KcChunkRecord;
  retrieval_mode: KcRetrievalMode;
  keyword_score: number;
  lexical_score: number;
  dense_score: number;
  fts_score: number;
  rerank_score: number;
  fused_score: number;
  rank: number;
  relevant_snippet?: string | null;
}

export interface KcQueryRewriteResult {
  original_query: string;
  retrieval_query: string;
  expansions: string[];
  vague: boolean;
}

export interface KcIntentMatch {
  intent_id: string;
  pattern: string;
  answer: string;
  source_hint?: string | null;
  score: number;
}

export interface KcSearchFilters {
  doc_types?: string[];
  preferred_doc_types?: string[];
  path_contains?: string[];
  file_name_contains?: string[];
  exclude_path_contains?: string[];
}

export interface KcGroundedContextSource {
  file_name: string;
  entity_kind?: string | null;
  entity_name?: string | null;
  line_start?: number | null;
  line_end?: number | null;
  source_confidence: number;
  text: string;
  parse_mode?: string | null;
  source_type?: string | null;
}

export interface KcFileCatalogEntry {
  relative_path: string;
  file_name: string;
  absolute_path: string;
  partition_id: string;
  size_bytes: number;
  attachable: boolean;
  summary: string;
}

export interface KcFileCatalog {
  collection_id: string;
  collection_name: string;
  root_path: string;
  catalog_text: string;
  entries: KcFileCatalogEntry[];
}

export interface KcLoadSelectedFilesResult {
  context_block: string;
  sources: KcGroundedContextSource[];
  selected_paths: string[];
  omitted_paths: string[];
}

export interface KcRepoMap {
  collection_id: string;
  collection_name: string;
  root_path: string;
  map_text: string;
  file_count: number;
  symbol_count: number;
}

export interface KcCodebaseContext {
  repo_map: string;
  context_block: string;
  sources: KcGroundedContextSource[];
  pinned_symbols: string[];
  pinned_paths: string[];
}

export interface KcEvidenceItem {
  file_name: string;
  label: string;
  line_start?: number | null;
  line_end?: number | null;
  excerpt: string;
  source_confidence: number;
  plain_summary?: string | null;
}

export interface KcGroundedContext {
  sources: KcGroundedContextSource[];
  context_block: string;
  allow_generation: boolean;
  blocked_reason?: string | null;
  min_confidence_used: number;
  evidence_items?: KcEvidenceItem[];
  evidence_answer?: string | null;
}

export interface KcSearchResult {
  collection_id: string;
  query: string;
  retrieval_query: string;
  mode: KcRetrievalMode;
  hits: KcSearchHit[];
  dense_available: boolean;
  fts_available: boolean;
  confidence: KcRetrievalConfidence;
  confidence_score: number;
  answer_mode: KcAnswerMode;
  sub_queries: string[];
  query_rewrite: KcQueryRewriteResult;
  intent_match?: KcIntentMatch | null;
  onnx_reranker_used: boolean;
  dense_pair_rerank_used: boolean;
  /** True when Qwen3 / llama.cpp RANK reranker scored the top hits. */
  llama_rerank_used?: boolean;
  degradation_reasons?: string[];
  search_scope_applied?: KcSearchScope | null;
  partitions_searched?: string[];
  partition_models_used?: Array<[string, string]>;
  grounded_context?: KcGroundedContext | null;
  structured_answer?: StructuredAnswer | null;
  detected_intent?: QueryIntent | null;
  intent_confidence?: number | null;
  /** Stage-B answer strategy intent (may differ from search/detected intent). */
  answer_intent?: QueryIntent | null;
  /** Origin of the effective intent: `llm` | `rules` | `veto` | `override`. */
  intent_source?: IntentSource | null;
  /** Tree-sitter entity bodies for symbols named in the query (extractive ground truth). */
  symbol_entities?: KcSymbolEntity[];
  /** True when sibling child hits were collapsed into parent bodies. */
  parent_merge_applied?: boolean;
  adjacent_expand_applied?: boolean;
  /** Filters auto-derived from the query when the client sent none. */
  auto_filters_applied?: KcSearchFilters | null;
  /** Per-component pipeline observability for this search. */
  pipeline_trace?: KcPipelineTrace | null;
}

export type KcStageStatus = 'ok' | 'skipped' | 'degraded' | 'failed';

export interface KcStageTrace {
  id: string;
  status: KcStageStatus;
  duration_ms?: number;
  detail?: string;
  remediation?: string;
  /** Truncated snapshot of stage input. */
  input?: string;
  /** Truncated snapshot of stage output. */
  output?: string;
}

export interface KcPipelineTrace {
  stages: KcStageTrace[];
  winning_answer_stage?: string | null;
  corrective_used?: boolean;
  overall_status?: KcStageStatus;
  primary_culprit_stage?: string | null;
  diagnosis_summary?: string | null;
  diagnosis_actions?: string[];
}

export interface KcSymbolEntity {
  file_name: string;
  relative_path: string;
  entity_kind: string;
  entity_name: string;
  line_start: number;
  line_end: number;
  parse_mode: string;
  body: string;
}

export type IntentSource = 'llm' | 'rules' | 'veto' | 'override';

/** Closed-enum intents (snake_case). Legacy `code_symbol` normalizes to `explain_symbol`. */
export type QueryIntent =
  | 'explain_symbol'
  | 'list_symbols_in_file'
  | 'locate_definition'
  | 'file_imports'
  | 'env_var'
  | 'error_code'
  | 'runbook_step'
  | 'timeline'
  | 'general';

const QUERY_INTENT_SET = new Set<string>([
  'explain_symbol',
  'list_symbols_in_file',
  'locate_definition',
  'file_imports',
  'env_var',
  'error_code',
  'runbook_step',
  'timeline',
  'general',
]);

/** Map legacy `code_symbol` → `explain_symbol`; reject unknown labels. */
export function normalizeQueryIntent(raw: string | null | undefined): QueryIntent | null {
  if (!raw) return null;
  const key = raw.trim().toLowerCase();
  if (key === 'code_symbol') return 'explain_symbol';
  if (QUERY_INTENT_SET.has(key)) return key as QueryIntent;
  return null;
}

export function effectiveAnswerIntent(result: {
  answer_intent?: QueryIntent | null;
  detected_intent?: QueryIntent | null;
}): QueryIntent {
  return normalizeQueryIntent(result.answer_intent)
    ?? normalizeQueryIntent(result.detected_intent)
    ?? 'general';
}

export interface StructuredAnswer {
  intent: QueryIntent | 'code_symbol';
  answer_text: string;
  confidence: number;
  source_file: string;
  line_start?: number | null;
  line_end?: number | null;
}

export interface KcCreateCollectionRequest {
  name: string;
  root_path: string;
  embedding_model_path?: string;
  folder_category?: string;
  code_model_path?: string;
  knowledge_model_path?: string;
}

export interface KcPartitionMix {
  root_path: string;
  code_files: number;
  documentation_files: number;
  runbooks_files: number;
  logs_data_files: number;
  general_files: number;
  total_supported: number;
}

export interface KcIndexOptions {
  rebuild?: boolean;
  build_dense?: boolean;
  embedding_model_path?: string;
  /** Compact document embedder (BGE-M3). Do not use Qwen3-8B here. */
  knowledge_model_path?: string;
  incremental?: boolean;
}

export interface KcSearchRequest {
  collection_id: string;
  query: string;
  mode: KcRetrievalMode;
  top_k?: number;
  query_dense_vector?: number[];
  filters?: KcSearchFilters;
  search_scope?: KcSearchScope;
  /** Stage-A intent override for scope / filters / MMR / detected_intent. */
  intent_override?: QueryIntent;
}

export interface KcEmbedTextsRequest {
  model_path: string;
  texts: string[];
  context_size?: number;
  batch_size?: number;
}

export interface KcEmbeddingValidation {
  ok: boolean;
  message: string;
  model_path: string;
  runtime_path?: string;
  warnings: string[];
}

export interface KcEvalCase {
  id: string;
  question: string;
  expected_files: string[];
  expected_terms: string[];
  search_scope?: KcSearchScope;
  forbidden_files?: string[];
}

export interface KcEvalCaseResult {
  case_id: string;
  question: string;
  hit_count: number;
  recall_at_k: number;
  term_hit_rate: number;
  /** Fraction of top-k hits whose file matches expected_files. */
  context_precision_at_k?: number;
  /** Fraction of expected_terms supported by retrieved hit text. */
  lexical_faithfulness?: number;
  mrr: number;
  hybrid_log_rank?: number;
  top_file?: string | null;
  confidence: KcRetrievalConfidence;
  passed: boolean;
}

export type KcEvalMode = 'generic' | 'soc' | 'all';

export interface KcPartitionHealth {
  partition_id: string;
  embedding_model_path: string;
  profile_id: string;
  model_resolved: boolean;
  chunk_count: number;
  dense_chunk_count: number;
  dense_coverage_pct: number;
  vector_dimension?: number | null;
  hnsw_ready: boolean;
  hnsw_vector_count: number;
}

export interface KcCollectionHealth {
  collection_id: string;
  status: KcCollectionStatus;
  file_count: number;
  indexed_file_count: number;
  chunk_count: number;
  dense_chunk_count: number;
  dense_coverage_pct: number;
  fts_populated: boolean;
  indexed_files: number;
  skipped_files: number;
  failed_files: number;
  pending_files: number;
  ocr_needed_files: string[];
  failed_file_samples: string[];
  skipped_file_samples: string[];
  last_error?: string | null;
  hnsw_ready: boolean;
  hnsw_vector_count: number;
  onnx_reranker_configured: boolean;
  onnx_reranker_enabled: boolean;
  pdf_ocr_available: boolean;
  ocr_engine_hint?: string;
  image_rag_opt_in?: boolean;
  image_rag_configured?: boolean;
  folder_category: string;
  partitions: KcPartitionHealth[];
  dual_model_reindex_recommended: boolean;
  code_entity_count: number;
  tree_sitter_files: number;
  heuristic_files: number;
  unsupported_language_files: number;
  parse_failed_files: number;
  code_entity_rebuild_required: boolean;
  code_parse_summary?: string | null;
}

export interface KcSystemReadiness {
  db_ready: boolean;
  embedding_model_resolved: boolean;
  embedding_model_path: string;
  llama_server_available: boolean;
  pdf_ocr_available: boolean;
  onnx_reranker_configured: boolean;
  deployment_data_root: string;
  warnings: string[];
  code_model_resolved: boolean;
  code_model_path: string;
  knowledge_model_resolved: boolean;
  knowledge_model_path: string;
  /** True when a Qwen3 / llama.cpp RANK reranker GGUF is on disk. */
  llama_rerank_configured?: boolean;
  /** Resolved path to the llama RANK reranker GGUF. */
  llama_rerank_model_path?: string;
}

export interface KcEvalResult {
  collection_id: string;
  eval_mode: string;
  production_parity: boolean;
  cases_run: number;
  cases_passed: number;
  average_recall_at_k: number;
  average_term_hit_rate: number;
  average_context_precision_at_k?: number;
  average_lexical_faithfulness?: number;
  average_mrr: number;
  average_hybrid_log_rank?: number;
  results: KcEvalCaseResult[];
}

export interface KnowledgeChatMessageMeta {
  sources: Array<{
    file_name: string;
    file_path: string;
    title: string;
    rank: number;
    fused_score: number;
  }>;
  retrieval_mode: KcRetrievalMode;
  hit_count: number;
  confidence?: KcRetrievalConfidence;
  confidence_score?: number;
  answer_mode?: KcAnswerMode;
  sub_queries?: string[];
  /** Wall time from send click to published answer (ms). */
  latency_ms?: number;
  /** Time until first hybrid search result returned (ms). */
  retrieval_ms?: number;
  /** Time from search complete to published answer (ms). */
  answer_ms?: number;
  /** Unix epoch ms when the answer was published. */
  answered_at_ms?: number;
  /** Per-component pipeline trace for this answer. */
  pipeline_trace?: KcPipelineTrace;
}

export const KC_DEFAULT_EMBEDDING_MODEL = '';

export const QA_CORPUS_NAME = 'PocketMind Hybrid AI QA Corpus';
export const QA_CORPUS_RUNTIME_PATH = 'D:\\nexus-ai-deep-fixed\\runtime-data\\qa-corpus';

export interface KcQaCorpusBootstrapResult {
  collection_id: string;
  collection_name: string;
  root_path: string;
  scanned_files: number;
  indexed_files: number;
  chunk_count: number;
  dense_chunk_count: number;
  status: KcCollectionStatus;
  message: string;
  warnings: string[];
}

export const KC_RETRIEVAL_MODE_LABELS: Record<KcRetrievalMode, string> = {
  keyword: 'Exact words',
  hybrid_lexical: 'Words + smart match',
  dense_vector: 'Meaning search',
  hybrid_dense: 'Best match (recommended)',
};

export const KC_STATUS_LABELS: Record<KcCollectionStatus, string> = {
  draft: 'Draft',
  scanning: 'Scanning',
  indexing: 'Indexing',
  ready: 'Ready',
  failed: 'Failed',
};

export const KC_CONFIDENCE_LABELS: Record<KcRetrievalConfidence, string> = {
  high: 'High confidence',
  medium: 'Medium confidence',
  low: 'Low confidence',
  none: 'No match',
};

export const KC_ANSWER_MODE_LABELS: Record<KcAnswerMode, string> = {
  found: 'Evidence found',
  partial: 'Partial evidence',
  evidence: 'Indexed source evidence',
  not_found: 'Not found in index',
};
