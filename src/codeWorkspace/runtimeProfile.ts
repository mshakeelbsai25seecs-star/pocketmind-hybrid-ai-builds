/**
 * PocketCode runtime profile — orthogonal axes that must never be conflated.
 * Inference host ≠ workspace host ≠ provision mode ≠ UI shell.
 */

import { getSetting, setSetting } from '../api/powerFeatures';

export type InferenceHost = 'local' | 'cloud' | 'enterprise';
export type WorkspaceHost = 'local' | 'remote';
export type WorkspaceProvision = 'none' | 'preloaded' | 'client_sync' | 'git_clone';
export type UiShell = 'desktop_full' | 'thin_client';

export interface PocketCodeRemoteConfig {
  /** Agent-host base URL (may differ from LLM base_url). */
  baseUrl: string;
  workspaceId: string;
  sessionId?: string;
}

export interface PocketCodeRuntimeProfile {
  inferenceHost: InferenceHost;
  workspaceHost: WorkspaceHost;
  /** Must be `none` when workspaceHost=local. */
  provision: WorkspaceProvision;
  /** thin_client requires workspaceHost=remote. */
  uiShell: UiShell;
  remote?: PocketCodeRemoteConfig;
}

export const RUNTIME_PROFILE_KEY = 'pocketcode.runtime_profile';

export type RuntimePresetId =
  | 'LocalClassic'
  | 'HybridBrain'
  | 'RemoteAgentPreloaded'
  | 'RemoteAgentSync'
  | 'RemoteAgentGit'
  | 'ThinClientPreloaded'
  | 'ThinClientSync'
  | 'ThinClientGit';

export const RUNTIME_PRESETS: Record<
  RuntimePresetId,
  { label: string; description: string; profile: PocketCodeRuntimeProfile }
> = {
  LocalClassic: {
    label: 'Local classic',
    description: 'Local or cloud/enterprise LLM; tools run on this PC.',
    profile: {
      inferenceHost: 'local',
      workspaceHost: 'local',
      provision: 'none',
      uiShell: 'desktop_full',
    },
  },
  HybridBrain: {
    label: 'Hybrid brain',
    description: 'Org/cloud LLM; tools and files stay on this PC.',
    profile: {
      inferenceHost: 'enterprise',
      workspaceHost: 'local',
      provision: 'none',
      uiShell: 'desktop_full',
    },
  },
  RemoteAgentPreloaded: {
    label: 'Remote agent · preloaded',
    description: 'Server tools on an admin-mounted workspace.',
    profile: {
      inferenceHost: 'enterprise',
      workspaceHost: 'remote',
      provision: 'preloaded',
      uiShell: 'desktop_full',
      remote: { baseUrl: '', workspaceId: '' },
    },
  },
  RemoteAgentSync: {
    label: 'Remote agent · client sync',
    description: 'Upload/sync local project to server, then run tools there.',
    profile: {
      inferenceHost: 'enterprise',
      workspaceHost: 'remote',
      provision: 'client_sync',
      uiShell: 'desktop_full',
      remote: { baseUrl: '', workspaceId: '' },
    },
  },
  RemoteAgentGit: {
    label: 'Remote agent · git clone',
    description: 'Server clones a git URL into a session workspace.',
    profile: {
      inferenceHost: 'enterprise',
      workspaceHost: 'remote',
      provision: 'git_clone',
      uiShell: 'desktop_full',
      remote: { baseUrl: '', workspaceId: '' },
    },
  },
  ThinClientPreloaded: {
    label: 'Thin client · preloaded',
    description: 'UI-only; remote tools + preloaded server workspace.',
    profile: {
      inferenceHost: 'enterprise',
      workspaceHost: 'remote',
      provision: 'preloaded',
      uiShell: 'thin_client',
      remote: { baseUrl: '', workspaceId: '' },
    },
  },
  ThinClientSync: {
    label: 'Thin client · client sync',
    description: 'UI-only; sync project then remote tools.',
    profile: {
      inferenceHost: 'enterprise',
      workspaceHost: 'remote',
      provision: 'client_sync',
      uiShell: 'thin_client',
      remote: { baseUrl: '', workspaceId: '' },
    },
  },
  ThinClientGit: {
    label: 'Thin client · git clone',
    description: 'UI-only; server git clone then remote tools.',
    profile: {
      inferenceHost: 'enterprise',
      workspaceHost: 'remote',
      provision: 'git_clone',
      uiShell: 'thin_client',
      remote: { baseUrl: '', workspaceId: '' },
    },
  },
};

export function defaultRuntimeProfile(): PocketCodeRuntimeProfile {
  return { ...RUNTIME_PRESETS.LocalClassic.profile };
}

