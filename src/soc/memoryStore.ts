import { invoke } from '@tauri-apps/api/tauri';
import { newMemoryId, normalizeMemoryKey } from './ids';
import type { SocMemoryEntry } from './types';

export async function socListMemory(): Promise<SocMemoryEntry[]> {
  const raw = await invoke<SocMemoryEntry[]>('soc_list_memory');
  return Array.isArray(raw) ? raw : [];
}

export async function socSaveMemory(entries: SocMemoryEntry[]): Promise<SocMemoryEntry[]> {
  return invoke<SocMemoryEntry[]>('soc_save_memory', { entries });
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
  return {
    schemaVersion: 1,
    id: newMemoryId(),
    entityType: input.entityType,
    key: normalizeMemoryKey(input.entityType, input.key),
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
