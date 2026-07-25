import { useCallback, useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/tauri';
import { RefreshCw, Server } from 'lucide-react';
import { useAppStore } from '../../store';
import type { EnterpriseModelInfo, EnterpriseServerConfig, EnterpriseServerTestResult } from '../../types';

const HEALTH_TTL_MS = 3 * 60 * 1000;

type HealthKind = 'ready' | 'unreachable' | 'auth' | 'unknown' | 'idle';

let cachedHealth: { at: number; ok: boolean; message: string; kind: HealthKind; baseUrl: string } | null = null;

function classifyHealthError(message: string): HealthKind {
  const m = message.toLowerCase();
  if (m.includes('401') || m.includes('403') || m.includes('auth') || m.includes('api key') || m.includes('unauthorized')) {
    return 'auth';
  }
  if (m.includes('timeout') || m.includes('connect') || m.includes('network') || m.includes('unreachable') || m.includes('dns')) {
    return 'unreachable';
  }
  return 'unreachable';
}

function backendLabel(model: string | null): { label: string; kind: 'local' | 'online' | 'org' } {
  if (model?.startsWith('enterprise:')) return { label: 'Org server', kind: 'org' };
  if (model?.startsWith('remote:')) return { label: 'Online', kind: 'online' };
  return { label: 'Local', kind: 'local' };
}

export default function ServerBackendStrip({
  onOpenOrgServer,
  lastError,
  onRetry,
}: {
  onOpenOrgServer: () => void;
  lastError?: string | null;
  onRetry?: () => void;
}) {
  const currentModel = useAppStore(s => s.currentModel);
  const lastLocalModel = useAppStore(s => s.lastLocalModel);
  const lastEnterpriseModel = useAppStore(s => s.lastEnterpriseModel);
  const setCurrentModel = useAppStore(s => s.setCurrentModel);
  const setActiveView = useAppStore(s => s.setActiveView);

  const [baseUrl, setBaseUrl] = useState('');
  const [models, setModels] = useState<EnterpriseModelInfo[]>([]);
  const [health, setHealth] = useState<HealthKind>('idle');
  const [healthMsg, setHealthMsg] = useState('');
  const [testing, setTesting] = useState(false);

  const backend = backendLabel(currentModel);
  const enterpriseId = currentModel?.startsWith('enterprise:')
    ? currentModel.slice('enterprise:'.length)
    : '';

  const loadConfig = useCallback(async () => {
    try {
      const cfg = await invoke<EnterpriseServerConfig>('get_enterprise_server_config');
      setBaseUrl(cfg.base_url || '');
      if (cfg.selected_model && models.length === 0) {
        setModels([{ id: cfg.selected_model }]);
      }
    } catch {
      /* ignore */
    }
  }, [models.length]);

  const testConnection = useCallback(async (force = false): Promise<boolean> => {
    if (!force && cachedHealth && Date.now() - cachedHealth.at < HEALTH_TTL_MS) {
      setHealth(cachedHealth.kind);
      setHealthMsg(cachedHealth.message);
      setBaseUrl(cachedHealth.baseUrl || baseUrl);
      return cachedHealth.ok;
    }
    setTesting(true);
    try {
      const cfg = await invoke<EnterpriseServerConfig>('get_enterprise_server_config');
      const url = (cfg.base_url || '').trim();
      setBaseUrl(url);
      if (!url) {
        setHealth('unreachable');
        setHealthMsg('No org server URL configured.');
        cachedHealth = { at: Date.now(), ok: false, message: 'No org server URL', kind: 'unreachable', baseUrl: '' };
        return false;
      }
      const result = await invoke<EnterpriseServerTestResult>('test_enterprise_server_connection', {
        baseUrl: url,
        apiKey: null,
      });
      const kind: HealthKind = result.ok ? 'ready' : classifyHealthError(result.message || '');
      setHealth(kind);
      setHealthMsg(result.message || (result.ok ? 'Ready' : 'Failed'));
      if (result.models?.length) setModels(result.models);
      cachedHealth = {
        at: Date.now(),
        ok: result.ok,
        message: result.message || '',
        kind,
        baseUrl: result.base_url || url,
      };
      return result.ok;
    } catch (err) {
      const msg = String(err);
      const kind = classifyHealthError(msg);
      setHealth(kind);
      setHealthMsg(msg);
      cachedHealth = { at: Date.now(), ok: false, message: msg, kind, baseUrl };
      return false;
    } finally {
      setTesting(false);
    }
  }, [baseUrl]);

  useEffect(() => {
    void loadConfig();
    if (currentModel?.startsWith('enterprise:')) {
      void testConnection(false);
    }
  }, [currentModel, loadConfig, testConnection]);

  const truncatedUrl = useMemo(() => {
    const u = baseUrl.replace(/^https?:\/\//, '');
    return u.length > 36 ? `${u.slice(0, 34)}…` : u;
  }, [baseUrl]);

  const healthLabel =
    health === 'ready' ? 'Ready'
      : health === 'auth' ? 'Auth error'
        : health === 'unreachable' ? 'Unreachable'
          : health === 'unknown' ? 'Unknown'
            : '—';

  // Model label lives in the composer bar — only show this strip for org health / errors.
  const orgUnhealthy = backend.kind === 'org' && health !== 'ready' && health !== 'idle';
  const showStrip = backend.kind === 'org' || !!lastError || orgUnhealthy;
  if (!showStrip) return null;

  return (
    <div className="mx-3 mt-2 rounded-lg border border-surface-200 dark:border-surface-800 bg-surface-50/80 dark:bg-surface-900/60 px-2.5 py-1.5 space-y-1">
      {backend.kind === 'org' && (
        <>
          <div className="flex flex-wrap items-center gap-2 text-[11px]">
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md font-bold bg-emerald-100 dark:bg-emerald-950/40 text-emerald-800 dark:text-emerald-200">
              <Server className="w-3 h-3" /> Org server
            </span>
            <span className="text-surface-500 truncate max-w-[12rem]" title={baseUrl}>{truncatedUrl || 'no URL'}</span>
            <span className={`font-semibold ${
              health === 'ready' ? 'text-emerald-600' : health === 'idle' ? 'text-surface-400' : 'text-amber-600'
            }`}
            >
              {testing ? 'Testing…' : healthLabel}
            </span>
            <span className="text-surface-400 truncate max-w-[10rem]" title={currentModel || ''}>
              {enterpriseId || 'No model'}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <select
              className="input-field text-[11px] py-1 px-1.5 max-w-[11rem]"
              value={enterpriseId}
              onChange={e => {
                const id = e.target.value.trim();
                if (id) setCurrentModel(`enterprise:${id}`);
              }}
            >
              {!enterpriseId && <option value="">Select model</option>}
              {models.map(m => (
                <option key={m.id} value={m.id}>{m.id}</option>
              ))}
              {enterpriseId && !models.some(m => m.id === enterpriseId) && (
                <option value={enterpriseId}>{enterpriseId}</option>
              )}
            </select>
            <button
              type="button"
              disabled={testing}
              onClick={() => void testConnection(true)}
              className="btn-secondary text-[10px] py-1 px-2 flex items-center gap-1"
            >
              <RefreshCw className={`w-3 h-3 ${testing ? 'animate-spin' : ''}`} /> Test
            </button>
            <button
              type="button"
              onClick={() => { setActiveView('enterprise-server'); onOpenOrgServer(); }}
              className="btn-secondary text-[10px] py-1 px-2"
            >
              Open Org Server
            </button>
            {lastLocalModel && (
              <button
                type="button"
                onClick={() => setCurrentModel(lastLocalModel)}
                className="btn-secondary text-[10px] py-1 px-2"
                title={lastLocalModel}
              >
                Use last local
              </button>
            )}
          </div>
        </>
      )}

      {(lastError || orgUnhealthy) && (
        <div className="flex flex-wrap items-center gap-2 text-[10px] text-amber-800 dark:text-amber-200">
          <span className="flex-1 min-w-0 break-words">{lastError || healthMsg}</span>
          {onRetry && (
            <button type="button" onClick={onRetry} className="underline font-semibold shrink-0">
              Retry
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Preflight for enterprise models — returns false if the loop must not start. */
export async function preflightEnterprise(modelPath: string | null): Promise<{ ok: boolean; message: string }> {
  if (!modelPath?.startsWith('enterprise:')) return { ok: true, message: '' };
  if (cachedHealth && cachedHealth.ok && Date.now() - cachedHealth.at < HEALTH_TTL_MS) {
    return { ok: true, message: cachedHealth.message };
  }
  try {
    const cfg = await invoke<EnterpriseServerConfig>('get_enterprise_server_config');
    const url = (cfg.base_url || '').trim();
    if (!url) return { ok: false, message: 'Org server URL is not configured. Open Org Server to set it up.' };
    const result = await invoke<EnterpriseServerTestResult>('test_enterprise_server_connection', {
      baseUrl: url,
      apiKey: null,
    });
    const kind: HealthKind = result.ok ? 'ready' : classifyHealthError(result.message || '');
    cachedHealth = {
      at: Date.now(),
      ok: result.ok,
      message: result.message || '',
      kind,
      baseUrl: result.base_url || url,
    };
    if (!result.ok) {
      return {
        ok: false,
        message: result.message || 'Org server unreachable. Retry, open Org Server, or use last local model.',
      };
    }
    return { ok: true, message: result.message || 'Ready' };
  } catch (err) {
    const msg = String(err);
    cachedHealth = {
      at: Date.now(),
      ok: false,
      message: msg,
      kind: classifyHealthError(msg),
      baseUrl: '',
    };
    return { ok: false, message: msg };
  }
}
