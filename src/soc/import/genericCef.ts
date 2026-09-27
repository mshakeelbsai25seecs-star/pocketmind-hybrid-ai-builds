import { normalizeSeverity } from '../caseFactory';
import type { ParsedAlert } from '../types';

function parseCefExtensions(ext: string): Record<string, string> {
  const out: Record<string, string> = {};
  // Values run until the next " key=" token (CEF extension format).
  const parts = ext.trim().split(/\s+(?=[a-zA-Z][a-zA-Z0-9]*=)/);
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).replace(/\\=/g, '=').trim();
    if (key) out[key] = value;
  }
  return out;
}

export function canParseCef(text: string): boolean {
  return text.split(/\r?\n/).some(line => /\bCEF:\d+\|/.test(line));
}

export function parseCef(text: string, fileLabel: string): ParsedAlert[] {
  const alerts: ParsedAlert[] = [];
  for (const line of text.split(/\r?\n/)) {
    const idx = line.indexOf('CEF:');
    if (idx < 0) continue;
    const cef = line.slice(idx);
    const parts = cef.split('|');
    if (parts.length < 7) continue;
    const deviceVendor = parts[1] || '';
    const deviceProduct = parts[2] || '';
    const signature = parts[4] || '';
    const name = parts[5] || 'CEF alert';
    const severity = normalizeSeverity(parts[6]);
    const ext = parseCefExtensions(parts.slice(7).join('|'));
    const sourceIp = ext.src || ext.sourceAddress || '';
    const destinationIp = ext.dst || ext.destinationAddress || '';
    const username = ext.suser || ext.duser || ext.destinationUserName || '';
    const asset = ext.dhost || ext.shost || ext.destinationHostName || '';
    alerts.push({
      externalId: ext.externalId || ext.cn1 || undefined,
      title: name,
      summary: `${deviceVendor}/${deviceProduct}: ${signature || name}`,
      severity,
      rawEvidence: line.trim(),
      entities: {
        sourceIp,
        destinationIp,
        username,
        asset,
        hostnames: asset ? [asset] : [],
        urls: ext.request ? [ext.request] : [],
        hashes: [],
        extra: ext,
      },
      tags: ['cef', 'import'],
      sourceLabel: fileLabel,
      originalPayload: line.trim(),
    });
  }
  return alerts;
}
