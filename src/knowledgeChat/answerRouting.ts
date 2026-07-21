import type { ProductConfig } from '../productConfig';
import type { KcGroundedContextSource, KcSearchHit, KcSearchResult, QueryIntent } from './types';
import { effectiveAnswerIntent, normalizeQueryIntent } from './types';
import { buildExplainFallbackFromAttached, resolveStructuredAnswer } from './evidenceAnswer';
import { wantsPerSymbolBehaviorExplanation } from './intentClassify';
import { tryExtractiveCodeSymbolAnswer } from './prompts';
import {
  bundleHitsForLlm,
  hasBundledSources,
  MIN_LLM_BUNDLE_CONFIDENCE,
  MAX_WHOLE_FILE_BYTES,
} from './contextBundler';

export type AnswerRoute = 'structured' | 'extractive' | 'llm' | 'evidence' | 'not_found';

export function topSourceConfidence(hits: KcSearchHit[]): number {
  return hits[0]?.chunk.source_confidence ?? 0;
}

/**
 * Local Corrective RAG grader (no web search): when top retrieval confidence is
 * below the generation threshold, prefer deterministic evidence / extractive /
 * not-found over LLM synthesis so the model cannot invent.
 */
export function isWeakGrounding(
  contextHits: KcSearchHit[],
  productConfig: ProductConfig | null | undefined,
): boolean {
  if (!contextHits.length) return true;
  const minGeneration = productConfig?.min_source_confidence_for_generation ?? 0.28;
  const top = topSourceConfidence(contextHits);
  const allowGeneration = contextHits.some(
    hit => (hit.chunk.source_confidence ?? 0) >= Math.max(minGeneration, MIN_LLM_BUNDLE_CONFIDENCE),
  );
  return top < minGeneration || !allowGeneration;
}

function allowsExplainExtractive(intent: QueryIntent): boolean {
  return intent === 'explain_symbol';
}

function allowsSpecialistExtractive(intent: QueryIntent): boolean {
  return intent === 'explain_symbol'
    || intent === 'list_symbols_in_file'
    || intent === 'locate_definition'
    || intent === 'file_imports'
    || intent === 'env_var'
    || intent === 'error_code'
    || intent === 'runbook_step'
    || intent === 'timeline';
}

export function resolveAnswerFallback(
  searchResult: KcSearchResult,
  question: string,
  contextHits: KcSearchHit[],
  attachedSources?: KcGroundedContextSource[] | null,
): string | null {
  const intent = effectiveAnswerIntent(searchResult);
  // general: never force a false extractive specialist
  if (intent === 'general') {
    return searchResult.grounded_context?.evidence_answer?.trim() || null;
  }

  const structured = resolveStructuredAnswer(searchResult, question);
  if (structured) return structured;

  if (allowsExplainExtractive(intent)) {
    return tryExtractiveCodeSymbolAnswer(
      question,
      contextHits,
      searchResult.symbol_entities,
      attachedSources,
    )
      || buildExplainFallbackFromAttached(question, attachedSources)
      || searchResult.grounded_context?.evidence_answer?.trim()
      || null;
  }

  return searchResult.grounded_context?.evidence_answer?.trim() || null;
}

export function shouldUseLlmSynthesis(
  searchResult: KcSearchResult,
  contextHits: KcSearchHit[],
  productConfig: ProductConfig | null | undefined,
  question = '',
): boolean {
  const intent = effectiveAnswerIntent(searchResult);
  if (wantsPerSymbolBehaviorExplanation(question)) {
    // Force synthesis so we explain bodies, not emit a symbol inventory.
    if (!contextHits.length) return false;
    if (isWeakGrounding(contextHits, productConfig)) return false;
    return true;
  }
  if (resolveStructuredAnswer(searchResult, question)) return false;
  if (
    allowsExplainExtractive(intent)
    && question
    && tryExtractiveCodeSymbolAnswer(
      question,
      contextHits,
      searchResult.symbol_entities,
      searchResult.grounded_context?.sources,
    )
  ) {
    return false;
  }
  if (!contextHits.length) return false;
  // Corrective gate: weak grounding → no LLM synthesis.
  if (isWeakGrounding(contextHits, productConfig)) return false;
  if (searchResult.grounded_context && searchResult.grounded_context.allow_generation === false) {
    return false;
  }
  return true;
}

export function resolveAnswerRoute(
  searchResult: KcSearchResult,
  question: string,
  contextHits: KcSearchHit[],
  productConfig: ProductConfig | null | undefined,
): AnswerRoute {
  const intent = effectiveAnswerIntent(searchResult);
  // Name-inventory structured answers must not short-circuit "what does each do?" questions.
  const allowStructured = !wantsPerSymbolBehaviorExplanation(question);

  if (allowStructured && resolveStructuredAnswer(searchResult, question) && allowsSpecialistExtractive(intent)) {
    return 'structured';
  }
  // Structured may still win for general numbered-list answers.
  if (allowStructured && resolveStructuredAnswer(searchResult, question) && intent === 'general') {
    return 'structured';
  }

  if (
    allowsExplainExtractive(intent)
    && tryExtractiveCodeSymbolAnswer(
      question,
      contextHits,
      searchResult.symbol_entities,
      searchResult.grounded_context?.sources,
    )
  ) {
    return 'extractive';
  }

  const hasEvidence = !!searchResult.grounded_context?.evidence_answer?.trim();
  if (isWeakGrounding(contextHits, productConfig)) {
    if (hasEvidence && hasBundledSources(contextHits)) return 'evidence';
    if (hasEvidence) return 'evidence';
    return 'not_found';
  }

  if (shouldUseLlmSynthesis(searchResult, contextHits, productConfig, question)) return 'llm';

  if (hasEvidence && hasBundledSources(contextHits)) return 'evidence';

  const minGeneration = productConfig?.min_source_confidence_for_generation ?? 0.28;
  if (hasEvidence && topSourceConfidence(contextHits) >= minGeneration) return 'evidence';

  return 'not_found';
}

export function isStructuredIntent(intent: QueryIntent | null | undefined): boolean {
  const normalized = normalizeQueryIntent(intent || null);
  return !!normalized && normalized !== 'general';
}

export { MIN_LLM_BUNDLE_CONFIDENCE, MAX_WHOLE_FILE_BYTES, bundleHitsForLlm, hasBundledSources };
