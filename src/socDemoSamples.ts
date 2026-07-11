import type { SocPromptKind, SocWorkspaceInput } from './socPromptTemplates';

export const SOC_DEMO_SAMPLE_NOTICE =
  'Synthetic example — not real customer data or a live Fortinet connection.';

export interface SocValidatorDemoSample {
  parserXml: string;
  playbookJson: string;
  regex: string;
  regexSampleLogs: string;
  iocText: string;
}

export interface SocDemoSample {
  id: string;
  title: string;
  subtitle: string;
  category: string;
  recommendedAction: SocPromptKind;
  input: SocWorkspaceInput;
  highlights: string[];
}

export const SOC_DEMO_SAMPLES: SocDemoSample[] = [
  {
    id: 'vpn-bruteforce-success',
    title: 'VPN brute-force followed by success',
    subtitle: 'Triage-focused sample for a FortiGate/FortiSIEM-style VPN authentication alert.',
    category: 'Triage example',
    recommendedAction: 'triage',
    input: {
      alertSummary:
        'Demo alert: 42 failed VPN login attempts for user j.saeed followed by one successful VPN login from the same external IP within 9 minutes. The user normally authenticates from Pakistan business hours, but this activity occurred after hours.',
      rawLogs: [
        '2026-06-10T18:42:11Z device=FGT-DEMO-EDGE type=vpn subtype=ssl event.action=failed-login srcip=203.0.113.45 dstip=10.10.5.10 user=j.saeed reason="invalid password" policyid=0 service=ssl-vpn',
        '2026-06-10T18:43:02Z device=FGT-DEMO-EDGE type=vpn subtype=ssl event.action=failed-login srcip=203.0.113.45 dstip=10.10.5.10 user=j.saeed reason="invalid password" policyid=0 service=ssl-vpn',
        '2026-06-10T18:50:44Z device=FGT-DEMO-EDGE type=vpn subtype=ssl event.action=successful-login srcip=203.0.113.45 dstip=10.10.5.10 user=j.saeed tunnelid=7712 assigned_ip=10.99.14.23 service=ssl-vpn',
        '2026-06-10T18:52:09Z device=FGT-DEMO-EDGE type=traffic subtype=forward srcip=10.99.14.23 dstip=10.20.30.15 dstport=445 action=accept policyid=21 service=SMB sentbyte=22109 rcvdbyte=3091',
      ].join('\n'),
      sourceIp: '203.0.113.45',
      destinationIp: '10.10.5.10',
      username: 'j.saeed',
      asset: 'FGT-DEMO-EDGE SSL-VPN gateway / demo VPN user',
      severity: 'High',
      notes:
        'Demo goal: classify true positive vs false positive, identify missing evidence, suggest FortiSIEM queries, and keep containment behind human approval.',
    },
    highlights: [
      'Shows triage, evidence gaps, IOC checks, validators, and report export.',
      'Uses documentation-safe sample IP space and generic usernames; not customer data.',
      'Recommended action in the SOC prompt workflow: Triage Alert.',
    ],
  },
  {
    id: 'fortisiem-parser-draft',
    title: 'FortiSIEM parser engineering sample',
    subtitle: 'Parser/R&D sample for mapping a custom application log into FortiSIEM-style fields.',
    category: 'Parser example',
    recommendedAction: 'parser',
    input: {
      alertSummary:
        'Demo parser task: onboard a custom PAM application log source and extract authentication result, user, source IP, target asset, action, and session ID fields for FortiSIEM correlation.',
      rawLogs: [
        '2026-06-10 19:04:18 PAM-DEMO auth_result=deny user=ops.admin src=198.51.100.77 target=vault-demo-01 action=checkout_password session=S-88921 reason="mfa failed"',
        '2026-06-10 19:06:45 PAM-DEMO auth_result=allow user=ops.admin src=198.51.100.77 target=vault-demo-01 action=checkout_password session=S-88928 reason="mfa passed"',
        '2026-06-10 19:08:10 PAM-DEMO auth_result=allow user=ops.admin src=198.51.100.77 target=db-demo-02 action=launch_ssh session=S-88931 reason="approved request"',
      ].join('\n'),
      sourceIp: '198.51.100.77',
      destinationIp: '10.30.40.20',
      username: 'ops.admin',
      asset: 'vault-demo-01 / custom PAM log source',
      severity: 'Medium',
      notes:
        'Draft parser recognizer for lines containing PAM-DEMO and key=value pairs. Extract auth_result, user, src, target, action, session, reason. Include parser ordering and malformed-line warnings.',
    },
    highlights: [
      'Shows R&D relevance: parser drafting, field mapping, recognizer logic, and sample log tests.',
      'Pairs well with the SOC Validators XML/regex checks.',
      'Recommended action in the SOC prompt workflow: Draft FortiSIEM Parser.',
    ],
  },
  {
    id: 'playbook-connector-spec',
    title: 'FortiSOAR playbook + connector requirement sample',
    subtitle: 'SOAR planning sample for enrichment, approval, and safe containment workflow design.',
    category: 'Playbook example',
    recommendedAction: 'playbook',
    input: {
      alertSummary:
        'Demo SOAR task: design a human-approved FortiSOAR-style playbook for suspected compromised VPN account investigation and enrichment.',
      rawLogs: [
        'Incident DEMO-2026-0610-007: VPN brute-force to success for j.saeed from 203.0.113.45',
        'Required enrichment: user risk, recent MFA events, asset criticality, geolocation, reputation lookup, recent SMB/LDAP access, and previous incidents for the same account/IP.',
        'Potential containment options must remain approval-gated: force password reset, revoke sessions, disable account, block IP on perimeter control, create ticket, notify L3 analyst.',
      ].join('\n'),
      sourceIp: '203.0.113.45',
      destinationIp: '10.10.5.10',
      username: 'j.saeed',
      asset: 'VPN gateway + identity provider + ticketing connector',
      severity: 'High',
      notes:
        'Connector requirement: actions for get_user_risk, list_recent_mfa_events, get_ip_reputation, create_ticket, add_comment, and request_human_approval. No containment action should run automatically.',
    },
    highlights: [
      'Illustrates human approval before any automated response.',
      'Shows connector analysis, playbook design, response safety, and analyst handoff value.',
      'Recommended action in the SOC prompt workflow: Draft FortiSOAR Playbook.',
    ],
  },
];

