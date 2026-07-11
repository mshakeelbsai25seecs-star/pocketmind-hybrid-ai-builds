/**
 * Lightweight self-test for extractive-over-LLM preference (no test runner in package.json).
 * Run: npx --yes tsx src/knowledgeChat/extractivePrefer.selftest.ts
 */
import {
  shouldPreferExtractiveOverLlm,
  shouldSkipLlmForExtractive,
} from './extractivePrefer';
import { isCodeSymbolQuestion, tryExtractiveFromAttachedSources } from './prompts';
import { needsCorrectiveRetrieval } from './correctiveRetrieval';
import { groundingCheck, symbolBodyGroundingScore } from './groundingCheck';
import type { KcSearchResult } from './types';

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

const handleSendBody = `
const handleSend = async () => {
  if (!input.trim()) return;
  const content = input.trim();
  setInput('');
  console.log('sending', content);
  await invoke('add_message', { content });
};
`;

const question = 'What does handleSend do in ChatView.tsx?';
assert(isCodeSymbolQuestion(question), 'handleSend question should be code-symbol');

const extractive = tryExtractiveFromAttachedSources(question, [
  { file_name: 'ChatView.tsx', text: handleSendBody, line_start: 10, line_end: 20 },
]);
assert(!!extractive, 'attached handleSend body must yield extractive answer');
assert(shouldSkipLlmForExtractive(question, extractive), 'must skip LLM when extractive ready');

const hallucinated = [
  '## Answer',
  '',
  'handleSend opens a WebSocket and streams tokens from a remote API.',
  '',
  '## Evidence',
  '',
  '[Source: ChatView.tsx | L10–L20]',
  '',
  '## Explanation',
  '',
  'The function streams tokens.',
].join('\n');

assert(
  shouldPreferExtractiveOverLlm(question, extractive, hallucinated, false),
  'prefer extractive over hallucinated draft',
);
assert(
  shouldPreferExtractiveOverLlm(question, extractive, hallucinated, true),
  'prefer extractive for code-symbol even if groundingOk',
);

const score = symbolBodyGroundingScore(hallucinated, handleSendBody, ['handleSend']);
assert(score < 0.12, `hallucination body overlap should be low, got ${score}`);
assert(
  !groundingCheck(hallucinated, [], question, 0.35, [
    { file_name: 'ChatView.tsx', text: handleSendBody, line_start: 10, line_end: 20, source_confidence: 0.9, source_type: 'whole_file' },
  ]),
  '## Evidence heading must not auto-pass grounding for code-symbol answers',
);

const medium = {
  collection_id: 'c',
  query: question,
  retrieval_query: question,
  mode: 'hybrid_dense',
  hits: [],
  dense_available: true,
  fts_available: true,
  confidence: 'medium',
  confidence_score: 0.4,
  answer_mode: 'found',
  sub_queries: [],
  query_rewrite: {
    original_query: question,
    retrieval_query: question,
    expansions: [],
    vague: false,
  },
  onnx_reranker_used: false,
  dense_pair_rerank_used: false,
  degradation_reasons: ['Dense pair rerank: embed failed'],
} as unknown as KcSearchResult;
assert(needsCorrectiveRetrieval(medium), 'medium + dense-pair miss should trigger CRAG');

console.log('extractivePrefer.selftest: all assertions passed');
