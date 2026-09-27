import { invoke } from '@tauri-apps/api/tauri';
import type { SocCase, SocCaseIndexEntry, SocImportBatch, SocMetricsSummary } from './types';

const LEGACY_KEY = 'pocketmind-soc-incidents-v1';

/** Drop the old localStorage seed without migrating demo INC-2024-* rows. */
export function clearLegacySocLocalSeed(): void {
  try {
    const raw = localStorage.getItem(LEGACY_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Array<{ id?: string }>;
    if (!Array.isArray(parsed)) {
      localStorage.removeItem(LEGACY_KEY);
      return;
    }
    const onlyDemo =
      parsed.length === 0
      || parsed.every(row => typeof row?.id === 'string' && /^INC-2024-052144$/i.test(row.id));
    if (onlyDemo) localStorage.removeItem(LEGACY_KEY);
  } catch {
    localStorage.removeItem(LEGACY_KEY);
  }
}

export async function socEnsureDirs(): Promise<string[]> {
  return invoke<string[]>('soc_ensure_dirs');
}

export async function socListCases(): Promise<SocCaseIndexEntry[]> {
  return invoke<SocCaseIndexEntry[]>('soc_list_cases');
}

export async function socGetCase(caseId: string): Promise<SocCase> {
  return invoke<SocCase>('soc_get_case', { caseId });
}

export async function socUpsertCase(socCase: SocCase): Promise<SocCase> {
  return invoke<SocCase>('soc_upsert_case', { case: socCase });
}

export async function socDeleteCase(caseId: string): Promise<void> {
  await invoke('soc_delete_case', { caseId });
}

export async function socRebuildIndex(): Promise<SocCaseIndexEntry[]> {
  return invoke<SocCaseIndexEntry[]>('soc_rebuild_index');
}

export async function socSaveImportBatch(batch: SocImportBatch): Promise<SocImportBatch> {
  return invoke<SocImportBatch>('soc_save_import_batch', { batch });
}

export async function socWriteCaseImportBlob(
  caseId: string,
  relativeName: string,
  contents: string,
): Promise<string> {
  return invoke<string>('soc_write_case_import_blob', { caseId, relativeName, contents });
}

export async function socWriteCaseArtifact(
  caseId: string,
  relativeName: string,
  contents: string,
): Promise<string> {
  return invoke<string>('soc_write_case_artifact', { caseId, relativeName, contents });
}

export async function socExportCaseMarkdown(
  caseId: string,
  markdown: string,
  filename?: string,
): Promise<string> {
  return invoke<string>('soc_export_case_markdown', { caseId, markdown, filename });
}

export async function socRecomputeMetrics(): Promise<SocMetricsSummary> {
  return invoke<SocMetricsSummary>('soc_recompute_metrics');
}
