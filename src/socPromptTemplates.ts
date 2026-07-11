import type { SocKnowledgeChunk, SocKnowledgeResource } from './types';
import { buildSocRetrievedSnippetContext } from './socKnowledgeIndex';
import { SOC_HUMAN_APPROVAL_NOTICE, SOC_SYSTEM_PROMPT } from './socChatHandoff';

export type SocPromptKind =
  | 'triage'
  | 'investigation'
  | 'rule'
  | 'parser'
  | 'playbook'
  | 'connector'
  | 'knowledge';

export interface SocWorkspaceInput {
  alertSummary: string;
  rawLogs: string;
  sourceIp: string;
  destinationIp: string;
  username: string;
  asset: string;
  severity: string;
  notes: string;
}

export interface SocPromptAction {
  id: SocPromptKind;
  label: string;
  shortLabel: string;
  description: string;
}

export { SOC_HUMAN_APPROVAL_NOTICE, SOC_SYSTEM_PROMPT } from './socChatHandoff';

export const SOC_PROMPT_ACTIONS: SocPromptAction[] = [
  {
    id: 'triage',
    label: 'Triage Alert',
    shortLabel: 'Triage',
    description: 'Classify the alert, summarize evidence, estimate severity, and recommend safe next steps.',
  },
  {
    id: 'investigation',
    label: 'Generate Investigation Plan',
    shortLabel: 'Investigation Plan',
    description: 'Create a step-by-step L3 investigation checklist for Fortinet SOC analysts.',
  },
  {
    id: 'rule',
    label: 'Draft FortiSIEM Rule',
    shortLabel: 'SIEM Rule',
    description: 'Draft rule logic, fields, correlation window, false-positive notes, and test cases.',
  },
  {
    id: 'parser',
    label: 'Draft FortiSIEM Parser',
    shortLabel: 'SIEM Parser',
    description: 'Analyze sample logs and draft parser mapping/recognizer guidance for FortiSIEM.',
  },
  {
    id: 'playbook',
    label: 'Draft FortiSOAR Playbook',
    shortLabel: 'SOAR Playbook',
    description: 'Draft a human-approved FortiSOAR playbook workflow with decision points.',
  },
  {
    id: 'connector',
    label: 'Analyze Connector Requirement',
    shortLabel: 'Connector',
    description: 'Turn connector requirements into actions, inputs, outputs, and validation notes.',
  },
  {
    id: 'knowledge',
    label: 'Search Offline Knowledge',
    shortLabel: 'Knowledge Search',
    description: 'Prepare a grounded offline knowledge-base query for Fortinet/company documents.',
  },
];

function clean(value: string): string {
  const trimmed = value.trim();
  return trimmed || 'Not provided';
}

