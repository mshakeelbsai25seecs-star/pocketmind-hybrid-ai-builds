import { AlertTriangle, Play, Terminal } from 'lucide-react';
import type { SandboxPendingRequest } from '../../codeWorkspace/sandboxTypes';
import type { SandboxRunResult } from '../../codeWorkspace/types';

export default function SandboxPanel({
  pending,
  lastResult,
  busy,
  onConfirm,
  onCancel,
}: {
  pending: SandboxPendingRequest | null;
  lastResult: SandboxRunResult | null;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="rounded-xl border border-surface-200 dark:border-surface-800 bg-white/70 dark:bg-surface-950/50 p-4 space-y-3">
      <div className="flex items-center gap-2 text-sm font-bold">
        <Terminal className="w-4 h-4 text-primary-500" />
        Allowlisted runner (not a free shell)
      </div>

      {pending && (
        <div className="rounded-lg border border-amber-200 dark:border-amber-900/60 bg-amber-50 dark:bg-amber-950/20 p-3 space-y-2">
          <p className="text-xs text-amber-800 dark:text-amber-200 flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            {pending.mode === 'cli'
              ? 'Agent wants to run an allowlisted CLI in your workspace. Confirm before execution.'
              : `Agent wants to run a ${pending.language} script in the workspace sandbox. Confirm before execution.`}
            {pending.background
              ? ' This one keeps running in the background until it exits or you stop it in the Terminal panel.'
              : ''}
          </p>
          {pending.mode === 'cli' ? (
            <pre className="text-xs font-mono max-h-32 overflow-auto bg-white/60 dark:bg-surface-900/60 rounded p-2">
              {pending.argv.map(a => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}
            </pre>
          ) : (
            <pre className="text-xs font-mono max-h-32 overflow-auto bg-white/60 dark:bg-surface-900/60 rounded p-2">
              {pending.code}
            </pre>
          )}
          <div className="flex gap-2">
            <button disabled={busy} onClick={onConfirm} className="btn-primary text-xs flex items-center gap-1">
              <Play className="w-3.5 h-3.5" /> Run
            </button>
            <button disabled={busy} onClick={onCancel} className="btn-secondary text-xs">Cancel</button>
          </div>
        </div>
      )}

      {lastResult && (
        <div className="space-y-2 text-xs font-mono">
          <div className="flex flex-wrap gap-2 text-surface-500">
            <span>{lastResult.language}</span>
            <span>exit: {lastResult.exit_code ?? 'n/a'}</span>
            <span>{lastResult.duration_ms}ms</span>
            {lastResult.timed_out && <span className="text-amber-600">timed out</span>}
          </div>
          {lastResult.stdout && (
            <div>
              <p className="font-bold text-surface-500 mb-1">stdout</p>
              <pre className="max-h-28 overflow-auto rounded bg-surface-50 dark:bg-surface-900 p-2">{lastResult.stdout}</pre>
            </div>
          )}
          {lastResult.stderr && (
            <div>
              <p className="font-bold text-red-500 mb-1">stderr</p>
              <pre className="max-h-28 overflow-auto rounded bg-red-50 dark:bg-red-950/20 p-2 text-red-700 dark:text-red-300">{lastResult.stderr}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
