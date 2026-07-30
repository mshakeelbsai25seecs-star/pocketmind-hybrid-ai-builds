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

const emptyParenFence = formatKnowledgeAnswer(
  [
    'UserPanel defines send, keydown, and copy helpers.',
    '',
    '## Evidence',
    '',
    '[Source: UserPanel.tsx | L1–L36]',
    '```typescript',
    'export default function UserPanel() {',
    '  const submitForm = async () => {',
    '    if (!input.trim()) return;',
    '    const content = input.trim();',
    '    void submitForm();',
    '  };',
    '  const handleKeyDown = (event: React.KeyboardEvent) => {',
    '    if (event.key === \'Enter\' && !event.shiftKey) {',
    '      event.preventDefault();',
    '    }',
    '  };',
    '  return <button onClick={() => void submitForm()}>Send</button>;',
    '}',
    '```',
  ].join('\n'),
  [],
  { skipQualityGate: true },
);
assert(emptyParenFence.includes('function UserPanel()'), 'must keep empty () in function decls inside fences');
assert(emptyParenFence.includes('async () =>'), 'must keep empty () in arrow functions inside fences');
assert(emptyParenFence.includes('input.trim()'), 'must keep empty () in method calls inside fences');
assert(emptyParenFence.includes('preventDefault()'), 'must keep empty () in preventDefault inside fences');
assert(emptyParenFence.includes('onClick={() => void submitForm()}'), 'must keep JSX handler () inside fences');
assert(!emptyParenFence.includes('function UserPanel {'), 'must not shred UserPanel() to UserPanel');
assert(!emptyParenFence.includes('async  =>'), 'must not shred async () => to async =>');

const citationStub = formatKnowledgeAnswer(
  '[Source: UserPanel.tsx | function submitForm]',
  [{ file_name: 'UserPanel.tsx', sectionLabel: 'function submitForm', line_start: 10, line_end: 16 }],
  {
    skipQualityGate: true,
    notFoundFallback: 'I could not find enough evidence in the selected folder index to answer this question reliably.',
  },
);
assert(
  citationStub.includes('could not find enough evidence'),
  'citation-only stubs must not be published as answers',
);

console.log('formatAnswer.selftest: ok');
