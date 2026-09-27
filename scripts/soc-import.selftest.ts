import assert from 'node:assert/strict';
import { parseImportFiles } from '../src/soc/import/index.ts';
import { parseVerdictFromModelText } from '../src/soc/investigate/parseVerdict.ts';
import { computeSocMetrics } from '../src/soc/metrics.ts';
import { createBlankCase, caseFromParsedAlert } from '../src/soc/caseFactory.ts';
import { newImportBatchId } from '../src/soc/ids.ts';
import type { SocCase } from '../src/soc/types.ts';

const fortiJson = JSON.stringify([
  {
    incidentId: '1001',
    incidentTitle: 'VPN brute force',
    eventSeverityCat: 'High',
    srcIpAddr: '203.0.113.10',
    user: 'j.saeed',
    hostName: 'vpn-gw-01',
    incidentDetail: 'Multiple failures then success',
  },
  {
    incidentId: '1002',
    incidentTitle: 'Port scan',
    eventSeverityCat: 'Medium',
    srcIpAddr: '198.51.100.7',
    destIpAddr: '10.0.0.5',
  },
]);

const parsed = parseImportFiles([{ name: 'forti.json', text: fortiJson }], 'auto');
assert.equal(parsed.alerts.length, 2);
assert.equal(parsed.alerts[0]?.externalId, '1001');
assert.equal(parsed.alerts[0]?.entities.sourceIp, '203.0.113.10');
assert.equal(parsed.formatUsed, 'fortisiem_json');

const cef = 'CEF:0|Fortinet|FortiGate|1.0|100|Login failed|8|src=1.2.3.4 dst=10.0.0.1 suser=alice';
const cefParsed = parseImportFiles([{ name: 'a.cef', text: cef }], 'auto');
assert.equal(cefParsed.alerts.length, 1);
assert.equal(cefParsed.alerts[0]?.entities.sourceIp, '1.2.3.4');
assert.equal(cefParsed.formatUsed, 'generic_cef');

const csv = 'title,severity,source_ip,user\nPhish,High,8.8.8.8,bob\n';
const csvParsed = parseImportFiles([{ name: 'a.csv', text: csv }], 'auto');
assert.equal(csvParsed.alerts.length, 1);
assert.equal(csvParsed.alerts[0]?.entities.username, 'bob');

const good = parseVerdictFromModelText(`
Some markdown
---SOC_VERDICT_JSON---
{"disposition":"malicious","confidence":"high","summary":"Compromised VPN","reasoning":"Fail then success","evidenceFound":["42 failures"],"missingEvidence":["EDR"],"recommendedActions":["Reset MFA"],"mitreTechniques":["T1110"],"interviewQuestions":["Did you travel?"]}
---END_SOC_VERDICT_JSON---
`);
assert.equal(good.parseOk, true);
assert.equal(good.verdict.disposition, 'malicious');
assert.equal(good.verdict.interviewQuestions[0], 'Did you travel?');

const bad = parseVerdictFromModelText('no fence here');
assert.equal(bad.parseOk, false);
assert.equal(bad.verdict.disposition, 'needs_evidence');

const batch = newImportBatchId();
const c1 = caseFromParsedAlert(parsed.alerts[0]!, { importBatchId: batch });
const c2 = createBlankCase({ title: 'Manual' });
c2.status = 'closed';
c2.closedAt = c2.createdAt + 10_000;
c2.disposition = 'benign';
c2.verdict = {
  ...good.verdict,
  aiDisposition: 'malicious',
  disposition: 'benign',
};
c2.timings.firstVerdictAt = c2.createdAt + 5_000;
const metrics = computeSocMetrics([c1, c2] as SocCase[]);
assert.equal(metrics.total_cases, 2);
assert.equal(metrics.closed_cases, 1);
assert.equal(metrics.override_count, 1);
assert.ok((metrics.override_rate || 0) > 0);

console.log('soc-import.selftest ok');
