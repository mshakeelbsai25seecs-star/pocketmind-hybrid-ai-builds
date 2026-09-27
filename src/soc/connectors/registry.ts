import { invoke } from '@tauri-apps/api/tauri';
import type { SocConnectorDescriptor } from '../types';

export const SOC_CONNECTORS: SocConnectorDescriptor[] = [
  {
    id: 'offline_import',
    label: 'Offline import',
    modes: ['offline_import'],
    capabilities: ['ingest'],
    status: 'available',
    configSchemaVersion: 1,
  },
  {
    id: 'fortisiem_live',
    label: 'FortiSIEM live query',
    modes: ['live_api'],
    capabilities: ['query', 'enrich'],
    status: 'disabled_in_build',
    configSchemaVersion: 1,
  },
  {
    id: 'fortisoar_live',
    label: 'FortiSOAR',
    modes: ['live_api'],
    capabilities: ['enrich', 'respond'],
    status: 'disabled_in_build',
    configSchemaVersion: 1,
  },
  {
    id: 'webhook_ingest',
    label: 'Generic webhook ingest',
    modes: ['live_api'],
    capabilities: ['ingest'],
    status: 'disabled_in_build',
    configSchemaVersion: 1,
  },
];

export async function loadConnectorsConfig(): Promise<Record<string, unknown>> {
  const raw = await invoke<Record<string, unknown>>('soc_get_connectors_config');
  return raw && typeof raw === 'object' ? raw : {};
}

export async function saveConnectorsConfig(value: Record<string, unknown>): Promise<Record<string, unknown>> {
  return invoke<Record<string, unknown>>('soc_save_connectors_config', { value });
}

export function liveConnectorUnavailableMessage(): string {
  return 'Live connectors are not enabled in this build.';
}
