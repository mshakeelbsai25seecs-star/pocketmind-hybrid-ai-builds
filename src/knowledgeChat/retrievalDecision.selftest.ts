/**
 * Self-test for LLM retrieval-decision JSON parsing.
 * Run: npx --yes tsx src/knowledgeChat/retrievalDecision.selftest.ts
 */
import { parseRetrievalDecision } from './retrievalDecision';

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

assert(parseRetrievalDecision('{"action":"answer"}')?.action === 'answer', 'answer ok');
assert(
  parseRetrievalDecision('{"action":"need_retrieval","query":"submitForm body in UserPanel.tsx"}')?.action
    === 'need_retrieval',
  'need_retrieval ok',
);
assert(
  (parseRetrievalDecision('{"action":"need_retrieval","query":"submitForm body in UserPanel.tsx"}') as { query: string })
    .query.includes('UserPanel'),
  'query preserved',
);
assert(parseRetrievalDecision('{"action":"need_retrieval","query":"short"}') === null, 'reject short query');
assert(parseRetrievalDecision('not json') === null, 'reject garbage');
assert(
  parseRetrievalDecision('```json\n{"action":"answer"}\n```')?.action === 'answer',
  'fence ok',
);

console.log('retrievalDecision.selftest.ts: ok');
