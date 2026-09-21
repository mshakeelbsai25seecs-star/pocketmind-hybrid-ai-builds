import { useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/tauri';
import {
  Activity, AlertTriangle, CheckCircle2, DatabaseBackup, FolderCog,
  KeyRound, ScrollText, ServerCog,
} from 'lucide-react';
import { useAppStore } from '../store';
import { CHAT_API_PROVIDERS, IMAGE_API_PROVIDERS } from '../apiProviders';
import { fetchAuditLog, formatAuditTimestamp, type AuditLogEntry } from '../auditLog';
import { fetchDeploymentConfig, type DeploymentConfig } from '../deploymentConfig';
import { getBackupSchedule, runEncryptedBackup, restoreEncryptedBackup } from '../api/powerFeatures';
import { onOpenExternal } from '../openExternal';
import { open } from '@tauri-apps/api/dialog';
import DiagnosticsPanel from './DiagnosticsPanel';
import BackupRestore from './BackupRestore';
import EnterpriseServer from './EnterpriseServer';
import SettingsPanel from './SettingsPanel';
import DeploymentSettingsPanel from './DeploymentSettingsPanel';
import type { AppView, EnterpriseServerConfig, RuntimeDiagnostics } from '../types';

export type ControlCenterTab =
  | 'overview'
  | 'diagnostics'
  | 'keys'
  | 'audit'
  | 'backups'
  | 'deployment'
  | 'organization'
  | 'settings';

export function tabForView(view: AppView): ControlCenterTab {
  switch (view) {
    case 'diagnostics':
      return 'diagnostics';
    case 'backup':
      return 'backups';
    case 'enterprise-server':
      return 'organization';
    case 'settings':
      return 'settings';
    default:
      return 'overview';
  }
}

const CENTER_NAV: { id: ControlCenterTab; label: string }[] = [
  { id: 'overview', label: 'Control Center' },
  { id: 'diagnostics', label: 'Diagnostics' },
  { id: 'keys', label: 'API Keys' },
  { id: 'audit', label: 'Audit Log' },
  { id: 'backups', label: 'Backups' },
  { id: 'deployment', label: 'Deployment' },
  { id: 'organization', label: 'Organization' },
  { id: 'settings', label: 'Settings' },
];

export default function ControlCenter({ initialTab }: { initialTab?: ControlCenterTab }) {
  const [tab, setTab] = useState<ControlCenterTab>(initialTab || 'overview');
  useEffect(() => {
    if (initialTab) setTab(initialTab);
  }, [initialTab]);

  return (
    <div className="flex-1 min-h-0 flex bg-black text-surface-50">
      <nav className="w-52 shrink-0 border-r border-white/10 py-4 px-2 space-y-0.5">
        {CENTER_NAV.map(item => (
          <button
            key={item.id}
            type="button"
            onClick={() => setTab(item.id)}
            className={`w-full text-left px-3 py-2 rounded-xl text-sm ${
              tab === item.id ? 'bg-primary-950/50 text-primary-200 font-semibold' : 'text-surface-400 hover:bg-white/5'
            }`}
          >
            {item.label}
          </button>
        ))}
      </nav>
      <div className="flex-1 min-h-0 flex flex-col">
        <header className="px-6 py-4 border-b border-white/10 flex items-center justify-between gap-3">
          <h1 className="text-xl font-bold">Control Center</h1>
          <OrgStatusChip />
        </header>
        {tab === 'overview' && <Overview onOpen={setTab} />}
        {tab === 'diagnostics' && <div className="flex-1 min-h-0 overflow-hidden"><DiagnosticsPanel /></div>}
        {tab === 'keys' && <div className="flex-1 min-h-0 overflow-y-auto"><ApiKeyVault /></div>}
        {tab === 'audit' && <div className="flex-1 min-h-0 overflow-y-auto p-6"><AuditPane /></div>}
        {tab === 'backups' && <div className="flex-1 min-h-0 overflow-hidden"><BackupRestore /></div>}
        {tab === 'deployment' && <div className="flex-1 min-h-0 overflow-y-auto p-6"><DeploymentSettingsPanel /></div>}
        {tab === 'organization' && <div className="flex-1 min-h-0 overflow-hidden"><EnterpriseServer /></div>}
        {tab === 'settings' && <div className="flex-1 min-h-0 overflow-hidden"><SettingsPanel /></div>}
      </div>
    </div>
  );
}

function OrgStatusChip() {
  const [cfg, setCfg] = useState<EnterpriseServerConfig | null>(null);
  useEffect(() => {
    invoke<EnterpriseServerConfig>('get_enterprise_server_config').then(setCfg).catch(() => setCfg(null));
  }, []);
  const connected = Boolean(cfg?.base_url);
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className={`w-2 h-2 rounded-full ${connected ? 'bg-primary-400' : 'bg-surface-600'}`} />
      <span className="text-surface-400">Organization Server</span>
      <span className={connected ? 'text-primary-300' : 'text-surface-500'}>
        {connected ? `Connected · ${cfg?.base_url}` : 'Not connected'}
      </span>
    </div>
  );
}

