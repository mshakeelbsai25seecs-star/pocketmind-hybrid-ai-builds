export interface SystemInfo {
  os_name: string;
  os_version: string;
  cpu: CPUInfo;
  memory: MemoryInfo;
  gpus: GPUInfo[];
  storage: StorageInfo;
  process_memory_bytes: number;
  app_version: string;
}

export interface CPUInfo {
  brand: string;
  cores_physical: number;
  cores_logical: number;
  frequency_mhz: number;
  usage_percent: number;
  architecture: string;
}

export interface MemoryInfo {
  total_bytes: number;
  used_bytes: number;
  free_bytes: number;
  available_bytes: number;
}

export interface GPUInfo {
  name: string;
  vendor: string;
  vram_total_bytes: number;
  vram_used_bytes: number;
  is_cuda_capable: boolean;
  is_metal_capable: boolean;
  is_vulkan_capable: boolean;
  compute_score: number;
}

export interface StorageInfo {
  total_bytes: number;
  free_bytes: number;
}

export interface ModelRecommendation {
  name: string;
  params_billions: number;
  quant: string;
  size_gb: number;
  estimated_tok_sec: number;
  confidence: string;
  required_vram_gb: number;
  required_ram_gb: number;
}

export interface Conversation {
  id: string;
  title: string;
  character_id?: string;
  model_id?: string;
  mode: string;
  created_at: number;
  updated_at: number;
}

export interface Message {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  metadata?: string;
  created_at: number;
}

export interface Character {
  id: string;
  name: string;
  description: string;
  system_prompt: string;
  avatar_path?: string;
  personality_traits: string;
  memory: string;
  folder_id?: string;
  voice_preset?: string;
  created_at: number;
  updated_at: number;
}

export interface LocalModelRecord {
  id: string;
  name: string;
  path: string;
  backend: string;
  quantization?: string;
  size_bytes: number;
  downloaded: boolean;
  source_url?: string;
  metadata?: string;
  created_at: number;
}

export interface GenerationParams {
  temperature: number;
  top_k: number;
  top_p: number;
  repetition_penalty: number;
  max_tokens: number;
  context_size: number;
  gpu_layers: number;
  batch_size: number;
  threads: number;
  rope_scaling?: number;
  flash_attention: boolean;
}

export interface ToolCallFunction {
  name: string;
  arguments: string;
}

export interface ToolCall {
  id: string;
  type?: string;
  function: ToolCallFunction;
}

