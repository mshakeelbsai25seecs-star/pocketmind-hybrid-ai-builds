import { open } from '@tauri-apps/api/dialog';
import { invoke } from '@tauri-apps/api/tauri';
import {
  loadDeploymentConfigMapped,
  saveDeploymentConfigMapped,
  type DeploymentConfig,
} from './deploymentConfig';
import { formatInvokeError } from './lib/formatInvokeError';
import { useAppStore } from './store';

export type StorageAccessProbe = {
  ok: boolean;
  dataRoot: string;
  writable: boolean;
  message: string;
  suggestedRoots: string[];
};

/** True when backend signals the user must pick a writable data folder. */
export function needsWritableDataRoot(err: unknown): boolean {
  const text = formatInvokeError(err).toLowerCase();
  return (
    text.includes('needs_writable_data_root=true')
    || text.includes('access denied')
    || text.includes('permission denied')
    || text.includes('no writable data folder')
    || text.includes('unauthorizedaccess')
    || (text.includes('not enough space') && text.includes('deployment'))
  );
}

export async function probeStorageAccess(): Promise<StorageAccessProbe> {
  const raw = await invoke<{
    ok: boolean;
    data_root: string;
    writable: boolean;
    message: string;
    suggested_roots: string[];
  }>('probe_storage_access');
  return {
    ok: raw.ok,
    dataRoot: raw.data_root,
    writable: raw.writable,
    message: raw.message,
    suggestedRoots: raw.suggested_roots || [],
  };
}

function remapUnderRoot(path: string, fromRoot: string, toRoot: string): string {
  const norm = (v: string) => v.replace(/\//g, '\\').replace(/[\\/]+$/, '').toLowerCase();
  const p = path.replace(/\//g, '\\');
  const from = fromRoot.replace(/\//g, '\\').replace(/[\\/]+$/, '');
  const to = toRoot.replace(/\//g, '\\').replace(/[\\/]+$/, '');
  if (!from || !p) return path;
  if (norm(p) === norm(from)) return to;
  const prefix = from + '\\';
  if (p.toLowerCase().startsWith(prefix.toLowerCase())) {
    return to + p.slice(from.length);
  }
  return path;
}

/** Remap deployment paths onto a newly chosen writable data root and persist. */
export async function applyWritableDataRoot(selectedFolder: string): Promise<DeploymentConfig> {
  const root = selectedFolder.trim().replace(/[\\/]+$/, '');
  if (!root) throw new Error('No folder selected.');
  const current = await loadDeploymentConfigMapped();
  const prev = (current.dataRoot || '').trim();
  const next: DeploymentConfig = {
    ...current,
    dataRoot: root,
    modelsDir: prev ? remapUnderRoot(current.modelsDir, prev, root) : `${root}\\models`,
    embeddingModelPath: prev
      ? remapUnderRoot(current.embeddingModelPath, prev, root)
      : `${root}\\models\\embeddings\\Qwen3-Embedding-8B-Q4_K_M.gguf`,
    socDataRoot: prev ? remapUnderRoot(current.socDataRoot, prev, root) : `${root}\\company-data`,
    exportDir: prev ? remapUnderRoot(current.exportDir, prev, root) : `${root}\\exports`,
    denseIndexPath: prev
      ? remapUnderRoot(current.denseIndexPath, prev, root)
      : `${root}\\indexes\\nexus-soc-dense-index.json`,
    rerankerModelPath: prev
      ? remapUnderRoot(current.rerankerModelPath, prev, root)
      : `${root}\\models\\rerankers\\Qwen3-Reranker-4B-Q4_K_M.gguf`,
  };
  const saved = await saveDeploymentConfigMapped(next);
  useAppStore.getState().setDeploymentConfig(saved);
  useAppStore.getState().setModelsDir(saved.modelsDir);
  await invoke('ensure_deployment_directories').catch(() => undefined);
  return saved;
}

/**
 * Open the real Windows folder picker so the user can grant a writable data location.
 * Returns the saved config, or null if cancelled.
 */
export async function chooseWritableDataRoot(opts?: {
  title?: string;
  defaultPath?: string;
}): Promise<DeploymentConfig | null> {
  const selected = await open({
    directory: true,
    multiple: false,
    title: opts?.title || 'Choose a writable PocketMind data folder',
    defaultPath: opts?.defaultPath || undefined,
  });
  if (typeof selected !== 'string' || !selected.trim()) return null;
  return applyWritableDataRoot(selected.trim());
}
