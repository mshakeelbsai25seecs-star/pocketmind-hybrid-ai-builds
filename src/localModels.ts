import type { LocalModelRecord } from './types';

/** Non-primary multi-part shards must not be selected as the chat model. */
export function isSecondaryGgufShard(fileNameOrPath: string): boolean {
  const leaf = fileNameOrPath.replace(/\\/g, '/').split('/').pop() || fileNameOrPath;
  const lower = leaf.toLowerCase();
  const ofIdx = lower.lastIndexOf('-of-');
  if (ofIdx < 0) return false;
  const before = lower.slice(0, ofIdx);
  const dash = before.lastIndexOf('-');
  if (dash < 0) return false;
  const num = before.slice(dash + 1);
  if (!/^\d+$/.test(num)) return false;
  return Number.parseInt(num, 10) !== 1;
}

export function isMmprojPath(fileNameOrPath: string): boolean {
  return fileNameOrPath.toLowerCase().includes('mmproj');
}

/** Models shown in Chat / Models picker for local GGUF use. */
export function isChatSelectableLocalModel(model: Pick<LocalModelRecord, 'name' | 'path' | 'backend'>): boolean {
  if ((model.backend || '').toLowerCase() === 'mmproj') return false;
  if ((model.backend || '').toLowerCase() === 'gguf_shard') return false;
  if (isMmprojPath(model.name) || isMmprojPath(model.path)) return false;
  if (isSecondaryGgufShard(model.name) || isSecondaryGgufShard(model.path)) return false;
  return true;
}

export function filterChatSelectableLocalModels(models: LocalModelRecord[]): LocalModelRecord[] {
  return models.filter(isChatSelectableLocalModel);
}
