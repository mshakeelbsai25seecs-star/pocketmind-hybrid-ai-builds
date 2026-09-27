import { invoke } from '@tauri-apps/api/tauri';

export interface LanHostStatus {
  enabled: boolean;
  running: boolean;
  port: number;
  apiKey: string;
  lanIps: string[];
  baseUrls: string[];
  workspaceRoot: string | null;
  workspaceId: string;
  modelLoaded: boolean;
  modelPath: string | null;
  error: string | null;
}

export async function getLanHostStatus(): Promise<LanHostStatus> {
  return invoke<LanHostStatus>('get_lan_host_status');
}

export async function setLanHostConfig(input: {
  enabled: boolean;
  port: number;
  regenerateKey?: boolean;
}): Promise<LanHostStatus> {
  return invoke<LanHostStatus>('set_lan_host_config', {
    enabled: input.enabled,
    port: input.port,
    regenerateKey: input.regenerateKey ?? null,
  });
}

export async function restartLanHost(): Promise<LanHostStatus> {
  return invoke<LanHostStatus>('restart_lan_host');
}

/** Strip trailing /v1 for agent-host style base URLs. */
export function agentBaseFromOpenAiUrl(openAiBaseUrl: string): string {
  const trimmed = openAiBaseUrl.trim().replace(/\/+$/, '');
  return trimmed.replace(/\/v1$/i, '');
}

export interface OptionalParserComponent {
  id: string;
  label: string;
  description: string;
  installed: boolean;
  path: string | null;
  detail: string;
}

export async function listOptionalParserComponents(): Promise<OptionalParserComponent[]> {
  return invoke<OptionalParserComponent[]>('list_optional_parser_components');
}

export async function installOptionalParserComponent(id: string): Promise<OptionalParserComponent> {
  return invoke<OptionalParserComponent>('install_optional_parser_component', { id });
}

/**
 * Download a DOCX (or other) artifact from a LAN / org host.
 * `hostBase` may be with or without `/v1`.
 */
export async function downloadHostArtifact(opts: {
  hostBase: string;
  apiKey: string;
  artifactId: string;
  filename?: string;
}): Promise<Blob> {
  const root = agentBaseFromOpenAiUrl(opts.hostBase);
  const url = `${root}/v1/artifacts/${encodeURIComponent(opts.artifactId)}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      Accept: '*/*',
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Artifact download failed (${res.status}): ${text || res.statusText}`);
  }
  return res.blob();
}
