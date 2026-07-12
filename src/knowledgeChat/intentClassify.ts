import { invoke } from '@tauri-apps/api/tauri';
import type { GenerationParams } from '../types';
import type { IntentSource, KcSearchHit, QueryIntent } from './types';
import { normalizeQueryIntent } from './types';

export type IntentClassifySource = IntentSource;

export interface IntentClassifyResult {
  intent: QueryIntent;
  source: IntentClassifySource;
  raw?: string;
}

const INTENT_LABELS: QueryIntent[] = [
  'explain_symbol',
  'list_symbols_in_file',
  'locate_definition',
  'file_imports',
  'env_var',
  'error_code',
  'runbook_step',
  'timeline',
  'general',
];

const STAGE_A_SYSTEM = [
  'You classify a developer knowledge-base question into exactly one intent label.',
  'Reply with JSON only: {"intent":"<label>"}.',
  `Allowed labels: ${INTENT_LABELS.join(', ')}.`,
  'Disambiguation:',
  '- explain_symbol: explain one named function/class/symbol (NOT a full file listing).',
  '- list_symbols_in_file: list functions/classes/exports in a named file (NOT explain one body).',
  '- locate_definition: where is X defined / which file (short locate, not full explain).',
  '- file_imports: what does a file import (not symbol list / explain).',
  '- env_var: environment variable name and/or default.',
  '- error_code: named error code meaning.',
  '- runbook_step: what should I do / first incident steps.',
  '- timeline: how long / duration.',
  '- general: none of the above.',
].join(' ');

const STAGE_B_SYSTEM = [
  'You pick the best answer strategy for a question given retrieval snippets.',
  'Reply with JSON only: {"intent":"<label>"}.',
  `Allowed labels: ${INTENT_LABELS.join(', ')}.`,
  'Prefer list_symbols_in_file when the question asks what functions/methods/classes are in a file',
  'and snippets show multiple symbols in that file.',
  'Prefer explain_symbol for one named symbol with explain/describe verbs.',
  'Prefer locate_definition for where/which-file questions.',
  'Prefer file_imports for import/dependency questions.',
  'Use general when no specialist applies — never guess a specialist.',
].join(' ');

type GenerationResponsePayload = {
  text?: string;
};

/** Strict JSON parse: `{"intent":"<label>"}` only; reject unknown labels. */
export function parseIntentJson(raw: string | null | undefined): QueryIntent | null {
  if (!raw?.trim()) return null;
  let text = raw.trim();
  // Strip optional markdown fences.
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();
  // Extract first JSON object if model added prose.
  const objMatch = text.match(/\{[\s\S]*\}/);
  if (objMatch) text = objMatch[0];
  try {
    const parsed = JSON.parse(text) as { intent?: unknown };
    if (typeof parsed?.intent !== 'string') return null;
    return normalizeQueryIntent(parsed.intent);
  } catch {
    return null;
  }
}

/** High-precision rule vetoes that beat the LLM when ultra-clear. */
export function vetoSearchIntent(question: string): QueryIntent | null {
  const q = question.toLowerCase();
  if (/\bE-\d{2,}\b/i.test(question) || q.includes('error code')) {
    return 'error_code';
  }
  if (
    q.includes('environment variable')
    || q.includes('env var')
    || /\bNEXUS_[A-Z0-9_]+\b/.test(question)
  ) {
    return 'env_var';
  }
  // /what functions|methods|classes are (defined|exported) in .+\.(tsx?|py|rs)/i
  if (
    /\b(what|which|list)\s+(the\s+)?(functions|methods|classes|exports)\b/i.test(question)
    && /\b(defined|exported|in|from)\b/i.test(question)
    && extractFileHint(question)
  ) {
    return 'list_symbols_in_file';
  }
  if (isListSymbolsQuestion(q) && extractFileHint(question)) {
    return 'list_symbols_in_file';
  }
  return null;
}

