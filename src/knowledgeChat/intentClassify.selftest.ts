/**
 * Self-test for two-stage intent classification helpers.
 * Run: npx --yes tsx src/knowledgeChat/intentClassify.selftest.ts
 */
import {
  classifyRulesAnswerIntent,
  classifyRulesSearchIntent,
  parseIntentJson,
  strategyForIntent,
  vetoSearchIntent,
} from './intentClassify';
import type { KcSearchHit } from './types';
import { normalizeQueryIntent } from './types';

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

assert(parseIntentJson('{"intent":"explain_symbol"}') === 'explain_symbol', 'parse explain');
assert(parseIntentJson('{"intent":"code_symbol"}') === 'explain_symbol', 'legacy code_symbol');
assert(parseIntentJson('{"intent":"list_symbols_in_file"}') === 'list_symbols_in_file', 'parse list');
assert(parseIntentJson('{"intent":"nope"}') === null, 'reject unknown');
assert(parseIntentJson('not json') === null, 'reject garbage');
assert(parseIntentJson('```json\n{"intent":"env_var"}\n```') === 'env_var', 'fence ok');

assert(
  vetoSearchIntent('What functions are defined in ChatView.tsx?') === 'list_symbols_in_file',
  'veto forces list',
);
assert(
  vetoSearchIntent('What does error code E-402 mean?') === 'error_code',
  'veto forces error',
);

assert(
  classifyRulesSearchIntent('Explain handleSend in ChatView.tsx') === 'explain_symbol',
  'rules explain',
);
assert(
  classifyRulesSearchIntent('what are the imports in config_loader.py') === 'file_imports',
  'rules imports',
);
assert(
  classifyRulesSearchIntent('Where is handleSend defined?') === 'locate_definition',
  'rules locate',
);
assert(
  vetoSearchIntent(
    'Where is the API timeout read from the environment and what is its default?',
  ) === 'env_var',
  'veto env from-the-environment',
);
assert(
  classifyRulesSearchIntent(
    'Where is the API timeout read from the environment and what is its default?',
  ) === 'env_var',
  'rules env timeout+default not locate',
);
assert(
  classifyRulesSearchIntent('Where is load_api_timeout defined?') === 'locate_definition',
  'symbol locate still locate',
);

const hits: KcSearchHit[] = [
  {
    chunk: {
      id: '1',
      collection_id: 'c',
      file_id: 'f',
      file_name: 'ChatView.tsx',
      file_path: 'ChatView.tsx',
      chunk_index: 0,
      title: 'handleSend',
      start_char: 0,
      end_char: 10,
      text: 'const handleSend = () => {}',
      top_terms: [],
      has_dense: true,
      entity_kind: 'function',
      entity_name: 'handleSend',
      source_confidence: 0.9,
    } as KcSearchHit['chunk'],
    retrieval_mode: 'hybrid_dense',
    keyword_score: 1,
    lexical_score: 1,
    dense_score: 1,
    fts_score: 1,
    rerank_score: 1,
    fused_score: 1,
    rank: 1,
  },
  {
    chunk: {
      id: '2',
      collection_id: 'c',
      file_id: 'f',
      file_name: 'ChatView.tsx',
      file_path: 'ChatView.tsx',
      chunk_index: 1,
      title: 'renderMessages',
      start_char: 0,
      end_char: 10,
      text: 'function renderMessages() {}',
      top_terms: [],
      has_dense: true,
      entity_kind: 'function',
      entity_name: 'renderMessages',
      source_confidence: 0.85,
    } as KcSearchHit['chunk'],
    retrieval_mode: 'hybrid_dense',
    keyword_score: 1,
    lexical_score: 1,
    dense_score: 1,
    fts_score: 1,
    rerank_score: 1,
    fused_score: 1,
    rank: 2,
  },
];

assert(
  classifyRulesAnswerIntent('What functions are defined in ChatView.tsx?', hits) === 'list_symbols_in_file',
  'stage B rules list',
);
assert(strategyForIntent('list_symbols_in_file') === 'extractive_list_symbols', 'strategy map');
assert(normalizeQueryIntent('code_symbol') === 'explain_symbol', 'normalize legacy');

console.log('intentClassify.selftest.ts: ok');
