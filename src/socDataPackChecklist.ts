import type { SocCompanyDataScanFile, SocCompanyDataType, SocDataPackChecklistItem, SocDataPackChecklistStatus, SocKnowledgeResource } from './types';
import { flattenSocChunks, isSocIndexableTextPath } from './socKnowledgeIndex';

const CHECKLIST_ID_BY_DATA_TYPE: Partial<Record<SocCompanyDataType, string>> = {
  rule: 'fortisiem-rules',
  parser: 'fortisiem-parsers',
  raw_log: 'raw-logs',
  alert_incident: 'alerts-incidents',
  true_positive: 'true-positive-examples',
  false_positive: 'false-positive-examples',
  sop_policy: 'soc-sops',
  severity_escalation: 'severity-escalation',
  response_approval: 'response-approval',
  connector_inventory: 'connector-inventory',
  playbook: 'fortisoar-playbooks',
  expected_output: 'expected-output-templates',
};

export function applyCompanyScanToChecklist(
  checklist: SocDataPackChecklistItem[],
  files: SocCompanyDataScanFile[],
  targetStatus: SocDataPackChecklistStatus = 'sanitized',
): SocDataPackChecklistItem[] {
  const merged = mergeSocDataPackChecklist(checklist);
  const foundTypes = new Set(
    files.filter(file => file.supported && file.dataType !== 'other').map(file => file.dataType),
  );
  if (!foundTypes.size) return merged;

  const timestamp = Math.floor(Date.now() / 1000);
  const autoNote = `Auto-updated from company intake scan on ${new Date().toLocaleDateString()}.`;

  return merged.map(item => {
    const matchedType = (Object.entries(CHECKLIST_ID_BY_DATA_TYPE) as Array<[SocCompanyDataType, string]>)
      .find(([, checklistId]) => checklistId === item.id)?.[0];
    if (!matchedType || !foundTypes.has(matchedType)) return item;
    if (isStatusAtLeast(item.status, targetStatus)) return item;
    return {
      ...item,
      status: targetStatus,
      updatedAt: timestamp,
      notes: item.notes?.trim() ? item.notes : autoNote,
    };
  });
}


export const SOC_DATA_PACK_STATUS_LABELS: Record<SocDataPackChecklistStatus, string> = {
  missing: 'Not received',
  not_received: 'Not received',
  received: 'Received',
  sanitized: 'Sanitized',
  imported: 'Imported',
  indexed: 'Indexed',
  tested: 'Tested',
};

export const SOC_DATA_PACK_STATUS_ORDER: SocDataPackChecklistStatus[] = [
  'not_received',
  'received',
  'sanitized',
  'imported',
  'indexed',
  'tested',
];

function statusRank(status: SocDataPackChecklistStatus): number {
  if (status === 'missing') return 0;
  return SOC_DATA_PACK_STATUS_ORDER.indexOf(status);
}

export function normalizeSocDataPackStatus(status?: SocDataPackChecklistStatus): SocDataPackChecklistStatus {
  return status === 'missing' || !status ? 'not_received' : status;
}

export function isStatusAtLeast(status: SocDataPackChecklistStatus | undefined, threshold: SocDataPackChecklistStatus): boolean {
  return statusRank(normalizeSocDataPackStatus(status)) >= statusRank(threshold);
}

