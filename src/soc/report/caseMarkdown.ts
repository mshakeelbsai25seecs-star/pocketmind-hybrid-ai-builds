import type { SocCase } from '../types';

export function buildCaseMarkdown(socCase: SocCase): string {
  const v = socCase.verdict;
  const lines: string[] = [
    `# ${socCase.id} — ${socCase.title}`,
    '',
    `- Status: ${socCase.status}`,
    `- Severity: ${socCase.severity}`,
    `- Disposition: ${socCase.disposition}`,
    `- Source: ${socCase.source.kind}${socCase.source.externalId ? ` (${socCase.source.externalId})` : ''}`,
    `- Created: ${new Date(socCase.createdAt).toISOString()}`,
    `- Updated: ${new Date(socCase.updatedAt).toISOString()}`,
    socCase.closedAt ? `- Closed: ${new Date(socCase.closedAt).toISOString()}` : '',
    socCase.approvedBy ? `- Approved by: ${socCase.approvedBy}` : '',
    '',
    '## Summary',
    socCase.summary || '(none)',
    '',
    '## Entities',
    `- Source IP: ${socCase.entities.sourceIp || '—'}`,
    `- Destination IP: ${socCase.entities.destinationIp || '—'}`,
    `- User: ${socCase.entities.username || '—'}`,
    `- Asset: ${socCase.entities.asset || '—'}`,
    '',
    '## Evidence chain',
  ];

  if (!socCase.evidenceChain.length) {
    lines.push('(empty)');
  } else {
    for (const step of socCase.evidenceChain) {
      lines.push(
        `- ${new Date(step.at).toISOString()} · [${step.source}] ${step.action} — ${step.detail}${step.ok ? '' : ' (failed)'}`,
      );
    }
  }

  lines.push('', '## Verdict');
  if (!v) {
    lines.push('(none)');
  } else {
    lines.push(
      `- Disposition: ${v.disposition}`,
      `- Confidence: ${v.confidence}`,
      `- Summary: ${v.summary}`,
      '',
      '### Reasoning',
      v.reasoning || '(none)',
      '',
      '### Evidence found',
      ...(v.evidenceFound.length ? v.evidenceFound.map(e => `- ${e}`) : ['- (none)']),
      '',
      '### Missing evidence',
      ...(v.missingEvidence.length ? v.missingEvidence.map(e => `- ${e}`) : ['- (none)']),
      '',
      '### Recommended actions',
      ...(v.recommendedActions.length ? v.recommendedActions.map(e => `- ${e}`) : ['- (none)']),
      '',
      '### Interview questions',
      ...(v.interviewQuestions.length ? v.interviewQuestions.map(e => `- ${e}`) : ['- (none)']),
    );
  }

  if (socCase.rawEvidence.trim()) {
    lines.push('', '## Raw evidence', '```', socCase.rawEvidence.trim(), '```');
  }

  if (socCase.overrides.length) {
    lines.push('', '## Overrides');
    for (const o of socCase.overrides) {
      lines.push(`- ${new Date(o.at).toISOString()} ${o.by}: ${o.field} ${o.from} → ${o.to}${o.note ? ` (${o.note})` : ''}`);
    }
  }

  return lines.filter(Boolean).join('\n');
}