export function validateRuntimeProfile(
  profile: PocketCodeRuntimeProfile,
): { ok: true } | { ok: false; reason: string } {
  if (profile.workspaceHost === 'local' && profile.provision !== 'none') {
    return { ok: false, reason: 'Local workspace cannot use a remote provision mode.' };
  }
  if (profile.workspaceHost === 'remote' && profile.provision === 'none') {
    return { ok: false, reason: 'Remote workspace requires preloaded, client_sync, or git_clone.' };
  }
  if (profile.uiShell === 'thin_client' && profile.workspaceHost !== 'remote') {
    return { ok: false, reason: 'Thin client requires workspaceHost=remote.' };
  }
  if (profile.workspaceHost === 'remote') {
    const base = profile.remote?.baseUrl?.trim() || '';
    const wid = profile.remote?.workspaceId?.trim() || '';
    if (!base) {
      return { ok: false, reason: 'Remote workspace requires agent-host baseUrl.' };
    }
    if (!wid && profile.provision === 'preloaded') {
      return { ok: false, reason: 'Preloaded mode requires a workspaceId.' };
    }
  }
  return { ok: true };
}

export function profileBannerLabel(profile: PocketCodeRuntimeProfile): string {
  const tools = profile.workspaceHost === 'remote' ? 'Remote tools' : 'Local tools';
  const prov =
    profile.provision === 'none'
      ? 'Local files'
      : profile.provision === 'preloaded'
        ? 'Preloaded'
        : profile.provision === 'client_sync'
          ? 'Client sync'
          : 'Git clone';
  const llm =
    profile.inferenceHost === 'enterprise'
      ? 'Enterprise LLM'
      : profile.inferenceHost === 'cloud'
        ? 'Cloud LLM'
        : 'Local LLM';
  const shell = profile.uiShell === 'thin_client' ? ' · Thin client' : '';
  return `${tools} · ${prov} · ${llm}${shell}`;
}

export function inferInferenceHostFromModel(modelPath: string | null | undefined): InferenceHost {
  if (!modelPath) return 'local';
  if (modelPath.startsWith('enterprise:')) return 'enterprise';
  if (modelPath.startsWith('remote:')) return 'cloud';
  return 'local';
}

/** Merge selected model into profile inference axis without touching workspace axes. */
export function withInferenceFromModel(
  profile: PocketCodeRuntimeProfile,
  modelPath: string | null | undefined,
): PocketCodeRuntimeProfile {
  return { ...profile, inferenceHost: inferInferenceHostFromModel(modelPath) };
}

export async function loadRuntimeProfile(): Promise<PocketCodeRuntimeProfile> {
  try {
    const raw = await getSetting(RUNTIME_PROFILE_KEY);
    if (!raw?.trim()) return defaultRuntimeProfile();
    const parsed = JSON.parse(raw) as PocketCodeRuntimeProfile;
    const merged: PocketCodeRuntimeProfile = {
      ...defaultRuntimeProfile(),
      ...parsed,
      remote: parsed.remote
        ? {
            baseUrl: parsed.remote.baseUrl || '',
            workspaceId: parsed.remote.workspaceId || '',
            sessionId: parsed.remote.sessionId,
          }
        : undefined,
    };
    const v = validateRuntimeProfile(merged);
    if (!v.ok && merged.workspaceHost === 'local') {
      // Incomplete remote configs while idle on local are fine — normalize.
      return { ...merged, provision: 'none', remote: undefined };
    }
    return merged;
  } catch {
    return defaultRuntimeProfile();
  }
}

export async function saveRuntimeProfile(profile: PocketCodeRuntimeProfile): Promise<void> {
  const v = validateRuntimeProfile(profile);
  if (!v.ok) {
    // Allow saving incomplete remote drafts only when switching away from active remote use;
    // still persist so the UI can complete fields.
    if (profile.workspaceHost === 'remote' && (!profile.remote?.baseUrl || !profile.remote?.workspaceId)) {
      await setSetting(RUNTIME_PROFILE_KEY, JSON.stringify(profile));
      return;
    }
    throw new Error(v.reason);
  }
  await setSetting(RUNTIME_PROFILE_KEY, JSON.stringify(profile));
}

export function applyPreset(
  id: RuntimePresetId,
  previous?: PocketCodeRuntimeProfile,
): PocketCodeRuntimeProfile {
  const base = { ...RUNTIME_PRESETS[id].profile };
  if (base.workspaceHost === 'remote') {
    base.remote = {
      baseUrl: previous?.remote?.baseUrl || '',
      workspaceId: previous?.remote?.workspaceId || '',
      sessionId: previous?.remote?.sessionId,
    };
  }
  return base;
}

export function isThinClient(profile: PocketCodeRuntimeProfile): boolean {
  return profile.uiShell === 'thin_client';
}

export function usesRemoteWorkspace(profile: PocketCodeRuntimeProfile): boolean {
  return profile.workspaceHost === 'remote';
}
