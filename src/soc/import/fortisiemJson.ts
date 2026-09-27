import { normalizeSeverity } from '../caseFactory';
import type { ParsedAlert, SocSeverity } from '../types';

function asString(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v);
  return '';
}

function pick(obj: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    if (key in obj && asString(obj[key]).trim()) return asString(obj[key]).trim();
  }
  return '';
}

function looksLikeFortiSiEmObject(obj: Record<string, unknown>): boolean {
  const keys = Object.keys(obj).map(k => k.toLowerCase());
  const markers = [
    'eventid', 'incidentid', 'eventname', 'incidenttitle', 'srcip', 'sourceip',
    'reptDevIpAddr', 'reptdevipaddr', 'phEventCategory', 'pheventcategory',
  ];
  return markers.some(m => keys.includes(m.toLowerCase()));
}

function objectToAlert(obj: Record<string, unknown>, sourceLabel: string): ParsedAlert {
  const externalId = pick(obj, [
    'incidentId', 'incidentID', 'eventId', 'eventID', 'id', 'Incident ID', 'Event ID',
  ]);
  const title = pick(obj, [
    'incidentTitle', 'eventName', 'name', 'ruleName', 'title', 'Incident Title', 'Event Name',
  ]) || 'FortiSIEM alert';
  const summary = pick(obj, [
    'incidentDetail', 'rawEventMsg', 'msg', 'description', 'summary', 'Detail',
  ]) || title;
  const severityRaw = pick(obj, [
    'eventSeverityCat', 'eventSeverity', 'severity', 'incidentSeverity', 'Severity',
  ]);
  const severity: SocSeverity = normalizeSeverity(severityRaw);
  const sourceIp = pick(obj, ['srcIpAddr', 'srcIp', 'sourceIp', 'Source IP', 'src']);
  const destinationIp = pick(obj, ['destIpAddr', 'destIp', 'destinationIp', 'Destination IP', 'dst']);
  const username = pick(obj, ['user', 'userName', 'username', 'User', 'account']);
  const asset = pick(obj, ['hostName', 'hostname', 'asset', 'reptDevName', 'targetHost']);

  return {
    externalId: externalId || undefined,
    title,
    summary,
    severity,
    rawEvidence: JSON.stringify(obj, null, 2),
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
    tags: ['fortisiem', 'import'],
    sourceLabel,
    originalPayload: JSON.stringify(obj),
  };
}

export function parseFortiSiEmJson(text: string, fileLabel: string): ParsedAlert[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const parsed = JSON.parse(trimmed) as unknown;
  const rows: Record<string, unknown>[] = [];

  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      if (item && typeof item === 'object') rows.push(item as Record<string, unknown>);
    }
  } else if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    if (Array.isArray(obj.data)) {
      for (const item of obj.data) {
        if (item && typeof item === 'object') rows.push(item as Record<string, unknown>);
      }
    } else if (Array.isArray(obj.events)) {
      for (const item of obj.events) {
        if (item && typeof item === 'object') rows.push(item as Record<string, unknown>);
      }
    } else if (Array.isArray(obj.incidents)) {
      for (const item of obj.incidents) {
        if (item && typeof item === 'object') rows.push(item as Record<string, unknown>);
      }
    } else {
      rows.push(obj);
    }
  }

  return rows
    .filter(row => looksLikeFortiSiEmObject(row) || Object.keys(row).length > 0)
    .map(row => objectToAlert(row, fileLabel));
}

export function canParseFortiSiEmJson(text: string): boolean {
  try {
    const parsed = JSON.parse(text.trim()) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.some(item => item && typeof item === 'object' && looksLikeFortiSiEmObject(item as Record<string, unknown>));
    }
    if (parsed && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>;
      if (looksLikeFortiSiEmObject(obj)) return true;
      for (const key of ['data', 'events', 'incidents']) {
        const arr = obj[key];
        if (Array.isArray(arr) && arr.some(item => item && typeof item === 'object' && looksLikeFortiSiEmObject(item as Record<string, unknown>))) {
          return true;
        }
      }
    }
    return false;
  } catch {
    return false;
  }
}
