import type {
  SocCompanyDataScanFile,
  SocCompanyDataType,
  SocDataPackChecklistItem,
  SocKnowledgeCategory,
  SocKnowledgeProduct,
  SocKnowledgeResource,
  SocKnowledgeScanFile,
} from './types';
import { flattenSocChunks, isSocIndexableTextPath, normalizeSocPath } from './socKnowledgeIndex';
import { mergeSocDataPackChecklist, getCompanyIntakeReadinessStats, isStatusAtLeast } from './socDataPackChecklist';

export const SOC_COMPANY_INTAKE_SUBDIR = 'intake';

/** @deprecated Use deployment config soc intake root instead */
export const SOC_COMPANY_INTAKE_ROOT = '';

export function resolveSocIntakeRoot(config?: { socDataRoot: string; socIntakeSubdir: string }): string {
  if (!config?.socDataRoot) return '';
  const base = config.socDataRoot.replace(/[\\/]+$/, '');
  const sub = (config.socIntakeSubdir || SOC_COMPANY_INTAKE_SUBDIR).replace(/^[\\/]+/, '');
  return `${base}\\${sub}`;
}

export const SOC_COMPANY_INTAKE_FOLDERS = [
  { folder: '00_received_original_keep_safe', label: 'Original received files', purpose: 'Keep the original received material unchanged and separated for chain-of-custody/reference.' },
  { folder: '01_sanitized_rules', label: 'Sanitized FortiSIEM rules', purpose: 'Custom/tuned rules ready for offline import.' },
  { folder: '02_sanitized_parsers', label: 'Sanitized parser XML', purpose: 'FortiSIEM parser XML plus matching safe notes.' },
  { folder: '03_sanitized_raw_logs', label: 'Sanitized raw logs', purpose: 'Representative raw logs for parser and triage testing.' },
  { folder: '04_sanitized_alerts_incidents', label: 'Sanitized alerts/incidents', purpose: 'Alert/incident records with analyst verdicts.' },
  { folder: '05_true_positive_examples', label: 'True-positive examples', purpose: 'Confirmed malicious/suspicious examples for decision tuning.' },
  { folder: '06_false_positive_examples', label: 'False-positive examples', purpose: 'Benign/noisy examples for tuning and exception guidance.' },
  { folder: '07_soc_sops_policies', label: 'SOC SOPs and policies', purpose: 'Severity, escalation, approval, closure, and handoff guidance.' },
  { folder: '08_connector_inventory', label: 'Connector inventory', purpose: 'Connector capabilities without credentials or secrets.' },
  { folder: '09_fortisoar_playbooks', label: 'FortiSOAR playbooks', purpose: 'Exported playbooks and automation workflow references.' },
  { folder: '10_expected_outputs', label: 'Expected output templates', purpose: 'Preferred report, parser, playbook, and case-summary formats.' },
  { folder: '11_import_ready', label: 'Import-ready bundle', purpose: 'Final sanitized files ready to scan/register/index in the app.' },
  { folder: '12_import_reports', label: 'Import reports', purpose: 'Local export destination for intake summaries and readiness reports.' },
];


export function isAllowedCompanyIntakePath(value: string, config?: { dataRoot: string; socDataRoot: string }): boolean {
  const normalized = normalizeSocPath(value).toLowerCase();
  if (!normalized) return false;
  if (config) {
    const roots = [config.dataRoot, config.socDataRoot].map(r => normalizeSocPath(r).toLowerCase()).filter(Boolean);
    return roots.some(root => normalized === root || normalized.startsWith(`${root}\\`) || normalized.startsWith(`${root}/`));
  }
  return normalized.length > 2;
}

function inferVersion(lower: string): string {
  const match = lower.match(/7[._-]?(4|5|6)(?:[._-]?\d+)?|7\.(4|5|6)(?:\.\d+)?/);
  return match ? match[0].replace(/_/g, '.').replace(/-/g, '.') : '';
}