export function getCompanyIntakeReadinessStats(items: SocDataPackChecklistItem[]) {
  const checklist = mergeSocDataPackChecklist(items);
  const required = checklist.filter(item => item.priority === 'required');
  const requiredMissing = required.filter(item => !isStatusAtLeast(item.status, 'received')).length;
  const receivedOrBetter = checklist.filter(item => isStatusAtLeast(item.status, 'received')).length;
  const sanitizedOrBetter = checklist.filter(item => isStatusAtLeast(item.status, 'sanitized')).length;
  const importedOrBetter = checklist.filter(item => isStatusAtLeast(item.status, 'imported')).length;
  const indexedOrBetter = checklist.filter(item => isStatusAtLeast(item.status, 'indexed')).length;
  const tested = checklist.filter(item => isStatusAtLeast(item.status, 'tested')).length;
  const readinessPercent = checklist.length ? Math.round(((receivedOrBetter * 1) + (sanitizedOrBetter * 1.25) + (importedOrBetter * 1.5) + (indexedOrBetter * 1.75) + (tested * 2)) / (checklist.length * 7.5) * 100) : 0;
  let nextRecommendedAction = 'Request the first sanitized company data pack.';
  if (receivedOrBetter > 0 && sanitizedOrBetter === 0) nextRecommendedAction = 'Move received examples into sanitized/import-ready folders before indexing.';
  else if (sanitizedOrBetter > 0 && importedOrBetter === 0) nextRecommendedAction = 'Scan the sanitized intake folder and import supported files into the knowledge base.';
  else if (importedOrBetter > 0 && indexedOrBetter === 0) nextRecommendedAction = 'Index imported text files and build RAG context from source-backed chunks.';
  else if (indexedOrBetter > 0 && tested === 0) nextRecommendedAction = 'Run validators and create evaluation cases for the imported examples.';
  else if (tested > 0) nextRecommendedAction = 'Prepare a company-specific walkthrough and evaluation report.';

  return {
    totalChecklistItems: checklist.length,
    receivedOrBetter,
    sanitizedOrBetter,
    importedOrBetter,
    indexedOrBetter,
    tested,
    requiredMissing,
    readinessPercent: Math.min(100, Math.max(0, readinessPercent)),
    nextRecommendedAction,
  };
}

export const SOC_DATA_PACK_DEFAULT_CHECKLIST: SocDataPackChecklistItem[] = [
  {
    id: 'fortisiem-rules',
    label: 'FortiSIEM rules',
    description: 'Custom/tuned detection rules with severity, thresholds, time windows, MITRE mapping, and tuning notes.',
    priority: 'required',
    status: 'not_received',
  },
  {
    id: 'fortisiem-parsers',
    label: 'FortiSIEM parsers',
    description: 'Parser XML examples with recognizers, extraction regexes, field mappings, and parser naming conventions.',
    priority: 'required',
    status: 'not_received',
  },
  {
    id: 'raw-logs',
    label: 'Raw log samples',
    description: 'Sanitized FortiGate/VPN, Windows/AD, EDR, email, proxy/DNS, cloud, and other common log samples.',
    priority: 'required',
    status: 'not_received',
  },
  {
    id: 'alerts-incidents',
    label: 'Sample alerts/incidents',
    description: 'Sanitized FortiSIEM alerts or incident records with affected entities, evidence, response, and closure notes.',
    priority: 'required',
    status: 'not_received',
  },
  {
    id: 'true-positive-examples',
    label: 'True-positive examples',
    description: 'Confirmed malicious/suspicious cases with the evidence that proved the verdict.',
    priority: 'recommended',
    status: 'not_received',
  },
  {
    id: 'false-positive-examples',
    label: 'False-positive examples',
    description: 'Benign/noisy cases with analyst explanation, exceptions, and tuning recommendations.',
    priority: 'recommended',
    status: 'not_received',
  },
  {
    id: 'soc-sops',
    label: 'SOC SOPs',
    description: 'Sanitized L1/L2/L3 triage, investigation, escalation, closure, and handoff procedures.',
    priority: 'required',
    status: 'not_received',
  },
  {
    id: 'severity-escalation',
    label: 'Severity / escalation policy',
    description: 'Severity definitions, escalation triggers, SLA/SLO targets, and customer/internal notification rules.',
    priority: 'required',
    status: 'not_received',
  },
  {
    id: 'response-approval',
    label: 'Response approval policy',
    description: 'Which actions L2/L3 can perform, which require approval, and how rollback/verification is recorded.',
    priority: 'required',
    status: 'not_received',
  },
  {
    id: 'connector-inventory',
    label: 'Connector inventory',
    description: 'Connector names, capabilities, action types, read-only vs response actions, and playbook usage without secrets.',
    priority: 'recommended',
    status: 'not_received',
  },
  {
    id: 'fortisoar-playbooks',
    label: 'Additional FortiSOAR playbooks',
    description: 'Exports for phishing, brute-force, malware, enrichment, notification, containment, and case workflows.',
    priority: 'recommended',
    status: 'not_received',
  },
  {
    id: 'expected-output-templates',
    label: 'Expected output / report templates',
    description: 'Preferred report, parser, playbook, connector, case-summary, and handoff formats for the final product.',
    priority: 'recommended',
    status: 'not_received',
  },
];

