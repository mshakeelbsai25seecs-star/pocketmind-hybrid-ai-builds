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

export async function cwCanUse(
  modelPath: string | null,
  params?: number | null,
): Promise<{ allowed: boolean; reason: string }> {
  const result = await invoke<{ allowed: boolean; message: string }>('cw_can_use', {
    modelPath: modelPath || '',
    params: params ?? null,
  });
  return { allowed: result.allowed, reason: result.message };
}

export async function cwListDir(workspaceRoot: string, path = '.'): Promise<DirEntryInfo[]> {
  return invoke<DirEntryInfo[]>('cw_list_dir', { workspaceRoot, rel: path });
}

export async function cwGlobFileSearch(workspaceRoot: string, pattern: string): Promise<string[]> {
  return invoke<string[]>('cw_glob', { workspaceRoot, pattern });
}

export async function cwGrep(
  workspaceRoot: string,
  pattern: string,
  path?: string | null,
  glob?: string | null,
  caseInsensitive = false,
): Promise<string> {
  return invoke<string>('cw_grep', {
    workspaceRoot,
    pattern,
    path: path ?? null,
    glob: glob ?? null,
    caseInsensitive,
  });
}

export async function cwReadFile(
  workspaceRoot: string,
  path: string,
  offset = 0,
  limit = 120,
  forUi = false,
): Promise<string> {
  return invoke<string>('cw_read_file', {
    workspaceRoot,
    path,
    offset,
    limit,
    forUi,
  });
}

export interface SymbolHit {
  path: string;
  name: string;
  kind: string;
  line_start: number;
  line_end: number;
  signature: string;
}

export async function cwEnsureSymbolIndex(
  workspaceRoot: string,
): Promise<[number, number]> {
  return invoke<[number, number]>('cw_ensure_symbol_index', { workspaceRoot });
}

export async function cwRepoMap(workspaceRoot: string): Promise<string> {
  return invoke<string>('cw_repo_map', { workspaceRoot });
}

export async function cwFindSymbol(
  workspaceRoot: string,
  query: string,
): Promise<SymbolHit[]> {
  return invoke<SymbolHit[]>('cw_find_symbol', { workspaceRoot, query });
}

export async function cwReadSymbol(
  workspaceRoot: string,
  path: string,
  name: string,
  lineStart?: number | null,
): Promise<string> {
  return invoke<string>('cw_read_symbol', {
    workspaceRoot,
    path,
    name,
    lineStart: lineStart ?? null,
  });
}

export async function cwDeleteFile(workspaceRoot: string, path: string): Promise<void> {
  await invoke('cw_delete_file', { workspaceRoot, path });
}

export interface CheckpointSummary {
  run_id: string;
  created_at: number;
  file_count: number;
}

export interface CheckpointManifest {
  run_id: string;
  created_at: number;
  workspace_root: string;
  files: Array<{
    path: string;
    action: 'write' | 'create' | 'delete';
    existed: boolean;
    snapshot_rel?: string | null;
  }>;
}

export async function cwCheckpointBegin(workspaceRoot: string): Promise<string> {
  return invoke<string>('cw_checkpoint_begin', { workspaceRoot });
}

export async function cwCheckpointSnapshotWrite(
  workspaceRoot: string,
  runId: string,
  path: string,
): Promise<void> {
  await invoke('cw_checkpoint_snapshot_write', { workspaceRoot, runId, path });
}

export async function cwCheckpointSnapshotDelete(
  workspaceRoot: string,
  runId: string,
  path: string,
): Promise<void> {
  await invoke('cw_checkpoint_snapshot_delete', { workspaceRoot, runId, path });
}

export async function cwListCheckpoints(workspaceRoot: string): Promise<CheckpointSummary[]> {
  return invoke<CheckpointSummary[]>('cw_list_checkpoints', { workspaceRoot });
}

export async function cwRestoreCheckpoint(workspaceRoot: string, runId: string): Promise<number> {
  return invoke<number>('cw_restore_checkpoint', { workspaceRoot, runId });
}

