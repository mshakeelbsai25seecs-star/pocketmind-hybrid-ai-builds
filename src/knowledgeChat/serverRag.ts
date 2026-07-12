/**
 * Thin-client Knowledge Chat against the org Full Server RAG gateway.
 * Desktop sends prompts + Bearer token only; search/index stay on the server.
 */
import { invoke } from '@tauri-apps/api/tauri';
import type { EnterpriseServerConfig } from '../types';
import type { KcCollection } from './types';

export interface ServerRagSource {
  file_name: string;
  relative_path: string;
  title: string;
  snippet: string;
  score: number;
  partition_id: string;
}

export interface ServerRagChatResponse {
  answer: string;
  sources: ServerRagSource[];
  collection_id: string;
}

export interface ServerRagCredentials {
  baseUrl: string;
  token: string;
}

function normalizeGatewayRoot(baseUrl: string): string {
  let url = baseUrl.trim().replace(/\/+$/, '');
  if (url.endsWith('/v1')) {
    url = url.slice(0, -3);
  }
  return url.replace(/\/+$/, '');
}

export async function loadServerRagCredentials(): Promise<ServerRagCredentials | null> {
  const config = await invoke<EnterpriseServerConfig>('get_enterprise_server_config');
  if (!config.server_rag_enabled || !config.base_url.trim()) {
    return null;
  }
  const token = await invoke<string>('get_enterprise_server_token').catch(() => '');
  if (!token.trim()) {
    return null;
  }
  return { baseUrl: normalizeGatewayRoot(config.base_url), token: token.trim() };
}

export async function isServerRagActive(): Promise<boolean> {
  return (await loadServerRagCredentials()) !== null;
}

export async function probeServerRag(baseUrl: string, token: string): Promise<boolean> {
  const root = normalizeGatewayRoot(baseUrl);
  try {
    const res = await fetch(`${root}/v1/knowledge/collections`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function serverRagListCollections(creds: ServerRagCredentials): Promise<KcCollection[]> {
  const res = await fetch(`${creds.baseUrl}/v1/knowledge/collections`, {
    headers: { Authorization: `Bearer ${creds.token}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Server RAG collections failed (${res.status}): ${text || res.statusText}`);
  }
  const data = (await res.json()) as KcCollection[];
  return Array.isArray(data) ? data : [];
}

export async function serverRagChat(
  creds: ServerRagCredentials,
  collectionId: string,
  message: string,
): Promise<ServerRagChatResponse> {
  const res = await fetch(`${creds.baseUrl}/v1/knowledge/chat`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${creds.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      collection_id: collectionId,
      message,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Server RAG chat failed (${res.status}): ${text || res.statusText}`);
  }
  return (await res.json()) as ServerRagChatResponse;
}
