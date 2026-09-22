import { ONLINE_CHAT_MODELS } from './modelCatalog';
import type { LocalModelRecord, OnlineChatModel } from './types';

/** Build the store id for an online catalog model. */
export function remoteModelPath(model: OnlineChatModel): string {
  return `remote:${model.provider}/${model.modelId}`;
}

export function isRemoteModelPath(path: string | null | undefined): boolean {
  return !!path && (path.startsWith('remote:') || path.startsWith('enterprise:'));
}

export function isOnlineRemotePath(path: string | null | undefined): boolean {
  return !!path && path.startsWith('remote:');
}

/** Short label for UI (Chat, Models, PocketCode). */
export function answerModelLabel(path: string | null | undefined, localModels: LocalModelRecord[] = []): string {
  if (!path) return 'No model selected';
  if (path.startsWith('enterprise:')) {
    return path.slice('enterprise:'.length) || 'Organization server';
  }
  if (path.startsWith('remote:')) {
    const rest = path.slice('remote:'.length);
    const slash = rest.indexOf('/');
    const provider = slash >= 0 ? rest.slice(0, slash) : rest;
    const modelId = slash >= 0 ? rest.slice(slash + 1) : '';
    const catalog = ONLINE_CHAT_MODELS.find(
      m => m.provider === provider && m.modelId === modelId,
    );
    if (catalog) return `${catalog.name} (${catalog.providerName})`;
    return modelId ? `${provider} / ${modelId}` : provider;
  }
  const local = localModels.find(m => m.path === path);
  if (local?.name) return local.name;
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

export function answerModelKind(path: string | null | undefined): 'local' | 'online' | 'enterprise' | 'none' {
  if (!path) return 'none';
  if (path.startsWith('enterprise:')) return 'enterprise';
  if (path.startsWith('remote:')) return 'online';
  return 'local';
}

export function backendForModelPath(path: string): 'llama.cpp' | 'remote' | 'enterprise' {
  if (path.startsWith('enterprise:')) return 'enterprise';
  if (path.startsWith('remote:')) return 'remote';
  return 'llama.cpp';
}
