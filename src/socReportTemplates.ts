import type { KcSearchHit } from './knowledgeChat/types';
import { formatSourceCitation } from './knowledgeChat/prompts';
import type { SocKnowledgeChunk, SocKnowledgeResource } from './types';
import type { SocWorkspaceInput } from './socPromptTemplates';
import { SOC_HUMAN_APPROVAL_NOTICE, SOC_SYSTEM_PROMPT } from './socPromptTemplates';
import { buildSocRetrievedSnippetContext } from './socKnowledgeIndex';
import { SOC_APP_NAME, SOC_ARTIFACT_DISCLAIMER } from './productConfig';

export type SocArtifactReportType =
  | 'triage_report'
  | 'investigation_plan'
  | 'fortisiem_rule_draft'
  | 'fortisiem_parser_draft'
  | 'fortisoar_playbook_draft'
  | 'connector_spec'
  | 'knowledge_context_summary'
  | 'validator_report_summary';

export interface SocReportTypeOption {
  id: SocArtifactReportType;
  label: string;
  description: string;
}

export interface SocArtifactReportInput {
  reportTitle: string;
  reportType: SocArtifactReportType;
  analystNotes: string;
  severityVerdict: string;
  scope: string;
  assumptions: string;
  evidenceSummary: string;
  recommendations: string;
  safetyNotes: string;
  validatorReport: string;
}

export const SOC_ARTIFACT_REPORT_TYPES: SocReportTypeOption[] = [
  {
    id: 'triage_report',
    label: 'SOC triage report',
    description: 'Executive verdict, evidence summary, risk level, and safe response notes.',
  },
  {
    id: 'investigation_plan',
    label: 'Investigation plan',
    description: 'Step-by-step L3 investigation workflow with evidence gaps and escalation notes.',
  },
  {
    id: 'fortisiem_rule_draft',
    label: 'FortiSIEM rule draft',
    description: 'Detection goal, fields, correlation logic, tuning notes, and test cases.',
  },
  {
    id: 'fortisiem_parser_draft',
    label: 'FortiSIEM parser draft',
    description: 'Parser objective, log source notes, field mapping, recognizer, and validation checklist.',
  },
  {
    id: 'fortisoar_playbook_draft',
    label: 'FortiSOAR playbook draft',
    description: 'Trigger, enrichment, decision points, human approvals, and response flow.',
  },
  {
    id: 'connector_spec',
    label: 'Connector requirement/spec',
    description: 'Connector purpose, actions, inputs, outputs, auth, errors, and test cases.',
  },
  {
    id: 'knowledge_context_summary',
    label: 'Offline knowledge context summary',
    description: 'Selected local references and retrieved snippets summarized for analysts.',
  },
  {
    id: 'validator_report_summary',
    label: 'Validator report summary',
    description: 'Offline deterministic validation results and recommended fixes.',
  },
];

export const emptySocArtifactReportInput: SocArtifactReportInput = {
  reportTitle: 'SOC report',
  reportType: 'triage_report',
  analystNotes: '',
  severityVerdict: '',
  scope: '',
  assumptions: '',
  evidenceSummary: '',
  recommendations: '',
  safetyNotes: SOC_HUMAN_APPROVAL_NOTICE,
  validatorReport: '',
};

function clean(value: string, fallback = 'Not provided'): string {
  const trimmed = value.trim();
  return trimmed || fallback;
}

function bulletLines(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '- Not provided';
  return trimmed
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => line.startsWith('- ') ? line : `- ${line}`)
    .join('\n');
}

function fenced(value: string, language = ''): string {
  const trimmed = value.trim();
  if (!trimmed) return 'Not provided';
  return ['```' + language, trimmed, '```'].join('\n');
}

function trimBlock(value: string, limit: number): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (trimmed.length <= limit) return trimmed;
  return `${trimmed.slice(0, limit)}\n\n[...trimmed for offline report preview...]`;
}

export function defaultSocArtifactReportTitle(type: SocArtifactReportType): string {
  const option = SOC_ARTIFACT_REPORT_TYPES.find(item => item.id === type);
  return option ? `${SOC_APP_NAME} — ${option.label}` : 'SOC report';
}

function formatWorkspaceContext(workspaceInput: SocWorkspaceInput): string {
  return [
    `- Alert summary: ${clean(workspaceInput.alertSummary)}`,
    `- Severity/current priority: ${clean(workspaceInput.severity)}`,
    `- Source IP: ${clean(workspaceInput.sourceIp)}`,
    `- Destination IP: ${clean(workspaceInput.destinationIp)}`,
    `- Username/account: ${clean(workspaceInput.username)}`,
    `- Asset/device: ${clean(workspaceInput.asset)}`,
    `- Rule/playbook/parser notes: ${clean(workspaceInput.notes)}`,
  ].join('\n');
}

