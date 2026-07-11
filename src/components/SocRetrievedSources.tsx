import { useState } from 'react';
import { BookOpen, Loader2, RefreshCw } from 'lucide-react';
import type { KcSearchHit } from '../knowledgeChat/types';
import { confidenceBadgeClass, formatSourceCitation, formatSourceSnippetPreview } from '../knowledgeChat/prompts';
import { KC_ANSWER_MODE_LABELS, KC_CONFIDENCE_LABELS } from '../knowledgeChat/types';

type SocRetrievedSourcesProps = {
  hits: KcSearchHit[];
  loading?: boolean;
  error?: string | null;
  notice?: string | null;
  query?: string;
  onRefresh?: () => void;
  compact?: boolean;
};

export default function SocRetrievedSources({
  hits,
  loading = false,
  error = null,
  notice = null,
  query,
  onRefresh,
  compact = false,
}: SocRetrievedSourcesProps) {
  const [expanded, setExpanded] = useState(!compact);

  return (
    <div className="rounded-2xl border border-emerald-200/70 dark:border-emerald-900/60 bg-emerald-50/70 dark:bg-emerald-950/20 p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <BookOpen className="w-4 h-4 text-emerald-600 dark:text-emerald-300 shrink-0" />
            <p className="text-xs font-bold uppercase tracking-[0.16em] text-emerald-700 dark:text-emerald-300">
              Auto-retrieved company knowledge
            </p>
          </div>
          {query && (
            <p className="mt-1 text-xs text-surface-600 dark:text-surface-300 truncate" title={query}>
              Query: {query}
            </p>
          )}
        </div>
        {onRefresh && (
          <button
            type="button"
            onClick={onRefresh}
            disabled={loading}
            className="btn-secondary text-xs px-3 py-1.5 flex items-center gap-1.5 shrink-0"
          >
            {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            Refresh
          </button>
        )}
      </div>

      {loading && (
        <p className="text-sm text-surface-600 dark:text-surface-300 flex items-center gap-2">
          <Loader2 className="w-4 h-4 animate-spin" />
          Searching indexed company folder…
        </p>
      )}

      {error && !loading && (
        <p className="text-sm text-amber-700 dark:text-amber-300">{error}</p>
      )}

      {notice && !loading && (
        <p className="text-xs text-sky-700 dark:text-sky-300">{notice}</p>
      )}

      {!loading && !error && hits.length > 0 && (
        <>
          <p className={`text-xs font-semibold ${confidenceBadgeClass('medium')}`}>
            {hits.length} snippet{hits.length === 1 ? '' : 's'} injected into SOC prompts and reports
          </p>
          <button
            type="button"
            onClick={() => setExpanded(prev => !prev)}
            className="text-xs font-bold text-emerald-700 dark:text-emerald-300"
          >
            {expanded ? 'Hide snippets' : 'Show snippets'}
          </button>
          {expanded && (
            <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
              {hits.map(hit => (
                <div
                  key={hit.chunk.id}
                  className="rounded-xl border border-white/70 dark:border-surface-800 bg-white/80 dark:bg-surface-900/50 p-3"
                >
                  <p className="text-xs font-bold text-surface-900 dark:text-white">
                    {formatSourceCitation(hit)}
                  </p>
                  <p className="mt-1 text-xs leading-5 text-surface-600 dark:text-surface-300">
                    {formatSourceSnippetPreview(hit.chunk.text, compact ? 180 : 280)}
                  </p>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {!loading && !error && hits.length === 0 && (
        <p className="text-sm text-surface-500 dark:text-surface-400">
          {KC_ANSWER_MODE_LABELS.not_found} — {KC_CONFIDENCE_LABELS.none}. Link and index a company folder to ground SOC answers.
        </p>
      )}
    </div>
  );
}
