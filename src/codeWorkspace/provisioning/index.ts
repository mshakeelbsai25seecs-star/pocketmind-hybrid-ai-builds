import { invoke } from '@tauri-apps/api/tauri';
import type { PocketCodeRuntimeProfile, WorkspaceProvision } from '../runtimeProfile';
import type { ProvisionContext, ProvisionResult } from './types';
import { provisionPreloaded, listRemoteWorkspaces } from './preloaded';
import { provisionClientSync, provisionClientSyncChunk } from './clientSync';
import { provisionGitClone } from './gitClone';

export type { ProvisionContext, ProvisionResult } from './types';
export { provisionPreloaded, listRemoteWorkspaces } from './preloaded';
export { provisionClientSync, provisionClientSyncChunk } from './clientSync';
export { provisionGitClone } from './gitClone';

export async function buildProvisionContext(
  profile: PocketCodeRuntimeProfile,
): Promise<ProvisionContext> {
  if (profile.workspaceHost !== 'remote' || !profile.remote?.baseUrl?.trim()) {
    throw new Error('Provisioning requires a remote workspace profile with agent-host baseUrl.');
  }
  const token = await invoke<string>('get_enterprise_server_token').catch(() => '');
  if (!token.trim()) {
    throw new Error('Organization API token required for workspace provisioning.');
  }
  return {
    agentHostBaseUrl: profile.remote.baseUrl.trim(),
    token,
  };
}

/** Dispatch to the correct provisioner — never mixes modes. */
export async function runProvision(
  profile: PocketCodeRuntimeProfile,
  mode: WorkspaceProvision,
  payload: Record<string, unknown>,
): Promise<ProvisionResult> {
  if (mode === 'none' || profile.workspaceHost !== 'remote') {
    throw new Error('Cannot provision for a local workspace profile.');
  }
  if (profile.provision !== mode) {
    throw new Error(
      `Active profile provision is "${profile.provision}", but "${mode}" was requested. Switch the runtime preset first.`,
    );
  }
  const ctx = await buildProvisionContext(profile);
  switch (mode) {
    case 'preloaded':
      return provisionPreloaded(ctx, {
        workspaceId: String(payload.workspaceId || profile.remote?.workspaceId || ''),
        serverPath: String(payload.serverPath || ''),
        readOnly: Boolean(payload.readOnly),
      });
    case 'client_sync':
      return provisionClientSync(ctx, {
        workspaceId: String(payload.workspaceId || profile.remote?.workspaceId || '') || undefined,
        archiveBase64: String(payload.archiveBase64 || ''),
        format: (payload.format as 'tar' | 'zip') || 'zip',
        projectName: payload.projectName ? String(payload.projectName) : undefined,
      });
    case 'git_clone':
      return provisionGitClone(ctx, {
        workspaceId: String(payload.workspaceId || profile.remote?.workspaceId || '') || undefined,
        url: String(payload.url || ''),
        ref: payload.ref ? String(payload.ref) : undefined,
        token: payload.token ? String(payload.token) : undefined,
        depth: typeof payload.depth === 'number' ? payload.depth : 1,
      });
    default:
      throw new Error(`Unknown provision mode: ${mode}`);
  }
}
