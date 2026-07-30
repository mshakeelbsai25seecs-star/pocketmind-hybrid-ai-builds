import type { KcGroundedContextSource, KcSearchHit, KcSymbolEntity } from './types';
import { isEmptyModelResponse, isNotFoundAnswer } from './groundingCheck';
import {
  isCodeSymbolQuestion,
  tryExtractiveCodeSymbolAnswer,
} from './prompts';
import { isWeakStructuredCodeAnswer } from './evidenceAnswer';

/**
 * When a deterministic extractive/symbol answer exists for a code-symbol question,
 * never let a small chat LLM overwrite it. Phi-3 (and similar) often paraphrase
 * attached function bodies incorrectly even when evidence is perfect.
 */
export function shouldPreferExtractiveOverLlm(
  question: string,
  extractive: string | null | undefined,
  llmDraft: string,
  groundingOk: boolean,
): boolean {
  if (!extractive?.trim()) return false;
  if (isCodeSymbolQuestion(question)) return true;
  if (!groundingOk) return true;
  if (isNotFoundAnswer(llmDraft)) return true;
  if (isEmptyModelResponse(llmDraft)) return true;
  if (isWeakStructuredCodeAnswer(llmDraft)) return true;
  return false;
}

/** Skip LLM synthesis entirely when extractive symbol evidence is ready. */
export function shouldSkipLlmForExtractive(
  question: string,
  extractive: string | null | undefined,
): boolean {
  return !!extractive?.trim() && isCodeSymbolQuestion(question);
}

/**
 * Build the best available extractive answer from hits, Tree-sitter entities,
 * and/or already-attached source file bodies (the submitForm failure mode).
 */
export function resolveBestExtractiveAnswer(
  question: string,
  hits: KcSearchHit[],
  symbolEntities?: KcSymbolEntity[] | null,
  attachedSources?: KcGroundedContextSource[] | null,
): string | null {
  const fromHits = tryExtractiveCodeSymbolAnswer(
    question,
    hits,
    symbolEntities ?? undefined,
    attachedSources ?? undefined,
  );
  if (fromHits) return fromHits;
  return null;
}
