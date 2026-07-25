import { invoke } from '@tauri-apps/api/tauri';

export interface ApiKeyValidation {
  ok: boolean;
  provider: string;
  message: string;
  key_url?: string | null;
}

/** Probe a pasted key, or the saved key when `key` is empty/omitted. */
export async function validateApiKey(
  provider: string,
  key?: string | null,
): Promise<ApiKeyValidation> {
  const trimmed = (key || '').trim();
  return invoke('validate_api_key', {
    provider,
    key: trimmed || null,
  });
}
