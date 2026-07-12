import type { KcFileCatalog, KcSearchHit } from './types';

export const KC_FILE_SELECT_SYSTEM_PROMPT = [
  'You are the file-selection stage of Nexus Data Knowledge Chat.',
  'The user message contains a QUESTION, optional RETRIEVAL HINTS, and an INDEXED FOLDER CATALOG.',
  'The catalog lists every indexed file with partition, size, attachability (<= 5 KB), and a one-line summary.',
  'Choose the minimum catalog files needed to answer the question.',
  'Output ONLY a JSON array of relative_path strings — no markdown, no explanation.',
  'Example: ["code/config_loader.py","docs/architecture.md"]',
  'Rules:',
  '- Use only paths that appear in the catalog. Do not invent paths.',
  '- Prefer attachable files (attachable: yes).',
  '- Pick 1–8 files.',
  '- Prefer retrieval hint files when they match the question.',
  '- If no catalog file can answer the question, output [].',
].join(' ');

export function buildFileSelectionPrompt(
  question: string,
  catalog: KcFileCatalog,
  retrievalHits: KcSearchHit[],
): string {
  const hints = [...new Set(
    retrievalHits
      .filter(hit => (hit.chunk.source_confidence ?? 0) >= 0.18)
      .map(hit => hit.chunk.file_name),
  )].slice(0, 8);

  const hintBlock = hints.length
    ? `RETRIEVAL HINTS (hybrid search pre-ranked these as likely relevant):\n${hints.map(f => `- ${f}`).join('\n')}\n`
    : '';

  return [
    'QUESTION',
    question.trim(),
    '',
    hintBlock.trimEnd(),
    hintBlock ? '' : '',
    'INDEXED FOLDER CATALOG',
    catalog.catalog_text.trim(),
    '',
    'Respond with ONLY a JSON array of relative_path values from the catalog.',
  ].filter((line, idx, arr) => !(line === '' && idx > 0 && arr[idx - 1] === '')).join('\n');
}

export function parseSelectedFilePaths(raw: string, catalog: KcFileCatalog): string[] {
  const trimmed = raw.trim();
  if (!trimmed || trimmed === '[]') return [];

  const jsonMatch = trimmed.match(/\[[\s\S]*\]/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      if (Array.isArray(parsed)) {
        return parsed
          .filter((item): item is string => typeof item === 'string')
          .map(path => path.trim())
          .filter(Boolean);
      }
    } catch {
      // fall through to line parsing
    }
  }

  const known = new Set(catalog.entries.map(e => e.relative_path.toLowerCase()));
  const fromLines = trimmed
    .split(/\n|,/)
    .map(line => line.trim().replace(/^[-*]\s*/, '').replace(/^`|`$/g, '').replace(/^"|"$/g, ''))
    .filter(line => known.has(line.toLowerCase()) || [...known].some(p => line.toLowerCase().endsWith(p)));

  return [...new Set(fromLines)];
}

export function extractQuerySymbols(question: string): string[] {
  const camel = [...question.matchAll(/\b([a-z][a-zA-Z0-9]*(?:[A-Z][a-z0-9]+)+)\b/g)]
    .map(match => match[1])
    .filter(symbol => symbol.length > 4);
  const snake = [...question.matchAll(/\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b/g)]
    .map(match => match[1])
    .filter(symbol => symbol.length > 4);
  return [...new Set([...camel, ...snake])];
}

export function pathsFromRetrievalHits(
  hits: KcSearchHit[],
  catalog: KcFileCatalog,
): string[] {
  const paths = new Set<string>();
  for (const hit of hits.filter(h => (h.chunk.source_confidence ?? 0) >= 0.18)) {
    const entry = catalog.entries.find(e =>
      e.absolute_path === hit.chunk.file_path
      || e.file_name.toLowerCase() === hit.chunk.file_name.toLowerCase(),
    );
    if (entry) paths.add(entry.relative_path);
  }
  return [...paths];
}

/** Deterministic pre-selection from retrieval hits + symbol/file hints (before LLM pass). */
export function boostSelectedPathsFromQuery(
  question: string,
  catalog: KcFileCatalog,
  retrievalHits: KcSearchHit[],
): string[] {
  const paths = new Set<string>();
  const symbols = extractQuerySymbols(question).map(s => s.toLowerCase());
  const fileHint = question.match(/\b([\w.-]+\.(?:tsx?|jsx?|py|rs|go|json|md))\b/i)?.[1]?.toLowerCase();

  for (const hit of retrievalHits.filter(h => (h.chunk.source_confidence ?? 0) >= 0.18)) {
    const entry = catalog.entries.find(e =>
      e.absolute_path === hit.chunk.file_path
      || e.file_name.toLowerCase() === hit.chunk.file_name.toLowerCase(),
    );
    if (entry) {
      paths.add(entry.relative_path);
    }
  }

  for (const entry of catalog.entries) {
    if (!entry.attachable) continue;
    const pathLower = entry.relative_path.toLowerCase();
    const nameLower = entry.file_name.toLowerCase();
    const blob = `${pathLower} ${nameLower} ${entry.summary.toLowerCase()}`;

    if (fileHint && (nameLower === fileHint || pathLower.endsWith(fileHint))) {
      paths.add(entry.relative_path);
    }

    for (const symbol of symbols) {
      if (blob.includes(symbol)) {
        paths.add(entry.relative_path);
      }
      const compact = symbol.replace(/_/g, '');
      if (compact.length >= 6 && blob.replace(/_/g, '').includes(compact)) {
        paths.add(entry.relative_path);
      }
    }
  }

  return [...paths];
}

export function mergeSelectedPaths(...groups: string[][]): string[] {
  return [...new Set(groups.flat().filter(Boolean))];
}