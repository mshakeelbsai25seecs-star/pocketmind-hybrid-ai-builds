import { invoke } from '@tauri-apps/api/tauri';
import type { GenerationParams } from '../types';
import type { KcQueryRewriteResult } from './types';

const QUERY_EXPAND_SYSTEM = [
  'You expand shorthand knowledge search queries for indexed folder retrieval.',
  'Reply with ONLY a JSON object: {"query":"...","filters":{}}',
  'The query field must be one rewritten search sentence.',
  'Preserve domain-specific terms from the original question.',
  'Do not answer the question; only rewrite it for document retrieval.',
  'Do not wrap the JSON in markdown fences.',
].join(' ');

type GenerationResponsePayload = {
  text?: string;
};

/** Parse constrained LLM rewrite JSON `{"query":"...","filters":{}}`. */
export function parseConstrainedLlmRewrite(raw: string): string | null {
  const trimmed = (raw || '').trim();
  if (!trimmed) return null;
  let body = trimmed;
  if (body.startsWith('```')) {
    body = body.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  }
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(body.slice(start, end + 1)) as { query?: unknown };
    const q = typeof parsed.query === 'string' ? parsed.query.trim() : '';
    if (q.length < 8 || q.length > 500) return null;
    // Reject answers / refusals that are not search rewrites.
    if (/^(i (can|could) not|sorry|as an ai)\b/i.test(q)) return null;
    if (/\n{2,}/.test(q)) return null;
    return q.replace(/\s+/g, ' ');
  } catch {
    return null;
  }
}

export async function expandVagueQueryWithLlm(
  question: string,
  rewrite: KcQueryRewriteResult,
  modelPath: string,
  defaultParams: GenerationParams,
): Promise<string> {
  if (!rewrite.vague || !modelPath.trim()) {
    return rewrite.retrieval_query;
  }

  const prompt = [
    'Rewrite this shorthand query into a clear search sentence for indexed company documents.',
    'Return ONLY JSON: {"query":"...","filters":{}}',
    `Original: ${question}`,
    `Rule-expanded: ${rewrite.retrieval_query}`,
  ].join('\n');

  try {
    const result = await invoke<GenerationResponsePayload>('generate_response', {
      request: {
        prompt,
        system_prompt: QUERY_EXPAND_SYSTEM,
        model_path: modelPath,
        backend: modelPath.startsWith('enterprise:')
          ? 'enterprise'
          : modelPath.startsWith('remote:')
            ? 'remote'
            : 'llama.cpp',
        params: {
          ...defaultParams,
          temperature: 0.08,
          max_tokens: 96,
          top_p: 0.8,
        },
      },
    });
    const raw = result.text?.trim() || '';
    const constrained = parseConstrainedLlmRewrite(raw);
    if (constrained) {
      return constrained;
    }
    // Parse fail → keep rule-expanded / original retrieval query (never invent free-form).
    return rewrite.retrieval_query;
  } catch {
    return rewrite.retrieval_query;
  }
}