export function mergeSocDataPackChecklist(items?: SocDataPackChecklistItem[]): SocDataPackChecklistItem[] {
  const existing = new Map((items || []).map(item => [item.id, item]));
  return SOC_DATA_PACK_DEFAULT_CHECKLIST.map(defaultItem => {
    const current = existing.get(defaultItem.id);
    return {
      ...defaultItem,
      ...(current || {}),
      status: normalizeSocDataPackStatus(current?.status || defaultItem.status),
    };
  });
}

export function socChecklistProgress(items: SocDataPackChecklistItem[]) {
  const merged = mergeSocDataPackChecklist(items);
  const received = merged.filter(item => isStatusAtLeast(item.status, 'received')).length;
  const required = merged.filter(item => item.priority === 'required');
  const requiredReceived = required.filter(item => isStatusAtLeast(item.status, 'received')).length;
  return {
    total: merged.length,
    received,
    missing: merged.length - received,
    required: required.length,
    requiredReceived,
    requiredMissing: required.length - requiredReceived,
    percent: merged.length ? Math.round((received / merged.length) * 100) : 0,
  };
}

export function buildSocDataPackChecklistMarkdown(items: SocDataPackChecklistItem[]): string {
  const merged = mergeSocDataPackChecklist(items);
  const readiness = getCompanyIntakeReadinessStats(merged);
  return [
    '# Company data pack checklist',
    '',
    `Generated: ${new Date().toLocaleString()}`,
    '',
    '## Company-Specific Readiness',
    `- Readiness: ${readiness.readinessPercent}%`,
    `- Received or better: ${readiness.receivedOrBetter}/${readiness.totalChecklistItems}`,
    `- Sanitized or better: ${readiness.sanitizedOrBetter}/${readiness.totalChecklistItems}`,
    `- Imported or better: ${readiness.importedOrBetter}/${readiness.totalChecklistItems}`,
    `- Indexed or better: ${readiness.indexedOrBetter}/${readiness.totalChecklistItems}`,
    `- Tested: ${readiness.tested}/${readiness.totalChecklistItems}`,
    `- Required categories missing: ${readiness.requiredMissing}`,
    `- Next recommended action: ${readiness.nextRecommendedAction}`,
    '',
    '## Items',
    ...merged.map(item => [
      `### ${isStatusAtLeast(item.status, 'received') ? '[x]' : '[ ]'} ${item.label}`,
      `- Priority: ${item.priority}`,
      `- Status: ${SOC_DATA_PACK_STATUS_LABELS[item.status]}`,
      `- Purpose: ${item.description}`,
      `- Notes: ${item.notes?.trim() || 'none'}`,
    ].join('\n')),
    '',
    '## Safety note',
    'Do not include passwords, API keys, customer secrets, or sensitive unsanitized data. Sanitized operational examples are enough for product tailoring.',
    'Keep original received files separate from sanitized/import-ready files. This workflow is local-only and does not require cloud upload.',
  ].join('\n');
}

