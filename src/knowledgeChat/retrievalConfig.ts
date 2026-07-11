/**
 * Read-only mirror of the Rust `RetrievalConfig` (src-tauri/src/knowledge_chat/retrieval_config.rs).
 *
 * This exists purely for surfacing the active retrieval tunables in the UI (health /
 * eval / diagnostics panels). It is NOT a second source of truth: the Rust module
 * owns the real values used during search. Keep these in sync when defaults change.
 */

export type KcDeploymentProfile = 'demo' | 'server';

export interface RetrievalConfigView {
  profile: KcDeploymentProfile;
  rrfK: number;
  rerankPoolLimit: number;
  densePrefetchLimit: number;
  densePrefetchLimitExact: number;
  densePairRerankTopN: number;
  onnxRerankTopN: number;
  densePairBlendSelf: number;
  densePairBlendNew: number;
  onnxBlendSelf: number;
  onnxBlendNew: number;
  enableDensePairRerank: boolean;
  enableOnnxRerank: boolean;
}

const DEMO_RETRIEVAL_CONFIG: RetrievalConfigView = {
  profile: 'demo',
  rrfK: 60,
  rerankPoolLimit: 48,
  densePrefetchLimit: 48,
  densePrefetchLimitExact: 100,
  densePairRerankTopN: 24,
  onnxRerankTopN: 48,
  densePairBlendSelf: 0.52,
  densePairBlendNew: 0.48,
  onnxBlendSelf: 0.4,
  onnxBlendNew: 0.6,
  enableDensePairRerank: true,
  enableOnnxRerank: true,
};

const SERVER_RETRIEVAL_CONFIG: RetrievalConfigView = {
  ...DEMO_RETRIEVAL_CONFIG,
  profile: 'server',
  rerankPoolLimit: 96,
  densePrefetchLimit: 100,
  densePrefetchLimitExact: 200,
  densePairRerankTopN: 48,
  onnxRerankTopN: 96,
};

export function retrievalConfigForProfile(profile: string | null | undefined): RetrievalConfigView {
  return profile === 'server' ? SERVER_RETRIEVAL_CONFIG : DEMO_RETRIEVAL_CONFIG;
}

/** Compact human-readable summary of the active retrieval stages for diagnostics UI. */
export function describeRetrievalConfig(config: RetrievalConfigView): string {
  const stages = [
    `RRF k=${config.rrfK}`,
    `pool≤${config.rerankPoolLimit}`,
    config.enableDensePairRerank ? `dense-pair top-${config.densePairRerankTopN}` : 'dense-pair off',
    config.enableOnnxRerank ? `final-rerank top-${config.onnxRerankTopN}` : 'final-rerank off',
  ];
  return stages.join(' · ');
}

/** Expected on-disk model paths after the user downloads the Qwen3 GGUFs. */
export const MODEL_DROP_PATHS = {
  codeEmbedding: String.raw`D:\NexusAI\models\embeddings\Qwen3-Embedding-8B-Q4_K_M.gguf`,
  docEmbedding: String.raw`D:\NexusAI\models\embeddings\bge-m3-Q4_K_M.gguf`,
  reranker: String.raw`D:\NexusAI\models\rerankers\Qwen3-Reranker-4B-Q4_K_M.gguf`,
} as const;

/** Hugging Face download pages for the expected GGUFs. */
export const MODEL_DOWNLOAD_LINKS = {
  codeEmbedding: 'https://huggingface.co/Qwen/Qwen3-Embedding-8B-GGUF',
  docEmbedding: 'https://huggingface.co/gpustack/bge-m3-GGUF',
  /** Prefer a llama.cpp-correct conversion with cls.output.weight. */
  reranker: 'https://huggingface.co/Voodisss/Qwen3-Reranker-4B-GGUF-llama_cpp',
} as const;
