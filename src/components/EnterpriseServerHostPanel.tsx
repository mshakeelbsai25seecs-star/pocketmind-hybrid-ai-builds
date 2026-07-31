import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/tauri';
import { Cpu, ExternalLink, FolderOpen, Loader2, Play, RefreshCw, Server } from 'lucide-react';
import { fetchDeploymentPaths } from '../deploymentConfig';
import { openExternal } from '../openExternal';
import {
  fetchLlamaServerBootstrap,
  fetchLlamaServerLogs,
  fetchLlamaServerStatus,
  importLocalGguf,
  loadStoredAdminToken,
  saveStoredAdminToken,
  scanGgufFolder,
  startLlamaServer,
  type LlamaServerHostHint,
  type LlamaServerStatus,
} from '../enterpriseServerHost';

function humanError(err: unknown): string {
  if (!err) return 'Unknown error';
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.message;
  try { return JSON.stringify(err); } catch { return String(err); }
}

export default function EnterpriseServerHostPanel() {
  const [hint, setHint] = useState<LlamaServerHostHint | null>(null);
  const [adminReachable, setAdminReachable] = useState<boolean | null>(null);
  const [token, setToken] = useState(loadStoredAdminToken);
  const [status, setStatus] = useState<LlamaServerStatus | null>(null);
  const [importPath, setImportPath] = useState('');
  const [scanFolder, setScanFolder] = useState('');
  const [scanRows, setScanRows] = useState<Array<{ path: string; filename: string; size_human: string; valid: boolean }>>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [liveLogs, setLiveLogs] = useState(false);
  const [logs, setLogs] = useState('—');
  const [logsBusy, setLogsBusy] = useState(false);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const h = await invoke<LlamaServerHostHint>('get_llama_server_host_hint');
      setHint(h);
      if (!token.trim() && h.admin_token) {
        setToken(h.admin_token);
        saveStoredAdminToken(h.admin_token);
      }
      const boot = await fetchLlamaServerBootstrap(h.admin_url);
      setAdminReachable(Boolean(boot));
      if (boot && (token.trim() || h.admin_token)) {
        const st = await fetchLlamaServerStatus(h.admin_url, token.trim() || h.admin_token || '');
        setStatus(st);
      } else {
        setStatus(null);
      }
    } catch (err) {
      setError(humanError(err));
    }
  }, [token]);

  const loadLogs = useCallback(async () => {
    if (!hint?.admin_url) return;
    setLogsBusy(true);
    try {
      const tok = token.trim() || hint.admin_token || '';
      const text = await fetchLlamaServerLogs(hint.admin_url, tok, 120);
      setLogs(text || '(no logs)');
    } catch (err) {
      setLogs(humanError(err));
    } finally {
      setLogsBusy(false);
    }
  }, [hint, token]);

  useEffect(() => {
    void refresh();
    void fetchDeploymentPaths().then(paths => {
      if (!scanFolder.trim() && paths.modelsDir) setScanFolder(paths.modelsDir);
    }).catch(() => undefined);
  }, [refresh]);

  useEffect(() => {
    if (!liveLogs) return;
    void loadLogs();
    const timer = window.setInterval(() => { void loadLogs(); }, 3000);
    return () => window.clearInterval(timer);
  }, [liveLogs, loadLogs]);

  const saveToken = () => {
    saveStoredAdminToken(token);
    setMessage('Admin token saved in this app.');
    void refresh();
  };

  const doImport = async (path: string) => {
    if (!hint) return;
    setBusy(true);
    setError(null);
    setMessage('Importing GGUF into server models folder…');
    try {
      const tok = token.trim() || hint.admin_token || '';
      const res = await importLocalGguf(hint.admin_url, tok, path, true);
      setMessage(res.message || 'Model imported and selected.');
      await refresh();
    } catch (err) {
      setError(humanError(err));
      setMessage(null);
    } finally {
      setBusy(false);
    }
  };

  const doScan = async () => {
    if (!hint || !scanFolder.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const tok = token.trim() || hint.admin_token || '';
      const res = await scanGgufFolder(hint.admin_url, tok, scanFolder);
      setScanRows(res.models || []);
      setMessage(`Found ${res.count || 0} GGUF file(s) in ${scanFolder}.`);
    } catch (err) {
      setError(humanError(err));
    } finally {
      setBusy(false);
    }
  };

  const doStart = async (mode?: 'cuda' | 'cpu') => {
    if (!hint) return;
    setBusy(true);
    setError(null);
    setMessage(mode === 'cpu' ? 'Starting CPU-only server…' : 'Starting server with auto GPU optimizer…');
    try {
      const tok = token.trim() || hint.admin_token || '';
      const res = await startLlamaServer(hint.admin_url, tok, mode);
      setMessage(res.message || 'Server start requested.');
      await refresh();
      if (liveLogs) await loadLogs();
      if (hint.chat_url) {
        setMessage(prev => `${prev || ''} Client URL: ${hint.chat_url}`);
      }
    } catch (err) {
      setError(humanError(err));
      setMessage(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="premium-card p-6 space-y-4 border-primary-200/60 dark:border-primary-900/40">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-black flex items-center gap-2">
            <Server className="w-5 h-5 text-primary-500" /> Host chat server on this machine
          </h2>
          <p className="text-sm text-surface-500 mt-1">
            Import a local GGUF, start the Docker llama.cpp service (CUDA when NVIDIA + Docker are ready),
            then point Organization Server clients at <code>{hint?.chat_url || 'http://127.0.0.1:8000/v1'}</code>.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn-secondary" onClick={() => void refresh()} disabled={busy}>
            <RefreshCw className="w-4 h-4" /> Refresh status
          </button>
          {hint?.admin_url && (
            <button type="button" className="btn-secondary" onClick={() => void openExternal(hint.admin_url)} title="Open the full admin UI in your browser (port 8090)">
              <ExternalLink className="w-4 h-4" /> Open admin UI
            </button>
          )}
        </div>
      </div>

      {hint?.package_root && (
        <p className="text-xs text-surface-500">Package: <code>{hint.package_root}</code></p>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <label className="block">
          <span className="text-sm font-bold">Admin token</span>
          <div className="flex gap-2 mt-1">
            <input
              type="password"
              className="input-field flex-1"
              value={token}
              onChange={e => setToken(e.target.value)}
              placeholder="From START_ADMIN.cmd or .admin_token"
            />
            <button type="button" className="btn-secondary" onClick={saveToken}>Save</button>
          </div>
        </label>
        <label className="block">
          <span className="text-sm font-bold">Import local GGUF (full path)</span>
          <div className="flex gap-2 mt-1">
            <input
              className="input-field flex-1"
              value={importPath}
              onChange={e => setImportPath(e.target.value)}
              placeholder="D:\models\your-model.gguf"
            />
            <button type="button" className="btn-primary" disabled={busy || !importPath.trim()} onClick={() => void doImport(importPath)} title="Hard-link or copy into server models folder and select">
              Import &amp; select
            </button>
          </div>
        </label>
      </div>

      <div className="rounded-2xl border border-surface-200 dark:border-surface-800 p-4 space-y-3">
        <span className="text-sm font-bold flex items-center gap-2"><FolderOpen className="w-4 h-4" /> Scan folder for GGUFs</span>
        <div className="flex gap-2">
          <input className="input-field flex-1" value={scanFolder} onChange={e => setScanFolder(e.target.value)} placeholder="D:\PocketMind\models" />
          <button type="button" className="btn-secondary" disabled={busy || !scanFolder.trim()} onClick={() => void doScan()} title="List .gguf files without importing">Scan folder</button>
        </div>
        {scanRows.length > 0 && (
          <ul className="text-sm space-y-1 max-h-40 overflow-y-auto">
            {scanRows.map(row => (
              <li key={row.path} className="flex items-center justify-between gap-2">
                <span className="truncate" title={row.path}>{row.filename} · {row.size_human}</span>
                {row.valid && (
                  <button type="button" className="btn-secondary text-xs py-1 px-2 shrink-0" onClick={() => void doImport(row.path)}>
                    Import
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {status && (
        <div className="rounded-2xl bg-surface-50/80 dark:bg-surface-900/50 p-4 text-sm space-y-1">
          <p>Docker: {status.docker_ok ? 'OK' : 'Missing — install/start Docker Desktop (+ NVIDIA Container Toolkit for CUDA)'}</p>
          <p>Suggested mode: <code>{status.mode_suggested}</code> · Container: {status.inspect?.running ? 'running' : (status.inspect?.status || 'not running')}</p>
          <p>Model: {status.selected_model.valid ? 'valid' : 'invalid'} — {status.selected_model.size_human} ({status.selected_model.reason || status.selected_model.model_path_env})</p>
          {status.optimizer?.strategy && (
            <p>Optimizer: <code>{status.optimizer.strategy}</code>
              {status.optimizer.strategy === 'no-model'
                ? ' — import a GGUF before Start'
                : status.optimizer.notes?.[0]
                  ? ` — ${status.optimizer.notes[0]}`
                  : ''}
            </p>
          )}
          <p>Chat API: {status.chat_api.ok ? 'reachable' : `down${status.chat_api.error ? ` — ${status.chat_api.error}` : ''}`}</p>
          {!status.docker_ok && (
            <p className="text-amber-700 dark:text-amber-300">Chat cannot start until Docker is available — same root cause as local llama-server being unreachable.</p>
          )}
          {status.docker_ok && !status.selected_model.valid && (
            <p className="text-amber-700 dark:text-amber-300">Import a local GGUF above (or scan your models folder), then Start. Default <code>model.gguf</code> is only a placeholder.</p>
          )}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="btn-primary"
          disabled={busy}
          onClick={() => void doStart()}
          title="Start llama.cpp with auto GPU optimizer (CUDA when Docker + NVIDIA are ready, else CPU)"
        >
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
          Start server (auto GPU)
        </button>
        <button
          type="button"
          className="btn-secondary"
          disabled={busy}
          onClick={() => void doStart('cpu')}
          title="Force CPU-only mode — slower but works without NVIDIA Docker"
        >
          <Cpu className="w-4 h-4" /> Start CPU-only
        </button>
      </div>

      <div className="rounded-2xl border border-surface-200 dark:border-surface-800 p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-sm font-bold">Container logs</span>
          <div className="flex flex-wrap gap-2">
            <label className="inline-flex items-center gap-2 text-xs text-surface-600 dark:text-surface-300">
              <input
                type="checkbox"
                checked={liveLogs}
                onChange={e => setLiveLogs(e.target.checked)}
              />
              Live logs (3s)
            </label>
            <button
              type="button"
              className="btn-secondary text-xs py-1 px-2"
              disabled={logsBusy || !hint?.admin_url}
              onClick={() => void loadLogs()}
              title="Fetch the latest docker compose logs once"
            >
              {logsBusy ? 'Loading…' : 'Refresh logs'}
            </button>
          </div>
        </div>
        <pre className="text-xs whitespace-pre-wrap break-words max-h-56 overflow-y-auto rounded-xl bg-surface-950/90 text-surface-100 p-3 font-mono">{logs}</pre>
      </div>

      {message && <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:border-emerald-900/50 dark:bg-emerald-950/30 dark:text-emerald-200">{message}</div>}
      {error && <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-200">{error}</div>}
      {adminReachable === false && (
        <p className="text-xs text-amber-700 dark:text-amber-300">
          Admin UI not reachable at {hint?.admin_url}. Run <strong>START_ADMIN.cmd</strong> from
          {' '}<code>{hint?.package_root || 'dist-server-client\\PocketMind-llama-cpp-server'}</code> first.
        </p>
      )}
      {!hint?.package_root && adminReachable === false && (
        <p className="text-xs text-surface-500">
          Copy <code>dist-server-client\PocketMind-llama-cpp-server</code> next to the app or set
          {' '}<code>LLAMA_CPP_SERVER_ROOT</code> to its path.
        </p>
      )}
    </div>
  );
}
