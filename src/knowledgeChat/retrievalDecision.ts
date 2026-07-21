import { invoke } from '@tauri-apps/api/tauri';
import type { GenerationParams } from '../types';
import type { KcSearchHit } from './types';
import { backendForModelPath } from '../answerModel';

export type RetrievalDecision =
  | { action: 'answer' }
  | { action: 'need_retrieval'; query: string };

type GenerationResponsePayload = {
  text?: string;
};

const RETRIEVAL_DECISION_SYSTEM = [
  'You are a retrieval controller for a private knowledge-base RAG system.',
  'Decide whether the retrieved snippets are enough to answer the user question.',
  'Reply with JSON only — no markdown fences, no prose.',
  'If the snippets are sufficient to answer accurately, reply: {"action":"answer"}',
  'If you need a better search (wrong file, missing function bodies, incomplete coverage),',
  'reply: {"action":"need_retrieval","query":"<one improved search sentence>"}',
  'The query must preserve file names, symbol names, and domain terms from the question.',
  'Do not answer the user question in this step — only decide answer vs need_retrieval.',
  'Prefer need_retrieval when the question asks what code does / is for and snippets are only names or stubs.',
].join(' ');

function summarizeHits(hits: KcSearchHit[], limit = 8): string {
  if (!hits.length) return '(no hits)';
  return hits.slice(0, limit).map((hit, i) => {
    const file = hit.chunk.file_name || hit.chunk.file_path || 'unknown';
    const entity = hit.chunk.entity_name
      ? ` ${hit.chunk.entity_kind || 'symbol'}=${hit.chunk.entity_name}`
      : '';
    const lines = hit.chunk.line_start
      ? ` L${hit.chunk.line_start}${hit.chunk.line_end && hit.chunk.line_end > hit.chunk.line_start ? `-${hit.chunk.line_end}` : ''}`
      : '';
    const excerpt = (hit.chunk.text || '').replace(/\s+/g, ' ').trim().slice(0, 220);
    return `${i + 1}. ${file}${entity}${lines} :: ${excerpt}`;
  }).join('\n');
}

/** Parse constrained `{"action":"answer"}` or `{"action":"need_retrieval","query":"..."}`. */
export function parseRetrievalDecision(raw: string | null | undefined): RetrievalDecision | null {
  if (!raw?.trim()) return null;
  let body = raw.trim();
  if (body.startsWith('```')) {
    body = body.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  }
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(body.slice(start, end + 1)) as {
      action?: unknown;
      query?: unknown;
    };
    const action = typeof parsed.action === 'string' ? parsed.action.trim().toLowerCase() : '';
    if (action === 'answer') return { action: 'answer' };
    if (action === 'need_retrieval') {
      const q = typeof parsed.query === 'string' ? parsed.query.trim().replace(/\s+/g, ' ') : '';
      if (q.length < 8 || q.length > 500) return null;
      if (/^(i (can|could) not|sorry|as an ai)\b/i.test(q)) return null;
      if (/\n{2,}/.test(q)) return null;
      return { action: 'need_retrieval', query: q };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Ask the answer model whether current hits are enough, or request one refined search.
 * Fail-open to `{ action: 'answer' }` so we never block synthesis on controller errors.
 */
export async function decideRetrievalSufficiency(
  question: string,
  hits: KcSearchHit[],
  modelPath: string,
  defaultParams: GenerationParams,
  confidence?: string | null,
): Promise<RetrievalDecision> {
  if (!modelPath.trim()) return { action: 'answer' };

  const prompt = [
    `User question: ${question}`,
    `Retrieval confidence: ${confidence || 'unknown'}`,
    'Retrieved snippets:',
    summarizeHits(hits),
    'Decide: {"action":"answer"} or {"action":"need_retrieval","query":"..."}',
  ].join('\n');

  try {
    const result = await invoke<GenerationResponsePayload>('generate_response', {
      request: {
        prompt,
        system_prompt: RETRIEVAL_DECISION_SYSTEM,
        model_path: modelPath,
        backend: backendForModelPath(modelPath),
        params: {
          ...defaultParams,
          temperature: 0.05,
          max_tokens: 120,
          top_p: 0.8,
        },
      },
    });
    return parseRetrievalDecision(result.text) || { action: 'answer' };
  } catch {
    return { action: 'answer' };
  }
}
