import { invoke } from '@tauri-apps/api/tauri';
import type { DirEntryInfo, EditPreview, SandboxRunResult } from '../codeWorkspace/types';

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
  limit = 200,
): Promise<string> {
  return invoke<string>('cw_read_file', {
    workspaceRoot,
    path,
    offset,
    limit,
  });
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
  language: 'python' | 'javascript',
  code: string,
  args?: string[],
): Promise<SandboxRunResult> {
  return invoke<SandboxRunResult>('cw_run_sandbox', {
    workspaceRoot,
    language,
    script: code,
    args: args ?? null,
  });
}
