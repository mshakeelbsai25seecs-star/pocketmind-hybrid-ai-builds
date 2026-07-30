import { provisionFetch } from './http';
import type { ProvisionContext, ProvisionResult } from './types';

/**
 * Server-side git clone/fetch into a new or existing workspace.
 * Isolated from preloaded/sync — credentials are sent only to agent-host.
 */
export async function provisionGitClone(
  ctx: ProvisionContext,
  input: {
    workspaceId?: string;
    url: string;
    ref?: string;
    token?: string;
    depth?: number;
  },
): Promise<ProvisionResult> {
  return provisionFetch<ProvisionResult>(ctx, '/v1/workspaces/provision/git', {
    method: 'POST',
    json: {
      workspace_id: input.workspaceId || null,
      url: input.url,
      ref: input.ref || null,
      token: input.token || null,
      depth: input.depth ?? 1,
    },
  });
}
