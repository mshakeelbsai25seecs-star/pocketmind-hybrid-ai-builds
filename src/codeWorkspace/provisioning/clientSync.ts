import { provisionFetch, joinUrl } from './http';
import type { ProvisionContext, ProvisionResult } from './types';

/**
 * Create/update a workspace by uploading a base64 tar/zip archive of the local project.
 * Isolated from preloaded/git — does not touch server mounts or git.
 */
export async function provisionClientSync(
  ctx: ProvisionContext,
  input: {
    workspaceId?: string;
    archiveBase64: string;
    format: 'tar' | 'zip';
    projectName?: string;
  },
): Promise<ProvisionResult> {
  return provisionFetch<ProvisionResult>(ctx, '/v1/workspaces/provision/sync', {
    method: 'POST',
    json: {
      workspace_id: input.workspaceId || null,
      archive_base64: input.archiveBase64,
      format: input.format,
      project_name: input.projectName || null,
    },
  });
}

/** Stream-style chunk upload for large trees (agent-host concatenates by upload_id). */
export async function provisionClientSyncChunk(
  ctx: ProvisionContext,
  input: {
    uploadId: string;
    chunkIndex: number;
    totalChunks: number;
    chunkBase64: string;
    workspaceId?: string;
    projectName?: string;
    format?: 'tar' | 'zip';
  },
): Promise<ProvisionResult | { ok: true; received: number }> {
  return provisionFetch(ctx, '/v1/workspaces/provision/sync/chunk', {
    method: 'POST',
    json: {
      upload_id: input.uploadId,
      chunk_index: input.chunkIndex,
      total_chunks: input.totalChunks,
      chunk_base64: input.chunkBase64,
      workspace_id: input.workspaceId || null,
      project_name: input.projectName || null,
      format: input.format || 'tar',
    },
  });
}

export function syncEndpoint(ctx: ProvisionContext): string {
  return joinUrl(ctx.agentHostBaseUrl, '/v1/workspaces/provision/sync');
}
