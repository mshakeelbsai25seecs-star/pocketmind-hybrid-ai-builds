/**
 * Pure ranking logic for codebase_search (no Tauri/transport imports, so it is unit-testable).
 */

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'have', 'has', 'was', 'were',
  'are', 'is', 'be', 'been', 'what', 'where', 'which', 'when', 'how', 'why', 'who', 'does',
  'do', 'did', 'can', 'could', 'should', 'would', 'will', 'about', 'there', 'their', 'them',
  'then', 'than', 'you', 'your', 'our', 'its', 'it', 'in', 'on', 'of', 'to', 'as',
  'at', 'by', 'or', 'if', 'not', 'all', 'any', 'get', 'set', 'use', 'used', 'using', 'file',
  'files', 'code', 'please', 'tell', 'show', 'find', 'look', 'check', 'workspace',
  'project', 'repo', 'repository', 'folder', 'value', 'values',
]);

const MAX_TERMS = 6;
const MAX_FILES_REPORTED = 12;
const MAX_LINES_PER_FILE = 4;
const MAX_OUTPUT_CHARS = 12_000;

export function searchTerms(query: string): string[] {
  const raw = query
    .replace(/[`"']/g, ' ')
    .split(/[^A-Za-z0-9_.$-]+/)
    .map(t => t.trim())
    .filter(Boolean);

  const seen = new Set<string>();
  const terms: string[] = [];
  for (const token of raw) {
    const lower = token.toLowerCase();
    if (lower.length < 3) continue;
    if (STOPWORDS.has(lower)) continue;
    if (seen.has(lower)) continue;
    seen.add(lower);
    terms.push(token);
  }
  // Identifier-ish and longer terms are the most selective.
  terms.sort((a, b) => {
    const idA = /[_.$-]|[a-z][A-Z]/.test(a) ? 1 : 0;
    const idB = /[_.$-]|[a-z][A-Z]/.test(b) ? 1 : 0;
    if (idA !== idB) return idB - idA;
    return b.length - a.length;
  });
  return terms.slice(0, MAX_TERMS);
}

interface FileScore {
  path: string;
  terms: Set<string>;
  hits: number;
  lines: Map<number, { text: string; terms: Set<string> }>;
}

/** rg emits `path:line:text`; paths are absolute when the search root is absolute. */
export function parseGrepLine(
  line: string,
  workspaceRoot: string,
): { path: string; line: number; text: string } | null {
  const m = /^(.*?):(\d+):(.*)$/.exec(line);
  if (!m) return null;
  let path = m[1].replace(/\\/g, '/');
  const rootNorm = workspaceRoot.replace(/\\/g, '/').replace(/\/+$/, '');
  if (rootNorm && path.toLowerCase().startsWith(`${rootNorm.toLowerCase()}/`)) {
    path = path.slice(rootNorm.length + 1);
  }
  const lineNo = Number(m[2]);
  if (!Number.isFinite(lineNo)) return null;
  return { path, line: lineNo, text: m[3] };
}

/** Merge per-term grep output into a ranked, agent-friendly report. */
export function rankGrepOutputs(
  query: string,
  terms: string[],
  outputs: string[],
  workspaceRoot: string,
): string {
  const files = new Map<string, FileScore>();
  outputs.forEach((out, i) => {
    const term = (terms[i] || '').toLowerCase();
    for (const line of (out || '').split('\n')) {
      if (!line.trim()) continue;
      const parsed = parseGrepLine(line, workspaceRoot);
      if (!parsed) continue;
      const entry = files.get(parsed.path) || {
        path: parsed.path,
        terms: new Set<string>(),
        hits: 0,
        lines: new Map<number, { text: string; terms: Set<string> }>(),
      };
      entry.terms.add(term);
      entry.hits += 1;
      const existing = entry.lines.get(parsed.line);
      if (existing) {
        existing.terms.add(term);
      } else if (entry.lines.size < 200) {
        entry.lines.set(parsed.line, {
          text: parsed.text.trim().slice(0, 240),
          terms: new Set([term]),
        });
      }
      files.set(parsed.path, entry);
    }
  });

  if (files.size === 0) {
    return `codebase_search found nothing for terms: ${terms.join(', ')}.\n`
      + 'Try different wording, or a single grep with a narrower pattern. Do not repeat this query.';
  }

  const ranked = [...files.values()].sort((a, b) => {
    if (b.terms.size !== a.terms.size) return b.terms.size - a.terms.size;
    if (b.hits !== a.hits) return b.hits - a.hits;
    return a.path.localeCompare(b.path);
  });

  const lines: string[] = [
    `codebase_search "${query}"`,
    `Terms: ${terms.join(', ')} · matched ${files.size} file(s); top ${Math.min(ranked.length, MAX_FILES_REPORTED)} below.`,
    'Read the promising ones with read_file (small window around the line numbers). Do not re-run this search.',
    '',
  ];

  for (const file of ranked.slice(0, MAX_FILES_REPORTED)) {
    lines.push(`## ${file.path} — ${file.terms.size}/${terms.length} terms, ${file.hits} hits`);
    const best = [...file.lines.entries()]
      .sort((a, b) => {
        if (b[1].terms.size !== a[1].terms.size) return b[1].terms.size - a[1].terms.size;
        return a[0] - b[0];
      })
      .slice(0, MAX_LINES_PER_FILE);
    for (const [lineNo, info] of best) {
      lines.push(`  L${lineNo}: ${info.text}`);
    }
    lines.push('');
  }

  const text = lines.join('\n');
  return text.length > MAX_OUTPUT_CHARS
    ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n…[truncated — narrow the query or use grep with a glob]`
    : text;
}
