/**
 * Browser / Vite persistence for SOC when Tauri FS commands are unavailable.
 * Same schema as the desktop `{data_root}/soc/` store — used for offline QA and
 * as a last-resort fallback. Desktop production always prefers Tauri.
 */
import { computeSocMetrics } from './metrics';
import type {
  SocCase,
  SocCaseIndexEntry,
  SocImportBatch,
  SocMemoryEntry,
  SocMetricsSummary,
} from './types';

const CASES_KEY = 'pocketmind-soc-cases-v1';
const MEMORY_KEY = 'pocketmind-soc-memory-v1';
const IMPORTS_KEY = 'pocketmind-soc-imports-v1';
const ARTIFACTS_KEY = 'pocketmind-soc-artifacts-v1';
const CONNECTORS_KEY = 'pocketmind-soc-connectors-v1';

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  localStorage.setItem(key, JSON.stringify(value));
}

function indexEntry(c: SocCase): SocCaseIndexEntry {
  return {
    id: c.id,
    title: c.title,
    status: c.status,
    severity: c.severity,
    disposition: c.disposition,
    source_kind: c.source.kind,
    created_at: c.createdAt,
    updated_at: c.updatedAt,
    closed_at: c.closedAt ?? null,
    assignee: c.assignee,
    external_id: c.source.externalId ?? null,
  };
}

function loadCases(): Record<string, SocCase> {
  return readJson<Record<string, SocCase>>(CASES_KEY, {});
}

function saveCases(map: Record<string, SocCase>): void {
  writeJson(CASES_KEY, map);
}

export function browserEnsureDirs(): string[] {
  if (!localStorage.getItem(CASES_KEY)) writeJson(CASES_KEY, {});
  if (!localStorage.getItem(MEMORY_KEY)) writeJson(MEMORY_KEY, []);
  if (!localStorage.getItem(IMPORTS_KEY)) writeJson(IMPORTS_KEY, {});
  if (!localStorage.getItem(ARTIFACTS_KEY)) writeJson(ARTIFACTS_KEY, {});
  if (!localStorage.getItem(CONNECTORS_KEY)) writeJson(CONNECTORS_KEY, {});
  return ['browser:soc'];
}

export function browserListCases(): SocCaseIndexEntry[] {
  const map = loadCases();
  return Object.values(map)
    .map(indexEntry)
    .sort((a, b) => b.updated_at - a.updated_at);
}

export function browserGetCase(caseId: string): SocCase {
  const c = loadCases()[caseId];
  if (!c) throw new Error(`Case not found: ${caseId}`);
  return c;
}

export function browserUpsertCase(socCase: SocCase): SocCase {
  if (!socCase?.id) throw new Error('Case id is required');
  const now = Date.now();
  const map = loadCases();
  const prev = map[socCase.id];
  const next: SocCase = {
    ...socCase,
    schemaVersion: 1,
    createdAt: prev?.createdAt ?? socCase.createdAt ?? now,
    updatedAt: now,
  };
  map[next.id] = next;
  saveCases(map);
  return next;
}

export function browserDeleteCase(caseId: string): void {
  const map = loadCases();
  delete map[caseId];
  saveCases(map);
  const arts = readJson<Record<string, Record<string, string>>>(ARTIFACTS_KEY, {});
  delete arts[caseId];
  writeJson(ARTIFACTS_KEY, arts);
}

export function browserListMemory(): SocMemoryEntry[] {
  const rows = readJson<SocMemoryEntry[]>(MEMORY_KEY, []);
  return Array.isArray(rows) ? rows : [];
}

export function browserSaveMemory(entries: SocMemoryEntry[]): SocMemoryEntry[] {
  if (!Array.isArray(entries)) throw new Error('Memory entries must be an array');
  writeJson(MEMORY_KEY, entries);
  return entries;
}

export function browserSaveImportBatch(batch: SocImportBatch): SocImportBatch {
  const map = readJson<Record<string, SocImportBatch>>(IMPORTS_KEY, {});
  map[batch.id] = batch;
  writeJson(IMPORTS_KEY, map);
  return batch;
}

export function browserWriteArtifact(
  caseId: string,
  relativeName: string,
  contents: string,
  kind: 'artifacts' | 'import',
): string {
  const arts = readJson<Record<string, Record<string, string>>>(ARTIFACTS_KEY, {});
  const bucket = arts[caseId] || {};
  const key = `${kind}/${relativeName}`;
  bucket[key] = contents;
  arts[caseId] = bucket;
  writeJson(ARTIFACTS_KEY, arts);
  return `browser://${caseId}/${key}`;
}

export function browserExportCaseMarkdown(caseId: string, markdown: string, filename?: string): string {
  const name = (filename || `${caseId}.md`).replace(/[^\w.\-]+/g, '_');
  const key = `export:${name}`;
  localStorage.setItem(key, markdown);
  // Also offer download when in browser
  try {
    const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  } catch {
    /* ignore download failures */
  }
  return `browser-download:${name}`;
}

export function browserRecomputeMetrics(): SocMetricsSummary {
  const cases = Object.values(loadCases());
  return computeSocMetrics(cases);
}

export function browserGetConnectorsConfig(): Record<string, unknown> {
  return readJson<Record<string, unknown>>(CONNECTORS_KEY, {});
}

export function browserSaveConnectorsConfig(value: Record<string, unknown>): Record<string, unknown> {
  writeJson(CONNECTORS_KEY, value);
  return value;
}
