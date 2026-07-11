import type { KcQueryRewriteResult, KcRetrievalConfidence, KcSearchResult } from './types';

const CONFIDENCE_RANK: Record<KcRetrievalConfidence, number> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
};

/**
 * CRAG-lite trigger: low/none always re-searches; medium also re-searches when
 * dense-pair failed, top confidence is thin, or retrieval reported degradation.
 * Extractive / structured wins should skip this (caller checks).
 */
export function needsCorrectiveRetrieval(searchResult: KcSearchResult): boolean {
  if (searchResult.confidence === 'low' || searchResult.confidence === 'none') {
    return true;
  }
  if (searchResult.confidence === 'medium') {
    if (searchResult.dense_available && !searchResult.dense_pair_rerank_used) return true;
    const top = searchResult.hits[0]?.chunk.source_confidence ?? 0;
    if (top > 0 && top < 0.45) return true;
    if ((searchResult.degradation_reasons?.length ?? 0) > 0) return true;
  }
  return false;
}

/**
 * Extractive / structured answers short-circuit CRAG — no extra retrieval.
 */
export function shouldSkipCorrectiveRetrieval(
  hasStructuredAnswer: boolean,
  hasExtractivePreview: boolean,
): boolean {
  return hasStructuredAnswer || hasExtractivePreview;
}

/**
 * Tighten the query for corrective re-search: keep the original question (rule rewrite
 * base) and drop vague / LLM expansions that diluted the first pass.
 */
export function tightenSearchQuery(
  question: string,
  rewrite: KcQueryRewriteResult,
): string {
  const original = (rewrite.original_query || question).trim();
  if (!original) return question.trim();
  // Prefer the unaugmented original; expansions live only on retrieval_query.
  return original.replace(/\s+/g, ' ');
}

/** Prefer the corrective pass when confidence improves or it surfaces more hits. */
export function shouldPreferCorrectiveResult(
  corrective: KcSearchResult,
  original: KcSearchResult,
): boolean {
  const rankDelta =
    CONFIDENCE_RANK[corrective.confidence] - CONFIDENCE_RANK[original.confidence];
  if (rankDelta > 0) return true;
  if (rankDelta < 0) return false;

  const corrTop = corrective.hits[0]?.chunk.source_confidence ?? 0;
  const origTop = original.hits[0]?.chunk.source_confidence ?? 0;
  if (corrTop > origTop + 0.02) return true;
  if (corrTop < origTop - 0.02) return false;

  return corrective.hits.length >= original.hits.length;
}

export const CORRECTIVE_RETRIEVAL_NOTICE =
  'Corrective retrieval: re-searched with tightened query.';
