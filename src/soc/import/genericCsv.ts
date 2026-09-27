import { normalizeSeverity } from '../caseFactory';
import type { ParsedAlert } from '../types';

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === ',' && !inQuotes) {
      out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur.trim());
  return out;
}

function headerIndex(headers: string[], candidates: string[]): number {
  const lower = headers.map(h => h.toLowerCase());
  for (const c of candidates) {
    const idx = lower.indexOf(c.toLowerCase());
    if (idx >= 0) return idx;
  }
  return -1;
}

export function canParseCsv(text: string): boolean {
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return false;
  const headers = parseCsvLine(lines[0]!).map(h => h.toLowerCase());
  const markers = ['src', 'source', 'ip', 'user', 'alert', 'event', 'severity', 'title', 'name'];
  return headers.some(h => markers.some(m => h.includes(m)));
}

export function parseCsv(text: string, fileLabel: string): ParsedAlert[] {
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = parseCsvLine(lines[0]!);
  const iTitle = headerIndex(headers, ['title', 'name', 'event', 'alert', 'rule', 'incident']);
  const iSev = headerIndex(headers, ['severity', 'sev', 'priority']);
  const iSrc = headerIndex(headers, ['src', 'source_ip', 'sourceip', 'srcip', 'source']);
  const iDst = headerIndex(headers, ['dst', 'dest', 'destination_ip', 'destip', 'destination']);
  const iUser = headerIndex(headers, ['user', 'username', 'account']);
  const iAsset = headerIndex(headers, ['asset', 'host', 'hostname', 'device']);
  const iId = headerIndex(headers, ['id', 'event_id', 'incident_id', 'alert_id']);
  const iSummary = headerIndex(headers, ['summary', 'description', 'detail', 'message', 'msg']);

  const alerts: ParsedAlert[] = [];
  for (let r = 1; r < lines.length; r += 1) {
    const cols = parseCsvLine(lines[r]!);
    if (cols.every(c => !c)) continue;
    const get = (idx: number) => (idx >= 0 ? cols[idx] || '' : '');
    const title = get(iTitle) || `CSV row ${r + 1}`;
    alerts.push({
      externalId: get(iId) || undefined,
      title,
      summary: get(iSummary) || title,
      severity: normalizeSeverity(get(iSev)),
      rawEvidence: lines[r]!,
      entities: {
        sourceIp: get(iSrc),
        destinationIp: get(iDst),
        username: get(iUser),
        asset: get(iAsset),
        hostnames: get(iAsset) ? [get(iAsset)] : [],
        urls: [],
        hashes: [],
        extra: Object.fromEntries(headers.map((h, i) => [h, cols[i] || ''])),
      },
      tags: ['csv', 'import'],
      sourceLabel: fileLabel,
      originalPayload: lines[r],
    });
  }
  return alerts;
}
