import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ChevronDown, ChevronRight, RefreshCw, Square, TerminalSquare } from 'lucide-react';
import {
  killTerminalSession,
  loadTerminalSessions,
  refreshTerminalSession,
  subscribeTerminalSessions,
  terminalSessionList,
} from '../../codeWorkspace/terminalSessions';
import { terminalStatusLabel } from '../../codeWorkspace/terminalTypes';

function durationLabel(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const secs = ms / 1000;
  if (secs < 60) return `${secs.toFixed(secs < 10 ? 1 : 0)}s`;
  const mins = Math.floor(secs / 60);
  return `${mins}m ${Math.round(secs - mins * 60)}s`;
}

/**
 * Live view of commands the agent (or the user) started: streaming output while they run, plus a
 * short history of finished runs. Output is owned by the backend; this only renders snapshots.
 */
export default function TerminalPanel() {
  const sessions = useSyncExternalStore(subscribeTerminalSessions, terminalSessionList);
  const [open, setOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const outputRef = useRef<HTMLPreElement>(null);
  const pinnedToBottom = useRef(true);

  useEffect(() => {
    void loadTerminalSessions();
  }, []);

  const running = useMemo(() => sessions.filter(s => s.running).length, [sessions]);

  // Follow the newest session unless the user picked one.
  const selected = useMemo(() => {
    if (selectedId) {
      const match = sessions.find(s => s.id === selectedId);
      if (match) return match;
    }
    return sessions[0] || null;
  }, [selectedId, sessions]);

  // A new command should pop the panel open — that is the point of running it.
  useEffect(() => {
    if (running > 0) setOpen(true);
  }, [running]);

  useEffect(() => {
    if (!open || !selected) return;
    void refreshTerminalSession(selected.id).catch(() => undefined);
  }, [open, selected?.id]);

  useEffect(() => {
    const el = outputRef.current;
    if (!el || !pinnedToBottom.current) return;
    el.scrollTop = el.scrollHeight;
  }, [selected?.output, selected?.id]);

  if (sessions.length === 0) return null;

  return (
    <div className="border-t border-surface-200 dark:border-surface-800 flex-shrink-0">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center gap-1.5 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-surface-500 hover:bg-surface-50 dark:hover:bg-surface-900"
      >
        {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        <TerminalSquare className="w-3 h-3" />
        Terminal
        <span className="normal-case tracking-normal font-medium text-surface-400">
          {running > 0 ? `${running} running · ${sessions.length}` : sessions.length}
        </span>
        {running > 0 && <span className="w-1.5 h-1.5 rounded-full bg-primary-500 animate-pulse" />}
      </button>

      {open && (
        <div className="flex flex-col max-h-64">
          <div className="flex gap-1 overflow-x-auto px-1.5 pb-1">
            {sessions.slice(0, 8).map(s => (
              <button
                key={s.id}
                type="button"
                onClick={() => setSelectedId(s.id)}
                title={`${s.command} — ${terminalStatusLabel(s)}`}
                className={`shrink-0 max-w-[14rem] truncate px-1.5 py-0.5 rounded text-[10px] font-mono border ${
                  selected?.id === s.id
                    ? 'bg-surface-100 dark:bg-surface-800 border-surface-300 dark:border-surface-700'
                    : 'border-transparent text-surface-500 hover:bg-surface-50 dark:hover:bg-surface-900'
                }`}
              >
                {s.running && (
                  <span className="inline-block w-1.5 h-1.5 mr-1 rounded-full bg-primary-500 animate-pulse align-middle" />
                )}
                {s.command}
              </button>
            ))}
          </div>

          {selected && (
            <>
              <div className="flex items-center gap-2 px-2.5 pb-1 text-[10px] text-surface-500">
                <span className="font-mono truncate">{selected.command}</span>
                <span
                  className={
                    selected.running
                      ? 'text-primary-600 dark:text-primary-300'
                      : selected.exit_code === 0
                        ? 'text-surface-500'
                        : 'text-red-600 dark:text-red-400'
                  }
                >
                  {terminalStatusLabel(selected)}
                </span>
                <span>{durationLabel(selected.duration_ms)}</span>
                <div className="ml-auto flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => void refreshTerminalSession(selected.id)}
                    className="p-0.5 rounded hover:bg-surface-100 dark:hover:bg-surface-800"
                    title="Refresh output"
                  >
                    <RefreshCw className="w-3 h-3" />
                  </button>
                  {selected.running && (
                    <button
                      type="button"
                      onClick={() => void killTerminalSession(selected.id)}
                      className="flex items-center gap-1 px-1.5 py-0.5 rounded text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30"
                      title="Stop this process"
                    >
                      <Square className="w-3 h-3" /> Stop
                    </button>
                  )}
                </div>
              </div>
              <pre
                ref={outputRef}
                onScroll={e => {
                  const el = e.currentTarget;
                  pinnedToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
                }}
                className="flex-1 min-h-0 overflow-auto px-2.5 pb-2 text-[11px] leading-relaxed font-mono whitespace-pre-wrap break-words text-surface-700 dark:text-surface-300"
              >
                {selected.truncated ? '…[earlier output trimmed]\n' : ''}
                {selected.output || (selected.running ? 'Waiting for output…' : '(no output)')}
              </pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}
