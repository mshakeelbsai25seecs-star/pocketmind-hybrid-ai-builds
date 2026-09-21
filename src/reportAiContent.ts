import { openExternal } from './openExternal';

export const AI_CONTENT_REPORT_EMAIL = 'support.pocketmind@gmail.com';

export type AiContentReportReason =
  | 'inappropriate'
  | 'harmful'
  | 'offensive'
  | 'misleading'
  | 'other';

export const AI_CONTENT_REPORT_REASONS: Array<{ id: AiContentReportReason; label: string }> = [
  { id: 'inappropriate', label: 'Inappropriate or adult content' },
  { id: 'harmful', label: 'Harmful, unsafe, or dangerous advice' },
  { id: 'offensive', label: 'Offensive, hateful, or abusive' },
  { id: 'misleading', label: 'Misleading, inaccurate, or deceptive' },
  { id: 'other', label: 'Other concern' },
];

export type AiContentReportPayload = {
  reason: AiContentReportReason;
  details: string;
  contentExcerpt: string;
  sourceLabel: string;
  contentKind?: 'text' | 'image' | 'document' | 'other';
};

function reasonLabel(reason: AiContentReportReason): string {
  return AI_CONTENT_REPORT_REASONS.find((item) => item.id === reason)?.label || reason;
}

/** Keep mailto bodies under common client URL limits. */
export function truncateForReport(text: string, maxChars = 1200): string {
  const normalized = (text || '').replace(/\r\n/g, '\n').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 20)).trimEnd()}\n…[truncated]`;
}

export function buildAiContentReportMailto(payload: AiContentReportPayload): string {
  const subject = encodeURIComponent(
    `[PocketMind AI] Report AI content — ${reasonLabel(payload.reason)}`,
  );
  const body = encodeURIComponent(
    [
      'PocketMind AI — Report inappropriate AI-generated content',
      '',
      `Source: ${payload.sourceLabel || 'App'}`,
      `Kind: ${payload.contentKind || 'text'}`,
      `Reason: ${reasonLabel(payload.reason)}`,
      '',
      'Additional details from the user:',
      payload.details.trim() || '(none)',
      '',
      'Reported AI output excerpt:',
      truncateForReport(payload.contentExcerpt),
      '',
      '—',
      'Sent from PocketMind AI (Microsoft Store policy 11.16 reporting).',
    ].join('\n'),
  );
  return `mailto:${AI_CONTENT_REPORT_EMAIL}?subject=${subject}&body=${body}`;
}

export function buildAiContentReportClipboard(payload: AiContentReportPayload): string {
  return [
    'PocketMind AI — Report inappropriate AI-generated content',
    `To: ${AI_CONTENT_REPORT_EMAIL}`,
    `Source: ${payload.sourceLabel || 'App'}`,
    `Kind: ${payload.contentKind || 'text'}`,
    `Reason: ${reasonLabel(payload.reason)}`,
    '',
    'Additional details:',
    payload.details.trim() || '(none)',
    '',
    'Reported AI output excerpt:',
    truncateForReport(payload.contentExcerpt, 4000),
  ].join('\n');
}

export async function submitAiContentReport(payload: AiContentReportPayload): Promise<'mailto' | 'clipboard'> {
  const mailto = buildAiContentReportMailto(payload);
  try {
    await openExternal(mailto);
    return 'mailto';
  } catch {
    const text = buildAiContentReportClipboard(payload);
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return 'clipboard';
    }
    throw new Error(
      `Could not open email. Please write to ${AI_CONTENT_REPORT_EMAIL} and paste your report manually.`,
    );
  }
}
