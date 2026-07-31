/**
 * Phase 0 + Cursor-parity self-test (no LLM required):
 *   - tool fingerprint metrics on golden-style duplicate calls
 *   - codebase_search ranking over FortiSIEM-like XML grep hits
 *   - system prompt policies (search / anti-thrash / finish)
 *   - always-on explore-efficiently skill
 *   - golden fixture manifests exist and declare budgets
 *
 * Run: npm run test:agent-parity
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ToolRunCache, toolFingerprint } from '../src/codeWorkspace/toolFingerprint';
import { rankGrepOutputs, searchTerms } from '../src/codeWorkspace/codebaseSearchCore';
import { systemPromptForMode } from '../src/codeWorkspace/prompts';
import { ALWAYS_ON_SKILL_IDS, BUILTIN_SKILLS } from '../src/codeWorkspace/builtinSkills';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const check = (name: string, cond: boolean, extra = '') => {
  if (cond) return;
  failures += 1;
  console.error('FAIL', name, extra);
};

// —— Metrics: simulate a thrashing FortiSIEM Q&A run ——
const cache = new ToolRunCache();
const grepArgs = { pattern: 'Logon Time', path: '.', glob: '*.xml' };
check('fresh grep executes', cache.check('grep', grepArgs, 1) === null);
cache.record('grep', grepArgs, 1, 'rules/auth-logon.xml:5:<name>Logon Time Outside Business Hours</name>');
const dup1 = cache.check('grep', grepArgs, 2);
check('duplicate flagged', Boolean(dup1?.includes('DUPLICATE CALL')), dup1 || '');
const dup2 = cache.check('grep', grepArgs, 3);
check('second duplicate refused', Boolean(dup2?.startsWith('REFUSED')), dup2 || '');
check(
  'golden metrics budget',
  cache.metrics.duplicates <= 2 && cache.metrics.refused === 1 && cache.metrics.calls === 3,
  JSON.stringify(cache.metrics),
);
check(
  'fingerprint stable for same grep',
  toolFingerprint('grep', grepArgs) === toolFingerprint('grep', { ...grepArgs, path: './' }),
);

// —— codebase_search ranking on FortiSIEM-like hits ——
const query = 'logon time outside business hours rule severity';
const terms = searchTerms(query);
check('search terms include logon', terms.some(t => /logon/i.test(t)), terms.join(','));
const report = rankGrepOutputs(
  query,
  terms,
  [
    [
      `${root}/test-fixtures/pocketcode-agent/fortisiem-intake/rules/auth-logon.xml:4:<Rule id="PH_RULE_Logon_Time_Outside_Business">`,
      `${root}/test-fixtures/pocketcode-agent/fortisiem-intake/rules/auth-logon.xml:5:<name>Logon Time Outside Business Hours</name>`,
      `${root}/test-fixtures/pocketcode-agent/fortisiem-intake/rules/auth-logon.xml:12:<severity>5</severity>`,
    ].join('\n'),
    `${root}/test-fixtures/pocketcode-agent/fortisiem-intake/README.md:3:what is the logon time rule?`,
  ],
  `${root}/test-fixtures/pocketcode-agent/fortisiem-intake`,
);
check('ranks auth-logon.xml', report.includes('rules/auth-logon.xml'), report.slice(0, 400));
check('keeps rule id evidence', report.includes('PH_RULE_Logon_Time_Outside_Business'), report.slice(0, 600));
check('keeps line numbers', /L\d+:/.test(report), report.slice(0, 400));

// —— Prompt policies ——
const agentPrompt = systemPromptForMode('agent', {
  workspaceBrief: 'Root folders: rules/\nFile types: .xml ×1',
  projectRules: 'Prefer grep for XML rule packs.',
  toolProtocol: 'json',
});
check('search policy present', agentPrompt.includes('SEARCH POLICY'));
check('no-repeat policy present', agentPrompt.includes('NO REPEATED WORK'));
check('finish policy present', agentPrompt.includes('FINISHING'));
check('workspace brief injected', agentPrompt.includes('WORKSPACE BRIEF') && agentPrompt.includes('rules/'));
check('project rules injected', agentPrompt.includes('PROJECT RULES') && agentPrompt.includes('XML rule packs'));
check('json batching hint', /Plan a short sequence|exactly one tool per turn/i.test(agentPrompt));
check('codebase_search in tool list', agentPrompt.includes('codebase_search'));

const nativePrompt = systemPromptForMode('ask', { toolProtocol: 'native' });
check('native multi-tool preference', nativePrompt.includes('Batch independent calls'));

// —— Always-on efficiency skill ——
check(
  'explore-efficiently builtin exists',
  BUILTIN_SKILLS.some(s => s.id === 'builtin:explore-efficiently'),
);
check(
  'explore-efficiently always-on',
  ALWAYS_ON_SKILL_IDS.includes('builtin:explore-efficiently'),
);

// —— Golden fixture manifests ——
for (const rel of [
  'test-fixtures/pocketcode-agent/fortisiem-intake/GOLDEN.json',
  'test-fixtures/pocketcode-agent/mini-code/GOLDEN.json',
  'test-fixtures/pocketcode-agent/fortisiem-intake/rules/auth-logon.xml',
  'test-fixtures/pocketcode-agent/mini-code/src/math.ts',
]) {
  const path = join(root, rel);
  check(`fixture exists ${rel}`, existsSync(path));
}

const forti = JSON.parse(
  readFileSync(join(root, 'test-fixtures/pocketcode-agent/fortisiem-intake/GOLDEN.json'), 'utf8'),
) as { tasks: Array<{ max_steps: number; max_duplicate_reads: number; must_find: string[] }> };
check('fortisiem task budget ≤ 6', forti.tasks[0]?.max_steps <= 6);
check('fortisiem duplicate budget ≤ 1', forti.tasks[0]?.max_duplicate_reads <= 1);
check(
  'fortisiem must_find covers rule id',
  forti.tasks[0]?.must_find?.includes('PH_RULE_Logon_Time_Outside_Business'),
);

const xml = readFileSync(
  join(root, 'test-fixtures/pocketcode-agent/fortisiem-intake/rules/auth-logon.xml'),
  'utf8',
);
check('xml contains logon rule', xml.includes('PH_RULE_Logon_Time_Outside_Business') && xml.includes('Win-Security-4624'));

if (failures > 0) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log('agent-parity ok');
