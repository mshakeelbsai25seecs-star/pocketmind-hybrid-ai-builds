export type SocValidatorStatus = 'pass' | 'warning' | 'fail' | 'info';

export interface SocValidatorFinding {
  id: string;
  title: string;
  status: SocValidatorStatus;
  message: string;
  detail?: string;
}

export interface SocIocResult {
  ips: string[];
  domains: string[];
  urls: string[];
  hashes: string[];
  emails: string[];
}

export interface SocValidatorInput {
  artifactText: string;
  sampleLogs: string;
  regexText: string;
  notes: string;
}

export interface SocValidatorResult {
  findings: SocValidatorFinding[];
  iocs: SocIocResult;
  regexMatches: string[];
  generatedAt: number;
}

const PLACEHOLDER_PATTERN = /\b(TODO|TBD|FIXME|REPLACE_ME|CHANGEME|INSERT_|YOUR_|PLACEHOLDER|example\.com|x\.x\.x\.x)\b/i;
const APPROVAL_PATTERN = /\b(approval|approve|manual review|human review|analyst approval|change ticket|authorization|confirm before|rollback)\b/i;
const DESTRUCTIVE_ACTION_PATTERN = /\b(disable user|disable account|block ip|block domain|quarantine|isolate host|delete|remove|shutdown|kill process|reset password|revoke token|containment|contain host|terminate)\b/i;

function unique(values: string[], limit = 80): string[] {
  return Array.from(new Set(values.filter(Boolean))).slice(0, limit);
}

function compactText(value: string, max = 900): string {
  const cleaned = value.replace(/\s+/g, ' ').trim();
  return cleaned.length > max ? `${cleaned.slice(0, max)}...` : cleaned;
}

function addFinding(findings: SocValidatorFinding[], finding: SocValidatorFinding) {
  findings.push(finding);
}

function parseRegexInput(value: string): { pattern: string; flags: string } {
  const trimmed = value.trim();
  const slashStyle = trimmed.match(/^\/(.*)\/([a-z]*)$/i);
  if (slashStyle) {
    const flags = slashStyle[2].includes('g') ? slashStyle[2] : `${slashStyle[2]}g`;
    return { pattern: slashStyle[1], flags };
  }
  return { pattern: trimmed, flags: 'gmi' };
}

