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
  /** Qwen/llama RANK top-N (Rust RetrievalConfig.llama_rerank_top_n). */
  llamaRerankTopN: number;
  densePairBlendSelf: number;
  densePairBlendNew: number;
  onnxBlendSelf: number;
  onnxBlendNew: number;
  enableDensePairRerank: boolean;
  /** Primary final reranker: Qwen3-Reranker GGUF via llama.cpp RANK. */
  enableLlamaRerank: boolean;
  /** Secondary neural fallback when Qwen RANK did not apply. */
  enableOnnxRerank: boolean;
}

const DEMO_RETRIEVAL_CONFIG: RetrievalConfigView = {
  profile: 'demo',
  rrfK: 60,
  rerankPoolLimit: 128,
  densePrefetchLimit: 128,
  densePrefetchLimitExact: 256,
  densePairRerankTopN: 64,
  onnxRerankTopN: 96,
  llamaRerankTopN: 16,
  densePairBlendSelf: 0.52,
  densePairBlendNew: 0.48,
  onnxBlendSelf: 0.4,
  onnxBlendNew: 0.6,
  enableDensePairRerank: true,
  enableLlamaRerank: true,
  enableOnnxRerank: true,
};

const SERVER_RETRIEVAL_CONFIG: RetrievalConfigView = {
  ...DEMO_RETRIEVAL_CONFIG,
  profile: 'server',
  rerankPoolLimit: 160,
  densePrefetchLimit: 160,
  densePrefetchLimitExact: 320,
  densePairRerankTopN: 96,
  onnxRerankTopN: 96,
  llamaRerankTopN: 48,
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
    config.enableLlamaRerank
      ? `qwen-rank(primary) top-${config.llamaRerankTopN}`
      : 'qwen-rank off',
    config.enableOnnxRerank ? `onnx/phrase(fallback) top-${config.onnxRerankTopN}` : 'onnx fallback off',
  ];
  return stages.join(' · ');
}

/** Suggested filenames under Settings → Deployment models dir (portable; no machine-specific roots). */
export const MODEL_DROP_PATHS = {
  codeEmbedding: 'models/embeddings/Qwen3-Embedding-8B-Q4_K_M.gguf',
  docEmbedding: 'models/embeddings/bge-m3-Q4_K_M.gguf',
  reranker: 'models/rerankers/Qwen3-Reranker-4B-Q4_K_M.gguf',
} as const;

/** Hugging Face download pages for the expected GGUFs. */
export const MODEL_DOWNLOAD_LINKS = {
  codeEmbedding: 'https://huggingface.co/Qwen/Qwen3-Embedding-8B-GGUF',
  docEmbedding: 'https://huggingface.co/gpustack/bge-m3-GGUF',
  /** Prefer a llama.cpp-correct conversion with cls.output.weight. */
  reranker: 'https://huggingface.co/Voodisss/Qwen3-Reranker-4B-GGUF-llama_cpp',
  unlimitedOcr: 'https://huggingface.co/baidu/Unlimited-OCR',
} as const;

export type SupportModelKind = 'code_embedding' | 'doc_embedding' | 'reranker' | 'unlimited_ocr';

export interface SupportModelCatalogEntry {
  id: SupportModelKind;
  title: string;
  description: string;
  /** Relative under modelsDir, e.g. embeddings or rerankers. Empty for OCR (uses app data root). */
  destSubdir: string;
  fileName: string;
  /** Direct HTTPS URL for GGUF downloads; empty for HF snapshot downloads (OCR). */
  url: string;
  repoPage: string;
  /** Approximate size label for UI. */
  sizeLabel: string;
  /** How the app downloads this asset. */
  downloadMode: 'gguf' | 'hf_snapshot';
  requiredFor: string;
}

/**
 * On-demand support models (not bundled in the installer).
 * Chat GGUFs stay in Models; these power Knowledge Chat + optional OCR.
 */
export const SUPPORT_MODEL_CATALOG: SupportModelCatalogEntry[] = [
  {
    id: 'doc_embedding',
    title: 'Document embeddings (BGE-M3)',
    description: 'Recommended for Knowledge Chat PDFs, docs, and runbooks.',
    destSubdir: 'embeddings',
    fileName: 'bge-m3-Q4_K_M.gguf',
    url: 'https://huggingface.co/gpustack/bge-m3-GGUF/resolve/main/bge-m3-Q4_K_M.gguf?download=true',
    repoPage: MODEL_DOWNLOAD_LINKS.docEmbedding,
    sizeLabel: '~418 MB',
    downloadMode: 'gguf',
    requiredFor: 'Knowledge Chat document search',
  },
  {
    id: 'code_embedding',
    title: 'Code embeddings (Qwen3-Embedding-8B)',
    description: 'For Knowledge Chat / code partition. Large — skip on low-RAM PCs.',
    destSubdir: 'embeddings',
    fileName: 'Qwen3-Embedding-8B-Q4_K_M.gguf',
    url: 'https://huggingface.co/Qwen/Qwen3-Embedding-8B-GGUF/resolve/main/Qwen3-Embedding-8B-Q4_K_M.gguf?download=true',
    repoPage: MODEL_DOWNLOAD_LINKS.codeEmbedding,
    sizeLabel: '~4.4 GB',
    downloadMode: 'gguf',
    requiredFor: 'Knowledge Chat code search',
  },
  {
    id: 'reranker',
    title: 'Reranker (Qwen3-Reranker-4B)',
    description: 'Improves answer ranking (llama.cpp RANK). Optional but recommended.',
    destSubdir: 'rerankers',
    fileName: 'Qwen3-Reranker-4B-Q4_K_M.gguf',
    url: 'https://huggingface.co/Voodisss/Qwen3-Reranker-4B-GGUF-llama_cpp/resolve/main/Qwen3-Reranker-4B-Q4_K_M.gguf?download=true',
    repoPage: MODEL_DOWNLOAD_LINKS.reranker,
    sizeLabel: '~2.3 GB',
    downloadMode: 'gguf',
    requiredFor: 'Knowledge Chat ranking quality',
  },
  {
    id: 'unlimited_ocr',
    title: 'Unlimited-OCR weights',
    description: 'Optional high-accuracy scanned PDF/image OCR. Works on CPU (slower) or NVIDIA CUDA. Needs Python torch + transformers.',
    destSubdir: '',
    fileName: '(Hugging Face snapshot)',
    url: '',
    repoPage: MODEL_DOWNLOAD_LINKS.unlimitedOcr,
    sizeLabel: 'multi-GB',
    downloadMode: 'hf_snapshot',
    requiredFor: 'Optional Unlimited-OCR engine',
  },
];
