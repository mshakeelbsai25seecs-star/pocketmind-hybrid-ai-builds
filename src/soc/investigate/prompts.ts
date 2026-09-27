import { SOC_HUMAN_APPROVAL_NOTICE } from '../../socChatHandoff';
import type { SocCase, SocMemoryEntry } from '../types';

export const SOC_INVESTIGATION_SYSTEM = [
  'You are PocketMind Hybrid AI SOC Alert Analyst.',
  'Investigate the case using only provided evidence, company knowledge snippets, and memory entries.',
  'Do not claim live SIEM, EDR, or SOAR API access.',
  SOC_HUMAN_APPROVAL_NOTICE,
  'Return a human-readable Markdown investigation AND a machine-readable JSON fence exactly once.',
  'Use this fence exactly:',
  '---SOC_VERDICT_JSON---',
  '{',
  '  "disposition": "benign|suspicious|malicious|needs_evidence|undetermined",',
  '  "confidence": "low|medium|high",',
  '  "summary": "one sentence",',
  '  "reasoning": "short paragraph",',
  '  "evidenceFound": ["..."],',
  '  "missingEvidence": ["..."],',
  '  "recommendedActions": ["..."],',
  '  "mitreTechniques": ["Txxxx"],',
  '  "interviewQuestions": ["..."]',
  '}',
  '---END_SOC_VERDICT_JSON---',
].join('\n');

export function buildInvestigationUserPrompt(input: {
  case: SocCase;
  knowledgeContext?: string;
  memoryEntries?: SocMemoryEntry[];
  extractedIocs?: string[];
}): string {
  const c = input.case;
  const memoryBlock = (input.memoryEntries || []).length
    ? [
      'ANALYST-APPROVED MEMORY:',
      ...(input.memoryEntries || []).map(
        m => `- (${m.classification}) ${m.entityType}:${m.key} — ${m.note}`,
      ),
    ].join('\n')
    : 'ANALYST-APPROVED MEMORY: none';

  const iocBlock = (input.extractedIocs || []).length
    ? `EXTRACTED IOCs:\n${(input.extractedIocs || []).map(x => `- ${x}`).join('\n')}`
    : 'EXTRACTED IOCs: none beyond entity fields';

  return [
    `CASE ID: ${c.id}`,
    `TITLE: ${c.title}`,
    `SEVERITY: ${c.severity}`,
    `STATUS: ${c.status}`,
    `SUMMARY: ${c.summary || '(empty)'}`,
    `SOURCE IP: ${c.entities.sourceIp || '(none)'}`,
    `DEST IP: ${c.entities.destinationIp || '(none)'}`,
    `USER: ${c.entities.username || '(none)'}`,
    `ASSET: ${c.entities.asset || '(none)'}`,
    `NOTES: ${c.notes || '(none)'}`,
    `TAGS: ${c.tags.join(', ') || '(none)'}`,
    '',
    'RAW EVIDENCE:',
    c.rawEvidence?.trim() || '(none)',
    '',
    memoryBlock,
    '',
    iocBlock,
    '',
    (input.knowledgeContext || '').trim() || 'COMPANY KNOWLEDGE: none retrieved',
    '',
    'TASK: Investigate and conclude. Prefer needs_evidence over guessing.',
  ].join('\n');
}