export const SOC_DEMO_VALIDATOR_SAMPLE: SocValidatorDemoSample = {
  parserXml: [
    '<parser name="Demo-PAM-Parser">',
    '  <eventFormatRecognizer><![CDATA[PAM-DEMO]]></eventFormatRecognizer>',
    '  <parsingInstructions>',
    '    <collectFieldsByRegex src="$_rawmsg">',
    '      <regex><![CDATA[auth_result=(?<result>\\w+) user=(?<user>\\S+) src=(?<srcIp>\\S+) target=(?<target>\\S+) action=(?<action>\\S+) session=(?<session>\\S+)]]></regex>',
    '    </collectFieldsByRegex>',
    '  </parsingInstructions>',
    '</parser>',
  ].join('\n'),
  playbookJson: JSON.stringify(
    {
      name: 'Demo VPN Compromise Investigation',
      trigger: 'FortiSIEM incident: VPN brute-force followed by success',
      approval_required: true,
      steps: [
        { id: 'enrich-user', action: 'get_user_risk', connector: 'identity-demo' },
        { id: 'enrich-ip', action: 'get_ip_reputation', connector: 'threat-intel-demo' },
        { id: 'approval', action: 'request_human_approval', owner: 'L3 analyst' },
        { id: 'ticket', action: 'create_ticket', connector: 'ticketing-demo' },
      ],
      safety_note: 'Containment actions are recommendations only until approved by a human analyst.',
    },
    null,
    2
  ),
  regex: 'srcip=(\\d{1,3}(?:\\.\\d{1,3}){3}).*user=([^\\s]+).*event\\.action=([^\\s]+)',
  regexSampleLogs: [
    'device=FGT-DEMO-EDGE event.action=failed-login srcip=203.0.113.45 user=j.saeed service=ssl-vpn',
    'device=FGT-DEMO-EDGE event.action=successful-login srcip=203.0.113.45 user=j.saeed service=ssl-vpn',
  ].join('\n'),
  iocText: [
    'Demo suspicious IPs: 203.0.113.45, 198.51.100.77',
    'Demo URL: https://vpn-demo.example.invalid/login',
    'Demo email: soc-demo@example.invalid',
    'Demo SHA256: 275a021bbfb6489e54d471899f7db9d1663fc695ec2fe2a2c4538aabf651fd0f',
  ].join('\n'),
};

export function buildSocDemoValidatorSampleText(sample: SocValidatorDemoSample = SOC_DEMO_VALIDATOR_SAMPLE): string {
  return [
    SOC_DEMO_SAMPLE_NOTICE,
    '',
    '# Validator test files',
    '',
    '## Parser XML Sample',
    '```xml',
    sample.parserXml,
    '```',
    '',
    '## FortiSOAR-style JSON Sample',
    '```json',
    sample.playbookJson,
    '```',
    '',
    '## Regex Tester Sample',
    'Regex:',
    '`' + sample.regex + '`',
    '',
    'Sample logs:',
    '```text',
    sample.regexSampleLogs,
    '```',
    '',
    '## IOC Extraction Sample',
    '```text',
    sample.iocText,
    '```',
  ].join('\n');
}

export function buildSocDemoSampleSummary(sample: SocDemoSample): string {
  return [
    SOC_DEMO_SAMPLE_NOTICE,
    '',
    `# ${sample.title}`,
    '',
    `Category: ${sample.category}`,
    `Recommended SOC action: ${sample.recommendedAction}`,
    '',
    '## Workspace Fields',
    `Alert summary: ${sample.input.alertSummary}`,
    `Source IP: ${sample.input.sourceIp}`,
    `Destination IP: ${sample.input.destinationIp}`,
    `Username: ${sample.input.username}`,
    `Asset/device: ${sample.input.asset}`,
    `Severity: ${sample.input.severity}`,
    `Notes: ${sample.input.notes}`,
    '',
    '## Raw logs / evidence',
    '```text',
    sample.input.rawLogs,
    '```',
    '',
    '## Notes',
    ...sample.highlights.map(point => `- ${point}`),
  ].join('\n');
}
