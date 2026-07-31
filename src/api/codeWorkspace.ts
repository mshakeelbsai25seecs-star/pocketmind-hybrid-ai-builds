/**
 * PocketCode workspace facade.
 * Resolves LocalTauri vs RemoteAgentHttp from the active runtime profile.
 * Agent loop and UI keep calling these functions — no mode branches here beyond transport resolve.
 */

import { invoke } from '@tauri-apps/api/tauri';
import type {
  DirEntryInfo,
  EditPreview,
  PocketCodePlan,
  PocketCodePlanTodo,
  RunnersStatus,
  SandboxRunResult,
} from '../codeWorkspace/types';
import type { SandboxPendingRequest } from '../codeWorkspace/sandboxTypes';
import type {
  TerminalSnapshot,
  TerminalStartInfo,
  TerminalStartRequest,
} from '../codeWorkspace/terminalTypes';
import {
  loadRuntimeProfile,
  type PocketCodeRuntimeProfile,
} from '../codeWorkspace/runtimeProfile';
import {
  remoteWorkspaceRootToken,
  resetWorkspaceToolsCache,
  resolveWorkspaceTools,
  type WorkspaceTools,
} from '../codeWorkspace/workspaceTransport';

export type {
  CheckpointManifest,
  CheckpointSummary,
  CwOcrResult,
  CwPdfPageImage,
  SymbolHit,
} from './codeWorkspaceTypes';

export { remoteWorkspaceRootToken, resetWorkspaceToolsCache };

let cachedProfile: PocketCodeRuntimeProfile | null = null;

/** Force-reload profile on next tool call (after saveRuntimeProfile). */
export function invalidateRuntimeProfileCache(): void {
  cachedProfile = null;
  resetWorkspaceToolsCache();
}

export async function getActiveRuntimeProfile(): Promise<PocketCodeRuntimeProfile> {
  if (!cachedProfile) {
    cachedProfile = await loadRuntimeProfile();
  }
  return cachedProfile;
}

async function tools(): Promise<WorkspaceTools> {
  const profile = await getActiveRuntimeProfile();
  return resolveWorkspaceTools(profile);
}

/** Logical workspace root for the active profile (local path or remote://id). */
export async function activeWorkspaceRoot(localFallback = ''): Promise<string> {
  const profile = await getActiveRuntimeProfile();
  if (profile.workspaceHost === 'remote') {
    const id = profile.remote?.workspaceId?.trim() || '';
    if (!id) throw new Error('Remote workspace profile has no workspaceId. Provision or select a workspace first.');
    return remoteWorkspaceRootToken(id);
  }
  return localFallback;
}

export async function cwCanUse(
  modelPath: string | null,
  params?: number | null,
): Promise<{ allowed: boolean; reason: string }> {
  const profile = await getActiveRuntimeProfile();
  if (profile.uiShell === 'thin_client') {
    const ok =
      Boolean(modelPath?.startsWith('enterprise:') || modelPath?.startsWith('remote:'));
    return {
      allowed: ok,
      reason: ok
        ? 'Thin client: org/cloud model'
        : 'Thin client requires an enterprise or cloud model (local GGUF disabled).',
    };
  }
  const result = await invoke<{ allowed: boolean; message: string }>('cw_can_use', {
    modelPath: modelPath || '',
    params: params ?? null,
  });
  return { allowed: result.allowed, reason: result.message };
}

export async function cwListDir(workspaceRoot: string, path = '.'): Promise<DirEntryInfo[]> {
  return (await tools()).listDir(workspaceRoot, path);
}

export async function cwGlobFileSearch(workspaceRoot: string, pattern: string): Promise<string[]> {
  return (await tools()).glob(workspaceRoot, pattern);
}

export async function cwGrep(
  workspaceRoot: string,
  pattern: string,
  path?: string | null,
  glob?: string | null,
  caseInsensitive = false,
): Promise<string> {
  return (await tools()).grep(workspaceRoot, pattern, path, glob, caseInsensitive);
}

export async function cwLoadProjectRules(workspaceRoot: string): Promise<string> {
  return (await tools()).loadProjectRules(workspaceRoot);
}

export async function cwReadFile(
  workspaceRoot: string,
  path: string,
  offset = 0,
  limit = 120,
  forUi = false,
): Promise<string> {
  return (await tools()).readFile(workspaceRoot, path, offset, limit, forUi);
}

export async function cwEnsureSymbolIndex(
  workspaceRoot: string,
): Promise<[number, number]> {
  return (await tools()).ensureSymbolIndex(workspaceRoot);
}

export async function cwRepoMap(workspaceRoot: string): Promise<string> {
  return (await tools()).repoMap(workspaceRoot);
}

export async function cwFindSymbol(
  workspaceRoot: string,
  query: string,
): Promise<import('./codeWorkspaceTypes').SymbolHit[]> {
  return (await tools()).findSymbol(workspaceRoot, query);
}

export async function cwReadSymbol(
  workspaceRoot: string,
  path: string,
  name: string,
  lineStart?: number | null,
): Promise<string> {
  return (await tools()).readSymbol(workspaceRoot, path, name, lineStart);
}

export async function cwDeleteFile(workspaceRoot: string, path: string): Promise<void> {
  await (await tools()).deleteFile(workspaceRoot, path);
}

export async function cwCheckpointBegin(workspaceRoot: string): Promise<string> {
  return (await tools()).checkpointBegin(workspaceRoot);
}

