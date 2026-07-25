/**
 * Run Knowledge Chat TypeScript selftests (no Vitest dependency).
 * Usage: node scripts/run-kc-selftests.mjs
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = [
  'src/knowledgeChat/formatAnswer.selftest.ts',
  'src/knowledgeChat/extractivePrefer.selftest.ts',
  'src/knowledgeChat/intentClassify.selftest.ts',
  'src/knowledgeChat/retrievalDecision.selftest.ts',
];

let failed = 0;
for (const rel of files) {
  const abs = path.join(root, rel);
  console.log(`\n--- ${rel} ---`);
  const r = spawnSync('npx', ['--yes', 'tsx', abs], {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    windowsHide: true,
  });
  if (r.status !== 0) {
    failed += 1;
    console.error(`FAIL ${rel}`);
  } else {
    console.log(`OK ${rel}`);
  }
}

if (failed > 0) {
  console.error(`\n${failed} selftest(s) failed`);
  process.exit(1);
}
console.log('\nAll KC selftests passed');
