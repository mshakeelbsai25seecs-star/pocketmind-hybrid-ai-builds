import type { ParsedAlert } from '../types';

export function parseRawBundle(text: string, fileLabel: string): ParsedAlert[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const title = fileLabel.replace(/\.[^.]+$/, '') || 'Imported evidence';
  return [{
    title,
    summary: `Imported file ${fileLabel}`,
    severity: 'unknown',
    rawEvidence: trimmed,
    entities: {
      sourceIp: '',
      destinationIp: '',
      username: '',
      asset: '',
      hostnames: [],
      urls: [],
      hashes: [],
      extra: {},
    },
    tags: ['raw', 'import'],
    sourceLabel: fileLabel,
    originalPayload: trimmed,
  }];
}
