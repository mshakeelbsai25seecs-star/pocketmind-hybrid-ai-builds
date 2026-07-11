/**
 * Lightweight self-test for Knowledge Chat answer formatting (no test runner in package.json).
 * Run: npx --yes tsx src/knowledgeChat/formatAnswer.selftest.ts
 */
import {
  formatKnowledgeAnswer,
  prepareKnowledgeDisplayMarkdown,
  unescapeLlmLiterals,
} from './formatAnswer';
import { sanitizeLlmKnowledgeDraft } from './llmAnswerFinalize';

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

const indentedFence = [
  '## Answer',
  '',
  'Reads `NEXUS_API_TIMEOUT` from the environment.',
  '',
  '## Evidence',
  '',
  '[Source: config.py | L10–L18]',
  '```',
  'def get_timeout():',
  '    value = environ.get("NEXUS_API_TIMEOUT", "30")',
  '    return int(value)',
  '```',
  '',
  '## Explanation',
  '',
  'Behavior comes from the indexed function body.',
].join('\n');

const formatted = formatKnowledgeAnswer(indentedFence, [], { skipQualityGate: true });
assert(formatted.includes('    value = environ.get'), 'must preserve indented code inside fences');
assert(!/^##\s+Answer/m.test(formatted), 'redundant ## Answer heading should be stripped');
assert(/^##\s+Evidence/m.test(formatted), 'Evidence heading must remain');

const display = prepareKnowledgeDisplayMarkdown(formatted, [], { alreadyFormatted: true });
assert(display.includes('    value = environ.get'), 'display pass must not flatten fenced code');

const literals = unescapeLlmLiterals('line1\\n\\nline2');
assert(literals === 'line1\n\nline2', 'literal \\n sequences must become newlines');

const sanitized = sanitizeLlmKnowledgeDraft(
  'Uses NEXUS_API_TIMEOUT and api_timeout ※ ※ with ___ junk.',
);
assert(sanitized.includes('NEXUS_API_TIMEOUT'), 'sanitize must keep snake_case identifiers');
assert(sanitized.includes('api_timeout'), 'sanitize must keep lowercase snake_case');
assert(!sanitized.includes('※'), 'sanitize should strip decorative reference marks');

const listShredGuard = formatKnowledgeAnswer(
  [
    '## Answer',
    '',
    'Two policies apply.',
    '',
    '## Evidence',
    '',
    '[Source: a.md | Page 1]',
    '```',
    'policy_one = True',
    '```',
    '',
    '[Source: b.md | Page 2]',
    '```',
    'policy_two = True',
    '```',
  ].join('\n'),
  [],
  { question: 'List the 2 company policies', skipQualityGate: true },
);
assert(listShredGuard.includes('## Evidence'), 'list-style restructure must not shred structured answers');
assert(listShredGuard.includes('policy_one = True'), 'structured evidence fences must survive list questions');

console.log('formatAnswer.selftest: ok');
