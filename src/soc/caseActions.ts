import { logAuditEvent } from '../auditLog';
import { socUpsertCase } from './caseStore';
import type { SocCase, SocConfidence, SocDisposition, SocOverrideRecord } from './types';

function pushOverride(
  socCase: SocCase,
  field: SocOverrideRecord['field'],
  from: string,
  to: string,
  by: string,
  note = '',
): SocOverrideRecord[] {
  if (from === to) return socCase.overrides;
  return [
    ...socCase.overrides,
    {
      at: Date.now(),
      by: by.trim() || 'analyst',
      field,
      from,
      to,
      note,
    },
  ];
}

export async function updateCaseDisposition(
  socCase: SocCase,
  disposition: SocDisposition,
  by: string,
  note = '',
): Promise<SocCase> {
  const next: SocCase = {
    ...socCase,
    disposition,
    overrides: pushOverride(socCase, 'disposition', socCase.disposition, disposition, by, note),
    updatedAt: Date.now(),
    verdict: socCase.verdict
      ? { ...socCase.verdict, disposition }
      : socCase.verdict,
  };
  return socUpsertCase(next);
}

export async function updateCaseConfidence(
  socCase: SocCase,
  confidence: SocConfidence,
  by: string,
): Promise<SocCase> {
  if (!socCase.verdict) return socCase;
  const from = socCase.verdict.confidence;
  const next: SocCase = {
    ...socCase,
    overrides: pushOverride(socCase, 'confidence', from, confidence, by),
    updatedAt: Date.now(),
    verdict: { ...socCase.verdict, confidence },
  };
  return socUpsertCase(next);
}

export async function approveCase(
  socCase: SocCase,
  approvedBy: string,
  closeAfter: boolean,
): Promise<SocCase> {
  if (!socCase.verdict) throw new Error('Generate an investigation verdict before approval.');
  if (socCase.disposition === 'undetermined') {
    throw new Error('Set a disposition before approval.');
  }
  const who = approvedBy.trim();
  if (!who) throw new Error('Approver name is required.');
  const now = Date.now();
  let next: SocCase = {
    ...socCase,
    approvedAt: now,
    approvedBy: who,
    status: closeAfter ? 'closed' : 'pending_approval',
    closedAt: closeAfter ? now : socCase.closedAt,
    updatedAt: now,
    overrides: closeAfter
      ? pushOverride(socCase, 'status', socCase.status, 'closed', who, 'approve_and_close')
      : socCase.overrides,
  };
  next = await socUpsertCase(next);
  void logAuditEvent({
    eventType: 'soc.approve',
    category: 'soc',
    summary: `${socCase.id} approved by ${who}`,
    detail: closeAfter ? 'approve_and_close' : 'approve',
  });
  return next;
}

export async function closeCase(socCase: SocCase, by: string): Promise<SocCase> {
  if (socCase.disposition === 'undetermined') {
    throw new Error('Set a disposition before closing.');
  }
  const who = by.trim() || 'analyst';
  const now = Date.now();
  const next = await socUpsertCase({
    ...socCase,
    status: 'closed',
    closedAt: now,
    updatedAt: now,
    overrides: pushOverride(socCase, 'status', socCase.status, 'closed', who),
  });
  void logAuditEvent({
    eventType: 'soc.close',
    category: 'soc',
    summary: `${socCase.id} closed by ${who}`,
  });
  return next;
}
