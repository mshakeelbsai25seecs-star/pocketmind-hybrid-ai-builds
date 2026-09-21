import { useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { Plus, Trash2, X } from 'lucide-react';
import {
  ptyKill,
  ptyResize,
  ptyShells,
  ptySpawn,
  ptyWrite,
  type PtySessionInfo,
  type PtyShellInfo,
} from '../../codeWorkspace/ideApi';

function stripAnsi(s: string) {
  return s
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, '')
    .replace(/\r/g, '');
}

export default function PtyTerminal({
  cwd,
  defaultShell = 'powershell',
}: {
  cwd: string | null;
  defaultShell?: string;
}) {
  const hostRef = useRef<HTMLPreElement>(null);
  const [shells, setShells] = useState<PtyShellInfo[]>([]);
  const [shell, setShell] = useState(defaultShell);
  const [session, setSession] = useState<PtySessionInfo | null>(null);
  const [buffer, setBuffer] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const sessionId = useRef<string | null>(null);

  useEffect(() => {
    void ptyShells().then(rows => {
      setShells(rows);
      const def = rows.find(s => s.id === defaultShell && s.available)
        || rows.find(s => s.available);
      if (def) setShell(def.id);
    }).catch(err => setError(String(err)));
  }, [defaultShell]);

  useEffect(() => {
    if (sessionId.current || !cwd) return;
    const preferred = shells.find(s => s.id === defaultShell && s.available) || shells.find(s => s.available);
    if (!preferred) return;
    void start(preferred.id);
    // start is stable enough for first mount of a workspace
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, shells.length]);

  useEffect(() => {
    let unlistenData: (() => void) | undefined;
    let unlistenExit: (() => void) | undefined;
    void listen<{ id: string; data: string }>('pty-data', ev => {
      if (ev.payload.id !== sessionId.current) return;
      setBuffer(prev => {
        const next = stripAnsi(prev + ev.payload.data);
        return next.length > 400_000 ? next.slice(-300_000) : next;
      });
    }).then(fn => { unlistenData = fn; });
    void listen<{ id: string; code: number | null }>('pty-exit', ev => {
      if (ev.payload.id !== sessionId.current) return;
      setSession(s => s ? { ...s, running: false, exit_code: ev.payload.code } : s);
    }).then(fn => { unlistenExit = fn; });
    return () => {
      unlistenData?.();
      unlistenExit?.();
    };
  }, []);

  useEffect(() => {
    const el = hostRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [buffer]);

  const start = async (kind = shell) => {
    setBusy(true);
    setError(null);
    try {
      const info = await ptySpawn(kind, cwd, 120, 32);
      sessionId.current = info.id;
      setSession(info);
      setBuffer('');
      setTimeout(() => hostRef.current?.focus(), 50);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    if (!sessionId.current) return;
    try {
      await ptyKill(sessionId.current);
    } catch {
      /* ignore */
    }
  };

  const onKeyDown = async (e: React.KeyboardEvent<HTMLPreElement>) => {
    if (!sessionId.current || session && !session.running) return;
    let data = '';
    if (e.key === 'Enter') data = '\r';
    else if (e.key === 'Backspace') data = '\x7f';
    else if (e.key === 'Tab') data = '\t';
    else if (e.key === 'Escape') data = '\x1b';
    else if (e.key === 'ArrowUp') data = '\x1b[A';
    else if (e.key === 'ArrowDown') data = '\x1b[B';
    else if (e.key === 'ArrowRight') data = '\x1b[C';
    else if (e.key === 'ArrowLeft') data = '\x1b[D';
    else if (e.key === 'Home') data = '\x1b[H';
    else if (e.key === 'End') data = '\x1b[F';
    else if (e.ctrlKey && e.key.toLowerCase() === 'c') data = '\x03';
    else if (e.ctrlKey && e.key.toLowerCase() === 'd') data = '\x04';
    else if (e.ctrlKey && e.key.toLowerCase() === 'l') data = '\x0c';
    else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) data = e.key;
    else return;
    e.preventDefault();
    try {
      await ptyWrite(sessionId.current, data);
    } catch (err) {
      setError(String(err));
    }
  };

  const onPaste = async (e: React.ClipboardEvent) => {
    if (!sessionId.current) return;
    const text = e.clipboardData.getData('text');
    if (!text) return;
    e.preventDefault();
    await ptyWrite(sessionId.current, text).catch(err => setError(String(err)));
  };

  useEffect(() => {
    const el = hostRef.current;
    if (!el || !session) return;
    const ro = new ResizeObserver(() => {
      const cols = Math.max(40, Math.floor(el.clientWidth / 7.6));
      const rows = Math.max(8, Math.floor(el.clientHeight / 17));
      void ptyResize(session.id, cols, rows).catch(() => undefined);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [session?.id]);

  return (
    <div className="h-full min-h-0 flex flex-col bg-[#0d1117] text-surface-100">
      <div className="flex items-center gap-1 px-2 py-1 border-b border-white/10 text-[11px]">
        <select
          value={shell}
          onChange={e => setShell(e.target.value)}
          className="bg-transparent border border-white/10 rounded px-1.5 py-0.5"
          title="Shell"
        >
          {shells.map(s => (
            <option key={s.id} value={s.id} disabled={!s.available}>
              {s.label}{s.available ? '' : ' (unavailable)'}
            </option>
          ))}
        </select>
        <button type="button" className="p-1 rounded hover:bg-white/10" title="New terminal" onClick={() => void start()} disabled={busy}>
          <Plus className="w-3.5 h-3.5" />
        </button>
        <button type="button" className="p-1 rounded hover:bg-white/10" title="Kill terminal" onClick={() => void stop()}>
          <Trash2 className="w-3.5 h-3.5" />
        </button>
        <button type="button" className="p-1 rounded hover:bg-white/10 ml-auto" title="Clear buffer" onClick={() => setBuffer('')}>
          <X className="w-3.5 h-3.5" />
        </button>
        <span className="text-surface-500 truncate">
          {session ? `${session.shell} · ${session.cwd}` : cwd || 'No workspace'}
        </span>
      </div>
      {error && <div className="px-2 py-1 text-[11px] text-red-300 border-b border-red-900/40">{error}</div>}
      {!session && (
        <div className="p-3 text-[12px] text-surface-400 space-y-2">
          <p>Integrated terminal drives a real {shells.find(s => s.id === shell)?.label || 'shell'} process, not a log view.</p>
          <button type="button" className="btn-primary text-xs" disabled={busy} onClick={() => void start()}>
            Start {shells.find(s => s.id === shell)?.label || 'shell'}
          </button>
          {shells.find(s => s.id === shell && !s.available)?.note && (
            <p className="text-amber-300">{shells.find(s => s.id === shell)?.note}</p>
          )}
        </div>
      )}
      <pre
        ref={hostRef}
        tabIndex={0}
        onKeyDown={e => void onKeyDown(e)}
        onPaste={e => void onPaste(e)}
        className="flex-1 min-h-0 overflow-auto p-2 m-0 text-[12px] leading-[17px] font-mono whitespace-pre-wrap break-words outline-none caret-emerald-400"
      >
        {buffer || (session ? '' : '')}
      </pre>
    </div>
  );
}