export async function cwRestoreCheckpointFile(
  workspaceRoot: string,
  runId: string,
  path: string,
): Promise<void> {
  await invoke('cw_restore_checkpoint_file', { workspaceRoot, runId, path });
}

export async function cwCheckpointManifest(
  workspaceRoot: string,
  runId: string,
): Promise<CheckpointManifest> {
  return invoke<CheckpointManifest>('cw_checkpoint_manifest', { workspaceRoot, runId });
}

export async function cwApplyEditPreview(
  workspaceRoot: string,
  path: string,
  oldString: string,
  newString: string,
): Promise<EditPreview> {
  return invoke<EditPreview>('cw_apply_edit_preview', {
    workspaceRoot,
    path,
    oldString,
    newString,
  });
}

export async function cwApplyEditWrite(
  workspaceRoot: string,
  path: string,
  content: string,
): Promise<void> {
  await invoke('cw_apply_edit_write', { workspaceRoot, path, content });
}

export async function cwRunSandbox(
  workspaceRoot: string,
  request: SandboxPendingRequest,
): Promise<SandboxRunResult> {
  if (request.mode === 'cli') {
    return invoke<SandboxRunResult>('cw_run_sandbox', {
      workspaceRoot,
      language: null,
      script: null,
      args: null,
      argv: request.argv,
    });
  }
  return invoke<SandboxRunResult>('cw_run_sandbox', {
    workspaceRoot,
    language: request.language,
    script: request.code,
    args: request.args ?? null,
    argv: null,
  });
}

export async function cwListRunners(): Promise<RunnersStatus> {
  return invoke<RunnersStatus>('cw_list_runners');
}

export async function cwPlanWrite(
  workspaceRoot: string,
  id: string | null,
  title: string,
  markdown: string,
  todos: string[],
  status?: string | null,
): Promise<PocketCodePlan> {
  return invoke<PocketCodePlan>('cw_plan_write', {
    workspaceRoot,
    id,
    title,
    markdown,
    todos,
    status: status ?? null,
  });
}

export async function cwPlanRead(workspaceRoot: string, id: string): Promise<PocketCodePlan> {
  return invoke<PocketCodePlan>('cw_plan_read', { workspaceRoot, id });
}

export async function cwPlanList(
  workspaceRoot: string,
): Promise<Array<{ id: string; title: string; status: string; updated_at: number; todo_count: number }>> {
  return invoke('cw_plan_list', { workspaceRoot });
}

export async function cwPlanUpdateMarkdown(
  workspaceRoot: string,
  id: string,
  markdown: string,
  todos?: PocketCodePlanTodo[] | null,
): Promise<PocketCodePlan> {
  return invoke<PocketCodePlan>('cw_plan_update_markdown', {
    workspaceRoot,
    id,
    markdown,
    todos: todos ?? null,
  });
}

export async function cwPlanUpdateStatus(
  workspaceRoot: string,
  id: string,
  status: string,
  checkpointRunId?: string | null,
): Promise<PocketCodePlan> {
  return invoke<PocketCodePlan>('cw_plan_update_status', {
    workspaceRoot,
    id,
    status,
    checkpointRunId: checkpointRunId ?? null,
  });
}

export interface CwOcrResult {
  text: string;
  engine: string;
  ok: boolean;
  message: string;
}

export async function cwOcrImage(path: string): Promise<CwOcrResult> {
  return invoke<CwOcrResult>('cw_ocr_image', { path });
}

export async function cwImageBase64(path: string): Promise<[string, string]> {
  return invoke<[string, string]>('cw_image_base64', { path });
}

export interface CwPdfPageImage {
  page: number;
  mime: string;
  base64: string;
}

export async function cwPdfPageImages(path: string, maxPages = 3): Promise<CwPdfPageImage[]> {
  return invoke<CwPdfPageImage[]>('cw_pdf_page_images', { path, maxPages });
}
