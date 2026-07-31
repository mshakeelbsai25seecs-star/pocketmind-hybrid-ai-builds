/**
 * Client for the co-located PocketMind llama.cpp Docker admin (port 8090).
 * Used on server machines to import GGUFs and start the CUDA/CPU chat container.
 */

export interface LlamaServerHostHint {
  package_root: string | null;
  admin_token: string | null;
  admin_url: string;
  chat_url: string;
  models_dir: string | null;
}

export interface LlamaServerBootstrap {
  package_root: string;
  models_dir: string;
  chat_port: number;
  admin_port: number;
  has_token_file: boolean;
}

export interface LlamaServerStatus {
  mode_suggested: string;
  docker_ok: boolean;
  chat_api: { ok: boolean; error?: string };
  selected_model: {
    valid: boolean;
    model_path_env: string;
    host_path: string;
    size_human: string;
    reason: string;
  };
  inspect: { running?: boolean; status?: string };
  chat_url_local: string;
  optimizer?: { strategy?: string; model_bytes_human?: string; notes?: string[] };
}

const TOKEN_KEY = 'pm.llama.admin.token';

export function loadStoredAdminToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY)?.trim() || '';
  } catch {
    return '';
  }
}

export function saveStoredAdminToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token.trim());
  } catch {
    /* ignore */
  }
}

async function adminFetch<T>(
  adminUrl: string,
  path: string,
  token: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers || {});
  headers.set('Accept', 'application/json');
  if (token) headers.set('X-Admin-Token', token);
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const base = adminUrl.replace(/\/+$/, '');
  const res = await fetch(`${base}${path}`, { ...init, headers });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const detail = data && typeof data === 'object' && data !== null
      ? (data as Record<string, unknown>).detail ?? (data as Record<string, unknown>).error ?? text
      : text;
    throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail));
  }
  return data as T;
}

export async function fetchLlamaServerBootstrap(adminUrl: string): Promise<LlamaServerBootstrap | null> {
  try {
    const base = adminUrl.replace(/\/+$/, '');
    const res = await fetch(`${base}/api/bootstrap`, { headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    return await res.json() as LlamaServerBootstrap;
  } catch {
    return null;
  }
}

export async function fetchLlamaServerStatus(
  adminUrl: string,
  token: string,
): Promise<LlamaServerStatus> {
  return adminFetch(adminUrl, '/api/status', token);
}

export async function importLocalGguf(
  adminUrl: string,
  token: string,
  path: string,
  select = true,
): Promise<{ message?: string }> {
  return adminFetch(adminUrl, '/api/models/import', token, {
    method: 'POST',
    body: JSON.stringify({
      path: path.trim(),
      include_shards: true,
      include_mmproj: true,
      select,
    }),
  });
}

export async function startLlamaServer(
  adminUrl: string,
  token: string,
  mode?: 'cuda' | 'cpu',
): Promise<{ message?: string }> {
  return adminFetch(adminUrl, '/api/server/start', token, {
    method: 'POST',
    body: JSON.stringify(mode ? { mode } : {}),
  });
}

export async function scanGgufFolder(
  adminUrl: string,
  token: string,
  folder: string,
): Promise<{ count: number; models: Array<{ path: string; filename: string; size_human: string; valid: boolean }> }> {
  return adminFetch(adminUrl, '/api/models/scan-folder', token, {
    method: 'POST',
    body: JSON.stringify({ folder: folder.trim() }),
  });
}