export function classifyRulesSearchIntent(question: string): QueryIntent {
  const veto = vetoSearchIntent(question);
  if (veto) return veto;

  const q = question.toLowerCase();

  if (
    q.includes('first step')
    || q.includes('what should i do')
    || q.includes('what do i do')
    || q.includes('how do i respond')
    || q.includes('how should i')
    || q.includes('who approves')
    || q.includes('password reset')
    || (q.includes('vpn') && q.includes('alert'))
  ) {
    return 'runbook_step';
  }

  if (
    q.includes('how long')
    || q.includes('how many days')
    || (q.includes('how many') && q.includes('day'))
    || q.includes('duration')
    || q.includes('take to')
    || q.includes('onboarding')
    || q.includes('business day')
  ) {
    return 'timeline';
  }

  if (isListSymbolsQuestion(q) && extractFileHint(question)) {
    return 'list_symbols_in_file';
  }

  if (isFileImportsQuestion(q)) {
    return 'file_imports';
  }

  if (isLocateDefinitionQuestion(q)) {
    return 'locate_definition';
  }

  if (
    isExplainSymbolQuestion(q)
    || extractCamelSymbols(question).some(s => s.length > 4)
    || extractSnakeSymbols(question).some(s => s.length > 4)
    || (
      (q.includes('function') || q.includes('method') || q.includes('class'))
      && (q.includes('validat') || q.includes('jwt') || q.includes('token') || q.includes('what rust'))
    )
  ) {
    return 'explain_symbol';
  }

  return 'general';
}

/** Evidence-aware rules backup for Stage B. */
export function classifyRulesAnswerIntent(
  question: string,
  hits: KcSearchHit[],
): QueryIntent {
  const veto = vetoSearchIntent(question);
  if (veto) return veto;

  const q = question.toLowerCase();
  const fileHint = extractFileHint(question);
  if (fileHint && isListSymbolsQuestion(q)) {
    const sameFileSymbols = hits.filter(h => {
      const file = h.chunk.file_name?.toLowerCase() || '';
      return file === fileHint.toLowerCase() || file.endsWith(fileHint.toLowerCase());
    }).filter(h => h.chunk.entity_name && h.chunk.entity_kind !== 'module');
    if (sameFileSymbols.length >= 2) {
      return 'list_symbols_in_file';
    }
    return 'list_symbols_in_file';
  }

  if (isFileImportsQuestion(q)) return 'file_imports';
  if (isLocateDefinitionQuestion(q)) return 'locate_definition';

  const camels = extractCamelSymbols(question);
  if (
    camels.length === 1
    && /\b(explain|describe|what does|how does|walk me through|purpose of)\b/i.test(question)
  ) {
    return 'explain_symbol';
  }

  return classifyRulesSearchIntent(question);
}

function summarizeHitsForPrompt(hits: KcSearchHit[], limit = 6): string {
  return hits.slice(0, limit).map((hit, i) => {
    const path = hit.chunk.file_name || hit.chunk.file_path || 'unknown';
    const symbol = hit.chunk.entity_name
      ? `${hit.chunk.entity_kind || 'symbol'} ${hit.chunk.entity_name}`
      : (hit.chunk.title || 'chunk');
    const snippet = (hit.relevant_snippet || hit.chunk.text || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 160);
    return `${i + 1}. ${path} | ${symbol} | ${snippet}`;
  }).join('\n');
}

async function classifyWithLlm(
  systemPrompt: string,
  userPrompt: string,
  modelPath: string,
  defaultParams: GenerationParams,
): Promise<{ intent: QueryIntent | null; raw: string }> {
  if (!modelPath.trim()) {
    return { intent: null, raw: '' };
  }
  try {
    const result = await invoke<GenerationResponsePayload>('generate_response', {
      request: {
        prompt: userPrompt,
        system_prompt: systemPrompt,
        model_path: modelPath,
        backend: modelPath.startsWith('enterprise:')
          ? 'enterprise'
          : modelPath.startsWith('remote:')
            ? 'remote'
            : 'llama.cpp',
        params: {
          ...defaultParams,
          temperature: 0,
          max_tokens: 48,
          top_p: 0.8,
        },
      },
    });
    const raw = result.text?.trim() || '';
    return { intent: parseIntentJson(raw), raw };
  } catch {
    return { intent: null, raw: '' };
  }
}

/** Stage A — query-only search intent. */
export async function classifySearchIntent(
  question: string,
  modelPath: string,
  defaultParams: GenerationParams,
): Promise<IntentClassifyResult> {
  const veto = vetoSearchIntent(question);
  if (veto) {
    return { intent: veto, source: 'veto' };
  }

  const { intent, raw } = await classifyWithLlm(
    STAGE_A_SYSTEM,
    `Question:\n${question}\n\nRespond with {"intent":"<label>"} only.`,
    modelPath,
    defaultParams,
  );
  if (intent) {
    return { intent, source: 'llm', raw };
  }

  return {
    intent: classifyRulesSearchIntent(question),
    source: 'rules',
    raw: raw || undefined,
  };
}

