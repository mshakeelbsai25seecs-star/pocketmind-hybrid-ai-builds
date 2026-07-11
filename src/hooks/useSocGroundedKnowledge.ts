import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '../store';
import { useKnowledgeChatStore } from '../knowledgeChat/store';
import type { KcSearchHit } from '../knowledgeChat/types';
import type { SocPromptKind, SocWorkspaceInput } from '../socPromptTemplates';
import type { SocArtifactReportType } from '../socReportTemplates';
import type { SocKnowledgeChunk } from '../types';
import {
  buildSocAutoKnowledgeContextBlock,
  buildSocRetrievalQuery,
  mergeSocKnowledgeChunks,
  retrieveSocGroundedKnowledge,
  type SocGroundedRetrievalResult,
} from '../socKnowledgeRetrieval';
import { buildSocKnowledgeContext } from '../socPromptTemplates';

export interface UseSocGroundedKnowledgeOptions {
  action: SocPromptKind;
  workspaceInput: SocWorkspaceInput;
  reportType?: SocArtifactReportType;
  enabled?: boolean;
  debounceMs?: number;
}

export function useSocGroundedKnowledge(options: UseSocGroundedKnowledgeOptions) {
  const {
    socKnowledgeCollectionId,
    socAutoRetrieveKnowledge,
    socKnowledgeResources,
    selectedSocKnowledgeResourceIds,
    selectedSocKnowledgeChunkIds,
  } = useAppStore();
  const { embeddingModelPath, retrievalMode, topK } = useKnowledgeChatStore();

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [retrieval, setRetrieval] = useState<SocGroundedRetrievalResult | null>(null);
  const requestIdRef = useRef(0);

  const query = useMemo(
    () => buildSocRetrievalQuery(options.action, options.workspaceInput, options.reportType),
    [options.action, options.workspaceInput, options.reportType],
  );

  const selectedResources = useMemo(() => {
    const selected = new Set(selectedSocKnowledgeResourceIds);
    return socKnowledgeResources.filter(resource => selected.has(resource.id));
  }, [socKnowledgeResources, selectedSocKnowledgeResourceIds]);

  const selectedManualChunks = useMemo(() => {
    const selected = new Set(selectedSocKnowledgeChunkIds);
    return socKnowledgeResources
      .flatMap(resource => resource.indexedChunks || [])
      .filter(chunk => selected.has(chunk.id));
  }, [socKnowledgeResources, selectedSocKnowledgeChunkIds]);

  const refresh = useCallback(async () => {
    const enabled = options.enabled !== false;
    if (!enabled || !socAutoRetrieveKnowledge || !socKnowledgeCollectionId || !query.trim()) {
      setRetrieval(null);
      setError(null);
      setNotice(null);
      setLoading(false);
      return;
    }

    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);
    setNotice(null);

    try {
      const result = await retrieveSocGroundedKnowledge({
        collectionId: socKnowledgeCollectionId,
        query,
        embeddingModelPath,
        retrievalMode,
        topK,
      });
      if (requestId !== requestIdRef.current) return;
      setRetrieval(result);
      setNotice(result.notice || null);
    } catch (err) {
      if (requestId !== requestIdRef.current) return;
      setRetrieval(null);
      setError(err instanceof Error ? err.message : String(err || 'Retrieval failed'));
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, [
    options.enabled,
    socAutoRetrieveKnowledge,
    socKnowledgeCollectionId,
    query,
    embeddingModelPath,
    retrievalMode,
    topK,
  ]);

  useEffect(() => {
    const debounceMs = options.debounceMs ?? 450;
    const timer = window.setTimeout(() => {
      void refresh();
    }, debounceMs);
    return () => window.clearTimeout(timer);
  }, [refresh, options.debounceMs]);

  const autoChunks = retrieval?.socChunks ?? [];
  const mergedChunks = useMemo(
    () => mergeSocKnowledgeChunks(autoChunks, selectedManualChunks),
    [autoChunks, selectedManualChunks],
  );

  const knowledgeContext = useMemo(() => {
    const autoBlock = buildSocAutoKnowledgeContextBlock(retrieval, error || undefined);
    const manualBlock = buildSocKnowledgeContext(selectedResources, selectedManualChunks);
    return [autoBlock, manualBlock].filter(Boolean).join('\n\n');
  }, [retrieval, error, selectedResources, selectedManualChunks]);

  const contextHits: KcSearchHit[] = retrieval?.contextHits ?? [];

  return {
    loading,
    error,
    notice,
    retrieval,
    query,
    contextHits,
    autoChunks,
    mergedChunks,
    knowledgeContext,
    selectedResources,
    selectedManualChunks,
    refresh,
    collectionReady: Boolean(retrieval?.collection?.status === 'ready'),
    hasAutoRetrieval: Boolean(socAutoRetrieveKnowledge && socKnowledgeCollectionId),
  };
}
