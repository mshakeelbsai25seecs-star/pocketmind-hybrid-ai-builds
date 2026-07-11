import type { KcGroundedContextSource, KcSearchHit } from './types';
import { isStructuredKnowledgeAnswer } from './formatAnswer';
import { extractQuerySymbols } from './fileSelection';
import { isCodeSymbolQuestion, resolveContextSnippet } from './prompts';

const KEY_PHRASE_PATTERN = /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b|\b\w+_\w+\b|E-\d{3,}/g;

function sourceCorpus(
  hits: KcSearchHit[],
  question: string,
  attachedSources?: KcGroundedContextSource[] | null,
): string {
  if (attachedSources?.length) {
    return attachedSources.map(source => source.text).join('\n').toLowerCase();
  }
  if (!hits.length) return '';
  return hits
    .slice(0, 8)
    .map(hit => resolveContextSnippet(hit, question, 8000))
    .join('\n')
    .toLowerCase();
}

/**
 * Token overlap between an LLM draft and the attached symbol body.
 * Symbol-name presence alone is NOT enough — Phi-3 often invents behavior
 * while still mentioning `handleSend`.
 */
export function symbolBodyGroundingScore(answer: string, sourceText: string, symbols: string[]): number {
  if (!answer.trim() || !sourceText.trim()) return 0;
  const answerLower = answer.toLowerCase();
  const sourceLower = sourceText.toLowerCase();

  // Prefer the slice around the first matching symbol when possible.
  let body = sourceLower;
  for (const symbol of symbols) {
    const idx = sourceLower.indexOf(symbol.toLowerCase());
    if (idx >= 0) {
      body = sourceLower.slice(Math.max(0, idx - 80), idx + 1800);
      break;
    }
  }

  const bodyTokens = body
    .split(/[^a-z0-9_]+/)
    .filter(token => token.length >= 4);
  if (!bodyTokens.length) return 0;

  const unique = [...new Set(bodyTokens)].slice(0, 48);
  const matched = unique.filter(token => answerLower.includes(token)).length;
  return matched / unique.length;
}

export function groundingCheck(
  answer: string,
  hits: KcSearchHit[],
  question: string,
  minOverlap = 0.35,
  attachedSources?: KcGroundedContextSource[] | null,
): boolean {
  if (!answer.trim()) return false;

  const sourceText = sourceCorpus(hits, question, attachedSources);
  if (!sourceText) return false;

  const querySymbols = extractQuerySymbols(question).map(s => s.toLowerCase());

  // Code-symbol questions: require overlap with the function body, not just the name
  // and not just a "## Evidence" heading (Phi-3 is prompted to emit that format).
  if (isCodeSymbolQuestion(question) && querySymbols.length) {
    const score = symbolBodyGroundingScore(answer, sourceText, querySymbols);
    return score >= 0.12;
  }

  if (querySymbols.some(symbol => sourceText.includes(symbol))) {
    return true;
  }

  const answerLower = answer.toLowerCase();
  if (querySymbols.some(symbol => answerLower.includes(symbol) && sourceText.includes(symbol))) {
    return true;
  }

  // Structured extractive answers that quote source lines still need phrase overlap
  // unless they already passed the code-symbol body check above.
  if (isStructuredKnowledgeAnswer(answer) && /```/.test(answer)) {
    const code = answer.match(/```[\s\S]*?```/g)?.join('\n').toLowerCase() ?? '';
    if (code.length > 40 && sourceText.includes(code.slice(0, 80).replace(/```/g, '').trim())) {
      return true;
    }
  }

  const keyPhrases = answer.match(KEY_PHRASE_PATTERN) ?? [];
  if (keyPhrases.length === 0) {
    return sourceText.length > 40 && answer.trim().length >= 40;
  }

  const matched = keyPhrases.filter(phrase => sourceText.includes(phrase.toLowerCase()));
  return matched.length / keyPhrases.length >= minOverlap;
}

export function isNotFoundAnswer(text: string): boolean {
  return /\bI could not find enough evidence\b/i.test(text);
}

export function isSubstantiveDraft(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 80) return false;
  if (isNotFoundAnswer(trimmed)) return false;
  return true;
}
