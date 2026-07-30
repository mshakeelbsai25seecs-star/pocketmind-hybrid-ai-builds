import { provisionFetch } from './http';
import type { ProvisionContext, ProvisionResult } from './types';

/** Bind an existing server path as a workspace (admin-mounted). */
export async function provisionPreloaded(
  ctx: ProvisionContext,
  input: { workspaceId?: string; serverPath: string; readOnly?: boolean },
): Promise<ProvisionResult> {
  return provisionFetch<ProvisionResult>(ctx, '/v1/workspaces/provision/preloaded', {
    method: 'POST',
    json: {
      workspace_id: input.workspaceId || null,
      server_path: input.serverPath,
      read_only: Boolean(input.readOnly),
    },
  });
}

export async function listRemoteWorkspaces(
  ctx: ProvisionContext,
): Promise<Array<{ id: string; root_path: string; provision: string; read_only: boolean }>> {
  return provisionFetch(ctx, '/v1/workspaces', { method: 'GET' });
}
