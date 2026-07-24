import { useMemo } from 'react';
import * as Diff from 'diff';

export type DiffViewerMode = 'unified' | 'split';

export interface DiffViewerProps {
  original: string;
  modified: string;
  mode?: DiffViewerMode;
  className?: string;
  originalLabel?: string;
  modifiedLabel?: string;
}

/**
 * Side-by-side / unified text diff for AI rewrites and Code Workspace edits.
 */
export default function DiffViewer({
  original,
  modified,
  mode = 'split',
  className = '',
  originalLabel = 'Original',
  modifiedLabel = 'Proposed',
}: DiffViewerProps) {
  const parts = useMemo(() => Diff.diffLines(original || '', modified || ''), [original, modified]);

  if (mode === 'unified') {
    return (
      <div className={`rounded-xl border border-surface-200 dark:border-surface-800 overflow-hidden text-sm font-mono ${className}`}>
        <div className="px-3 py-2 text-xs font-bold uppercase tracking-wider bg-surface-50 dark:bg-surface-900 text-surface-500">
          Unified diff
        </div>
        <pre className="p-3 overflow-auto max-h-[28rem] whitespace-pre-wrap">
          {parts.map((part, i) => (
            <span
              key={i}
              className={
                part.added
                  ? 'bg-green-100 dark:bg-green-950/50 text-green-800 dark:text-green-200'
                  : part.removed
                    ? 'bg-red-100 dark:bg-red-950/50 text-red-800 dark:text-red-200'
                    : 'text-surface-700 dark:text-surface-300'
              }
            >
              {part.value}
            </span>
          ))}
        </pre>
      </div>
    );
  }

  return (
    <div className={`grid md:grid-cols-2 gap-0 rounded-xl border border-surface-200 dark:border-surface-800 overflow-hidden text-sm font-mono ${className}`}>
      <div className="border-b md:border-b-0 md:border-r border-surface-200 dark:border-surface-800">
        <div className="px-3 py-2 text-xs font-bold uppercase tracking-wider bg-surface-50 dark:bg-surface-900 text-surface-500">
          {originalLabel}
        </div>
        <pre className="p-3 overflow-auto max-h-[28rem] whitespace-pre-wrap bg-red-50/40 dark:bg-red-950/20">
          {parts.map((part, i) =>
            part.added ? null : (
              <span key={i} className={part.removed ? 'bg-red-200/70 dark:bg-red-900/50' : ''}>
                {part.value}
              </span>
            ),
          )}
        </pre>
      </div>
      <div>
        <div className="px-3 py-2 text-xs font-bold uppercase tracking-wider bg-surface-50 dark:bg-surface-900 text-surface-500">
          {modifiedLabel}
        </div>
        <pre className="p-3 overflow-auto max-h-[28rem] whitespace-pre-wrap bg-green-50/40 dark:bg-green-950/20">
          {parts.map((part, i) =>
            part.removed ? null : (
              <span key={i} className={part.added ? 'bg-green-200/70 dark:bg-green-900/50' : ''}>
                {part.value}
              </span>
            ),
          )}
        </pre>
      </div>
    </div>
  );
}
