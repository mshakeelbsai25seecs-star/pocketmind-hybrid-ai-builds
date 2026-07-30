import { cwGlobFileSearch, cwListDir, cwLoadProjectRules } from '../api/codeWorkspace';

/**
 * A once-per-run inventory of the workspace that is injected into the system prompt.
 * Cursor gives its model the folder layout up front; without it, models burn turns on
 * list_dir/glob just to learn what exists — and often repeat those calls.
 *
 * Everything here goes through the workspace transport, so it works identically for the
 * local Tauri backend and for the remote agent-host (server mode).
 */

const MAX_ROOT_ENTRIES = 40;
const MAX_SUBDIRS = 10;
const MAX_ENTRIES_PER_SUBDIR = 12;
const MAX_GLOB_PATHS = 4000;
const MAX_BRIEF_CHARS = 3200;

const IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  'target',
  'dist',
  'build',
  '.next',
  '.venv',
  'venv',
  '__pycache__',
  '.pocketmind',
  '.pocketmind-index',
  '.pocketmind-checkpoints',
  '.pocketmind-sandbox',
  '.pocketmind-plans',
  '.pocketcode',
]);

interface BriefCacheEntry {
  builtAt: number;
  brief: string;
}

const BRIEF_TTL_MS = 60_000;
const briefCache = new Map<string, BriefCacheEntry>();

function extensionOf(path: string): string {
  const base = path.split(/[\\/]/).pop() || path;
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return '(no ext)';
  return base.slice(dot).toLowerCase();
}

function topExtensions(paths: string[], limit = 8): string {
  const counts = new Map<string, number>();
  for (const p of paths) {
    const ext = extensionOf(p);
    counts.set(ext, (counts.get(ext) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([ext, n]) => `${ext} ×${n}`)
    .join(', ');
}

/** True when the tree has (almost) no source files — data/doc workspaces need grep, not symbols. */
function looksLikeCodeTree(paths: string[]): boolean {
  const codeExt = /\.(ts|tsx|js|jsx|py|rs|go|java|kt|c|h|cpp|hpp|cs|rb|php|swift|scala|sh|sql)$/i;
  return paths.some(p => codeExt.test(p));
}

export async function buildWorkspaceBrief(workspaceRoot: string): Promise<string> {
  const cached = briefCache.get(workspaceRoot);
  if (cached && Date.now() - cached.builtAt < BRIEF_TTL_MS) return cached.brief;

  const lines: string[] = [];
  try {
    const root = await cwListDir(workspaceRoot, '.');
    const dirs = root.filter(e => e.is_dir && !IGNORED_DIRS.has(e.name));
    const files = root.filter(e => !e.is_dir);

    lines.push(`Root: ${workspaceRoot}`);
    if (files.length > 0) {
      lines.push(
        `Root files: ${files.slice(0, MAX_ROOT_ENTRIES).map(f => f.name).join(', ')}`
        + (files.length > MAX_ROOT_ENTRIES ? ` … +${files.length - MAX_ROOT_ENTRIES} more` : ''),
      );
    }
    if (dirs.length > 0) {
      lines.push(`Root folders: ${dirs.map(d => `${d.name}/`).join(', ')}`);
    }

    const shallow = await Promise.all(
      dirs.slice(0, MAX_SUBDIRS).map(async (d) => {
        try {
          const entries = await cwListDir(workspaceRoot, d.name);
          const names = entries
            .slice(0, MAX_ENTRIES_PER_SUBDIR)
            .map(e => (e.is_dir ? `${e.name}/` : e.name));
          const extra = entries.length > MAX_ENTRIES_PER_SUBDIR
            ? ` … +${entries.length - MAX_ENTRIES_PER_SUBDIR} more`
            : '';
          return `  ${d.name}/: ${names.join(', ')}${extra}`;
        } catch {
          return null;
        }
      }),
    );
    const subdirLines = shallow.filter((l): l is string => Boolean(l));
    if (subdirLines.length > 0) {
      lines.push('Layout:');
      lines.push(...subdirLines);
    }
  } catch {
    // No inventory is better than a wrong one; the model still has list_dir.
    return '';
  }

  try {
    const all = await cwGlobFileSearch(workspaceRoot, '**/*');
    const paths = all.slice(0, MAX_GLOB_PATHS);
    if (paths.length > 0) {
      lines.push(
        `File types (${paths.length}${all.length > paths.length ? '+' : ''} files): ${topExtensions(paths)}`,
      );
      if (!looksLikeCodeTree(paths)) {
        lines.push(
          'This workspace has little or no source code — prefer grep + read_file over repo_map/find_symbol.',
        );
      }
    }
  } catch {
    // extension inventory is a nice-to-have
  }

  const brief = lines.join('\n').slice(0, MAX_BRIEF_CHARS);
  briefCache.set(workspaceRoot, { builtAt: Date.now(), brief });
  return brief;
}

/** Optional per-project instructions stored in app data (not in the project folder). */
export async function loadProjectRules(workspaceRoot: string): Promise<string> {
  try {
    const trimmed = (await cwLoadProjectRules(workspaceRoot)).trim();
    if (!trimmed) return '';
    return trimmed.slice(0, 4000);
  } catch {
    return '';
  }
}

export function invalidateWorkspaceBrief(workspaceRoot?: string): void {
  if (workspaceRoot) briefCache.delete(workspaceRoot);
  else briefCache.clear();
}