function Overview({ onOpen }: { onOpen: (t: ControlCenterTab) => void }) {
  const store = useAppStore();
  const [diag, setDiag] = useState<RuntimeDiagnostics | null>(null);
  const [keys, setKeys] = useState<string[]>([]);
  const [audit, setAudit] = useState<AuditLogEntry[]>([]);
  const [org, setOrg] = useState<EnterpriseServerConfig | null>(null);
  const [paths, setPaths] = useState<DeploymentConfig | null>(store.deploymentConfig);
  const [backupHint, setBackupHint] = useState('No backup recorded');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = async () => {
    const [d, providers, log, cfg, deploy, sched] = await Promise.all([
      invoke<RuntimeDiagnostics>('get_runtime_diagnostics', {
        selectedModelPath: store.currentModel || null,
        modelsDir: store.modelsDir,
      }).catch(() => null),
      invoke<string[]>('get_api_key_providers').catch(() => [] as string[]),
      fetchAuditLog({ limit: 8 }).catch(() => [] as AuditLogEntry[]),
      invoke<EnterpriseServerConfig>('get_enterprise_server_config').catch(() => null),
      fetchDeploymentConfig().catch(() => store.deploymentConfig),
      getBackupSchedule().catch(() => null),
    ]);
    setDiag(d);
    setKeys(providers);
    setAudit(log);
    setOrg(cfg);
    if (deploy) {
      setPaths(deploy);
      store.setDeploymentConfig(deploy);
    }
    if (sched?.last_run_at) {
      setBackupHint(new Date(sched.last_run_at * 1000).toLocaleString());
    } else if (sched?.last_status) {
      setBackupHint(sched.last_status);
    }
  };

  useEffect(() => { void load(); }, []);

  const health = useMemo(() => {
    const info = store.systemInfo;
    return {
      system: true,
      models: Boolean(diag?.llama_server_found || store.currentModel),
      data: Boolean(paths?.dataRoot),
      ram: info ? `${Math.round(info.memory.total_bytes / 1_073_741_824)} GB` : '',
    };
  }, [diag, paths, store.systemInfo, store.currentModel]);

  const backupNow = async () => {
    const passphrase = window.prompt('Passphrase for encrypted backup (min 8 characters)');
    if (!passphrase || passphrase.trim().length < 8) {
      setNotice('Backup cancelled — passphrase must be at least 8 characters.');
      return;
    }
    const dest = await open({ directory: true, title: 'Backup destination folder' });
    if (typeof dest !== 'string') return;
    setBusy(true);
    try {
      const path = await runEncryptedBackup(passphrase.trim(), dest);
      setNotice(`Backup written to ${path}`);
      setBackupHint(new Date().toLocaleString());
    } catch (err) {
      setNotice(String(err));
    } finally {
      setBusy(false);
    }
  };

  const restoreNow = async () => {
    const file = await open({ multiple: false, filters: [{ name: 'PocketMind backup', extensions: ['pmbak', 'json'] }] });
    if (typeof file !== 'string') return;
    const passphrase = window.prompt('Passphrase for this backup');
    if (!passphrase) return;
    setBusy(true);
    try {
      const msg = await restoreEncryptedBackup(file, passphrase);
      setNotice(msg || 'Restore complete.');
    } catch (err) {
      setNotice(String(err));
    } finally {
      setBusy(false);
    }
  };

  const disconnectOrg = async () => {
    if (!confirm('Disconnect this device from the organization server?')) return;
    try {
      await invoke('clear_enterprise_server_key');
      const cfg = await invoke<EnterpriseServerConfig>('get_enterprise_server_config');
      await invoke('save_enterprise_server_config', {
        baseUrl: '',
        apiKey: null,
        selectedModel: '',
      });
      setOrg(await invoke<EnterpriseServerConfig>('get_enterprise_server_config'));
      setNotice('Organization server disconnected.');
    } catch (err) {
      setNotice(String(err));
    }
  };

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-4 max-w-6xl mx-auto w-full">
      {notice && <p className="text-sm text-primary-300">{notice}</p>}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <section className="rounded-2xl border border-white/10 bg-[#0c0c0c] p-4">
          <h2 className="font-semibold flex items-center gap-2 mb-3"><Activity className="w-4 h-4 text-primary-400" /> Diagnostics</h2>
          <div className="grid grid-cols-3 gap-2 text-center">
            <HealthCell title="System Health" ok={health.system} />
            <HealthCell title="Model Services" ok={health.models} />
            <HealthCell title="Data Connections" ok={health.data} />
          </div>
          <button type="button" className="text-xs text-primary-300 mt-3" onClick={() => onOpen('diagnostics')}>Open diagnostics</button>
        </section>

        <section className="rounded-2xl border border-white/10 bg-[#0c0c0c] p-4">
          <h2 className="font-semibold flex items-center gap-2 mb-2"><KeyRound className="w-4 h-4 text-primary-400" /> API Key Vault</h2>
          <p className="text-xs text-surface-400">Keys are encrypted and stored securely.</p>
          <p className="text-2xl font-semibold mt-3">{keys.length}</p>
          <p className="text-xs text-surface-500">Active keys</p>
          <button type="button" className="btn-secondary text-sm mt-3" onClick={() => onOpen('keys')}>Manage Keys</button>
        </section>

        <section className="rounded-2xl border border-white/10 bg-[#0c0c0c] p-4">
          <h2 className="font-semibold flex items-center gap-2 mb-2"><ScrollText className="w-4 h-4 text-primary-400" /> Audit Log (Local)</h2>
          <ul className="space-y-1.5 text-[12px]">
            {audit.length === 0 && <li className="text-surface-500">No events yet.</li>}
            {audit.slice(0, 5).map(e => (
              <li key={e.id} className="flex gap-2">
                <span className="text-surface-500 shrink-0">{formatAuditTimestamp(e.created_at)}</span>
                <span className="truncate">{e.summary}</span>
              </li>
            ))}
          </ul>
          <button type="button" className="text-xs text-primary-300 mt-2" onClick={() => onOpen('audit')}>View full log</button>
        </section>

        <section className="rounded-2xl border border-white/10 bg-[#0c0c0c] p-4">
          <h2 className="font-semibold flex items-center gap-2 mb-2"><DatabaseBackup className="w-4 h-4 text-primary-400" /> Backup &amp; Restore</h2>
          <p className="text-xs text-surface-400">Create a backup or restore from a previous backup.</p>
          <p className="text-xs text-surface-500 mt-2">Last backup {backupHint}</p>
          <div className="flex gap-2 mt-3">
            <button type="button" className="btn-primary text-sm" disabled={busy} onClick={() => void backupNow()}>Backup Now</button>
            <button type="button" className="btn-secondary text-sm" disabled={busy} onClick={() => void restoreNow()}>Restore</button>
          </div>
        </section>

        <section className="rounded-2xl border border-white/10 bg-[#0c0c0c] p-4">
          <h2 className="font-semibold flex items-center gap-2 mb-2"><ServerCog className="w-4 h-4 text-primary-400" /> Organization Server</h2>
          <p className="text-sm">{org?.base_url ? 'Connected to organization server' : 'Not connected'}</p>
          {org?.base_url && <p className="text-primary-300 text-sm break-all mt-1">{org.base_url}</p>}
          <div className="flex gap-2 mt-3">
            <button type="button" className="btn-secondary text-sm" onClick={() => onOpen('organization')}>Configure</button>
            {org?.base_url && (
              <button type="button" className="btn-secondary text-sm" onClick={() => void disconnectOrg()}>Disconnect</button>
            )}
          </div>
        </section>

        <section className="rounded-2xl border border-white/10 bg-[#0c0c0c] p-4">
          <h2 className="font-semibold flex items-center gap-2 mb-2"><FolderCog className="w-4 h-4 text-primary-400" /> Deployment Paths</h2>
          <dl className="text-[12px] space-y-1.5">
            <div className="flex justify-between gap-3"><dt className="text-surface-400">Models Path</dt><dd className="font-mono truncate">{paths?.modelsDir || '—'}</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-surface-400">Data Path</dt><dd className="font-mono truncate">{paths?.dataRoot || '—'}</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-surface-400">Export Path</dt><dd className="font-mono truncate">{paths?.exportDir || '—'}</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-surface-400">SOC Data</dt><dd className="font-mono truncate">{paths?.socDataRoot || '—'}</dd></div>
          </dl>
          <button type="button" className="btn-secondary text-sm mt-3" onClick={() => onOpen('deployment')}>Edit Paths</button>
        </section>
      </div>
    </div>
  );
}

