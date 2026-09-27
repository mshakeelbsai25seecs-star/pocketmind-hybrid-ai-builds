import { canParseCef, parseCef } from './genericCef';
import { canParseCsv, parseCsv } from './genericCsv';
import { canParseFortiSiEmJson, parseFortiSiEmJson } from './fortisiemJson';
import { canParseFortiSiEmXml, parseFortiSiEmXml } from './fortisiemXml';
import { parseRawBundle } from './rawBundle';
import type { ParsedAlert } from '../types';

export type SocImportFormat =
  | 'auto'
  | 'fortisiem_json'
  | 'fortisiem_xml'
  | 'generic_cef'
  | 'generic_csv'
  | 'raw_bundle';

export interface ImportFileInput {
  name: string;
  text: string;
}

export interface ImportParseResult {
  alerts: ParsedAlert[];
  errors: { file: string; row?: number; message: string }[];
  formatUsed: SocImportFormat;
}

function detectFormat(text: string): SocImportFormat {
  if (canParseFortiSiEmJson(text)) return 'fortisiem_json';
  if (canParseFortiSiEmXml(text)) return 'fortisiem_xml';
  if (canParseCef(text)) return 'generic_cef';
  if (canParseCsv(text)) return 'generic_csv';
  return 'raw_bundle';
}

function parseWithFormat(text: string, file: string, format: SocImportFormat): ParsedAlert[] {
  switch (format) {
    case 'fortisiem_json':
      return parseFortiSiEmJson(text, file);
    case 'fortisiem_xml':
      return parseFortiSiEmXml(text, file);
    case 'generic_cef':
      return parseCef(text, file);
    case 'generic_csv':
      return parseCsv(text, file);
    case 'raw_bundle':
    default:
      return parseRawBundle(text, file);
  }
}

export function parseImportFiles(
  files: ImportFileInput[],
  format: SocImportFormat = 'auto',
): ImportParseResult {
  const alerts: ParsedAlert[] = [];
  const errors: ImportParseResult['errors'] = [];
  let lastFormat: SocImportFormat = format === 'auto' ? 'raw_bundle' : format;

  for (const file of files) {
    try {
      const resolved = format === 'auto' ? detectFormat(file.text) : format;
      lastFormat = resolved;
      const parsed = parseWithFormat(file.text, file.name, resolved);
      if (!parsed.length) {
        errors.push({ file: file.name, message: 'No alerts found in file.' });
        continue;
      }
      alerts.push(...parsed);
    } catch (err) {
      errors.push({
        file: file.name,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { alerts, errors, formatUsed: lastFormat };
}

export { detectFormat };
