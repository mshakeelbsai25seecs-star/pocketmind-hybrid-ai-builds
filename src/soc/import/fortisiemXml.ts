import { normalizeSeverity } from '../caseFactory';
import type { ParsedAlert } from '../types';

function textBetween(xml: string, tag: string): string {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i');
  const m = xml.match(re);
  return m?.[1]?.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim() || '';
}

function splitEvents(xml: string): string[] {
  const chunks: string[] = [];
  const re = /<(event|incident|Entry)\b[\s\S]*?<\/\1>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) chunks.push(m[0]);
  return chunks.length ? chunks : [xml];
}

export function canParseFortiSiEmXml(text: string): boolean {
  const t = text.trim();
  if (!t.startsWith('<')) return false;
  return /<(event|incident|events|incidents|Entry)\b/i.test(t)
    || /srcIpAddr|eventName|incidentTitle|phEventCategory/i.test(t);
}

export function parseFortiSiEmXml(text: string, fileLabel: string): ParsedAlert[] {
  const alerts: ParsedAlert[] = [];
  for (const chunk of splitEvents(text)) {
    const title = textBetween(chunk, 'incidentTitle')
      || textBetween(chunk, 'eventName')
      || textBetween(chunk, 'name')
      || 'FortiSIEM XML alert';
    const externalId = textBetween(chunk, 'incidentId')
      || textBetween(chunk, 'eventId')
      || textBetween(chunk, 'id')
      || undefined;
    const summary = textBetween(chunk, 'incidentDetail')
      || textBetween(chunk, 'rawEventMsg')
      || textBetween(chunk, 'msg')
      || title;
    const severity = normalizeSeverity(
      textBetween(chunk, 'eventSeverityCat')
        || textBetween(chunk, 'eventSeverity')
        || textBetween(chunk, 'severity'),
    );
    const sourceIp = textBetween(chunk, 'srcIpAddr') || textBetween(chunk, 'srcIp');
    const destinationIp = textBetween(chunk, 'destIpAddr') || textBetween(chunk, 'destIp');
    const username = textBetween(chunk, 'user') || textBetween(chunk, 'userName');
    const asset = textBetween(chunk, 'hostName') || textBetween(chunk, 'reptDevName');

    alerts.push({
      externalId,
      title,
      summary,
      severity,
      rawEvidence: chunk.trim(),
      entities: {
        sourceIp,
        destinationIp,
        username,
        asset,
        hostnames: asset ? [asset] : [],
        urls: [],
        hashes: [],
        extra: {},
      },
      tags: ['fortisiem', 'xml', 'import'],
      sourceLabel: fileLabel,
      originalPayload: chunk.trim(),
    });
  }
  return alerts;
}