function HealthCell({ title, ok }: { title: string; ok: boolean }) {
  return (
    <div className="rounded-xl border border-white/10 p-3">
      <p className="text-[11px] text-surface-400">{title}</p>
      <p className={`text-sm font-semibold mt-1 ${ok ? 'text-primary-400' : 'text-amber-300'}`}>{ok ? 'Ready' : 'Check'}</p>
      <p className="text-[10px] text-surface-500">{ok ? 'All systems operational' : 'Needs attention'}</p>
    </div>
  );
}

function ApiKeyVault() {
  const [saved, setSaved] = useState<string[]>([]);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = () => {
    invoke<string[]>('get_api_key_providers').then(setSaved).catch(() => setSaved([]));
  };
  useEffect(() => { refresh(); }, []);

  const providers = useMemo(() => {
    const chat = CHAT_API_PROVIDERS.map(p => ({ ...p, kind: 'Chat' as const }));
    const image = IMAGE_API_PROVIDERS.filter(p => !CHAT_API_PROVIDERS.some(c => c.id === p.id))
      .map(p => ({ ...p, kind: 'Images' as const, freeModels: false }));
    return [...chat, ...image];
  }, []);

  const save = async (id: string) => {
    const key = (draft[id] || '').trim();
    if (!key) return;
    try {
      await invoke('store_api_key', { provider: id, key });
      setNotice(`Saved ${id} key.`);
      setDraft(d => ({ ...d, [id]: '' }));
      refresh();
    } catch (err) {
      setNotice(String(err));
    }
  };

  const remove = async (id: string) => {
    await invoke('remove_api_key', { provider: id });
    refresh();
  };

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-3">
      <h2 className="text-lg font-semibold">API Key Vault</h2>
      <p className="text-sm text-surface-400">Keys are encrypted on this device. They never leave the vault except to call the provider you enabled.</p>
      {notice && <p className="text-sm text-primary-300">{notice}</p>}
      {providers.map(p => (
        <div key={`${p.kind}-${p.id}`} className="rounded-xl border border-white/10 p-3 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <div>
              <p className="font-medium">{p.name}</p>
              <p className="text-[11px] text-surface-500">{p.kind}{saved.includes(p.id) ? ' · key saved' : ''}</p>
            </div>
            <a href={p.url} onClick={onOpenExternal(p.url)} className="text-xs text-primary-300 underline">Get key</a>
          </div>
          <div className="flex gap-2">
            <input
              type="password"
              value={draft[p.id] || ''}
              onChange={e => setDraft(d => ({ ...d, [p.id]: e.target.value }))}
              placeholder={saved.includes(p.id) ? '••••••••  (replace)' : 'Paste API key'}
              className="input-field flex-1 text-sm"
            />
            <button type="button" className="btn-primary text-sm" onClick={() => void save(p.id)}>Save</button>
            {saved.includes(p.id) && (
              <button type="button" className="btn-secondary text-sm" onClick={() => void remove(p.id)}>Remove</button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function AuditPane() {
  const [rows, setRows] = useState<AuditLogEntry[]>([]);
  useEffect(() => {
    fetchAuditLog({ limit: 200 }).then(setRows).catch(() => setRows([]));
  }, []);
  return (
    <div className="max-w-4xl mx-auto">
      <h2 className="text-lg font-semibold mb-3">Audit Log</h2>
      {rows.length === 0 && <p className="text-sm text-surface-500">No audit events recorded yet.</p>}
      <ul className="space-y-2">
        {rows.map(e => (
          <li key={e.id} className="rounded-xl border border-white/10 p-3 text-sm">
            <div className="flex items-center gap-2">
              {e.success ? <CheckCircle2 className="w-4 h-4 text-primary-400" /> : <AlertTriangle className="w-4 h-4 text-amber-400" />}
              <span className="text-surface-400 text-xs">{formatAuditTimestamp(e.created_at)}</span>
              <span className="font-medium">{e.summary}</span>
            </div>
            {e.detail && <p className="text-xs text-surface-500 mt-1 whitespace-pre-wrap">{e.detail}</p>}
          </li>
        ))}
      </ul>
    </div>
  );
}