export interface OpenAiFunctionTool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export interface ChatMessage {
  role: string;
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface GenerationChunk {
  text: string;
  finish_reason?: string;
  tokens_generated: number;
  tokens_per_sec: number;
  tool_calls?: ToolCall[] | null;
}

export type ThemeMode = 'light' | 'dark' | 'system';
export type PerformanceMode = 'low-ram' | 'battery-saver' | 'balanced' | 'maximum-speed' | 'maximum-quality';
export type AppView = 'chat' | 'home' | 'soc' | 'knowledge-chat' | 'code-workspace' | 'hardware' | 'runtime' | 'models' | 'enterprise-server' | 'image-studio' | 'diagnostics' | 'characters' | 'settings' | 'setup' | 'prompts' | 'storage' | 'backup' | 'help';

export type SocKnowledgeCategory =
  | 'FortiSIEM Guide'
  | 'FortiSOAR Guide'
  | 'Fortinet KB / Forum Export'
  | 'Internal SOC SOP'
  | 'FortiSIEM Rule'
  | 'FortiSIEM Parser'
  | 'FortiSOAR Playbook'
  | 'Connector Documentation'
  | 'Incident Example'
  | 'Sample Logs';

export type SocKnowledgeProduct = 'FortiSIEM' | 'FortiSOAR' | 'Fortinet' | 'Internal' | 'Other';

export type SocKnowledgeIndexStatus = 'not_indexed' | 'indexed' | 'warning' | 'error';

export type SocRetrievalMode = 'keyword' | 'hybrid_lexical' | 'dense_vector' | 'hybrid_dense';

export type SocDenseEmbeddingProviderMode = 'disabled' | 'hybrid_lexical_only' | 'local_dense';
export type SocDenseEmbeddingStatus = 'not_configured' | 'ready' | 'indexing' | 'failed';

export interface SocDenseEmbeddingSettings {
  providerMode: SocDenseEmbeddingProviderMode;
  modelPath: string;
  providerName: string;
  status: SocDenseEmbeddingStatus;
  lastIndexedAt?: number;
  vectorizedChunkCount: number;
  vectorDimension?: number;
  runtimePath?: string;
  modelFormat?: string;
  failedChunkCount?: number;
  error?: string;
}

export interface SocKnowledgeChunk {
  id: string;
  resourceId: string;
  resourceTitle: string;
  category: SocKnowledgeCategory;
  product: SocKnowledgeProduct;
  version?: string;
  tags?: string[];
  filePath: string;
  index: number;
  title: string;
  startChar: number;
  endChar: number;
  text: string;
  wordCount?: number;
  uniqueTermCount?: number;
  topTerms?: string[];
  lexicalVector?: number[];
  vectorDimensions?: number;
  embeddingKind?: string;
  vectorizedAt?: number;
  denseVector?: number[];
  denseVectorDimensions?: number;
  denseEmbeddingProvider?: string;
  denseEmbeddingModelPath?: string;
  denseEmbeddedAt?: number;
  denseEmbeddingStatus?: SocDenseEmbeddingStatus;
}

export interface SocDenseEmbeddingProviderValidation {
  ok: boolean;
  message: string;
  model_path: string;
  runtime_path?: string;
  provider_name: string;
  model_format?: string;
  warnings: string[];
}

export interface SocDenseEmbeddingTextRequest {
  chunk_id: string;
  text: string;
}

export interface SocDenseEmbeddingBuildRequest {
  model_path: string;
  texts: SocDenseEmbeddingTextRequest[];
  context_size?: number;
  batch_size?: number;
}

export interface SocDenseEmbeddingVectorResult {
  chunk_id: string;
  vector: number[];
  dimension: number;
}

export interface SocDenseEmbeddingBuildResult {
  ok: boolean;
  provider_name: string;
  runtime_path: string;
  model_path: string;
  model_format: string;
  dimension: number;
  vectors: SocDenseEmbeddingVectorResult[];
  warnings: string[];
}

export interface SocDenseIndexPersisted {
  model_path: string;
  dimension: number;
  updated_at: number;
  vectors: Record<string, number[]>;
}

export interface SocPdfOcrResult {
  ok: boolean;
  source_pdf: string;
  output_markdown: string;
  pages_processed: number;
  ocr_pages: number;
  char_count: number;
  alpha_count: number;
  text: string;
  warnings: string[];
}

export interface SocRagSearchResult {
  chunk: SocKnowledgeChunk;
  retrievalMode: SocRetrievalMode;
  keywordScore: number;
  similarityScore: number;
  denseSimilarityScore?: number;
  combinedScore: number;
}

export interface SocRagHealthStats {
  totalChunks: number;
  keywordIndexedChunks: number;
  vectorizedChunks: number;
  denseVectorChunks: number;
  staleChunks: number;
  failedChunks: number;
  retrievalModes: SocRetrievalMode[];
  embeddingStatus: string;
  embeddingKind: string;
  denseAvailable: boolean;
  denseProviderStatus: SocDenseEmbeddingStatus;
  denseProviderMode: SocDenseEmbeddingProviderMode;
  denseVectorDimension?: number;
  denseProviderName?: string;
  nextRecommendedAction: string;
}


export type SocDataPackChecklistStatus = 'not_received' | 'missing' | 'received' | 'sanitized' | 'imported' | 'indexed' | 'tested';

export interface SocDataPackChecklistItem {
  id: string;
  label: string;
  description: string;
  priority: 'required' | 'recommended' | 'optional';
  status: SocDataPackChecklistStatus;
  updatedAt?: number;
  notes?: string;
}

export type SocCompanyDataType =
  | 'rule'
  | 'parser'
  | 'raw_log'
  | 'alert_incident'
  | 'true_positive'
  | 'false_positive'
  | 'sop_policy'
  | 'severity_escalation'
  | 'response_approval'
  | 'connector_inventory'
  | 'playbook'
  | 'expected_output'
  | 'other';

export interface SocCompanyDataScanFile extends SocKnowledgeScanFile {
  dataType: SocCompanyDataType;
  inferredProduct: SocKnowledgeProduct;
  inferredCategory: SocKnowledgeCategory;
  inferredVersion: string;
  inferredTags: string[];
  duplicate: boolean;
}

export interface SocCompanyDataReadinessStats {
  totalChecklistItems: number;
  receivedOrBetter: number;
  sanitizedOrBetter: number;
  importedOrBetter: number;
  indexedOrBetter: number;
  tested: number;
  requiredMissing: number;
  readinessPercent: number;
  nextRecommendedAction: string;
}

export interface SocKnowledgeScanFile {
  path: string;
  name: string;
  extension: string;
  size_bytes: number;
  supported: boolean;
  reason?: string;
}

export interface SocKnowledgeScanResult {
  folder_path: string;
  scanned_files: number;
  supported_files: number;
  unsupported_files: number;
  truncated: boolean;
  files: SocKnowledgeScanFile[];
}

export interface SocKnowledgeResource {
  id: string;
  title: string;
  category: SocKnowledgeCategory;
  product: SocKnowledgeProduct;
  version: string;
  tags: string[];
  filePath: string;
  notes: string;
  createdAt: number;
  updatedAt: number;
  indexStatus?: SocKnowledgeIndexStatus;
  indexedAt?: number;
  indexedKind?: string;
  indexedCharCount?: number;
  indexedChunkCount?: number;
  extractionWarnings?: string[];
  indexedChunks?: SocKnowledgeChunk[];
}
export interface AttachmentChunk {
  index: number;
  title: string;
  start_char: number;
  end_char: number;
  text: string;
}

export interface AttachmentContext {
  path: string;
  name: string;
  kind: string;
  size_bytes: number;
  text: string;
  warnings: string[];
  chunk_count?: number;
  indexed_chars?: number;
  chunks?: AttachmentChunk[];
}



export interface EnterpriseServerConfig {
  base_url: string;
  selected_model: string;
  api_key_saved: boolean;
  embeddings_enabled: boolean;
  code_embedding_model: string;
  knowledge_embedding_model: string;
  embeddings_base_url: string;
  /** Knowledge Chat runs on the org Full Server RAG gateway (thin client). */
  server_rag_enabled?: boolean;
}

export interface EnterpriseModelInfo {
  id: string;
  owned_by?: string | null;
}

export interface EnterpriseEmbeddingProbe {
  partition: string;
  model_id: string;
  ok: boolean;
  message: string;
}

export interface EnterpriseServerTestResult {
  ok: boolean;
  message: string;
  base_url: string;
  model_count: number;
  models: EnterpriseModelInfo[];
  embedding_probes: EnterpriseEmbeddingProbe[];
}

export interface DiagnosticCheck {
  id: string;
  label: string;
  status: 'pass' | 'warning' | 'fail' | 'info';
  message: string;
  detail?: string;
}

export interface RuntimeDiagnostics {
  app_version: string;
  current_dir: string;
  executable_dir: string;
  llama_server_path?: string | null;
  llama_server_found: boolean;
  llama_server_help_ok: boolean;
  llama_server_error?: string | null;
  models_dir_exists: boolean;
  selected_model_path?: string | null;
  selected_model_exists: boolean;
  selected_model_size_bytes?: number | null;
  free_disk_bytes?: number | null;
  memory_total_bytes?: number | null;
  memory_available_bytes?: number | null;
  cpu_brand?: string | null;
  gpu_summary: string[];
  checks: DiagnosticCheck[];
}

export interface ModelHealthResult {
  ok: boolean;
  response: string;
  elapsed_ms: number;
  tokens_generated: number;
  tokens_per_sec: number;
  warning?: string | null;
}


export interface BackupData {
  app: string;
  version: number;
  exported_at: string;
  conversations: Conversation[];
  messages: Record<string, Message[]>;
  characters: Character[];
  local_models: LocalModelRecord[];
  settings: Record<string, string>;
}


export type ModelCategoryId =
  | 'general'
  | 'coding'
  | 'math'
  | 'business'
  | 'law'
  | 'medical'
  | 'writing'
  | 'small-fast'
  | 'large-quality'
  | 'vision'
  | 'image-realistic'
  | 'image-art'
  | 'image-design';

export interface ModelCategory {
  id: ModelCategoryId;
  label: string;
  description: string;
  icon: string;
}

export interface OfflineChatModelCatalogItem {
  id: string;
  name: string;
  params: string;
  quant: string;
  size: string;
  ram: string;
  speed: string;
  quality: string;
  categories: ModelCategoryId[];
  recommendedUse: string;
  url: string;
  /** Companion multimodal projector GGUF for offline vision. */
  mmprojUrl?: string;
  visionCapable?: boolean;
}

export interface OnlineChatModel {
  id: string;
  provider: 'groq' | 'cerebras' | 'gemini' | 'openrouter' | 'together' | 'openai' | 'anthropic' | 'deepseek' | 'mistral';
  providerName: string;
  modelId: string;
  name: string;
  tier: 'free' | 'premium';
  speed: string;
  quality: string;
  categories: ModelCategoryId[];
  recommendedUse: string;
  requiresApiKey: boolean;
  apiKeyUrl: string;
}

export interface ImageGenerationModel {
  id: string;
  type: 'image';
  mode: 'offline' | 'online';
  tier: 'free' | 'premium';
  provider: 'pollinations' | 'huggingface' | 'together' | 'stability' | 'replicate' | 'local';
  providerName: string;
  modelId: string;
  name: string;
  categories: ModelCategoryId[];
  recommendedUse: string;
  requiresApiKey: boolean;
  supportsDirectGeneration: boolean;
  defaultWidth: number;
  defaultHeight: number;
}

export interface GeneratedImageRecord {
  id: string;
  prompt: string;
  negativePrompt?: string;
  modelId: string;
  provider: string;
  width: number;
  height: number;
  seed: number;
  url: string;
  createdAt: number;
}

export interface GpuRuntimeCheck {
  id: string;
  label: string;
  status: 'pass' | 'warning' | 'fail' | 'info';
  message: string;
  detail?: string | null;
}

export interface GpuRuntimeReport {
  llama_server_path?: string | null;
  runtime_found: boolean;
  supports_gpu_layers: boolean;
  /** True only when a bundled runtime contains real CUDA/Vulkan/Metal libraries. */
  gpu_acceleration_available: boolean;
  supports_cuda_hint: boolean;
  supports_vulkan_hint: boolean;
  supports_metal_hint: boolean;
  supports_flash_attention: boolean;
  nvidia_smi_ok: boolean;
  nvidia_smi_summary?: string | null;
  vulkaninfo_ok: boolean;
  vulkaninfo_summary?: string | null;
  detected_gpus: GPUInfo[];
  selected_model_size_bytes?: number | null;
  recommended_gpu_layers: number;
  recommended_context_size: number;
  recommended_batch_size: number;
  recommended_mode: string;
  auto_strategy?: string;
  auto_gpu_layers?: number;
  auto_context_size?: number;
  auto_batch_size?: number;
  fit_status?: string;
  estimated_total_vram_bytes?: number;
  estimated_available_vram_bytes?: number;
  estimated_available_ram_bytes?: number;
  warning?: string | null;
  checks: GpuRuntimeCheck[];
}
