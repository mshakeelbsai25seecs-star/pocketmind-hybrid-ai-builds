import { newCaseId, newEvidenceStepId } from './ids';
import type {
  ParsedAlert,
  SocCase,
  SocCaseSource,
  SocDisposition,
  SocEntityRefs,
  SocEvidenceStep,
  SocSeverity,
} from './types';

export function emptyEntities(): SocEntityRefs {
  return {
    sourceIp: '',
    destinationIp: '',
    username: '',
    asset: '',
    hostnames: [],
    urls: [],
    hashes: [],
    extra: {},
  };
}

export function mergeEntities(partial?: Partial<SocEntityRefs>): SocEntityRefs {
  const base = emptyEntities();
  if (!partial) return base;
  return {
    sourceIp: partial.sourceIp?.trim() || '',
    destinationIp: partial.destinationIp?.trim() || '',
    username: partial.username?.trim() || '',
    asset: partial.asset?.trim() || '',
    hostnames: [...(partial.hostnames || [])],
    urls: [...(partial.urls || [])],
    hashes: [...(partial.hashes || [])],
    extra: { ...(partial.extra || {}) },
  };
}

export function createEvidenceStep(
  source: string,
  action: string,
  detail: string,
  opts?: Partial<Pick<SocEvidenceStep, 'hypothesis' | 'artifactPath' | 'ok' | 'at'>>,
): SocEvidenceStep {
  return {
    id: newEvidenceStepId(),
    at: opts?.at ?? Date.now(),
    source,
    action,
    detail,
    hypothesis: opts?.hypothesis,
    artifactPath: opts?.artifactPath,
    ok: opts?.ok ?? true,
  };
}

export function createBlankCase(opts?: {
  title?: string;
  summary?: string;
  severity?: SocSeverity;
  assignee?: string;
  source?: SocCaseSource;
}): SocCase {
  const now = Date.now();
  return {
    schemaVersion: 1,
    id: newCaseId(),
    title: opts?.title?.trim() || 'Untitled case',
    status: 'new',
    severity: opts?.severity || 'unknown',
    disposition: 'undetermined',
    source: opts?.source || { kind: 'manual' },
    createdAt: now,
    updatedAt: now,
    assignee: opts?.assignee?.trim() || '',
    summary: opts?.summary?.trim() || '',
    rawEvidence: '',
    entities: emptyEntities(),
    tags: [],
    notes: '',
    evidenceChain: [],
    verdict: null,
    overrides: [],
    engineering: {},
    timings: {},
  };
}

export function caseFromParsedAlert(
  alert: ParsedAlert,
  opts: { importBatchId: string; assignee?: string },
): SocCase {
  const now = Date.now();
  const title = alert.title.trim() || 'Imported alert';
  const step = createEvidenceStep(
    'import',
    'Imported alert',
    `${alert.sourceLabel}${alert.externalId ? ` · ${alert.externalId}` : ''}`,
  );
  return {
    schemaVersion: 1,
    id: newCaseId(),
    title: title.slice(0, 160),
    status: 'new',
    severity: alert.severity || 'unknown',
    disposition: 'undetermined' satisfies SocDisposition,
    source: {
      kind: 'import',
      importBatchId: opts.importBatchId,
      externalId: alert.externalId,
    },
    createdAt: now,
    updatedAt: now,
    assignee: opts.assignee?.trim() || '',
    summary: alert.summary.trim() || title,
    rawEvidence: alert.rawEvidence,
    entities: mergeEntities(alert.entities),
    tags: [...(alert.tags || [])],
    notes: alert.notes?.trim() || '',
    evidenceChain: [step],
    verdict: null,
    overrides: [],
    engineering: {},
    timings: {},
  };
}

export function normalizeSeverity(raw: unknown): SocSeverity {
  if (raw == null) return 'unknown';
  const s = String(raw).trim().toLowerCase();
  if (!s) return 'unknown';
  if (['critical', 'crit', '5', 'fatal'].includes(s)) return 'critical';
  if (['high', '4', 'major', 'error'].includes(s)) return 'high';
  if (['medium', 'med', '3', 'moderate', 'warning', 'warn'].includes(s)) return 'medium';
  if (['low', '2', 'minor'].includes(s)) return 'low';
  if (['info', 'informational', '1', '0'].includes(s)) return 'info';
  return 'unknown';
}
