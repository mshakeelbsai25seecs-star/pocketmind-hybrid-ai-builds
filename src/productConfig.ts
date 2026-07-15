import { invoke } from '@tauri-apps/api/tauri';
import type { KcEvidenceMode } from './knowledgeChat/types';

/** App security and quality settings (Settings → Security). */
export interface ProductConfig {
  block_low_confidence_generation: boolean;
  min_confidence_score: number;
  min_source_confidence_for_context: number;
  min_source_confidence_for_generation: number;
  audit_log_enabled: boolean;
  allow_intent_short_circuit: boolean;
  enable_llm_query_expand: boolean;
  folder_agnostic_mode: boolean;
  enable_hyde: boolean;
  knowledge_chat_evidence_mode: KcEvidenceMode;
  /** `demo` = laptop-friendly limits; `server` = full context for 70B deployment */
  knowledge_chat_deployment_profile: 'demo' | 'server';
  enable_contextual_indexing: boolean;
  enable_semantic_chunking: boolean;
  enable_exact_dense_search: boolean;
  enable_llm_contextual_summaries: boolean;
  /** `folder_qa` = document-oriented grounded RAG; `codebase_explorer` = repo map + symbol-first retrieval. */
  knowledge_chat_mode: KcKnowledgeChatMode;
}

export type KcKnowledgeChatMode = 'folder_qa' | 'codebase_explorer';

export const DEFAULT_PRODUCT_CONFIG: ProductConfig = {
  block_low_confidence_generation: true,
  min_confidence_score: 0.15,
  min_source_confidence_for_context: 0.42,
  min_source_confidence_for_generation: 0.28,
  audit_log_enabled: true,
  allow_intent_short_circuit: false,
  enable_llm_query_expand: true,
  folder_agnostic_mode: true,
  enable_hyde: true,
  knowledge_chat_evidence_mode: 'evidence_explanation',
  knowledge_chat_deployment_profile: 'server',
  enable_contextual_indexing: true,
  enable_semantic_chunking: true,
  enable_exact_dense_search: true,
  enable_llm_contextual_summaries: false,
  knowledge_chat_mode: 'folder_qa',
};

export const SOC_APP_NAME = 'Nexus AI — Fortinet SOC Copilot';

export const SOC_ARTIFACT_DISCLAIMER =
  'Draft for analyst review. Human approval is required before any response action in your environment.';

export function mapProductConfig(raw: ProductConfig): ProductConfig {
  return {
    block_low_confidence_generation: raw.block_low_confidence_generation !== false,
    min_confidence_score: Number(raw.min_confidence_score) || 0.15,
    min_source_confidence_for_context: Number(raw.min_source_confidence_for_context) || 0.42,
    min_source_confidence_for_generation: Number(raw.min_source_confidence_for_generation) || 0.28,
    audit_log_enabled: raw.audit_log_enabled !== false,
    allow_intent_short_circuit: raw.allow_intent_short_circuit === true,
    enable_llm_query_expand: raw.enable_llm_query_expand !== false,
    folder_agnostic_mode: raw.folder_agnostic_mode !== false,
    enable_hyde: raw.enable_hyde !== false,
    knowledge_chat_evidence_mode: raw.knowledge_chat_evidence_mode === 'evidence_explanation'
      ? 'evidence_explanation'
      : 'concise',
    knowledge_chat_deployment_profile: raw.knowledge_chat_deployment_profile === 'demo'
      ? 'demo'
      : 'server',
    enable_contextual_indexing: raw.enable_contextual_indexing !== false,
    enable_semantic_chunking: raw.enable_semantic_chunking !== false,
    enable_exact_dense_search: raw.enable_exact_dense_search !== false
      || raw.knowledge_chat_deployment_profile !== 'demo',
    enable_llm_contextual_summaries: raw.enable_llm_contextual_summaries === true,
    knowledge_chat_mode: raw.knowledge_chat_mode === 'codebase_explorer'
      ? 'codebase_explorer'
      : 'folder_qa',
  };
}

export async function loadProductConfig(): Promise<ProductConfig> {
  const raw = await invoke<ProductConfig>('get_product_config');
  return mapProductConfig(raw);
}

export async function saveProductConfig(config: ProductConfig): Promise<ProductConfig> {
  const raw = await invoke<ProductConfig>('set_product_config', { config });
  return mapProductConfig(raw);
}

export const SOC_LOW_CONFIDENCE_BLOCKED_MESSAGE = [
  'Not enough matching content was found in your indexed company folder to answer confidently.',
  '',
  'Try one of the following:',
  '• Add or update documents, then scan and index again in Company Knowledge.',
  '• Add more detail to the alert and log fields above.',
  '• Adjust the evidence threshold in Settings → Security if your policy allows.',
].join('\n');
