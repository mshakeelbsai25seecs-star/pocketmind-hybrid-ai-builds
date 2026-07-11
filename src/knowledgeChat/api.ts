import { invoke } from '@tauri-apps/api/tauri';
import type {
  KcCollection,
  KcCreateCollectionRequest,
  KcEmbedTextsRequest,
  KcEmbeddingValidation,
  KcEvalResult,
  KcEvalMode,
  KcCollectionHealth,
  KcSystemReadiness,
  KcFileRecord,
  KcIndexOptions,
  KcIndexResult,
  KcQueryRewriteResult,
  KcScanResult,
  KcSearchRequest,
  KcSearchResult,
  KcFileCatalog,
  KcLoadSelectedFilesResult,
  KcRepoMap,
  KcCodebaseContext,
  KcPartitionMix,
  KcQaCorpusBootstrapResult,
} from './types';

type EmbedTextsResult = { vectors: number[][]; model_path: string; vector_dimension: number };

export async function kcListCollections(): Promise<KcCollection[]> {
  return invoke<KcCollection[]>('kc_list_collections');
}

export async function kcGetCollection(collectionId: string): Promise<KcCollection> {
  return invoke<KcCollection>('kc_get_collection', { collectionId });
}

export async function kcCreateCollection(request: KcCreateCollectionRequest): Promise<KcCollection> {
  return invoke<KcCollection>('kc_create_collection', { request });
}

export async function kcDeleteCollection(collectionId: string): Promise<void> {
  return invoke('kc_delete_collection', { collectionId });
}

export async function kcScanCollection(collectionId: string, maxFiles?: number): Promise<KcScanResult> {
  return invoke<KcScanResult>('kc_scan_collection', { collectionId, maxFiles });
}

export async function kcListCollectionFiles(collectionId: string): Promise<KcFileRecord[]> {
  return invoke<KcFileRecord[]>('kc_list_collection_files', { collectionId });
}

export async function kcIndexCollection(collectionId: string, options?: KcIndexOptions): Promise<KcIndexResult> {
  return invoke<KcIndexResult>('kc_index_collection', { collectionId, options });
}

export async function kcHybridSearch(request: KcSearchRequest): Promise<KcSearchResult> {
  return invoke<KcSearchResult>('kc_hybrid_search', { request });
}

export async function kcBuildFileCatalog(collectionId: string): Promise<KcFileCatalog> {
  return invoke<KcFileCatalog>('kc_build_file_catalog', { collectionId });
}

export async function kcLoadSelectedFiles(
  collectionId: string,
  relativePaths: string[],
): Promise<KcLoadSelectedFilesResult> {
  return invoke<KcLoadSelectedFilesResult>('kc_load_selected_files', {
    collectionId,
    relativePaths,
  });
}

export async function kcBuildRepoMap(collectionId: string): Promise<KcRepoMap> {
  return invoke<KcRepoMap>('kc_build_repo_map', { collectionId });
}

export async function kcCodebaseExplorerContext(
  collectionId: string,
  query: string,
): Promise<KcCodebaseContext> {
  return invoke<KcCodebaseContext>('kc_codebase_explorer_context', { collectionId, query });
}

export async function kcPrepareSearchQuery(query: string): Promise<KcQueryRewriteResult> {
  return invoke<KcQueryRewriteResult>('kc_prepare_search_query', { query });
}

export async function kcEmbedQuery(
  modelPath: string,
  query: string,
  contextSize = 2048,
): Promise<number[] | undefined> {
  const result = await invoke<EmbedTextsResult>('kc_embed_query', {
    request: {
      model_path: modelPath,
      texts: [query],
      context_size: contextSize,
      batch_size: 512,
    } satisfies KcEmbedTextsRequest,
  });
  const vector = result.vectors[0];
  return vector?.length ? vector : undefined;
}

export async function kcValidateEmbeddingModel(modelPath: string): Promise<KcEmbeddingValidation> {
  return invoke<KcEmbeddingValidation>('kc_validate_embedding_model', { modelPath });
}

