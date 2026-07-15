import type { KcGroundedContext, KcSearchHit } from './types';
import { resolveContextSnippet } from './prompts';

/** Minimum source confidence included in LLM bundles. */
export const MIN_LLM_BUNDLE_CONFIDENCE = 0.18;

/** Maximum whole-file size attached to the LLM (bytes). Must match Rust `MAX_WHOLE_FILE_BYTES`. */
export const MAX_WHOLE_FILE_BYTES = 24576;

export function bundleHitsForLlm(hits: KcSearchHit[]): KcSearchHit[] {
  return hits.filter(hit => (hit.chunk.source_confidence ?? 0) >= MIN_LLM_BUNDLE_CONFIDENCE);
}

export function hasBundledSources(hits: KcSearchHit[]): boolean {
  return bundleHitsForLlm(hits).length > 0;
}

export function topBundledConfidence(hits: KcSearchHit[]): number {
  const bundled = bundleHitsForLlm(hits);
  return bundled[0]?.chunk.source_confidence ?? 0;
}

function isUsableContextBlock(block: string): boolean {
  const trimmed = block.trim();
  if (!trimmed) return false;
  if (/ATTACHED SOURCE FILES:\s*none/i.test(trimmed)) return false;
  if (/pending server assembly/i.test(trimmed)) return false;
  if (/No selected files could be attached/i.test(trimmed)) return false;
  return trimmed.includes('### File:') || trimmed.includes('Indexed excerpt');
}

function buildExcerptContextFromHits(hits: KcSearchHit[], collectionName: string, question: string): string {
  const bundled = bundleHitsForLlm(hits);
  const byFile = new Map<string, KcSearchHit[]>();
  for (const hit of bundled) {
    const key = hit.chunk.file_id || hit.chunk.file_name;
    const group = byFile.get(key) || [];
    group.push(hit);
    byFile.set(key, group);
  }

  const sections: string[] = [];
  for (const fileHits of byFile.values()) {
    const top = fileHits[0];
    const seen = new Set<string>();
    const excerpts: string[] = [];
    for (const hit of fileHits.sort((a, b) => (a.chunk.line_start ?? 0) - (b.chunk.line_start ?? 0))) {
      const text = resolveContextSnippet(hit, question, 2400).trim();
      if (!text || seen.has(text)) continue;
      seen.add(text);
      const anchor = hit.chunk.line_start
        ? ` | L${hit.chunk.line_start}${hit.chunk.line_end && hit.chunk.line_end > hit.chunk.line_start ? `–L${hit.chunk.line_end}` : ''}`
        : '';
      excerpts.push(`Indexed excerpt${anchor}:\n\`\`\`\n${text}\n\`\`\``);
    }
    if (!excerpts.length) continue;
    const label = top.chunk.entity_name
      ? `${top.chunk.entity_kind || 'symbol'} ${top.chunk.entity_name}`
      : top.chunk.file_name;
    sections.push(
      `### File: ${top.chunk.file_name} | ${label} | retrieval confidence ${((top.chunk.source_confidence ?? 0) * 100).toFixed(0)}%\n`
      + `Indexed excerpts from retrieval (> ${MAX_WHOLE_FILE_BYTES} bytes or server bundle unavailable):\n`
      + excerpts.join('\n\n'),
    );
  }

  if (!sections.length) {
    return [
      `Collection: ${collectionName}`,
      '',
      'ATTACHED SOURCE FILES: none.',
      `No indexed sources scored above ${(MIN_LLM_BUNDLE_CONFIDENCE * 100).toFixed(0)}% bundle confidence.`,
    ].join('\n');
  }

  return [
    `Collection: ${collectionName}`,
    '',
    `ATTACHED SOURCE FILES (${sections.length} source file(s))`,
    'Each block contains indexed excerpts from retrieval evidence.',
    '',
    '---',
    '',
    sections.join('\n\n---\n\n'),
  ].join('\n');
}

/**
 * Prefer the server-built context block from search (whole files ≤ 5 KB + excerpts otherwise).
 */
export function buildBundledLlmContext(
  hits: KcSearchHit[],
  grounded: KcGroundedContext | null | undefined,
  collectionName: string,
  question = '',
): string {
  if (grounded?.context_block?.trim() && isUsableContextBlock(grounded.context_block)) {
    return grounded.context_block;
  }

  if (grounded?.sources?.length) {
    const sections = grounded.sources.map(source => {
      const lineStart = source.line_start ?? 0;
      const lineEnd = source.line_end ?? 0;
      const anchor = lineStart > 0
        ? ` | L${lineStart}${lineEnd > lineStart ? `–L${lineEnd}` : ''}`
        : '';
      const kind = source.source_type === 'whole_file' ? 'Full file contents' : 'Indexed excerpts';
      return `### File: ${source.file_name}${anchor}\n${kind}:\n\`\`\`\n${source.text.trim()}\n\`\`\``;
    });
    return [
      `Collection: ${collectionName}`,
      '',
      `ATTACHED SOURCE FILES (${sections.length} source file(s))`,
      '',
      '---',
      '',
      sections.join('\n\n---\n\n'),
    ].join('\n');
  }

  return buildExcerptContextFromHits(hits, collectionName, question);
}

export function buildBundledGroundedPrompt(question: string, contextBlock: string): string {
  const explainHint = /\b(what does|how does|explain|describe|purpose of|walk me through)\b/i.test(question)
    ? [
        '',
        'ANSWER DETAIL GUIDE',
        'Write a grounded multi-part answer. Prefer: purpose of the file/symbol, important exports/APIs,',
        'and how they interact. Quote evidence in ## Evidence. Do not answer with a single short stub.',
      ].join('\n')
    : '';
  return [
    'QUESTION',
    question.trim(),
    explainHint,
    '',
    contextBlock.trim(),
  ].filter(Boolean).join('\n');
}
