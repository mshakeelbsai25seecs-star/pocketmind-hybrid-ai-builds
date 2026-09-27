import { invoke } from '@tauri-apps/api/tauri';
import {
  browserDeleteCase,
  browserEnsureDirs,
  browserExportCaseMarkdown,
  browserGetCase,
  browserListCases,
  browserRecomputeMetrics,
  browserSaveImportBatch,
  browserUpsertCase,
  browserWriteArtifact,
} from './browserStore';
import { isSocTauriRuntime } from './runtime';
import type { SocCase, SocCaseIndexEntry, SocImportBatch, SocMetricsSummary } from './types';

const LEGACY_KEY = 'pocketmind-soc-incidents-v1';

function useBrowser(): boolean {
  return !isSocTauriRuntime();
}

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
  if (useBrowser()) return browserEnsureDirs();
  try {
    return await invoke<string[]>('soc_ensure_dirs');
  } catch (err) {
    console.warn('soc_ensure_dirs failed; using browser store', err);
    return browserEnsureDirs();
  }
}

export async function socListCases(): Promise<SocCaseIndexEntry[]> {
  if (useBrowser()) return browserListCases();
  try {
    return await invoke<SocCaseIndexEntry[]>('soc_list_cases');
  } catch (err) {
    console.warn('soc_list_cases failed; using browser store', err);
    return browserListCases();
  }
}

export async function socGetCase(caseId: string): Promise<SocCase> {
  if (useBrowser()) return browserGetCase(caseId);
  try {
    return await invoke<SocCase>('soc_get_case', { caseId });
  } catch (err) {
    // Fall back only when case exists in browser store
    try {
      return browserGetCase(caseId);
    } catch {
      throw err;
    }
  }
}

export async function socUpsertCase(socCase: SocCase): Promise<SocCase> {
  if (useBrowser()) return browserUpsertCase(socCase);
  try {
    return await invoke<SocCase>('soc_upsert_case', { case: socCase });
  } catch (err) {
    console.warn('soc_upsert_case failed; using browser store', err);
    return browserUpsertCase(socCase);
  }
}

export async function socDeleteCase(caseId: string): Promise<void> {
  if (useBrowser()) {
    browserDeleteCase(caseId);
    return;
  }
  try {
    await invoke('soc_delete_case', { caseId });
  } catch (err) {
    console.warn('soc_delete_case failed; using browser store', err);
    browserDeleteCase(caseId);
  }
}

export async function socRebuildIndex(): Promise<SocCaseIndexEntry[]> {
  if (useBrowser()) return browserListCases();
  return invoke<SocCaseIndexEntry[]>('soc_rebuild_index');
}

export async function socSaveImportBatch(batch: SocImportBatch): Promise<SocImportBatch> {
  if (useBrowser()) return browserSaveImportBatch(batch);
  try {
    return await invoke<SocImportBatch>('soc_save_import_batch', { batch });
  } catch (err) {
    console.warn('soc_save_import_batch failed; using browser store', err);
    return browserSaveImportBatch(batch);
  }
}

export async function socWriteCaseImportBlob(
  caseId: string,
  relativeName: string,
  contents: string,
): Promise<string> {
  if (useBrowser()) return browserWriteArtifact(caseId, relativeName, contents, 'import');
  try {
    return await invoke<string>('soc_write_case_import_blob', { caseId, relativeName, contents });
  } catch {
    return browserWriteArtifact(caseId, relativeName, contents, 'import');
  }
}

export async function socWriteCaseArtifact(
  caseId: string,
  relativeName: string,
  contents: string,
): Promise<string> {
  if (useBrowser()) return browserWriteArtifact(caseId, relativeName, contents, 'artifacts');
  try {
    return await invoke<string>('soc_write_case_artifact', { caseId, relativeName, contents });
  } catch {
    return browserWriteArtifact(caseId, relativeName, contents, 'artifacts');
  }
}

export async function socExportCaseMarkdown(
  caseId: string,
  markdown: string,
  filename?: string,
): Promise<string> {
  if (useBrowser()) return browserExportCaseMarkdown(caseId, markdown, filename);
  try {
    return await invoke<string>('soc_export_case_markdown', { caseId, markdown, filename });
  } catch {
    return browserExportCaseMarkdown(caseId, markdown, filename);
  }
}

export async function socRecomputeMetrics(): Promise<SocMetricsSummary> {
  if (useBrowser()) return browserRecomputeMetrics();
  try {
    return await invoke<SocMetricsSummary>('soc_recompute_metrics');
  } catch {
    return browserRecomputeMetrics();
  }
}

export function socPersistenceMode(): 'tauri' | 'browser' {
  return useBrowser() ? 'browser' : 'tauri';
}
