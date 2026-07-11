import { invoke } from '@tauri-apps/api/tauri';
import { save } from '@tauri-apps/api/dialog';
import { useAppStore } from './store';

export interface AuditLogEntry {
  id: string;
  event_type: string;
  category: string;
  summary: string;
  detail?: string | null;
  resource_path?: string | null;
  success: boolean;
  created_at: number;
}

export interface LogAuditEventRequest {
  eventType: string;
  category: string;
  summary: string;
  detail?: string;
  resourcePath?: string;
  success?: boolean;
}

function mapEntry(raw: AuditLogEntry): AuditLogEntry {
  return {
    ...raw,
    success: Boolean(raw.success),
  };
}

export async function fetchAuditLog(options?: {
  limit?: number;
  offset?: number;
  category?: string;
}): Promise<AuditLogEntry[]> {
  const items = await invoke<AuditLogEntry[]>('get_audit_log', {
    limit: options?.limit ?? 200,
    offset: options?.offset ?? 0,
    category: options?.category || null,
  });
  return items.map(mapEntry);
}

export async function logAuditEvent(request: LogAuditEventRequest): Promise<void> {
  const product = useAppStore.getState().productConfig;
  if (product && !product.audit_log_enabled) return;
  try {
    await invoke('log_audit_event', {
      request: {
        event_type: request.eventType,
        category: request.category,
        summary: request.summary,
        detail: request.detail || null,
        resource_path: request.resourcePath || null,
        success: request.success ?? true,
      },
    });
  } catch {
    // Audit failures must not block analyst workflows.
  }
}

export async function exportAuditLogCsv(options?: { limit?: number; category?: string }): Promise<string | null> {
  const exportDir = useAppStore.getState().deploymentConfig?.exportDir;
  const defaultPath = exportDir
    ? `${exportDir.replace(/[\\/]+$/, '')}${exportDir.includes('/') ? '/' : '\\'}nexus-audit-log.csv`
    : 'nexus-audit-log.csv';
  const selected = await save({
    title: 'Export SOC audit log',
    defaultPath,
    filters: [{ name: 'CSV', extensions: ['csv'] }],
  });
  if (!selected) return null;
  return invoke<string>('export_audit_log', {
    path: selected,
    limit: options?.limit ?? 5000,
    category: options?.category || null,
  });
}

export function formatAuditTimestamp(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toLocaleString();
}
