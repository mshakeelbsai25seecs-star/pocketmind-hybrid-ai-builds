import { useState } from 'react';
import type { KcAnswerMode, KcRetrievalConfidence, KcSearchHit } from '../../knowledgeChat/types';
import {
  confidenceBadgeClass,
  formatSourceCitation,
  formatSourceSnippetPreview,
} from '../../knowledgeChat/prompts';
import { retrievalStatusLabel } from '../../knowledgeChat/formatAnswer';

type SourceSummary = {
  file_name: string;
  file_path?: string;
  title?: string;
  rank: number;
  snippet?: string;
  source_confidence?: number;
  interpretation?: string;
  line_start?: number | null;
  line_end?: number | null;
};

type MessageSourcesProps = {
  hits?: KcSearchHit[];
  summaries?: SourceSummary[];
  confidence?: KcRetrievalConfidence;
  answerMode?: KcAnswerMode;
  compact?: boolean;
  title?: string;
};

function hitFromSummary(summary: SourceSummary): KcSearchHit {
  return {
    rank: summary.rank,
    fused_score: 0,
    rerank_score: 0,
    keyword_score: 0,
    lexical_score: 0,
    dense_score: 0,
    fts_score: 0,
    retrieval_mode: 'hybrid_lexical',
    chunk: {
      id: `${summary.file_name}-${summary.rank}`,
      collection_id: '',
      file_id: '',
      file_name: summary.file_name,
      file_path: summary.file_path || summary.file_name,
      chunk_index: summary.rank,
      title: summary.title || summary.file_name,
      section_path: summary.title || null,
      start_char: 0,
      end_char: 0,
      text: summary.snippet || summary.title || '',
      context_text: null,
      doc_type: 'document',
      top_terms: [],
      has_dense: false,
      line_start: summary.line_start ?? null,
      line_end: summary.line_end ?? null,
      source_confidence: summary.source_confidence ?? null,
    },
  };
}

function confidenceLabel(value?: number | null): string | null {
  if (value == null || Number.isNaN(value)) return null;
  return `${Math.round(value * 100)}% confidence`;
}

export default function MessageSources({
  hits = [],
  summaries = [],
  confidence,
  answerMode,
  compact = false,
  title = 'Sources',
}: MessageSourcesProps) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const items = hits.length ? hits : summaries.map(hitFromSummary);
  const summaryByRank = new Map(summaries.map(item => [item.rank, item]));

  if (!items.length) return null;

  return (
    <div className={`${compact ? 'mt-3' : 'mt-4'} rounded-xl border border-surface-200 dark:border-surface-800 bg-surface-50/80 dark:bg-surface-900/50 p-3`}>
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-surface-500">{title}</p>
        {confidence && answerMode && (
          <span className={`text-[10px] font-semibold ${confidenceBadgeClass(confidence)}`}>
            {retrievalStatusLabel(confidence, answerMode)}
          </span>
        )}
      </div>
      <ul className="space-y-2">
        {items.slice(0, compact ? 4 : 6).map(hit => {
          const id = hit.chunk.id;
          const isOpen = expanded[id];
          const summary = summaryByRank.get(hit.rank);
          const previewLimit = isOpen ? 900 : 280;
          const preview = hit.chunk.text.length <= previewLimit && summaries.length
            ? hit.chunk.text
            : formatSourceSnippetPreview(hit.chunk.text, previewLimit);
          const conf = hit.chunk.source_confidence ?? summary?.source_confidence;
          const interpretation = summary?.interpretation;
          const lineAnchor = hit.chunk.line_start && hit.chunk.line_start > 0
            ? `L${hit.chunk.line_start}${hit.chunk.line_end && hit.chunk.line_end > hit.chunk.line_start ? `–L${hit.chunk.line_end}` : ''}`
            : null;
          return (
            <li key={id} className="text-xs text-surface-600 dark:text-surface-300">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-surface-800 dark:text-surface-100">{formatSourceCitation(hit)}</span>
                {lineAnchor && (
                  <span className="text-[10px] text-surface-500">{lineAnchor}</span>
                )}
                {confidenceLabel(conf) && (
                  <span className="text-[10px] text-primary-700 dark:text-primary-300">{confidenceLabel(conf)}</span>
                )}
              </div>
              <p className="text-[11px] text-surface-600 dark:text-surface-400 mt-1 leading-relaxed whitespace-pre-wrap">
                {preview}
              </p>
              {interpretation && (
                <p className="text-[11px] text-surface-700 dark:text-surface-200 mt-1 leading-relaxed">
                  <span className="font-semibold">What this means:</span> {interpretation}
                </p>
              )}
              {hit.chunk.text.length > 280 && (
                <button
                  type="button"
                  onClick={() => setExpanded(prev => ({ ...prev, [id]: !prev[id] }))}
                  className="mt-1 text-[10px] font-semibold text-primary-700 dark:text-primary-300 hover:underline"
                >
                  {isOpen ? 'Show less' : 'Show more'}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export type { SourceSummary };