function formatKnowledgeMetadata(resources: SocKnowledgeResource[]): string {
  if (!resources.length) return '- No selected offline knowledge metadata references.';
  return resources.slice(0, 10).map((resource, index) => {
    const tags = resource.tags.length ? resource.tags.join(', ') : 'none';
    return [
      `${index + 1}. **${resource.title}**`,
      `   - Category: ${resource.category}`,
      `   - Product: ${resource.product}`,
      `   - Version: ${resource.version || 'not specified'}`,
      `   - Tags: ${tags}`,
      `   - File path: ${resource.filePath}`,
      `   - Index status: ${resource.indexStatus || 'not_indexed'} (${resource.indexedChunkCount || 0} chunks)`,
      `   - Notes: ${resource.notes || 'none'}`,
    ].join('\n');
  }).join('\n');
}

function reportSpecificTemplate(type: SocArtifactReportType): string {
  switch (type) {
    case 'triage_report':
      return [
        '## Triage Decision',
        '- Verdict: true positive / false positive / needs more evidence',
        '- Confidence: low / medium / high',
        '- Severity recommendation:',
        '- Primary reason:',
        '',
        '## Response Recommendation',
        '- Recommended next action:',
        '- Approval required before response: yes',
        '- Rollback / verification note:',
      ].join('\n');
    case 'investigation_plan':
      return [
        '## Investigation Workflow',
        '1. Confirm alert scope and affected identities/assets.',
        '2. Reconstruct event timeline in FortiSIEM exports/logs.',
        '3. Extract and enrich IOCs locally where available.',
        '4. Compare against internal SOPs and selected offline references.',
        '5. Decide: close / monitor / escalate / contain with approval.',
        '',
        '## Evidence Gaps',
        '- Missing logs:',
        '- Missing asset/user context:',
        '- Missing FortiSOAR enrichment output:',
      ].join('\n');
    case 'fortisiem_rule_draft':
      return [
        '## FortiSIEM Detection Draft',
        '- Detection goal:',
        '- Required event types:',
        '- Required fields:',
        '- Correlation logic:',
        '- Time window / threshold:',
        '- Severity mapping:',
        '- False-positive tuning:',
        '',
        '## Test Cases',
        '- Matching sample:',
        '- Non-matching sample:',
        '- Edge case:',
      ].join('\n');
    case 'fortisiem_parser_draft':
      return [
        '## FortiSIEM Parser Draft',
        '- Log source/type:',
        '- Event recognizer idea:',
        '- Field extraction plan:',
        '- Attribute mapping:',
        '- Parser ordering/conflict risks:',
        '',
        '## Validation Checklist',
        '- XML syntax checked:',
        '- Sample logs tested:',
        '- Missing fields:',
        '- Human import approval:',
      ].join('\n');
    case 'fortisoar_playbook_draft':
      return [
        '## FortiSOAR Playbook Draft',
        '- Purpose:',
        '- Trigger:',
        '- Required inputs:',
        '- Enrichment steps:',
        '- Decision points:',
        '- Human approval gates:',
        '- Response/containment options:',
        '- Notifications/escalation:',
      ].join('\n');
    case 'connector_spec':
      return [
        '## Connector Requirement / Specification',
        '- Connector purpose:',
        '- Authentication/configuration:',
        '- Actions/operations:',
        '- Inputs:',
        '- Outputs:',
        '- Error handling:',
        '- Security considerations:',
        '- Test cases:',
      ].join('\n');
    case 'knowledge_context_summary':
      return [
        '## Offline Knowledge Summary',
        '- Selected resources should be reviewed by product/version before use.',
        '- Retrieved snippets come from the indexed company Knowledge Chat collection (hybrid lexical/dense retrieval).',
        '- Use this section as analyst context, not as a final answer without review.',
      ].join('\n');
    case 'validator_report_summary':
      return [
        '## Validator Summary',
        '- Syntax readiness:',
        '- Review warnings:',
        '- Unsafe-action approval findings:',
        '- Required fixes before production:',
      ].join('\n');
  }
}

function formatKcRetrievedHits(hits: KcSearchHit[]): string {
  if (!hits.length) return 'No auto-retrieved company knowledge snippets.';
  return hits.slice(0, 8).map(hit => [
    `### ${formatSourceCitation(hit)}`,
    `- Score: ${hit.fused_score.toFixed(2)}`,
    '',
    hit.chunk.text.trim().slice(0, 1200),
  ].join('\n')).join('\n\n');
}