export async function kcSetDefaultEmbeddingModel(modelPath: string): Promise<KcEmbeddingValidation> {
  return invoke<KcEmbeddingValidation>('kc_set_default_embedding_model', { modelPath });
}

export async function kcDiscoverEmbeddingModels(): Promise<string[]> {
  return invoke<string[]>('kc_discover_embedding_models');
}

export async function kcResolveEmbeddingModel(modelPath: string): Promise<string> {
  return invoke<string>('kc_resolve_embedding_model', { modelPath });
}

export async function kcGetDefaultEmbeddingModel(): Promise<string> {
  return invoke<string>('kc_get_default_embedding_model');
}

export async function kcQuickScanFolder(folderPath: string, maxFiles?: number): Promise<KcScanResult> {
  return invoke<KcScanResult>('kc_quick_scan_folder', { folderPath, maxFiles });
}

export async function kcPreviewPartitionMix(folderPath: string, maxFiles?: number): Promise<KcPartitionMix> {
  return invoke<KcPartitionMix>('kc_preview_partition_mix', { folderPath, maxFiles });
}

export async function kcRunEval(
  collectionId: string,
  topK?: number,
  evalMode?: KcEvalMode,
  productionParity = true,
): Promise<KcEvalResult> {
  return invoke<KcEvalResult>('kc_run_eval', {
    collectionId,
    cases: null,
    topK,
    evalMode,
    productionParity,
  });
}

export async function kcCollectionHealth(collectionId: string): Promise<KcCollectionHealth> {
  return invoke<KcCollectionHealth>('kc_collection_health', { collectionId });
}

export async function kcSystemReadiness(): Promise<KcSystemReadiness> {
  return invoke<KcSystemReadiness>('kc_system_readiness');
}

export async function kcEnsureQaCorpus(options?: {
  rebuild?: boolean;
  forceSync?: boolean;
}): Promise<KcQaCorpusBootstrapResult> {
  return invoke<KcQaCorpusBootstrapResult>('kc_ensure_qa_corpus', {
    rebuild: options?.rebuild ?? false,
    force_sync: options?.forceSync ?? false,
  });
}

export function humanError(err: unknown): string {
  let message: string;
  if (err instanceof Error) message = err.message;
  else if (typeof err === 'string') {
    message = err.replace(/^Unknown error:\s*/i, '').trim() || err;
  } else if (err && typeof err === 'object') {
    const record = err as Record<string, unknown>;
    if (typeof record.message === 'string') message = record.message;
    else if (typeof record.error === 'string') message = record.error;
    else {
      const variants = [
        'Unknown',
        'DatabaseError',
        'InferenceError',
        'MissingFile',
        'NetworkError',
        'OutOfMemory',
        'GpuFailure',
        'InvalidApiKey',
      ];
      let found = '';
      for (const key of variants) {
        const value = record[key];
        if (typeof value === 'string') {
          found = value;
          break;
        }
      }
      message = found || (() => {
        try {
          return JSON.stringify(err);
        } catch {
          return String(err);
        }
      })();
    }
  } else {
    message = String(err || 'Unexpected error');
  }

  return shortenInferenceStartupError(message);
}

function shortenInferenceStartupError(message: string): string {
  const marker = 'could not start the selected model after automatic GPU/CPU fallback';
  if (!message.toLowerCase().includes(marker)) {
    return message;
  }
  const parts = message.split(/Details:\s*/i);
  const summary = parts[0]?.trim() || message;
  const details = parts[1] || '';
  const attempts = details.match(/auto [^.]+ failed to become ready: [^.]+\./g) || [];
  const preview = attempts.slice(0, 2).join(' ');
  const suffix = attempts.length > 2
    ? ` (+${attempts.length - 2} more attempts; try CPU-only, a smaller GGUF, context 2048, batch 64)`
    : ' Try CPU-only mode, a smaller GGUF, context 2048, and batch 64.';
  return preview ? `${summary} Details: ${preview}${suffix}` : `${summary}${suffix}`;
}
