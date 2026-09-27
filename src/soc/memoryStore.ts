import { invoke } from '@tauri-apps/api/tauri';
import { browserListMemory, browserSaveMemory } from './browserStore';
import { newMemoryId, normalizeMemoryKey } from './ids';
import { isSocTauriRuntime } from './runtime';
import type { SocMemoryEntry } from './types';

export async function socListMemory(): Promise<SocMemoryEntry[]> {
  if (!isSocTauriRuntime()) return browserListMemory();
  try {
    const raw = await invoke<SocMemoryEntry[]>('soc_list_memory');
    return Array.isArray(raw) ? raw : [];
  } catch {
    return browserListMemory();
  }
}

export async function socSaveMemory(entries: SocMemoryEntry[]): Promise<SocMemoryEntry[]> {
  if (!isSocTauriRuntime()) return browserSaveMemory(entries);
  try {
    return await invoke<SocMemoryEntry[]>('soc_save_memory', { entries });
  } catch {
    return browserSaveMemory(entries);
  }
}

export function createMemoryEntry(input: {
  entityType: SocMemoryEntry['entityType'];
  key: string;
  note: string;
  classification: SocMemoryEntry['classification'];
  createdBy: string;
  createdFromCaseId?: string;
}): SocMemoryEntry {
  const now = Date.now();
  const key = normalizeMemoryKey(input.entityType, input.key);
  if (!key) throw new Error('Memory key is required.');
  if (!input.note.trim()) throw new Error('Memory note is required.');
  return {
    schemaVersion: 1,
    id: newMemoryId(),
    entityType: input.entityType,
    key,
    note: input.note.trim(),
    classification: input.classification,
    active: true,
    createdAt: now,
    updatedAt: now,
    createdBy: input.createdBy.trim() || 'analyst',
    createdFromCaseId: input.createdFromCaseId,
  };
}

export function matchMemoryForCase(
  entries: SocMemoryEntry[],
  entities: {
    sourceIp?: string;
    destinationIp?: string;
    username?: string;
    asset?: string;
    hostnames?: string[];
  },
): SocMemoryEntry[] {
  const active = entries.filter(e => e.active);
  const hits: SocMemoryEntry[] = [];
  const seen = new Set<string>();
  const consider = (entityType: SocMemoryEntry['entityType'], value?: string) => {
    if (!value?.trim()) return;
    const key = normalizeMemoryKey(entityType, value);
    for (const entry of active) {
      if (entry.entityType !== entityType) continue;
      if (entry.key !== key) continue;
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      hits.push(entry);
    }
  };
  consider('ip', entities.sourceIp);
  consider('ip', entities.destinationIp);
  consider('user', entities.username);
  consider('host', entities.asset);
  for (const host of entities.hostnames || []) consider('host', host);
  return hits;
}
