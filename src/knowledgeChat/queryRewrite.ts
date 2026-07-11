import { invoke } from '@tauri-apps/api/tauri';
import type { GenerationParams } from '../types';
import type { KcQueryRewriteResult } from './types';

const QUERY_EXPAND_SYSTEM = [
  'You expand shorthand knowledge search queries for indexed folder retrieval.',
  'Output one rewritten search sentence only.',
  'Preserve domain-specific terms from the original question.',
  'Do not answer the question; only rewrite it for document retrieval.',
].join(' ');

type GenerationResponsePayload = {
  text?: string;
};

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
          max_tokens: 72,
          top_p: 0.8,
        },
      },
    });
    const expanded = result.text?.trim().replace(/^["']|["']$/g, '');
    if (!expanded || expanded.length < 8) {
      return rewrite.retrieval_query;
    }
    return expanded;
  } catch {
    return rewrite.retrieval_query;
  }
}
