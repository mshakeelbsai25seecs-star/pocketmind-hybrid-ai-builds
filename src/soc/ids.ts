function randAlnum(len: number): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  for (let i = 0; i < len; i += 1) out += alphabet[bytes[i]! % alphabet.length];
  return out;
}

function yyyymmdd(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

export function newCaseId(now = new Date()): string {
  return `CASE-${yyyymmdd(now)}-${randAlnum(6)}`;
}

export function newEvidenceStepId(): string {
  return `ev-${randAlnum(10)}`;
}

export function newMemoryId(): string {
  return `mem-${randAlnum(10)}`;
}

export function newImportBatchId(now = new Date()): string {
  return `imp-${yyyymmdd(now)}-${randAlnum(6)}`;
}

export function normalizeMemoryKey(entityType: string, key: string): string {
  const trimmed = key.trim();
  if (!trimmed) return '';
  if (entityType === 'user' || entityType === 'domain' || entityType === 'host') {
    return trimmed.toLowerCase();
  }
  if (entityType === 'ip') return trimmed;
  return trimmed.toLowerCase();
}
