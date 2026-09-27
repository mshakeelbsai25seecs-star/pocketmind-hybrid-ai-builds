import { useCallback, useEffect, useState } from 'react';
import {
  Copy, KeyRound, Loader2, Radio, RefreshCw, Server, Wifi,
} from 'lucide-react';
import {
  getLanHostStatus,
  setLanHostConfig,
  restartLanHost,
  type LanHostStatus,
} from '../lanHost';

function humanError(err: unknown): string {
  if (!err) return 'Unknown error';
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.message;
  try { return JSON.stringify(err); } catch { return String(err); }
}

export default function LanHostPanel() {
  const [status, setStatus] = useState<LanHostStatus | null>(null);
  const [port, setPort] = useState(8787);
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const s = await getLanHostStatus();
    setStatus(s);
    setPort(s.port);
    setEnabled(s.enabled);
    if (s.error) setError(s.error);
    return s;
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await refresh();
      } catch (err) {
        if (!cancelled) setError(humanError(err));
      }
    })();
    return () => { cancelled = true; };
  }, [refresh]);

  const apply = async (opts?: { regenerateKey?: boolean; nextEnabled?: boolean; nextPort?: number }) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const s = await setLanHostConfig({
        enabled: opts?.nextEnabled ?? enabled,
        port: opts?.nextPort ?? port,
        regenerateKey: opts?.regenerateKey,
      });
      setStatus(s);
      setPort(s.port);
      setEnabled(s.enabled);
      if (s.error) {
        setError(s.error);
      } else {
        setNotice(s.running ? 'LAN host is listening.' : s.enabled ? 'LAN host enabled but not running yet.' : 'LAN host disabled.');
      }
    } catch (err) {
      setError(humanError(err));
    } finally {
      setBusy(false);
    }
  };

  const copyText = async (label: string, text: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(null), 1400);
  };

  const primaryUrl = status?.baseUrls?.[0] || (status ? `http://<lan-ip>:${status.port}/v1` : '');

  return (
    <div className="premium-card p-6 space-y-5">
      <div className="flex items-start gap-3">
        <div className="w-11 h-11 rounded-2xl bg-gradient-to-br from-emerald-600 to-teal-400 flex items-center justify-center text-white shadow-lg">
          <Wifi className="w-6 h-6" />
        </div>
        <div className="flex-1">
          <h2 className="text-xl font-black">LAN host (this PC)</h2>
          <p className="text-sm text-surface-500">
            OpenAI-compatible gateway for other PocketMind clients on your network. On by default.
            Remote sessions use this PC&apos;s PocketCode workspace in read-only mode.
          </p>
        </div>
        <button
          type="button"
          className="btn-secondary text-xs"
          disabled={busy}
          onClick={() => void refresh().catch(err => setError(humanError(err)))}
        >
          <RefreshCw className={`w-3.5 h-3.5 ${busy ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-4">
        <label className="inline-flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={enabled}
            disabled={busy}
            onChange={e => {
              const next = e.target.checked;
              setEnabled(next);
              void apply({ nextEnabled: next });
            }}
          />
          <span className="text-sm font-bold">Enable LAN host</span>
        </label>
        <span
          className={`inline-flex items-center gap-1.5 text-xs font-bold px-2.5 py-1 rounded-full border ${
            status?.running
              ? 'border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200'
              : 'border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200'
          }`}
        >
          <Radio className="w-3.5 h-3.5" />
          {status?.running ? 'Listening' : enabled ? 'Not listening' : 'Disabled'}
        </span>
        <span className="text-xs text-surface-500">
          {status?.modelLoaded ? 'Local model warm' : 'No local model loaded yet'}
        </span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <label className="block">
          <span className="text-sm font-bold text-surface-700 dark:text-surface-200">Port</span>
          <div className="flex gap-2 mt-2">
            <input
              type="number"
              min={1}
              max={65535}
              value={port}
              disabled={busy}
              onChange={e => setPort(Number(e.target.value) || 8787)}
              className="input-field flex-1"
            />
            <button type="button" className="btn-secondary" disabled={busy} onClick={() => void apply()}>
              Apply
            </button>
          </div>
        </label>
        <div>
          <span className="text-sm font-bold text-surface-700 dark:text-surface-200">LAN IP(s)</span>
          <div className="mt-2 flex flex-wrap gap-2">
            {(status?.lanIps?.length ? status.lanIps : ['(none detected)']).map(ip => (
              <button
                key={ip}
                type="button"
                className="btn-secondary text-xs"
                disabled={busy || ip.startsWith('(')}
                onClick={() => void copyText('ip', ip)}
              >
                <Server className="w-3.5 h-3.5" />
                {ip}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="space-y-2">
        <span className="text-sm font-bold text-surface-700 dark:text-surface-200">Base URL for clients</span>
        <div className="flex flex-wrap gap-2">
          {(status?.baseUrls?.length ? status.baseUrls : [primaryUrl]).filter(Boolean).map(url => (
            <button
              key={url}
              type="button"
              className="btn-secondary text-xs font-mono"
              disabled={busy || !url}
              onClick={() => void copyText('url', url)}
            >
              <Copy className="w-3.5 h-3.5" />
              {copied === 'url' ? 'Copied' : url}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-2">
        <span className="text-sm font-bold text-surface-700 dark:text-surface-200">API key</span>
        <div className="flex gap-2">
          <input
            readOnly
            value={status?.apiKey || ''}
            className="input-field flex-1 font-mono text-xs"
          />
          <button
            type="button"
            className="btn-secondary"
            disabled={busy || !status?.apiKey}
            onClick={() => status?.apiKey && void copyText('key', status.apiKey)}
          >
            <KeyRound className="w-4 h-4" />
            {copied === 'key' ? 'Copied' : 'Copy'}
          </button>
          <button
            type="button"
            className="btn-secondary"
            disabled={busy}
            onClick={() => void apply({ regenerateKey: true })}
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            New key
          </button>
        </div>
      </div>

      <div className="rounded-2xl border border-surface-200 dark:border-surface-800 bg-surface-50/70 dark:bg-surface-900/50 p-4 text-xs text-surface-500 space-y-1">
        <p>
          Workspace: <span className="font-mono text-surface-700 dark:text-surface-200">{status?.workspaceRoot || '(set a folder in PocketCode)'}</span>
          {' · '}id <span className="font-mono">{status?.workspaceId || 'host-workspace'}</span>
          {' · '}read-only for remote clients
        </p>
        <p>Clients paste the base URL + API key below, then use Chat (grounded) or PocketCode agent over the same API.</p>
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="btn-secondary text-xs"
          disabled={busy}
          onClick={() => void restartLanHost().then(setStatus).catch(err => setError(humanError(err)))}
        >
          Restart host
        </button>
      </div>

      {notice && <p className="text-sm text-emerald-600 dark:text-emerald-300">{notice}</p>}
      {error && (
        <p className="text-sm text-red-600 dark:text-red-300 whitespace-pre-wrap">{error}</p>
      )}
    </div>
  );
}
