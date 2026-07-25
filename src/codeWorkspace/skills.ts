import { invoke } from '@tauri-apps/api/tauri';
import { getSetting, setSetting } from '../api/powerFeatures';
import { BUILTIN_SKILLS } from './builtinSkills';

export interface SkillInfo {
  id: string;
  name: string;
  description: string;
  path: string;
  source: string;
  body: string;
}

const ENABLED_KEY = 'cw.enabled_skills';
const MAX_SKILLS_CHARS = 7000;

export async function listAllSkills(workspaceRoot?: string | null): Promise<SkillInfo[]> {
  const discovered = await invoke<SkillInfo[]>('cw_list_skills', {
    workspaceRoot: workspaceRoot?.trim() || null,
  }).catch(() => [] as SkillInfo[]);
  const builtins: SkillInfo[] = BUILTIN_SKILLS.map(s => ({
    id: s.id,
    name: s.name,
    description: s.description,
    path: '',
    source: 'builtin',
    body: s.body,
  }));
  const merged = [...builtins];
  for (const s of discovered) {
    if (!merged.some(m => m.id === s.id)) merged.push(s);
  }
  return merged;
}

export async function getEnabledSkillIds(): Promise<string[]> {
  const raw = await getSetting(ENABLED_KEY).catch(() => null);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map(String).filter(Boolean);
  } catch {
    return [];
  }
}

export async function setEnabledSkillIds(ids: string[]): Promise<void> {
  await setSetting(ENABLED_KEY, JSON.stringify([...new Set(ids)]));
}

export async function toggleSkillEnabled(id: string, enabled: boolean): Promise<string[]> {
  const cur = await getEnabledSkillIds();
  const next = enabled ? [...cur.filter(x => x !== id), id] : cur.filter(x => x !== id);
  await setEnabledSkillIds(next);
  return next;
}

/** Build capped markdown block for enabled skills. */
export async function loadEnabledSkillsMarkdown(workspaceRoot?: string | null): Promise<string> {
  const [all, enabled] = await Promise.all([
    listAllSkills(workspaceRoot),
    getEnabledSkillIds(),
  ]);
  if (enabled.length === 0) return '';
  const picked = all.filter(s => enabled.includes(s.id));
  if (picked.length === 0) return '';
  let out = 'Active skills (follow these instructions):\n';
  for (const s of picked) {
    const block = `\n### ${s.name}\n${s.body.trim()}\n`;
    if (out.length + block.length > MAX_SKILLS_CHARS) {
      out += '\n[Additional skills truncated for context budget.]\n';
      break;
    }
    out += block;
  }
  return out.trim();
}

export async function getSkillsDirs(workspaceRoot?: string | null): Promise<{ user: string; workspace: string | null }> {
  return invoke('cw_skills_dirs', { workspaceRoot: workspaceRoot?.trim() || null });
}