export function buildSocGroundedReportSystemPrompt(reportType: SocArtifactReportType): string {
  const option = SOC_ARTIFACT_REPORT_TYPES.find(item => item.id === reportType);
  return [
    SOC_SYSTEM_PROMPT,
    `You are drafting a ${option?.label || reportType} for offline analyst review.`,
    'Use RETRIEVED SOURCES from the company knowledge index when they support severity, escalation, SOP, or response guidance.',
    'Cite source file names in the report body when company policy evidence is used.',
    'Keep production response actions behind human approval. Do not claim live FortiSIEM/FortiSOAR integration.',
    'Output complete Markdown suitable for export. Preserve section headings from the template when possible.',
  ].join('\n');
}

export function buildSocGroundedReportUserPrompt(input: {
  reportTitle: string;
  reportType: SocArtifactReportType;
  templateMarkdown: string;
  workspaceInput: SocWorkspaceInput;
  contextBlock: string;
}): string {
  return [
    `Report title: ${input.reportTitle}`,
    `Report type: ${input.reportType}`,
    '',
    'INCIDENT / WORKSPACE CONTEXT:',
    formatWorkspaceContext(input.workspaceInput),
    '',
    'RAW EVIDENCE / LOGS:',
    input.workspaceInput.rawLogs.trim() || 'Not provided',
    '',
    'COMPANY KNOWLEDGE INDEX:',
    input.contextBlock,
    '',
    'REPORT TEMPLATE / STRUCTURE TO COMPLETE:',
    input.templateMarkdown,
    '',
    'Task: Produce a complete grounded Markdown report. Fill template sections with incident facts and company SOP evidence where available. Mark assumptions and evidence gaps clearly.',
  ].join('\n');
}

export function buildSocArtifactReport(
  reportInput: SocArtifactReportInput,
  workspaceInput: SocWorkspaceInput,
  resources: SocKnowledgeResource[],
  chunks: SocKnowledgeChunk[],
  generatedPrompt: string,
  autoRetrievedHits: KcSearchHit[] = [],
): string {
  const reportType = SOC_ARTIFACT_REPORT_TYPES.find(item => item.id === reportInput.reportType);
  const title = clean(reportInput.reportTitle, defaultSocArtifactReportTitle(reportInput.reportType));
  const generatedAt = new Date().toLocaleString();
  const snippetContext = chunks.length ? buildSocRetrievedSnippetContext(chunks.slice(0, 6)) : '';

  return [
    `# ${title}`,
    '',
    `**Artifact type:** ${reportType?.label || reportInput.reportType}`,
    `**Generated by:** ${SOC_APP_NAME}`,
    `**Generated at:** ${generatedAt}`,
    `**Status:** Local draft. Uses your indexed files only — not connected to FortiSIEM or FortiSOAR live APIs.`,
    '',
    '> AI-assisted SOC artifacts require analyst review and human approval before any production response action.',
    '',
    '## Scope / Environment',
    clean(reportInput.scope),
    '',
    '## Severity / Verdict',
    clean(reportInput.severityVerdict),
    '',
    '## Workspace Context',
    formatWorkspaceContext(workspaceInput),
    '',
    '## Raw Evidence / Logs',
    fenced(trimBlock(workspaceInput.rawLogs, 3500), 'text'),
    '',
    '## Evidence Summary',
    bulletLines(reportInput.evidenceSummary || workspaceInput.alertSummary),
    '',
    '## Assumptions',
    bulletLines(reportInput.assumptions),
    '',
    '## Recommendations',
    bulletLines(reportInput.recommendations),
    '',
    reportSpecificTemplate(reportInput.reportType),
    '',
    '## Selected Offline Knowledge Metadata',
    formatKnowledgeMetadata(resources),
    '',
    '## Auto-Retrieved Company Knowledge (Knowledge Chat index)',
    autoRetrievedHits.length ? formatKcRetrievedHits(autoRetrievedHits) : 'No auto-retrieved snippets for this report context.',
    '',
    '## Selected Manual Retrieval Snippets',
    snippetContext ? fenced(trimBlock(snippetContext, 5000), 'text') : 'No manually selected retrieval snippets.',
    '',
    '## Validator Report / Engineering Checks',
    reportInput.validatorReport.trim() ? fenced(trimBlock(reportInput.validatorReport, 5000), 'text') : 'No validator report pasted into this artifact.',
    '',
    '## Analyst / Company Notes',
    clean(reportInput.analystNotes),
    '',
    '## Human Approval / Safety Notes',
    bulletLines(reportInput.safetyNotes || SOC_HUMAN_APPROVAL_NOTICE),
    '',
    '## Related SOC Prompt Preview',
    generatedPrompt.trim() ? fenced(trimBlock(generatedPrompt, 3500), 'text') : 'No generated SOC prompt available.',
    '',
    '---',
    `Disclaimer: ${SOC_ARTIFACT_DISCLAIMER}`,
  ].join('\n');
}