export function classifyCompanyDataFile(filePath: string): Omit<SocCompanyDataScanFile, keyof SocKnowledgeScanFile> {
  const normalized = normalizeSocPath(filePath);
  const lower = normalized.toLowerCase();
  const tokens = lower.replace(/[^a-z0-9]+/g, ' ');
  let dataType: SocCompanyDataType = 'other';

  if (/true positive|true_positive|\btp\b|confirmed/.test(lower)) dataType = 'true_positive';
  else if (/false positive|false_positive|\bfp\b|benign|noisy/.test(lower)) dataType = 'false_positive';
  else if (/parser|recognizer|field mapping|field_mapping/.test(lower)) dataType = 'parser';
  else if (/rule|correlation|detection|threshold|use case|use_case/.test(lower)) dataType = 'rule';
  else if (/raw log|raw_log|sample log|sample_log|\.log$|logs?/.test(lower)) dataType = 'raw_log';
  else if (/alert|incident|case|ticket/.test(lower)) dataType = 'alert_incident';
  else if (/severity|escalation|sla|slo/.test(lower)) dataType = 'severity_escalation';
  else if (/approval|rollback|containment|response policy|response_policy/.test(lower)) dataType = 'response_approval';
  else if (/sop|procedure|policy|runbook|playbook policy/.test(lower)) dataType = 'sop_policy';
  else if (/connector|inventory|integration capability|capability list/.test(lower)) dataType = 'connector_inventory';
  else if (/playbook|workflow|automation/.test(lower)) dataType = 'playbook';
  else if (/expected|template|report format|output format|artifact/.test(lower)) dataType = 'expected_output';

  let inferredProduct: SocKnowledgeProduct = 'Other';
  if (lower.includes('fortisiem')) inferredProduct = 'FortiSIEM';
  else if (lower.includes('fortisoar')) inferredProduct = 'FortiSOAR';
  else if (lower.includes('fortinet') || lower.includes('fortigate') || lower.includes('fortianalyzer') || lower.includes('fortiedr')) inferredProduct = 'Fortinet';
  else if (['sop_policy', 'severity_escalation', 'response_approval', 'expected_output'].includes(dataType)) inferredProduct = 'Internal';

  let inferredCategory: SocKnowledgeCategory = 'Fortinet KB / Forum Export';
  switch (dataType) {
    case 'rule': inferredCategory = 'FortiSIEM Rule'; inferredProduct = inferredProduct === 'Other' ? 'FortiSIEM' : inferredProduct; break;
    case 'parser': inferredCategory = 'FortiSIEM Parser'; inferredProduct = inferredProduct === 'Other' ? 'FortiSIEM' : inferredProduct; break;
    case 'raw_log': inferredCategory = 'Sample Logs'; break;
    case 'alert_incident':
    case 'true_positive':
    case 'false_positive': inferredCategory = 'Incident Example'; break;
    case 'sop_policy':
    case 'severity_escalation':
    case 'response_approval':
    case 'expected_output': inferredCategory = 'Internal SOC SOP'; inferredProduct = 'Internal'; break;
    case 'connector_inventory': inferredCategory = 'Connector Documentation'; break;
    case 'playbook': inferredCategory = 'FortiSOAR Playbook'; inferredProduct = inferredProduct === 'Other' ? 'FortiSOAR' : inferredProduct; break;
    default:
      inferredCategory = inferredProduct === 'FortiSOAR' ? 'FortiSOAR Guide' : inferredProduct === 'FortiSIEM' ? 'FortiSIEM Guide' : 'Fortinet KB / Forum Export';
  }

  const tags = [
    dataType.replace(/_/g, '-'),
    inferredProduct.toLowerCase(),
    inferredCategory.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    tokens.includes('vpn') ? 'vpn' : '',
    tokens.includes('phishing') ? 'phishing' : '',
    tokens.includes('mitre') ? 'mitre' : '',
    tokens.includes('connector') ? 'connector' : '',
    tokens.includes('approval') ? 'approval' : '',
    tokens.includes('brute') ? 'brute-force' : '',
  ].filter(Boolean);

  return {
    dataType,
    inferredProduct,
    inferredCategory,
    inferredVersion: inferVersion(lower),
    inferredTags: Array.from(new Set(tags)).slice(0, 10),
    duplicate: false,
  };
}