export function validateFortiSiemParserXml(xmlText: string): SocValidatorFinding[] {
  const findings: SocValidatorFinding[] = [];
  const text = xmlText.trim();

  if (!text) {
    addFinding(findings, {
      id: 'xml-empty',
      title: 'Parser XML input',
      status: 'info',
      message: 'Paste FortiSIEM parser XML or parser draft text to run XML checks.',
    });
    return findings;
  }

  if (!text.startsWith('<')) {
    addFinding(findings, {
      id: 'xml-not-xml',
      title: 'XML syntax',
      status: 'warning',
      message: 'The artifact does not look like XML. XML syntax checks were skipped.',
      detail: 'Use the rule/playbook checklist findings below if this is a rule draft or playbook note instead of parser XML.',
    });
    return findings;
  }

  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(text, 'application/xml');
    const parserErrors = doc.getElementsByTagName('parsererror');
    if (parserErrors.length > 0) {
      addFinding(findings, {
        id: 'xml-invalid',
        title: 'XML syntax',
        status: 'fail',
        message: 'XML parser reported a syntax error.',
        detail: compactText(parserErrors[0]?.textContent || 'Unknown XML parse error.'),
      });
    } else {
      addFinding(findings, {
        id: 'xml-valid',
        title: 'XML syntax',
        status: 'pass',
        message: `XML is well formed. Root element: <${doc.documentElement?.nodeName || 'unknown'}>.`,
      });
    }
  } catch (err) {
    addFinding(findings, {
      id: 'xml-exception',
      title: 'XML syntax',
      status: 'fail',
      message: 'XML validation failed unexpectedly.',
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  const lower = text.toLowerCase();
  const hasRecognizer = lower.includes('eventformatrecognizer') || lower.includes('recognizer');
  const hasParsing = lower.includes('parsinginstructions') || lower.includes('collectandsetattrbyregex') || lower.includes('seteventattribute') || lower.includes('regex');

  addFinding(findings, {
    id: 'xml-recognizer',
    title: 'FortiSIEM parser recognizer',
    status: hasRecognizer ? 'pass' : 'warning',
    message: hasRecognizer
      ? 'Parser draft appears to include a recognizer section or recognizer-like keyword.'
      : 'No obvious FortiSIEM event recognizer section was found.',
    detail: hasRecognizer ? undefined : 'For production parser work, confirm there is a reliable event format recognizer so matching is controlled and parser ordering conflicts are reduced.',
  });

  addFinding(findings, {
    id: 'xml-parsing-instructions',
    title: 'Parser extraction logic',
    status: hasParsing ? 'pass' : 'warning',
    message: hasParsing
      ? 'Parser draft appears to include extraction/parsing instructions.'
      : 'No obvious parsing/extraction instructions were found.',
    detail: hasParsing ? undefined : 'Add or verify field extraction logic, sample log tests, and expected FortiSIEM event attribute mappings.',
  });

  if (PLACEHOLDER_PATTERN.test(text)) {
    addFinding(findings, {
      id: 'xml-placeholders',
      title: 'Placeholder scan',
      status: 'warning',
      message: 'Parser text contains placeholder-looking values.',
      detail: 'Remove TODO/TBD/example placeholders before importing into your environment.',
    });
  }

  return findings;
}

export function validateJsonDraft(jsonText: string): SocValidatorFinding[] {
  const findings: SocValidatorFinding[] = [];
  const text = jsonText.trim();

  if (!text || !/^[\[{]/.test(text)) {
    addFinding(findings, {
      id: 'json-skipped',
      title: 'JSON validation',
      status: 'info',
      message: 'No JSON-looking object/array was detected. Paste a FortiSOAR-style JSON draft to validate syntax.',
    });
    return findings;
  }

  try {
    const parsed = JSON.parse(text) as unknown;
    const summary = Array.isArray(parsed) ? `array with ${parsed.length} item(s)` : 'object';
    addFinding(findings, {
      id: 'json-valid',
      title: 'JSON syntax',
      status: 'pass',
      message: `JSON is valid and parsed as ${summary}.`,
    });

    const serialized = JSON.stringify(parsed).toLowerCase();
    const hasPlaybookSignals = ['playbook', 'workflow', 'trigger', 'task', 'step', 'connector', 'action'].some(keyword => serialized.includes(keyword));
    addFinding(findings, {
      id: 'json-playbook-signals',
      title: 'FortiSOAR-style structure signals',
      status: hasPlaybookSignals ? 'pass' : 'warning',
      message: hasPlaybookSignals
        ? 'JSON contains workflow/playbook/task/connector-style keywords.'
        : 'JSON is valid, but no obvious playbook/task/connector keywords were detected.',
      detail: hasPlaybookSignals ? undefined : 'If this is a FortiSOAR playbook draft, verify trigger, tasks, connector actions, decision points, and output fields are represented.',
    });
  } catch (err) {
    addFinding(findings, {
      id: 'json-invalid',
      title: 'JSON syntax',
      status: 'fail',
      message: 'JSON parsing failed.',
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  if (PLACEHOLDER_PATTERN.test(text)) {
    addFinding(findings, {
      id: 'json-placeholders',
      title: 'Placeholder scan',
      status: 'warning',
      message: 'JSON/playbook text contains placeholder-looking values.',
      detail: 'Remove placeholder values before export/import testing.',
    });
  }

  return findings;
}

export function validateYamlChecklist(yamlText: string): SocValidatorFinding[] {
  const findings: SocValidatorFinding[] = [];
  const text = yamlText.trim();

  if (!text || /^[\[{<]/.test(text)) {
    addFinding(findings, {
      id: 'yaml-skipped',
      title: 'Basic YAML checklist',
      status: 'info',
      message: 'No YAML-looking text was detected. This phase uses a basic checklist, not a full YAML parser.',
    });
    return findings;
  }

  const lines = text.split(/\r?\n/);
  const nonEmpty = lines.filter(line => line.trim() && !line.trim().startsWith('#'));
  const tabIndented = nonEmpty.filter(line => /^\s*\t/.test(line));
  const keyValueLines = nonEmpty.filter(line => /^\s*[\w.-]+\s*:/.test(line));
  const listLines = nonEmpty.filter(line => /^\s*-\s+/.test(line));

  addFinding(findings, {
    id: 'yaml-tabs',
    title: 'Basic YAML indentation',
    status: tabIndented.length ? 'fail' : 'pass',
    message: tabIndented.length
      ? `${tabIndented.length} line(s) appear to use tab indentation.`
      : 'No tab indentation was detected.',
    detail: tabIndented.length ? 'YAML generally requires spaces for indentation. Replace tabs with spaces before import/testing.' : undefined,
  });

  addFinding(findings, {
    id: 'yaml-structure',
    title: 'Basic YAML structure',
    status: keyValueLines.length || listLines.length ? 'pass' : 'warning',
    message: keyValueLines.length || listLines.length
      ? `Detected ${keyValueLines.length} key/value line(s) and ${listLines.length} list item(s).`
      : 'No obvious YAML key/value or list structure was detected.',
    detail: 'This is a lightweight checklist only. Use a real YAML parser/import validation before production use.',
  });

  if (PLACEHOLDER_PATTERN.test(text)) {
    addFinding(findings, {
      id: 'yaml-placeholders',
      title: 'Placeholder scan',
      status: 'warning',
      message: 'YAML/playbook text contains placeholder-looking values.',
    });
  }

  return findings;
}

export function testRegexAgainstLogs(regexText: string, sampleLogs: string): { findings: SocValidatorFinding[]; matches: string[] } {
  const findings: SocValidatorFinding[] = [];
  const patternText = regexText.trim();
  const logs = sampleLogs.trim();

  if (!patternText) {
    addFinding(findings, {
      id: 'regex-empty',
      title: 'Regex tester',
      status: 'info',
      message: 'Paste a regex to test it against sample logs.',
    });
    return { findings, matches: [] };
  }

  if (!logs) {
    addFinding(findings, {
      id: 'regex-no-logs',
      title: 'Regex tester',
      status: 'warning',
      message: 'Regex was provided, but no sample logs were pasted.',
      detail: 'Parser/rule work should include matching and non-matching sample events before production use.',
    });
    return { findings, matches: [] };
  }

  try {
    const parsed = parseRegexInput(patternText);
    const regex = new RegExp(parsed.pattern, parsed.flags);
    const lines = logs.split(/\r?\n/).filter(Boolean);
    const matchingLines = lines.filter(line => {
      regex.lastIndex = 0;
      return regex.test(line);
    }).slice(0, 40);

    addFinding(findings, {
      id: 'regex-valid',
      title: 'Regex syntax',
      status: 'pass',
      message: `Regex compiled successfully with flags ${parsed.flags}.`,
    });

    addFinding(findings, {
      id: 'regex-matches',
      title: 'Regex sample-log coverage',
      status: matchingLines.length ? 'pass' : 'warning',
      message: matchingLines.length
        ? `Regex matched ${matchingLines.length} sample log line(s). Showing up to 40.`
        : 'Regex compiled but did not match any sample log line.',
      detail: matchingLines.length ? matchingLines.slice(0, 8).join('\n') : 'Confirm the parser recognizer/extraction regex against known-good and known-bad logs.',
    });

    return { findings, matches: matchingLines };
  } catch (err) {
    addFinding(findings, {
      id: 'regex-invalid',
      title: 'Regex syntax',
      status: 'fail',
      message: 'Regex failed to compile.',
      detail: err instanceof Error ? err.message : String(err),
    });
    return { findings, matches: [] };
  }
}

export function extractSocIocs(text: string): SocIocResult {
  const source = text || '';
  const urls = unique(source.match(/\bhttps?:\/\/[^\s<>'"`]+/gi) || []);
  const emails = unique(source.match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi) || []);
  const hashes = unique(source.match(/\b(?:[a-f0-9]{32}|[a-f0-9]{40}|[a-f0-9]{64})\b/gi) || []);
  const ips = unique((source.match(/\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g) || [])
    .filter(ip => !ip.split('.').some(part => Number(part) > 255)));

  const urlDomains = urls.map(url => {
    try { return new URL(url).hostname.replace(/^www\./i, ''); } catch { return ''; }
  });
  const standaloneDomains = source.match(/\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|net|org|io|co|edu|gov|mil|info|biz|pk|ae|uk|us|de|fr|ru|cn|in|xyz)\b/gi) || [];
  const emailDomains = emails.map(email => email.split('@')[1]).filter(Boolean);
  const domains = unique([...urlDomains, ...standaloneDomains].map(domain => domain.toLowerCase().replace(/^www\./, ''))
    .filter(domain => !emailDomains.includes(domain)));

  return { ips, domains, urls, hashes, emails };
}

export function buildIocFindings(iocs: SocIocResult): SocValidatorFinding[] {
  const total = iocs.ips.length + iocs.domains.length + iocs.urls.length + iocs.hashes.length + iocs.emails.length;
  return [{
    id: 'ioc-summary',
    title: 'IOC extractor',
    status: total ? 'pass' : 'info',
    message: total
      ? `Extracted ${total} IOC candidate(s): ${iocs.ips.length} IPs, ${iocs.domains.length} domains, ${iocs.urls.length} URLs, ${iocs.hashes.length} hashes, ${iocs.emails.length} emails.`
      : 'No IOC candidates were detected in the current inputs.',
    detail: total ? 'Review extracted values before using them in blocking, enrichment, or containment steps.' : undefined,
  }];
}

export function reviewRuleDraft(text: string): SocValidatorFinding[] {
  const findings: SocValidatorFinding[] = [];
  const lower = text.toLowerCase();

  if (!text.trim()) {
    addFinding(findings, {
      id: 'rule-empty',
      title: 'FortiSIEM rule checklist',
      status: 'info',
      message: 'Paste a rule draft or detection idea to run checklist checks.',
    });
    return findings;
  }

  const checks: Array<[string, string, RegExp, string]> = [
    ['rule-datasource', 'Data source / event type', /\b(data source|event type|log source|fortigate|vpn|auth|authentication|eventid|event id)\b/i, 'Mention which event types/log sources the rule depends on.'],
    ['rule-fields', 'Required fields', /\b(field|src|source|dst|destination|user|username|host|asset|severity|event attribute)\b/i, 'List required fields and FortiSIEM attribute mappings.'],
    ['rule-window', 'Time window / threshold', /\b(threshold|count|within|window|minutes|hour|frequency|rate|correlation)\b/i, 'Define time window, threshold, and correlation logic to reduce noise.'],
    ['rule-severity', 'Severity logic', /\b(severity|critical|high|medium|low|risk|priority)\b/i, 'Add severity mapping and why it is appropriate.'],
    ['rule-fp', 'False-positive tuning', /\b(false positive|fp|tuning|suppress|allowlist|whitelist|baseline|exception)\b/i, 'Add expected false positives and tuning/exception guidance.'],
    ['rule-tests', 'Test cases', /\b(test case|matching|non-matching|sample|expected result|validation)\b/i, 'Add matching and non-matching examples before production deployment.'],
  ];

  checks.forEach(([id, title, pattern, detail]) => {
    const ok = pattern.test(lower);
    addFinding(findings, {
      id,
      title,
      status: ok ? 'pass' : 'warning',
      message: ok ? `${title} is mentioned.` : `${title} is missing or not obvious.`,
      detail: ok ? undefined : detail,
    });
  });

  if (!/\bmitre|attack|tactic|technique|t\d{4}/i.test(text)) {
    addFinding(findings, {
      id: 'rule-mitre',
      title: 'MITRE mapping',
      status: 'warning',
      message: 'No obvious MITRE ATT&CK mapping was found.',
      detail: 'Add tactic/technique mapping if this rule is tied to adversary behavior.',
    });
  }

  if (PLACEHOLDER_PATTERN.test(text)) {
    addFinding(findings, {
      id: 'rule-placeholders',
      title: 'Placeholder scan',
      status: 'warning',
      message: 'Rule draft contains placeholder-looking text.',
    });
  }

  return findings;
}

export function reviewPlaybookDraft(text: string): SocValidatorFinding[] {
  const findings: SocValidatorFinding[] = [];
  const lower = text.toLowerCase();

  if (!text.trim()) {
    addFinding(findings, {
      id: 'playbook-empty',
      title: 'FortiSOAR playbook checklist',
      status: 'info',
      message: 'Paste a playbook draft or workflow idea to run checklist checks.',
    });
    return findings;
  }

  const checks: Array<[string, string, RegExp, string]> = [
    ['playbook-trigger', 'Trigger / input fields', /\b(trigger|input|incident type|alert|record|field)\b/i, 'Define when the playbook starts and what fields it requires.'],
    ['playbook-enrichment', 'Enrichment steps', /\b(enrich|lookup|reputation|whois|asset|user context|threat intel|query)\b/i, 'Add enrichment before containment decisions.'],
    ['playbook-connectors', 'Connector actions', /\b(connector|action|api|fortigate|fortisiem|edr|email|ticket|siem)\b/i, 'List connectors/actions, inputs, outputs, and failure handling.'],
    ['playbook-decision', 'Decision points', /\b(decision|if|else|branch|condition|verdict|confidence)\b/i, 'Add decision branches for true positive, false positive, and insufficient evidence.'],
    ['playbook-output', 'Outputs / artifacts', /\b(output|artifact|tag|comment|note|status|report|evidence)\b/i, 'Define what the playbook writes back to the case/record.'],
    ['playbook-rollback', 'Rollback / verification', /\b(rollback|verify|verification|confirm|post-check|audit)\b/i, 'Add verification and rollback guidance for any response action.'],
  ];

  checks.forEach(([id, title, pattern, detail]) => {
    const ok = pattern.test(lower);
    addFinding(findings, {
      id,
      title,
      status: ok ? 'pass' : 'warning',
      message: ok ? `${title} is mentioned.` : `${title} is missing or not obvious.`,
      detail: ok ? undefined : detail,
    });
  });

  const hasDestructiveAction = DESTRUCTIVE_ACTION_PATTERN.test(lower);
  const hasApproval = APPROVAL_PATTERN.test(lower);
  if (hasDestructiveAction && !hasApproval) {
    addFinding(findings, {
      id: 'playbook-unsafe-action',
      title: 'Human approval gate',
      status: 'fail',
      message: 'Potential production response/containment action was found without an obvious human approval gate.',
      detail: 'Add analyst approval, change-ticket/reference, verification, and rollback steps before containment actions.',
    });
  } else if (hasDestructiveAction && hasApproval) {
    addFinding(findings, {
      id: 'playbook-approval-present',
      title: 'Human approval gate',
      status: 'pass',
      message: 'Potential response action is paired with approval/verification language.',
    });
  } else {
    addFinding(findings, {
      id: 'playbook-no-destructive-action',
      title: 'Human approval gate',
      status: 'info',
      message: 'No obvious destructive production action was detected.',
    });
  }

  if (PLACEHOLDER_PATTERN.test(text)) {
    addFinding(findings, {
      id: 'playbook-placeholders',
      title: 'Placeholder scan',
      status: 'warning',
      message: 'Playbook draft contains placeholder-looking text.',
    });
  }

  return findings;
}

export function runSocValidators(input: SocValidatorInput): SocValidatorResult {
  const combined = [input.artifactText, input.sampleLogs, input.regexText, input.notes].join('\n\n');
  const regexResult = testRegexAgainstLogs(input.regexText, input.sampleLogs);
  const iocs = extractSocIocs(combined);
  const artifact = input.artifactText.trim();

  const artifactLooksLikeParser = /eventFormatRecognizer|parsingInstructions|<parser/i.test(artifact);
  const artifactLooksLikeRule = /<rules>|<DataRequest|PatternClause|eventTypeGroup=/i.test(artifact);
  const artifactLooksLikePlaybook = /"steps"\s*:|playbook|workflow|automation/i.test(artifact) && /[\[{]/.test(artifact);
  const artifactLooksLikeJson = artifact.startsWith('{') || artifact.startsWith('[');
  const artifactLooksLikeYaml = /^[\w-]+:\s/m.test(artifact) && !artifactLooksLikeParser;

  const findings = [
    ...(artifactLooksLikeParser || (!artifactLooksLikeRule && !artifactLooksLikePlaybook && !artifactLooksLikeJson && artifact.includes('<')))
      ? validateFortiSiemParserXml(input.artifactText) : [],
    ...(artifactLooksLikeJson ? validateJsonDraft(input.artifactText) : []),
    ...(artifactLooksLikeYaml && !artifactLooksLikeJson ? validateYamlChecklist(input.artifactText) : []),
    ...regexResult.findings,
    ...buildIocFindings(iocs),
    ...(artifactLooksLikeRule ? reviewRuleDraft([input.artifactText, input.notes].join('\n')) : []),
    ...(artifactLooksLikePlaybook ? reviewPlaybookDraft([input.artifactText, input.notes].join('\n')) : []),
  ];

  return {
    findings,
    iocs,
    regexMatches: regexResult.matches,
    generatedAt: Math.floor(Date.now() / 1000),
  };
}

function formatIocList(label: string, values: string[]): string {
  return values.length ? `${label}: ${values.join(', ')}` : `${label}: none`;
}

export function formatSocValidatorReport(result: SocValidatorResult, input: SocValidatorInput): string {
  const statusCounts = result.findings.reduce<Record<SocValidatorStatus, number>>((acc, finding) => {
    acc[finding.status] += 1;
    return acc;
  }, { pass: 0, warning: 0, fail: 0, info: 0 });

  return [
    '# Validator report',
    '',
    `Generated: ${new Date(result.generatedAt * 1000).toLocaleString()}`,
    `Summary: ${statusCounts.pass} pass, ${statusCounts.warning} warning, ${statusCounts.fail} fail, ${statusCounts.info} info`,
    '',
    '## Findings',
    result.findings.map((finding, index) => [
      `${index + 1}. [${finding.status.toUpperCase()}] ${finding.title}`,
      `   ${finding.message}`,
      finding.detail ? `   Detail: ${finding.detail}` : '',
    ].filter(Boolean).join('\n')).join('\n\n'),
    '',
    '## Extracted IOC Candidates',
    formatIocList('IPs', result.iocs.ips),
    formatIocList('Domains', result.iocs.domains),
    formatIocList('URLs', result.iocs.urls),
    formatIocList('Hashes', result.iocs.hashes),
    formatIocList('Emails', result.iocs.emails),
    '',
    '## Regex Matches',
    result.regexMatches.length ? result.regexMatches.join('\n') : 'none',
    '',
    '## Analyst Notes',
    input.notes.trim() || 'none',
    '',
    'Human approval required before production response actions. This deterministic report is offline helper output, not a live FortiSIEM/FortiSOAR integration result.',
  ].join('\n');
}

export function formatSocValidatorChatSummary(result: SocValidatorResult, input: SocValidatorInput): string {
  const statusCounts = result.findings.reduce<Record<SocValidatorStatus, number>>((acc, finding) => {
    acc[finding.status] += 1;
    return acc;
  }, { pass: 0, warning: 0, fail: 0, info: 0 });

  const topWarnings = result.findings
    .filter(finding => finding.status === 'warning' || finding.status === 'fail')
    .slice(0, 10)
    .map(finding => `- [${finding.status.toUpperCase()}] ${finding.title}: ${finding.message}`);

  return [
    '# Compact SOC Validator Summary',
    '',
    `Generated: ${new Date(result.generatedAt * 1000).toLocaleString()}`,
    `Status counts: ${statusCounts.pass} pass, ${statusCounts.warning} warning, ${statusCounts.fail} fail, ${statusCounts.info} info`,
    `Regex matches: ${result.regexMatches.length}`,
    `IOCs: ${result.iocs.ips.length} IPs, ${result.iocs.domains.length} domains, ${result.iocs.urls.length} URLs, ${result.iocs.hashes.length} hashes, ${result.iocs.emails.length} emails`,
    '',
    '## Key warnings/failures to improve',
    topWarnings.length ? topWarnings.join('\n') : '- No warning or fail findings were detected.',
    '',
    '## Analyst objective',
    compactText(input.notes || 'No analyst notes provided.', 700),
    '',
    'Full report remains available through Copy Report / Export Report. This compact summary is intentionally used for local Chat to avoid context-size errors.',
  ].join('\n');
}

export function buildSocValidatorChatPrompt(result: SocValidatorResult, input: SocValidatorInput): string {
  return [
    'You are PocketMind Hybrid AI Fortinet SOC Copilot.',
    'Review the compact deterministic validator summary below and produce concise fixes, retest steps, and human approval guidance.',
    'Do not claim live FortiSIEM/FortiSOAR integration. Do not recommend destructive production actions without approval and rollback notes.',
    '',
    formatSocValidatorChatSummary(result, input),
  ].join('\n');
}
