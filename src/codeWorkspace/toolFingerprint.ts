/**
 * Duplicate-work guard for the agent loop.
 *
 * Models (especially open-weight ones in server mode) frequently re-read the same file window
 * or re-run the same grep, which burns the step budget and bloats context for zero new
 * information. We fingerprint every read-only tool call: the first repeat replays the cached
 * bytes with a warning, further repeats are refused outright.
 */

const CACHEABLE_TOOLS = new Set([
  'list_dir',
  'glob_file_search',
  'grep',
  'codebase_search',
  'repo_map',
  'find_symbol',
  'read_symbol',
  'read_file',
]);

function normPath(value: unknown): string {
  const raw = String(value ?? '').trim().replace(/\\/g, '/');
  return raw.replace(/^\.\/+/, '').replace(/\/+$/, '') || '.';
}

function stableArgs(tool: string, args: Record<string, unknown>): string {
  switch (tool) {
    case 'list_dir':
      return normPath(args.path ?? '.');
    case 'glob_file_search':
      return String(args.pattern ?? '').trim();
    case 'codebase_search':
      return `${String(args.query ?? '').trim().toLowerCase()}|${String(args.glob ?? '').trim()}`;
    case 'grep':
      return [
        String(args.pattern ?? '').trim(),
        normPath(args.path ?? '.'),
        String(args.glob ?? '').trim(),
        args.case_insensitive ? 'i' : '',
      ].join('|');
    case 'repo_map':
      return '';
    case 'find_symbol':
      return String(args.query ?? args.name ?? '').trim().toLowerCase();
    case 'read_symbol':
      return `${normPath(args.path)}|${String(args.name ?? args.query ?? '').trim()}`;
    case 'read_file': {
      const offset = Math.max(0, Math.floor(Number(args.offset ?? 0) || 0));
      const limit = Math.min(400, Math.max(1, Math.floor(Number(args.limit ?? 120) || 120)));
      return `${normPath(args.path)}|${offset}|${limit}`;
    }
    default:
      return '';
  }
}

export function toolFingerprint(tool: string, args: Record<string, unknown>): string | null {
  if (!CACHEABLE_TOOLS.has(tool)) return null;
  return `${tool}(${stableArgs(tool, args)})`;
}

export interface ToolRunMetrics {
  calls: number;
  duplicates: number;
  refused: number;
  byTool: Record<string, number>;
}

interface CacheEntry {
  step: number;
  result: string;
  repeats: number;
}

function preview(result: string, max = 200): string {
  const flat = result.split('\n').slice(0, 3).join(' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

export class ToolRunCache {
  private entries = new Map<string, CacheEntry>();

  readonly metrics: ToolRunMetrics = { calls: 0, duplicates: 0, refused: 0, byTool: {} };

  /**
   * Returns a replacement result when this exact call was already made, or null to execute it.
   */
  check(tool: string, args: Record<string, unknown>, step: number): string | null {
    this.metrics.calls += 1;
    this.metrics.byTool[tool] = (this.metrics.byTool[tool] || 0) + 1;
    const fp = toolFingerprint(tool, args);
    if (!fp) return null;
    const hit = this.entries.get(fp);
    if (!hit) return null;

    hit.repeats += 1;
    this.metrics.duplicates += 1;
    if (hit.repeats === 1) {
      return `DUPLICATE CALL — you already ran ${fp} at step ${hit.step}; this returns the same bytes.`
        + ` Do not call it again. Use what you have, change the arguments (e.g. a different offset`
        + ` or pattern), or finish.\n\n${hit.result}`;
    }
    this.metrics.refused += 1;
    return `REFUSED — ${fp} has now been requested ${hit.repeats + 1} times and the result never changes.`
      + ` Earlier result at step ${hit.step} began: ${preview(hit.result)}\n`
      + `Stop repeating tools: either call a tool with different arguments or finish with your answer now.`;
  }

  record(tool: string, args: Record<string, unknown>, step: number, result: string): void {
    const fp = toolFingerprint(tool, args);
    if (!fp) return;
    if (this.entries.has(fp)) return;
    this.entries.set(fp, { step, result, repeats: 0 });
  }

  /** Human-readable line for logs / status. */
  summary(): string {
    const tools = Object.entries(this.metrics.byTool)
      .sort((a, b) => b[1] - a[1])
      .map(([t, n]) => `${t}×${n}`)
      .join(' ');
    return `tool calls=${this.metrics.calls} duplicates=${this.metrics.duplicates}`
      + ` refused=${this.metrics.refused}${tools ? ` · ${tools}` : ''}`;
  }
}