/** Stage B — question + top snippets → answer strategy. */
export async function classifyAnswerIntent(
  question: string,
  hits: KcSearchHit[],
  modelPath: string,
  defaultParams: GenerationParams,
): Promise<IntentClassifyResult> {
  const veto = vetoSearchIntent(question);
  if (veto) {
    return { intent: veto, source: 'veto' };
  }

  const summary = summarizeHitsForPrompt(hits);
  const userPrompt = [
    `Question:\n${question}`,
    '',
    'Top retrieval snippets:',
    summary || '(none)',
    '',
    'Respond with {"intent":"<label>"} only.',
  ].join('\n');

  const { intent, raw } = await classifyWithLlm(
    STAGE_B_SYSTEM,
    userPrompt,
    modelPath,
    defaultParams,
  );
  if (intent) {
    return { intent, source: 'llm', raw };
  }

  return {
    intent: classifyRulesAnswerIntent(question, hits),
    source: 'rules',
    raw: raw || undefined,
  };
}

export function isCodeOrientedIntent(intent: QueryIntent | null | undefined): boolean {
  return intent === 'explain_symbol'
    || intent === 'list_symbols_in_file'
    || intent === 'locate_definition'
    || intent === 'file_imports'
    || intent === 'env_var';
}

export function strategyForIntent(intent: QueryIntent): string {
  switch (intent) {
    case 'explain_symbol':
      return 'extractive_explain_symbol';
    case 'list_symbols_in_file':
      return 'extractive_list_symbols';
    case 'locate_definition':
      return 'extractive_locate';
    case 'file_imports':
      return 'extractive_file_imports';
    case 'env_var':
    case 'error_code':
    case 'runbook_step':
    case 'timeline':
      return 'structured_extractor';
    case 'general':
    default:
      return 'llm_or_evidence';
  }
}

function extractFileHint(question: string): string | null {
  for (const token of question.split(/\s+/)) {
    if (token.includes('.') && /[a-zA-Z]/.test(token)) {
      const cleaned = token.replace(/^[^a-zA-Z0-9._-]+|[^a-zA-Z0-9._-]+$/g, '');
      if (cleaned.includes('.')) return cleaned;
    }
  }
  return null;
}

function isListSymbolsQuestion(q: string): boolean {
  return q.includes('functions defined in')
    || q.includes('methods defined in')
    || q.includes('classes defined in')
    || q.includes('functions in')
    || q.includes('methods in')
    || q.includes('classes in')
    || q.includes('exports from')
    || q.includes('what functions')
    || q.includes('what methods')
    || q.includes('what classes')
    || q.includes('which functions')
    || q.includes('which methods')
    || q.includes('which classes')
    || q.includes('list functions')
    || q.includes('list methods')
    || q.includes('list classes')
    || q.includes('list the symbols')
    || q.includes('list symbols')
    || (
      q.includes('what are the')
      && (q.includes('function') || q.includes('method') || q.includes('class') || q.includes('export'))
      && !!extractFileHint(q)
      && !q.includes('import')
    );
}

function isFileImportsQuestion(q: string): boolean {
  return (q.includes('import') || q.includes('imports'))
    && !!extractFileHint(q)
    && !isListSymbolsQuestion(q);
}

function isLocateDefinitionQuestion(q: string): boolean {
  return q.includes('where is')
    || q.includes('where are')
    || q.includes('which file')
    || q.includes('what file')
    || q.includes('defined in which')
    || (q.includes('where') && (q.includes('defined') || q.includes('declared') || q.includes('located')));
}

function isExplainSymbolQuestion(q: string): boolean {
  if (isListSymbolsQuestion(q) || isFileImportsQuestion(q)) return false;
  return q.includes('what does')
    || q.includes('how does')
    || q.includes('explain')
    || q.includes('describe')
    || q.includes('walk me through')
    || q.includes('show me')
    || q.includes('what is the logic')
    || q.includes('what happens when')
    || q.includes('purpose of');
}

function extractCamelSymbols(question: string): string[] {
  return question
    .split(/[^a-zA-Z0-9_]+/)
    .filter(w => w.length > 4 && /[A-Z]/.test(w) && /[a-z]/.test(w));
}

function extractSnakeSymbols(question: string): string[] {
  return question
    .split(/[^a-zA-Z0-9_]+/)
    .filter(w => (
      w.length > 4
      && w.includes('_')
      && /^[a-z0-9_]+$/.test(w)
      && (w.match(/[a-z]/g) || []).length >= 3
    ));
}
