/**
 * Node-side smoke for browser store helpers (localStorage polyfill).
 */
import assert from 'node:assert/strict';
import { createBlankCase } from '../src/soc/caseFactory.ts';
import {
  browserDeleteCase,
  browserEnsureDirs,
  browserGetCase,
  browserListCases,
  browserRecomputeMetrics,
  browserSaveMemory,
  browserUpsertCase,
} from '../src/soc/browserStore.ts';
import { createMemoryEntry } from '../src/soc/memoryStore.ts';

class MemoryStorage {
  map = new Map<string, string>();
  getItem(k: string) { return this.map.has(k) ? this.map.get(k)! : null; }
  setItem(k: string, v: string) { this.map.set(k, String(v)); }
  removeItem(k: string) { this.map.delete(k); }
}

(globalThis as unknown as { localStorage: MemoryStorage }).localStorage = new MemoryStorage();

browserEnsureDirs();
assert.equal(browserListCases().length, 0);

let c = createBlankCase({ title: 'Browser case', summary: 'test' });
c = browserUpsertCase(c);
assert.equal(browserListCases().length, 1);
assert.equal(browserGetCase(c.id).title, 'Browser case');

c = browserUpsertCase({ ...c, disposition: 'suspicious', status: 'closed', closedAt: Date.now(), verdict: {
  disposition: 'suspicious',
  confidence: 'medium',
  summary: 's',
  reasoning: 'r',
  evidenceFound: [],
  missingEvidence: [],
  recommendedActions: [],
  mitreTechniques: [],
  interviewQuestions: [],
  aiDisposition: 'malicious',
} });
const metrics = browserRecomputeMetrics();
assert.equal(metrics.total_cases, 1);
assert.equal(metrics.override_count, 1);

const mem = createMemoryEntry({
  entityType: 'ip',
  key: '1.2.3.4',
  note: 'lab scanner',
  classification: 'benign_expected',
  createdBy: 'analyst',
});
browserSaveMemory([mem]);

browserDeleteCase(c.id);
assert.equal(browserListCases().length, 0);

console.log('soc-browser-store.selftest ok');