export async function cwCheckpointSnapshotWrite(
  workspaceRoot: string,
  runId: string,
  path: string,
): Promise<void> {
  await (await tools()).checkpointSnapshotWrite(workspaceRoot, runId, path);
}

export async function cwCheckpointSnapshotDelete(
  workspaceRoot: string,
  runId: string,
  path: string,
): Promise<void> {
  await (await tools()).checkpointSnapshotDelete(workspaceRoot, runId, path);
}

export async function cwListCheckpoints(
  workspaceRoot: string,
): Promise<import('./codeWorkspaceTypes').CheckpointSummary[]> {
  return (await tools()).listCheckpoints(workspaceRoot);
}

export async function cwRestoreCheckpoint(workspaceRoot: string, runId: string): Promise<number> {
  return (await tools()).restoreCheckpoint(workspaceRoot, runId);
}

export async function cwRestoreCheckpointFile(
  workspaceRoot: string,
  runId: string,
  path: string,
): Promise<void> {
  await (await tools()).restoreCheckpointFile(workspaceRoot, runId, path);
}

export async function cwCheckpointManifest(
  workspaceRoot: string,
  runId: string,
): Promise<import('./codeWorkspaceTypes').CheckpointManifest> {
  return (await tools()).checkpointManifest(workspaceRoot, runId);
}

export async function cwApplyEditPreview(
  workspaceRoot: string,
  path: string,
  oldString: string,
  newString: string,
): Promise<EditPreview> {
  return (await tools()).applyEditPreview(workspaceRoot, path, oldString, newString);
}

export async function cwApplyEditWrite(
  workspaceRoot: string,
  path: string,
  content: string,
): Promise<void> {
  await (await tools()).applyEditWrite(workspaceRoot, path, content);
}

export async function cwRunSandbox(
  workspaceRoot: string,
  request: SandboxPendingRequest,
): Promise<SandboxRunResult> {
  return (await tools()).runSandbox(workspaceRoot, request);
}

export async function cwListRunners(): Promise<RunnersStatus> {
  return (await tools()).listRunners();
}

export async function cwTerminalStart(
  workspaceRoot: string,
  request: TerminalStartRequest,
): Promise<TerminalStartInfo> {
  return (await tools()).terminalStart(workspaceRoot, request);
}

export async function cwTerminalRead(
  id: string,
  tailBytes: number | null = null,
): Promise<TerminalSnapshot> {
  return (await tools()).terminalRead(id, tailBytes);
}

export async function cwTerminalKill(id: string): Promise<TerminalSnapshot> {
  return (await tools()).terminalKill(id);
}

export async function cwTerminalList(): Promise<TerminalSnapshot[]> {
  return (await tools()).terminalList();
}

export async function cwPlanWrite(
  workspaceRoot: string,
  id: string | null,
  title: string,
  markdown: string,
  todos: string[],
  status?: string | null,
): Promise<PocketCodePlan> {
  return (await tools()).planWrite(workspaceRoot, id, title, markdown, todos, status);
}

export async function cwPlanRead(workspaceRoot: string, id: string): Promise<PocketCodePlan> {
  return (await tools()).planRead(workspaceRoot, id);
}

export async function cwPlanList(
  workspaceRoot: string,
): Promise<Array<{ id: string; title: string; status: string; updated_at: number; todo_count: number }>> {
  return (await tools()).planList(workspaceRoot);
}

export async function cwPlanUpdateMarkdown(
  workspaceRoot: string,
  id: string,
  markdown: string,
  todos?: PocketCodePlanTodo[] | null,
): Promise<PocketCodePlan> {
  return (await tools()).planUpdateMarkdown(workspaceRoot, id, markdown, todos);
}

export async function cwPlanUpdateStatus(
  workspaceRoot: string,
  id: string,
  status: string,
  checkpointRunId?: string | null,
): Promise<PocketCodePlan> {
  return (await tools()).planUpdateStatus(workspaceRoot, id, status, checkpointRunId);
}

/** OCR stays on the desktop (local image path) — not part of workspace tool transport. */
export async function cwOcrImage(path: string): Promise<import('./codeWorkspaceTypes').CwOcrResult> {
  return invoke('cw_ocr_image', { path });
}

/** Extract/OCR all PDFs in a PocketCode workspace into app-data sidecars (Unlimited-OCR preferred). */
export async function cwPreparePdfs(
  workspaceRoot: string,
): Promise<import('./codeWorkspaceTypes').CwPdfPrepareReport> {
  return invoke('cw_prepare_pdfs', { workspaceRoot });
}

export async function cwPreparePdf(
  workspaceRoot: string,
  path: string,
): Promise<import('./codeWorkspaceTypes').CwPdfPrepareItem> {
  return invoke('cw_prepare_pdf', { workspaceRoot, path });
}

export async function cwImageBase64(path: string): Promise<[string, string]> {
  return invoke<[string, string]>('cw_image_base64', { path });
}

export async function cwSaveTempImage(base64: string, mime?: string | null): Promise<string> {
  return invoke<string>('cw_save_temp_image', {
    base64,
    mime: mime ?? null,
  });
}

export async function cwPdfPageImages(
  path: string,
  maxPages = 3,
): Promise<import('./codeWorkspaceTypes').CwPdfPageImage[]> {
  return invoke('cw_pdf_page_images', { path, maxPages });
}
