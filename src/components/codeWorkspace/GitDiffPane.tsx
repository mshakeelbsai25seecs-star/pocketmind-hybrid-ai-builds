import { useMemo, type ReactNode } from 'react';
import type { GitDiffResult } from '../../codeWorkspace/ideApi';

function parseUnified(unified: string): Array<{ type: 'hunk' | 'meta' | 'add' | 'del' | 'ctx'; text: string; ln?: number }> {
  const rows: Array<{ type: 'hunk' | 'meta' | 'add' | 'del' | 'ctx'; text: string; ln?: number }> = [];
  let newLn = 0;
  for (const raw of unified.split('\n')) {
    if (raw.startsWith('@@')) {
      const m = raw.match(/\+(\d+)/);
      newLn = m ? Number(m[1]) : newLn;
      rows.push({ type: 'hunk', text: raw });
      continue;
    }
    if (raw.startsWith('diff ') || raw.startsWith('index ') || raw.startsWith('---') || raw.startsWith('+++')) {
      rows.push({ type: 'meta', text: raw });
      continue;
    }
    if (raw.startsWith('+')) {
      rows.push({ type: 'add', text: raw.slice(1), ln: newLn });
      newLn += 1;
    } else if (raw.startsWith('-')) {
      rows.push({ type: 'del', text: raw.slice(1) });
    } else {
      const body = raw.startsWith(' ') ? raw.slice(1) : raw;
      rows.push({ type: 'ctx', text: body, ln: newLn });
      newLn += 1;
    }
  }
  return rows;
}

function DiffScrollShell({ children }: { children: ReactNode }) {
  return (
    <div className="h-full min-h-0 overflow-auto font-mono text-[12px] leading-[1.55] bg-[#0d1117]">
      {children}
    </div>
  );
}

export default function GitDiffPane({
  diff,
  loading,
}: {
  diff: GitDiffResult | null;
  loading?: boolean;
}) {
  const rows = useMemo(() => (diff?.unified ? parseUnified(diff.unified) : []), [diff?.unified]);

  if (loading) {
    return (
      <DiffScrollShell>
        <p className="p-4 text-xs text-surface-400">Loading git diff…</p>
      </DiffScrollShell>
    );
  }
  if (!diff) {
    return (
      <DiffScrollShell>
        <p className="p-4 text-xs text-surface-400">Select a file to see its git diff against HEAD.</p>
      </DiffScrollShell>
    );
  }
  if (diff.error) {
    return (
      <DiffScrollShell>
        <div className="p-4 text-sm text-amber-200 space-y-1">
          <p>{diff.error}</p>
          {diff.modified ? (
            <pre className="mt-3 text-[12px] text-surface-300 whitespace-pre-wrap font-mono">{diff.modified}</pre>
          ) : null}
        </div>
      </DiffScrollShell>
    );
  }
  if (diff.binary) {
    return (
      <DiffScrollShell>
        <p className="p-4 text-sm text-surface-400">{diff.unified || 'Binary file — no text diff.'}</p>
      </DiffScrollShell>
    );
  }
  if (!diff.unified.trim() && diff.original === diff.modified) {
    return (
      <DiffScrollShell>
        <p className="p-4 text-xs text-surface-400">No uncommitted changes vs HEAD.</p>
      </DiffScrollShell>
    );
  }

  return (
    <DiffScrollShell>
      {diff.too_large && (
        <div className="sticky top-0 z-10 px-3 py-1.5 text-[11px] bg-amber-950/90 text-amber-200 border-b border-white/10">
          Large diff truncated for the editor. Full file is still on disk.
        </div>
      )}
      <div className="sticky top-0 z-10 px-3 py-1.5 text-[11px] text-surface-400 border-b border-white/10 bg-[#0d1117]/95">
        {diff.untracked ? 'Untracked file' : '1 file changed'}
        {diff.too_large ? ' · truncated' : ''}
      </div>
      {rows.map((row, i) => (
        <div
          key={i}
          className={
            row.type === 'add'
              ? 'bg-[#1b4332]/70 text-emerald-100'
              : row.type === 'del'
                ? 'bg-[#5c1a1a]/80 text-red-100'
                : row.type === 'hunk'
                  ? 'bg-[#161b22] text-sky-300'
                  : row.type === 'meta'
                    ? 'text-surface-500'
                    : 'text-surface-200'
          }
        >
          <span className="inline-block w-10 text-right pr-2 text-[#6e7681] select-none">
            {row.ln ?? ''}
          </span>
          <span className="inline-block w-4 select-none opacity-70">
            {row.type === 'add' ? '+' : row.type === 'del' ? '−' : row.type === 'hunk' ? '@' : ' '}
          </span>
          <span className="whitespace-pre">{row.text || ' '}</span>
        </div>
      ))}
    </DiffScrollShell>
  );
}
