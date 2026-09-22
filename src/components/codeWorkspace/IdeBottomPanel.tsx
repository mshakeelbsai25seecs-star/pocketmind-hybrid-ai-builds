import { useEffect, useMemo, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import PtyTerminal from './PtyTerminal';
import {
  debugCurrent,
  debugEval,
  debugStart,
  debugStop,
  diagnosticsRun,
  outputClear,
  outputSnapshot,
  type DebugSessionInfo,
  type DiagnosticItem,
  type OutputLine,
} from '../../codeWorkspace/ideApi';

export type BottomTab = 'terminal' | 'problems' | 'output' | 'debug';

export default function IdeBottomPanel({
  workspaceRoot,
  onOpenFile,
}: {
  workspaceRoot: string | null;
  onOpenFile?: (path: string, line?: number) => void;
}) {
  const [tab, setTab] = useState<BottomTab>('terminal');
  const [problems, setProblems] = useState<DiagnosticItem[]>([]);
  const [notes, setNotes] = useState<string[]>([]);
  const [diagBusy, setDiagBusy] = useState(false);
  const [output, setOutput] = useState<OutputLine[]>([]);
  const [outChannel, setOutChannel] = useState<string>('all');
  const [debug, setDebug] = useState<DebugSessionInfo | null>(null);
  const [debugLog, setDebugLog] = useState('');
  const [expr, setExpr] = useState('');
  const [debugBusy, setDebugBusy] = useState(false);
  const [debugErr, setDebugErr] = useState<string | null>(null);

  const errorCount = problems.filter(p => p.severity === 'error').length;

  const refreshProblems = async () => {
    if (!workspaceRoot) {
      setProblems([]);
      setNotes(['Open a workspace folder to collect diagnostics.']);
      return;
    }
    setDiagBusy(true);
    try {
      const report = await diagnosticsRun(workspaceRoot);
      setProblems(report.diagnostics);
      setNotes(report.notes);
    } catch (err) {
      setNotes([String(err)]);
    } finally {
      setDiagBusy(false);
    }
  };

  useEffect(() => {
    void refreshProblems();
  }, [workspaceRoot]);

  useEffect(() => {
    void outputSnapshot(null).then(setOutput).catch(() => undefined);
    let unlisten: (() => void) | undefined;
    void listen<OutputLine>('cw-output', ev => {
      setOutput(prev => [...prev.slice(-1500), ev.payload]);
    }).then(fn => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, []);

  useEffect(() => {
    void debugCurrent().then(setDebug).catch(() => undefined);
    let unlisten: (() => void) | undefined;
    void listen<{ id: string; stream: string; text: string }>('cw-debug-output', ev => {
      setDebugLog(prev => `${prev}${ev.payload.text}\n`.slice(-200_000));
    }).then(fn => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, []);

  const visibleOutput = useMemo(
    () => outChannel === 'all' ? output : output.filter(l => l.channel === outChannel),
    [output, outChannel],
  );
  const channels = useMemo(
    () => Array.from(new Set(output.map(l => l.channel))),
    [output],
  );

  const startDebug = async (runtime = 'auto') => {
    if (!workspaceRoot) {
      setDebugErr('Open a workspace first.');
      return;
    }
    setDebugBusy(true);
    setDebugErr(null);
    try {
      const info = await debugStart(workspaceRoot, runtime);
      setDebug(info);
      setDebugLog(prev => `${prev}[started ${info.runtime} in ${info.cwd}]\n`);
    } catch (err) {
      setDebugErr(String(err));
    } finally {
      setDebugBusy(false);
    }
  };

  const submitExpr = async () => {
    if (!expr.trim()) return;
    try {
      await debugEval(expr);
      setDebugLog(prev => `${prev}> ${expr}\n`);
      setExpr('');
    } catch (err) {
      setDebugErr(String(err));
    }
  };

  const tabBtn = (id: BottomTab, label: string, extra?: string) => (
    <button
      type="button"
      onClick={() => setTab(id)}
      className={`px-2 py-1 text-[10px] font-semibold uppercase tracking-wider ${
        tab === id ? 'text-white border-b-2 border-primary-400' : 'text-surface-500 hover:text-surface-200'
      }`}
    >
      {label}{extra ? ` ${extra}` : ''}
    </button>
  );

  return (
    <div className="flex flex-col h-full min-h-0 bg-[#0d1117] border-t border-white/10">
      <div className="flex items-center gap-1 px-1 shrink-0">
        {tabBtn('terminal', 'Terminal')}
        {tabBtn('problems', 'Problems', errorCount ? String(errorCount) : '0')}
        {tabBtn('output', 'Output')}
        {tabBtn('debug', 'Debug Console')}
        <div className="ml-auto pr-2">
          {tab === 'problems' && (
            <button type="button" className="text-[10px] text-primary-300" onClick={() => void refreshProblems()} disabled={diagBusy}>
              {diagBusy ? 'Checking…' : 'Run'}
            </button>
          )}
        </div>
      </div>
      <div className="flex-1 min-h-0">
        {tab === 'terminal' && <PtyTerminal cwd={workspaceRoot} defaultShell="powershell" />}
        {tab === 'problems' && (
          <div className="h-full overflow-auto text-[12px]">
            {notes.map((n, i) => <p key={i} className="px-3 py-1 text-amber-200">{n}</p>)}
            {problems.length === 0 && !diagBusy && (
              <p className="px-3 py-2 text-surface-500">No problems in the workspace.</p>
            )}
            {problems.map((p, i) => (
              <button
                key={`${p.path}-${p.line}-${i}`}
                type="button"
                onClick={() => onOpenFile?.(p.path, p.line)}
                className="w-full text-left px-3 py-1 hover:bg-white/5 flex gap-2"
              >
                <span className={p.severity === 'error' ? 'text-red-400' : p.severity === 'warning' ? 'text-amber-300' : 'text-sky-300'}>
                  {p.severity}
                </span>
                <span className="text-surface-200 truncate">{p.message}</span>
                <span className="ml-auto text-surface-500 shrink-0">{p.path}:{p.line}</span>
                <span className="text-surface-600">{p.source}</span>
              </button>
            ))}
          </div>
        )}
        {tab === 'output' && (
          <div className="h-full min-h-0 flex flex-col">
            <div className="flex gap-2 px-2 py-1 text-[11px] border-b border-white/10">
              <select value={outChannel} onChange={e => setOutChannel(e.target.value)} className="bg-transparent border border-white/10 rounded px-1">
                <option value="all">All</option>
                {channels.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
              <button type="button" onClick={() => { void outputClear(outChannel === 'all' ? null : outChannel); setOutput([]); }}>Clear</button>
            </div>
            <pre className="flex-1 overflow-auto p-2 m-0 text-[11px] font-mono whitespace-pre-wrap text-surface-300">
              {visibleOutput.map(l => `[${l.channel}] ${l.text}`).join('\n') || '(no output yet)'}
            </pre>
          </div>
        )}
        {tab === 'debug' && (
          <div className="h-full min-h-0 flex flex-col">
            <div className="flex items-center gap-2 px-2 py-1 text-[11px] border-b border-white/10">
              <button type="button" className="btn-primary text-[11px] py-0.5 px-2" disabled={debugBusy} onClick={() => void startDebug('auto')}>Start</button>
              <button type="button" className="btn-secondary text-[11px] py-0.5 px-2" onClick={() => void startDebug('node')}>Node</button>
              <button type="button" className="btn-secondary text-[11px] py-0.5 px-2" onClick={() => void startDebug('python')}>Python</button>
              <button type="button" className="btn-secondary text-[11px] py-0.5 px-2" onClick={() => void startDebug('powershell')}>PowerShell</button>
              <button type="button" className="btn-secondary text-[11px] py-0.5 px-2" onClick={() => { void debugStop(); setDebug(null); }}>Stop</button>
              <span className="text-surface-500 truncate">{debug ? `${debug.runtime} · running` : 'No session'}</span>
            </div>
            {debugErr && <p className="px-2 text-[11px] text-red-300">{debugErr}</p>}
            <pre className="flex-1 overflow-auto p-2 m-0 text-[11px] font-mono whitespace-pre-wrap text-emerald-100">{debugLog || 'Start a debug runtime, then evaluate expressions below.'}</pre>
            <form
              className="flex gap-1 p-1 border-t border-white/10"
              onSubmit={e => { e.preventDefault(); void submitExpr(); }}
            >
              <input
                value={expr}
                onChange={e => setExpr(e.target.value)}
                placeholder="Evaluate expression…"
                className="flex-1 bg-transparent px-2 py-1 text-[12px] font-mono outline-none"
              />
              <button type="submit" className="btn-primary text-[11px] py-0.5 px-2">Eval</button>
            </form>
          </div>
        )}
      </div>
    </div>
  );
}