function truncateField(value: string, max: number): string {
  const trimmed = value.trim();
  if (!trimmed) return 'Not provided';
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}\n[...truncated for prompt budget — use Copy Prompt for full content...]`;
}

function baseContext(input: SocWorkspaceInput): string {
  return [
    `Alert summary: ${clean(input.alertSummary)}`,
    `Severity/current priority: ${clean(input.severity)}`,
    `Source IP: ${clean(input.sourceIp)}`,
    `Destination IP: ${clean(input.destinationIp)}`,
    `Username/account: ${clean(input.username)}`,
    `Asset/device: ${clean(input.asset)}`,
    `Rule/playbook/parser notes: ${clean(input.notes)}`,
    'Raw logs / evidence:',
    truncateField(input.rawLogs, 6000),
  ].join('\n');
}

function contextWithKnowledge(input: SocWorkspaceInput, knowledgeContext?: string): string {
  const context = baseContext(input);
  const selectedKnowledge = (knowledgeContext || '').trim();
  if (!selectedKnowledge) return context;

  return [
    context,
    '',
    selectedKnowledge,
    '',
    'Important: AUTO-RETRIEVED COMPANY KNOWLEDGE comes from the indexed Knowledge Chat collection (hybrid lexical/dense search). Manual selections are supplementary. Cite source file names/sections from retrieved snippets. Note gaps when company evidence is missing.',
  ].join('\n');
}

const header = SOC_SYSTEM_PROMPT;


export function buildSocKnowledgeContext(resources: SocKnowledgeResource[], retrievedChunks: SocKnowledgeChunk[] = []): string {
  const sections: string[] = [];

  if (resources.length) {
    sections.push([
      'SELECTED OFFLINE KNOWLEDGE REFERENCES:',
      resources.slice(0, 8).map((resource, index) => {
        const tags = resource.tags.length ? resource.tags.join(', ') : 'none';
        return [
          `Resource ${index + 1}: ${resource.title}`,
          `Category: ${resource.category}`,
          `Product: ${resource.product}`,
          `Version: ${resource.version || 'not specified'}`,
          `Tags: ${tags}`,
          `File path: ${resource.filePath}`,
          `Index status: ${resource.indexStatus || 'not_indexed'}`,
          resource.indexStatus !== 'indexed' && resource.indexStatus !== 'warning'
            ? 'Content note: metadata only — file text was not indexed; do not invent content from this path alone.'
            : '',
          `Indexed chunks: ${resource.indexedChunkCount || 0}`,
          `Notes: ${resource.notes || 'none'}`,
        ].join('\n');
      }).join('\n\n'),
    ].join('\n'));
  }

  if (retrievedChunks.length) {
    sections.push([
      'SELECTED BASIC LOCAL RETRIEVAL SNIPPETS:',
      buildSocRetrievedSnippetContext(retrievedChunks),
    ].join('\n'));
  }

  return sections.join('\n\n');
}

export function buildSocPrompt(kind: SocPromptKind, input: SocWorkspaceInput, knowledgeContext?: string): string {
  const context = contextWithKnowledge(input, knowledgeContext);

  switch (kind) {
    case 'triage':
      return `${header}\n\nTASK: Perform Fortinet SOC L3 alert triage.\n\nINPUT CONTEXT:\n${context}\n\nOUTPUT FORMAT:\n1. Executive verdict: true positive / false positive / needs more evidence\n2. Confidence: low / medium / high\n3. Severity recommendation and reasoning\n4. Evidence found\n5. Missing evidence\n6. Likely attack path or benign explanation\n7. FortiSIEM investigation queries or filters to try\n8. Suggested FortiSOAR enrichment/response playbook\n9. Safe response recommendation with human approval gate\n10. Escalation note for L3/R&D team`;

    case 'investigation':
      return `${header}\n\nTASK: Generate a Fortinet SOC L3 investigation plan.\n\nINPUT CONTEXT:\n${context}\n\nOUTPUT FORMAT:\n1. Investigation objective\n2. Hypotheses to test\n3. FortiSIEM data sources to check\n4. Timeline reconstruction steps\n5. IOC extraction checklist\n6. Enrichment steps suitable for FortiSOAR\n7. Decision tree: close / monitor / escalate / contain\n8. Evidence to preserve\n9. Analyst handoff notes\n10. Human approval points before response actions`;

    case 'rule':
      return `${header}\n\nTASK: Draft a FortiSIEM detection rule concept.\n\nINPUT CONTEXT:\n${context}\n\nOUTPUT FORMAT:\n1. Detection goal\n2. Required event types and fields\n3. Correlation logic\n4. Suggested time window and threshold\n5. Severity mapping\n6. MITRE ATT&CK mapping if applicable\n7. False-positive risks\n8. Tuning recommendations\n9. Test cases with sample matching/non-matching events\n10. Deployment notes and human review checklist\n\nImportant: If exact FortiSIEM import syntax is not available from provided docs, produce a safe draft/pseudocode instead of pretending it is production-ready.`;

    case 'parser':
      return `${header}\n\nTASK: Draft FortiSIEM parser guidance for the provided logs.\n\nINPUT CONTEXT:\n${context}\n\nOUTPUT FORMAT:\n1. Detected log source/type\n2. Event recognizer idea\n3. Field extraction plan\n4. Suggested FortiSIEM event attribute mapping\n5. Parser XML draft or pseudocode draft\n6. Regex/parsing notes\n7. Test against provided sample log lines\n8. Edge cases and malformed log handling\n9. Parser ordering/conflict risks\n10. Human validation checklist before import`;

    case 'playbook':
      return `${header}\n\nTASK: Draft a FortiSOAR playbook workflow.\n\nINPUT CONTEXT:\n${context}\n\nOUTPUT FORMAT:\n1. Playbook purpose\n2. Trigger and required inputs\n3. Enrichment steps\n4. Connector/action requirements\n5. Decision points\n6. Human approval checkpoints\n7. Containment/response options with safety notes\n8. Notification/escalation steps\n9. Output artifacts/tags/status updates\n10. Testing checklist before production use`;

    case 'connector':
      return `${header}\n\nTASK: Analyze a FortiSOAR connector requirement.\n\nINPUT CONTEXT:\n${context}\n\nOUTPUT FORMAT:\n1. Connector purpose\n2. Required authentication/configuration fields\n3. Needed actions/operations\n4. Inputs and outputs for each action\n5. Error handling and retry guidance\n6. Security considerations\n7. How this connector supports playbooks\n8. Offline documentation/data needed from the company\n9. Test cases\n10. Human review checklist`;

    case 'knowledge':
      return `${header}\n\nTASK: Answer using the selected offline Fortinet/company knowledge references and retrieved snippets when available.\n\nINPUT CONTEXT:\n${context}\n\nOUTPUT FORMAT:\n1. Direct answer grounded in selected snippets (cite source titles/paths)\n2. Confidence: low / medium / high\n3. Supporting evidence from indexed snippets\n4. Gaps or missing documents\n5. Recommended follow-up searches or imports\n6. FortiSIEM / FortiSOAR implications if relevant\n7. Human approval or escalation notes if response actions are implied\n8. Suggested next analyst steps`;

    default:
      return `${header}\n\nTASK: Perform Fortinet SOC L3 alert triage.\n\nINPUT CONTEXT:\n${context}\n\nOUTPUT FORMAT:\n1. Executive verdict: true positive / false positive / needs more evidence\n2. Confidence: low / medium / high\n3. Severity recommendation and reasoning\n4. Evidence found\n5. Missing evidence\n6. Likely attack path or benign explanation\n7. FortiSIEM investigation queries or filters to try\n8. Suggested FortiSOAR enrichment/response playbook\n9. Safe response recommendation with human approval gate\n10. Escalation note for L3/R&D team`;
  }
}
