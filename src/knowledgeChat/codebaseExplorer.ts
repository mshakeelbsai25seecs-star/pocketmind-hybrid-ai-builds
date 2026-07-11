import { kcCodebaseExplorerContext, kcLoadSelectedFiles } from './api';
import { KC_CODEBASE_AGENT_SYSTEM_PROMPT } from './prompts';
import type { KcGroundedContextSource } from './types';

const MAX_REPO_MAP_CHARS = 8_000;
const MAX_AGENT_ROUNDS = 2;
const MAX_FETCHED_FILES = 4;

type GenerationParams = Record<string, unknown>;

export interface ExplorerStreamFn {
  (
    prompt: string,
    systemPrompt: string,
    onChunk: (text: string) => void,
    setStatus: (status: string | null) => void,
    isStale: () => boolean,
    params?: GenerationParams,
  ): Promise<string>;
}

export interface ExplorerContextOptions {
  collectionId: string;
  question: string;
  streamGenerate: ExplorerStreamFn;
  setStatus: (status: string | null) => void;
  isStale: () => boolean;
  /** When false, skip the need_files planning loop and answer directly from pinned symbols. */
  enableAgentLoop?: boolean;
}

export interface ExplorerContextResult {
  prompt: string;
  sources: KcGroundedContextSource[];
  repoMap: string;
  pinnedSymbols: string[];
  loadedPaths: string[];
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n… (repo map truncated)`;
}

function buildExplorerPrompt(
  question: string,
  repoMap: string,
  contextBlock: string,
  attachedFiles: string,
): string {
  const parts: string[] = [question.trim(), ''];
  if (repoMap.trim()) {
    parts.push('REPO MAP:', truncate(repoMap, MAX_REPO_MAP_CHARS), '');
  }
  if (contextBlock.trim()) {
    parts.push(contextBlock, '');
  }
  if (attachedFiles.trim()) {
    parts.push('ATTACHED FILES:', attachedFiles, '');
  }
  return parts.join('\n');
}

export function parseNeedFiles(raw: string): string[] {
  const match = raw.match(/\{[\s\S]*?\}/);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[0]) as { need_files?: unknown };
    if (!Array.isArray(parsed.need_files)) return [];
    const paths = parsed.need_files
      .filter((p): p is string => typeof p === 'string')
      .map(p => p.trim().replace(/^`|`$/g, ''))
      .filter(Boolean);
    return [...new Set(paths)].slice(0, 3);
  } catch {
    return [];
  }
}

/**
 * Assemble Codebase Explorer context for a query: repo map + symbol-pinned entity
 * bodies, then an optional bounded need_files agent loop that loads whole files.
 */
export async function buildCodebaseExplorerContext(
  options: ExplorerContextOptions,
): Promise<ExplorerContextResult> {
  const { collectionId, question, streamGenerate, setStatus, isStale } = options;
  setStatus('Building repo map and pinning code symbols...');
  const ctx = await kcCodebaseExplorerContext(collectionId, question);
  if (isStale()) {
    return { prompt: '', sources: [], repoMap: '', pinnedSymbols: [], loadedPaths: [] };
  }

  const sources: KcGroundedContextSource[] = [...ctx.sources];
  const loadedPaths: string[] = [];
  const attachedBlocks: string[] = [];

  if (options.enableAgentLoop !== false) {
    const alreadyPinned = new Set(ctx.pinned_paths);
    for (let round = 0; round < MAX_AGENT_ROUNDS; round += 1) {
      if (loadedPaths.length >= MAX_FETCHED_FILES) break;
      setStatus('Deciding which files to read...');
      const planPrompt = buildExplorerPrompt(
        question,
        ctx.repo_map,
        [ctx.context_block, attachedBlocks.join('\n\n')].filter(Boolean).join('\n\n'),
        '',
      );
      const planRaw = await streamGenerate(
        planPrompt,
        KC_CODEBASE_AGENT_SYSTEM_PROMPT,
        () => undefined,
        setStatus,
        isStale,
        { max_tokens: 160, temperature: 0.0 },
      );
      if (isStale()) break;

      const requested = parseNeedFiles(planRaw)
        .filter(path => !alreadyPinned.has(path) && !loadedPaths.includes(path))
        .slice(0, MAX_FETCHED_FILES - loadedPaths.length);
      if (!requested.length) break;

      setStatus('Reading requested files...');
      const loaded = await kcLoadSelectedFiles(collectionId, requested);
      if (isStale()) break;
      if (loaded.context_block.trim() && loaded.sources.length) {
        attachedBlocks.push(loaded.context_block);
        sources.push(...loaded.sources);
        loadedPaths.push(...loaded.selected_paths);
      } else {
        break;
      }
    }
  }

  const prompt = buildExplorerPrompt(
    question,
    ctx.repo_map,
    ctx.context_block,
    attachedBlocks.join('\n\n'),
  );

  return {
    prompt,
    sources,
    repoMap: ctx.repo_map,
    pinnedSymbols: ctx.pinned_symbols,
    loadedPaths,
  };
}