export function buildSocKnowledgePackSummaryMarkdown(resources: SocKnowledgeResource[], checklist: SocDataPackChecklistItem[]): string {
  const indexed = resources.filter(resource => resource.indexStatus === 'indexed' || resource.indexStatus === 'warning');
  const failed = resources.filter(resource => resource.indexStatus === 'error');
  const unindexed = resources.filter(resource => !resource.indexStatus || resource.indexStatus === 'not_indexed');
  const metadataOnly = resources.filter(resource => !isSocIndexableTextPath(resource.filePath));
  const chunks = flattenSocChunks(resources);
  const denseChunks = chunks.filter(chunk => Array.isArray(chunk.denseVector) && chunk.denseVector.length > 0);
  const productBreakdown = countBy(resources.map(resource => resource.product || 'Other'));
  const versionBreakdown = countBy(resources.map(resource => resource.version || 'not specified'));
  const categoryBreakdown = countBy(resources.map(resource => resource.category || 'Other'));
  const readiness = getCompanyIntakeReadinessStats(checklist);

  return [
    '# Knowledge pack summary',
    '',
    `Generated: ${new Date().toLocaleString()}`,
    'Product: Nexus AI — Fortinet SOC Copilot',
    '',
    '## Knowledge Pack Health',
    `- Registered resources: ${resources.length}`,
    `- Indexed resources: ${indexed.length}`,
    `- Unindexed resources: ${unindexed.length}`,
    `- Failed index resources: ${failed.length}`,
    `- Metadata-only / unsupported for text index: ${metadataOnly.length}`,
    `- Indexed chunks: ${chunks.length}`,
    `- Dense-vectorized chunks: ${denseChunks.length}`,
    '',
    '## Product Breakdown',
    ...formatCountBlock(productBreakdown),
    '',
    '## Version Breakdown',
    ...formatCountBlock(versionBreakdown),
    '',
    '## Category Breakdown',
    ...formatCountBlock(categoryBreakdown),
    '',
    '## Company Data Pack Intake',
    `- Company-specific readiness: ${readiness.readinessPercent}%`,
    `- Received or better: ${readiness.receivedOrBetter}/${readiness.totalChecklistItems}`,
    `- Sanitized or better: ${readiness.sanitizedOrBetter}/${readiness.totalChecklistItems}`,
    `- Imported or better: ${readiness.importedOrBetter}/${readiness.totalChecklistItems}`,
    `- Indexed or better: ${readiness.indexedOrBetter}/${readiness.totalChecklistItems}`,
    `- Tested: ${readiness.tested}/${readiness.totalChecklistItems}`,
    `- Required categories missing: ${readiness.requiredMissing}`,
    ...mergeSocDataPackChecklist(checklist)
      .filter(item => !isStatusAtLeast(item.status, 'received'))
      .map(item => `- Missing ${item.priority}: ${item.label}`),
    '',
    '## Next Recommended Actions',
    '- Register/import sanitized company rules, parsers, playbooks, logs, incidents, SOPs, and connector inventory when received.',
    '- Index safe text resources locally and use selected snippets in SOC Workspace prompts.',
    '- Build dense vectors in small batches when the configured local embedding model can handle the selected chunk sizes.',
    '- Use Compact or Full Chat handoff based on the analyst review depth needed.',
    '- Preserve human approval before production response actions.',
    '',
    '## Scope Notes',
    '- Runs locally; no live FortiSIEM/FortiSOAR API connection.',
    '- Retrieval supports keyword, hybrid lexical RAG, and local dense RAG when real dense vectors are generated.',
    '- Safe local exports only.',
  ].join('\n');
}

function countBy(values: string[]): Record<string, number> {
  return values.reduce<Record<string, number>>((acc, value) => {
    const key = value || 'not specified';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

function formatCountBlock(values: Record<string, number>): string[] {
  const entries = Object.entries(values).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (!entries.length) return ['- none'];
  return entries.map(([label, count]) => `- ${label}: ${count}`);
}