export function enrichCompanyScanFiles(files: SocKnowledgeScanFile[], resources: SocKnowledgeResource[]): SocCompanyDataScanFile[] {
  const existingPaths = new Set(resources.map(resource => normalizeSocPath(resource.filePath).toLowerCase()));
  const seen = new Set<string>();
  return files.map(file => {
    const path = normalizeSocPath(file.path);
    const key = path.toLowerCase();
    const duplicate = existingPaths.has(key) || seen.has(key);
    seen.add(key);
    return {
      ...file,
      path,
      ...classifyCompanyDataFile(path),
      duplicate,
    };
  });
}

export function companyDataTypeLabel(type: SocCompanyDataType): string {
  switch (type) {
    case 'rule': return 'FortiSIEM rule';
    case 'parser': return 'FortiSIEM parser';
    case 'raw_log': return 'Raw log';
    case 'alert_incident': return 'Alert / incident';
    case 'true_positive': return 'True-positive example';
    case 'false_positive': return 'False-positive example';
    case 'sop_policy': return 'SOC SOP / policy';
    case 'severity_escalation': return 'Severity / escalation';
    case 'response_approval': return 'Response approval';
    case 'connector_inventory': return 'Connector inventory';
    case 'playbook': return 'FortiSOAR playbook';
    case 'expected_output': return 'Expected output template';
    default: return 'Other';
  }
}

function countBy<T extends string>(items: T[]): Record<T, number> {
  return items.reduce((acc, item) => {
    acc[item] = (acc[item] || 0) + 1;
    return acc;
  }, {} as Record<T, number>);
}

function formatCountBlock(values: Record<string, number>): string[] {
  const entries = Object.entries(values).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (!entries.length) return ['- none'];
  return entries.map(([label, count]) => `- ${label}: ${count}`);
}

