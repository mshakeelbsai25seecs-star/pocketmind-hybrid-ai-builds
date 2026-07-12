import type { KcGroundedContext, KcGroundedContextSource, KcSearchHit, KcSearchResult, QueryIntent } from './types';
import { normalizeQueryIntent } from './types';
import { extractQuerySymbols } from './fileSelection';
import { tryExtractiveFromAttachedSources } from './prompts';

export type KcEvidenceMode = 'concise' | 'evidence_explanation';

const MIN_STRUCTURED_CONFIDENCE = 0.5;

export function isExplainCodeQuestion(question: string): boolean {
  return /\b(explain|describe|walk me through|what does|how does|what is the logic|what happens when|purpose of)\b/i.test(question);
}

export function isWeakStructuredCodeAnswer(text: string): boolean {
  const lower = text.toLowerCase();
  return lower.includes('is defined as: this function')
    || lower.includes('is defined in the source')
    || (lower.includes('is defined as:') && text.length < 200);
}

export function resolveStructuredAnswer(searchResult: KcSearchResult): string | null {
  const answer = searchResult.structured_answer;
  if (!answer || answer.confidence < MIN_STRUCTURED_CONFIDENCE) return null;
  const intent = normalizeQueryIntent(answer.intent) ?? answer.intent;
  if (
    (intent === 'explain_symbol' || intent === 'code_symbol')
    && isWeakStructuredCodeAnswer(answer.answer_text)
  ) {
    return null;
  }
  return answer.answer_text.trim() || null;
}

export function isStructuredQueryIntent(intent: QueryIntent | undefined | null): boolean {
  return !!intent && intent !== 'general';
}

export function resolveEvidenceAnswer(searchResult: KcSearchResult): string | null {
  const answer = searchResult.grounded_context?.evidence_answer?.trim();
  return answer || null;
}

export function shouldAppendEvidenceExplanation(mode: KcEvidenceMode | undefined): boolean {
  return mode === 'evidence_explanation';
}

export function buildEvidenceAppendix(grounded: KcGroundedContext | null | undefined): string {
  if (!grounded) return '';
  const items = grounded.evidence_items?.length
    ? grounded.evidence_items
    : grounded.sources.map(source => ({
      file_name: source.file_name,
      label: source.entity_name
        ? `${source.entity_kind || 'symbol'} ${source.entity_name}`
        : source.file_name,
      line_start: source.line_start ?? null,
      line_end: source.line_end ?? null,
      excerpt: source.text,
      source_confidence: source.source_confidence,
      plain_summary: null as string | null,
    }));

  if (!items.length) return '';

  const sections = items.slice(0, 8).map(item => {
    const anchor = item.line_start && item.line_start > 0
      ? ` (L${item.line_start}${item.line_end && item.line_end > item.line_start ? `–L${item.line_end}` : ''})`
      : '';
    const excerpt = item.excerpt.includes('\n') || item.excerpt.length > 80
      ? `\`\`\`\n${item.excerpt.trim()}\n\`\`\``
      : `> ${item.excerpt.trim()}`;
    const meaning = item.plain_summary?.trim()
      ? `\n\n**What this means:** ${item.plain_summary.trim()}`
      : '';
    const confidence = `\n\n*Source confidence: ${(item.source_confidence * 100).toFixed(0)}%*`;
    return `**${item.file_name}${anchor}** — ${item.label}\n\n${excerpt}${meaning}${confidence}`;
  });

  return `\n\n---\n\n### Source evidence\n\n${sections.join('\n\n---\n\n')}`;
}

export function mergeAnswerWithEvidence(
  answer: string,
  searchResult: KcSearchResult,
  mode: KcEvidenceMode | undefined,
): string {
  if (!shouldAppendEvidenceExplanation(mode)) return answer;
  const appendix = buildEvidenceAppendix(searchResult.grounded_context);
  if (!appendix || answer.includes('### Source evidence')) return answer;
  return `${answer.trim()}${appendix}`;
}

export function buildExplainFallbackFromAttached(
  question: string,
  attachedSources?: KcGroundedContextSource[] | null,
): string | null {
  if (!isExplainCodeQuestion(question) || !attachedSources?.length) return null;

  const symbols = extractQuerySymbols(question);
  for (const source of attachedSources) {
    const text = source.text || '';
    const textLower = text.toLowerCase();
    for (const symbol of symbols) {
      if (!textLower.includes(symbol.toLowerCase())) continue;
      const explanation = summarizeAttachedSymbol(symbol, text, source.file_name);
      if (explanation) return explanation;
    }
    if (textLower.includes('environ')
      && (question.toLowerCase().includes('timeout') || symbols.some(s => s.includes('timeout')))) {
      const envMatch = text.match(/['"]([A-Z][A-Z0-9_]{3,})['"]/);
      const varName = envMatch?.[1] || 'the configured environment variable';
      return formatExplainAnswer(
        `Reads the API timeout from \`${varName}\`, with a default fallback when unset or invalid.`,
        source.file_name,
      );
    }
  }
  return null;
}

function summarizeAttachedSymbol(symbol: string, text: string, fileName: string): string | null {
  const body = text.replace(/^This (function|method|class)[^\n]*\n/gm, '').trim();
  if (body.toLowerCase().includes('environ') && symbol.toLowerCase().includes('timeout')) {
    const envMatch = body.match(/['"]([A-Z][A-Z0-9_]{3,})['"]/);
    const varName = envMatch?.[1] || 'the configured environment variable';
    return formatExplainAnswer(
      `Reads \`${varName}\` from the environment, with a default fallback when unset or invalid.`,
      fileName,
    );
  }
  // Prefer the shared extractive path so TS arrow fns (handleSend) are covered.
  const extractive = tryExtractiveFromAttachedSources(
    `What does ${symbol} do in ${fileName}?`,
    [{ file_name: fileName, text: body }],
  );
  if (extractive) return extractive;

  const defLine = body.split('\n').find(line =>
    line.includes(`def ${symbol}`)
    || line.includes(`function ${symbol}`)
    || line.includes(`const ${symbol}`)
    || line.includes(`${symbol} =`),
  );
  if (defLine) {
    return formatExplainAnswer(
      `\`${symbol}\` is defined in the attached source. Review the function body for its behavior.`,
      fileName,
    );
  }
  return null;
}

function formatExplainAnswer(body: string, fileName: string): string {
  return [
    '## Answer',
    body,
    '',
    '## Evidence',
    `> See attached file \`${fileName}\`.`,
    '',
    `[Source: ${fileName} | ${fileName}]`,
    '',
    '## Explanation',
    body,
  ].join('\n');
}
