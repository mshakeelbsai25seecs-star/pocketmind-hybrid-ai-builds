import type { KcGroundedContextSource, KcSearchHit, KcSearchResult } from './types';
import { KC_NOT_FOUND_MESSAGE } from './prompts';
import { groundingCheck, isNotFoundAnswer } from './groundingCheck';
import { resolveAnswerFallback } from './answerRouting';
import { shouldPreferExtractiveOverLlm } from './extractivePrefer';

export function sanitizeLlmKnowledgeDraft(text: string): string {
  let out = text.replace(/\r\n/g, '\n').trim();

  out = out
    .replace(/\[File:\\([^|\]]+)\|/gi, (_m, file) => {
      const name = String(file)
        .replace(/\\/g, '/')
        .split('/')
        .pop()
        ?.replace(/^code_/, '') || String(file);
      return `[Source: ${name} | `;
    })
    .replace(/\[File:([^|\]]+)\|/gi, (_m, file) => {
      const name = String(file).replace(/\\/g, '/').split('/').pop() || String(file);
      return `[Source: ${name} | `;
    })
    .replace(/\\t/g, ' ')
    .replace(/\\n/g, '\n')
    .replace(/\*{3,}/g, '**')
    // Strip decorative reference marks / underscore runs only — never wipe snake_case ids.
    .replace(/※+/g, ' ')
    .replace(/(^|[\s(])_{2,}(?=[\s).,;:!?]|$)/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return out;
}

export function stripTrailingNotFoundWhenSubstantive(text: string): string {
  const match = text.match(/\bI could not find enough evidence[\s\S]*$/i);
  if (!match || match.index === undefined) return text;
  if (match.index < 80) return text.trim();
  return text.slice(0, match.index).trim();
}

export function isSubstantiveLlmDraft(text: string, question: string): boolean {
  const trimmed = stripTrailingNotFoundWhenSubstantive(text).trim();
  if (trimmed.length < 80) return false;
  if (/^##\s+Answer\b/im.test(trimmed)) return true;

  const blob = trimmed.toLowerCase();
  const terms = question
    .toLowerCase()
    .match(/\b[a-z][a-z0-9_]{4,}\b/g)
    ?.filter(t => !['explain', 'function', 'describe', 'please', 'would'].includes(t)) ?? [];

  if (terms.some(term => blob.includes(term))) return true;
  if (/\b(nexus_api_timeout|api_timeout|environ|default|seconds)\b/i.test(trimmed)) return true;
  return trimmed.length >= 180;
}

export function finalizeLlmKnowledgeAnswer(
  draft: string,
  question: string,
  searchResult: KcSearchResult,
  contextHits: KcSearchHit[],
  attachedSources: KcGroundedContextSource[] | undefined,
  formatAnswer: (text: string, skipQualityGate?: boolean) => string,
): string {
  const cleaned = sanitizeLlmKnowledgeDraft(stripTrailingNotFoundWhenSubstantive(draft));
  const extractive = resolveAnswerFallback(searchResult, question, contextHits, attachedSources);

  if (!cleaned.trim()) {
    return formatAnswer(extractive || KC_NOT_FOUND_MESSAGE, true);
  }

  const grounded = groundingCheck(cleaned, contextHits, question, 0.35, attachedSources);
  // Accuracy-first: never keep a Phi-3 draft when extractive symbol evidence exists.
  if (extractive && shouldPreferExtractiveOverLlm(question, extractive, cleaned, grounded)) {
    return formatAnswer(extractive, true);
  }

  if (isSubstantiveLlmDraft(cleaned, question) && grounded) {
    return formatAnswer(cleaned, true);
  }

  if (isNotFoundAnswer(cleaned) || !grounded) {
    if (extractive) return formatAnswer(extractive, true);
    const fallback = resolveAnswerFallback(searchResult, question, contextHits, attachedSources);
    if (fallback) return formatAnswer(fallback, true);
  }

  if (isNotFoundAnswer(cleaned)) {
    return formatAnswer(KC_NOT_FOUND_MESSAGE, true);
  }

  return formatAnswer(cleaned, true);
}