export function buildCompanyDatasetSummaryMarkdown(args: {
  intakeFolderPath: string;
  checklist: SocDataPackChecklistItem[];
  resources: SocKnowledgeResource[];
  scannedFiles?: SocCompanyDataScanFile[];
  importedThisSession?: number;
}): string {
  const checklist = mergeSocDataPackChecklist(args.checklist);
  const readiness = getCompanyIntakeReadinessStats(checklist);
  const resources = args.resources;
  const indexed = resources.filter(resource => resource.indexStatus === 'indexed' || resource.indexStatus === 'warning');
  const chunks = flattenSocChunks(resources);
  const denseChunks = chunks.filter(chunk => Array.isArray(chunk.denseVector) && chunk.denseVector.length > 0);
  const scanned = args.scannedFiles || [];
  const supported = scanned.filter(file => file.supported);
  const unsupported = scanned.filter(file => !file.supported);
  const duplicates = scanned.filter(file => file.duplicate);
  const typeBreakdown = countBy(scanned.map(file => companyDataTypeLabel(file.dataType)));
  const missing = checklist.filter(item => !isStatusAtLeast(item.status, 'received'));

  return [
    '# Company dataset intake summary',
    '',
    `Generated: ${new Date().toLocaleString()}`,
    'Product: Nexus AI — Fortinet SOC Copilot',
    `Intake folder: ${args.intakeFolderPath || SOC_COMPANY_INTAKE_ROOT}`,
    '',
    '## Local-Only Safety',
    '- This report is generated locally from configured deployment paths and local knowledge records.',
    '- Do not import secrets, passwords, API keys, private customer data, or unsanitized sensitive records.',
    '- Keep original received files separate from sanitized/import-ready files.',
    '- No external/cloud upload is required for this workflow.',
    '',
    '## Intake Readiness',
    `- Company-specific readiness: ${readiness.readinessPercent}%`,
    `- Received or better: ${readiness.receivedOrBetter}/${readiness.totalChecklistItems}`,
    `- Sanitized or better: ${readiness.sanitizedOrBetter}/${readiness.totalChecklistItems}`,
    `- Imported or better: ${readiness.importedOrBetter}/${readiness.totalChecklistItems}`,
    `- Indexed or better: ${readiness.indexedOrBetter}/${readiness.totalChecklistItems}`,
    `- Tested: ${readiness.tested}/${readiness.totalChecklistItems}`,
    `- Required categories missing: ${readiness.requiredMissing}`,
    `- Next recommended action: ${readiness.nextRecommendedAction}`,
    '',
    '## Scan Summary',
    `- Files scanned: ${scanned.length}`,
    `- Supported files: ${supported.length}`,
    `- Unsupported files: ${unsupported.length}`,
    `- Duplicate/skipped candidates: ${duplicates.length}`,
    `- Imported in this session: ${args.importedThisSession || 0}`,
    '',
    '## Scanned Type Breakdown',
    ...formatCountBlock(typeBreakdown),
    '',
    '## Knowledge/RAG Readiness',
    `- Registered knowledge resources: ${resources.length}`,
    `- Indexed resources: ${indexed.length}`,
    `- Indexed chunks: ${chunks.length}`,
    `- Dense-vectorized chunks: ${denseChunks.length}`,
    '',
    '## Missing Company Inputs',
    ...(missing.length ? missing.map(item => `- ${item.priority}: ${item.label}`) : ['- none currently marked missing']),
    '',
    '## Artifact Mapping',
    '- FortiSIEM rules → rule review, tuning, MITRE/severity/threshold checks.',
    '- FortiSIEM parsers + raw logs → parser validation, regex testing, field mapping review.',
    '- Alerts/incidents → triage, investigation planning, report drafting.',
    '- True-positive / false-positive examples → analyst decision tuning and evaluation cases.',
    '- SOC SOPs and policies → severity, escalation, closure, and approval alignment.',
    '- Connector inventory → FortiSOAR playbook action planning.',
    '- FortiSOAR playbooks → playbook validation, safety checks, and workflow improvement.',
    '- Expected outputs → report/export formatting and handoff templates.',
    '',
    '## Next Recommended Actions',
    '- Place sanitized/import-ready files in the matching intake subfolders under your configured company-data root.',
    '- Scan the intake folder, import supported files, then index them in the Offline Knowledge Base.',
    '- Build dense vectors in small batches when the local embedding provider is ready and the chunk length fits the selected embedding model.',
    '- Run validators on parser/rule/playbook samples before using Chat for deeper reasoning.',
    '- Create evaluation cases from TP/FP examples after the company data pack arrives.',
  ].join('\n');
}

export function buildEvaluationSetTemplateMarkdown(): string {
  return [
    '# Evaluation set template',
    '',
    '| Field | Value |',
    '|---|---|',
    '| Test Case ID | SOC-EVAL-001 |',
    '| Scenario Name | Example: VPN brute force followed by successful login |',
    '| Input Type | alert / raw log / rule / parser / playbook / connector request |',
    '| Source File | <company-data>/intake/... |',
    '| Expected Verdict | true positive / false positive / needs more evidence |',
    '| Expected Severity | low / medium / high / critical |',
    '| Expected MITRE Mapping | T1110 Brute Force, T1078 Valid Accounts, etc. |',
    '| Expected Recommended Action | analyst-approved next step only |',
    '| Expected False-Positive Notes | expected benign causes / tuning exceptions |',
    '| Expected Output Artifact | triage report / rule review / parser notes / playbook review |',
    '| Human Approval Needed | yes / no, with reason |',
    '| Closure Criteria | evidence required before closing/escalating |',
    '',
    '## Notes',
    '- Keep examples sanitized before import.',
    '- Store expected outputs locally so future versions can compare app output against analyst-approved answers.',
  ].join('\n');
}
