/**
 * Self-test for the agent anti-thrash layer:
 *   - tool fingerprints normalize equivalent calls
 *   - ToolRunCache replays once, then refuses
 *   - codebase_search term extraction + ranking
 *
 * Run: npm run test:agent-antithrash
 */
import { ToolRunCache, toolFingerprint } from '../src/codeWorkspace/toolFingerprint';
import { rankGrepOutputs, searchTerms } from '../src/codeWorkspace/codebaseSearchCore';

let failures = 0;
const check = (name: string, cond: boolean, extra = '') => {
  if (cond) return;
  failures += 1;
  console.error('FAIL', name, extra);
};

// Fingerprints: equivalent paths and defaults collapse to one identity.
check(
  'read_file path normalization',
  toolFingerprint('read_file', { path: './src/a.ts', offset: 0 })
    === toolFingerprint('read_file', { path: 'src\\a.ts', limit: 120 }),
);
check(
  'read_file offset matters',
  toolFingerprint('read_file', { path: 'a.ts', offset: 0 })
    !== toolFingerprint('read_file', { path: 'a.ts', offset: 120 }),
);
check('apply_edit is not cacheable', toolFingerprint('apply_edit', { path: 'a.ts' }) === null);

// Cache: first repeat replays with a warning, second is refused.
const cache = new ToolRunCache();
check('fresh call executes', cache.check('grep', { pattern: 'severity' }, 1) === null);
cache.record('grep', { pattern: 'severity' }, 1, 'file.xml:3:severity=high');
const first = cache.check('grep', { pattern: 'severity' }, 2);
check(
  'duplicate replays payload',
  Boolean(first && first.includes('DUPLICATE CALL') && first.includes('severity=high')),
  first || '',
);
const second = cache.check('grep', { pattern: 'severity' }, 3);
check('second duplicate refused', Boolean(second && second.startsWith('REFUSED')), second || '');
check(
  'metrics counted',
  cache.metrics.duplicates === 2 && cache.metrics.refused === 1,
  JSON.stringify(cache.metrics),
);

// Search terms: stopwords dropped, identifiers preferred.
const terms = searchTerms('where is the rule severity configured in event_type handlers?');
check('stopwords removed', !terms.includes('the') && !terms.includes('where'), terms.join(','));
check('identifier first', terms[0] === 'event_type', terms.join(','));

// Ranking: file matching more terms wins, paths become relative, line numbers survive.
const report = rankGrepOutputs(
  'rule severity',
  ['rule', 'severity'],
  [
    'D:/ws/rules/a.xml:10:<rule id="1">',
    'D:/ws/rules/a.xml:12:severity=5\nD:/ws/other/b.xml:3:severity=1',
  ],
  'D:/ws',
);
check('relative paths', report.includes('rules/a.xml') && !report.includes('D:/ws/rules'), report);
check('best file ranked first', report.indexOf('rules/a.xml') < report.indexOf('other/b.xml'), report);
check('line numbers kept', report.includes('L12:'), report);

if (failures > 0) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log('agent-antithrash ok');
