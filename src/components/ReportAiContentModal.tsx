import { FormEvent, useEffect, useId, useState } from 'react';
import { Flag, Loader2, X } from 'lucide-react';
import {
  AI_CONTENT_REPORT_EMAIL,
  AI_CONTENT_REPORT_REASONS,
  AiContentReportPayload,
  AiContentReportReason,
  submitAiContentReport,
  truncateForReport,
} from '../reportAiContent';

export type ReportAiContentTarget = {
  contentExcerpt: string;
  sourceLabel: string;
  contentKind?: AiContentReportPayload['contentKind'];
};

type Props = {
  open: boolean;
  target: ReportAiContentTarget | null;
  onClose: () => void;
};

export default function ReportAiContentModal({ open, target, onClose }: Props) {
  const titleId = useId();
  const [reason, setReason] = useState<AiContentReportReason>('inappropriate');
  const [details, setDetails] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setReason('inappropriate');
    setDetails('');
    setBusy(false);
    setStatus(null);
    setError(null);
  }, [open, target?.contentExcerpt, target?.sourceLabel]);

  if (!open || !target) return null;

  const excerpt = truncateForReport(target.contentExcerpt, 500);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const mode = await submitAiContentReport({
        reason,
        details,
        contentExcerpt: target.contentExcerpt,
        sourceLabel: target.sourceLabel,
        contentKind: target.contentKind || 'text',
      });
      setStatus(
        mode === 'mailto'
          ? `Your email app should open so you can send the report to ${AI_CONTENT_REPORT_EMAIL}.`
          : `Email could not open automatically. The report text was copied — paste it into a message to ${AI_CONTENT_REPORT_EMAIL}.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm"
      role="presentation"
      onClick={() => {
        if (!busy) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="w-full max-w-lg rounded-2xl border border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-900 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-surface-200 dark:border-surface-800">
          <div className="flex items-start gap-3 min-w-0">
            <div className="w-10 h-10 rounded-xl bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 flex items-center justify-center shrink-0">
              <Flag className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <h2 id={titleId} className="text-lg font-bold tracking-tight">
                Report AI-generated content
              </h2>
              <p className="text-sm text-surface-500 mt-0.5">
                Flag inappropriate, harmful, or policy-violating AI output. Reports go to PocketMind support.
              </p>
            </div>
          </div>
          <button
            type="button"
            className="p-1.5 rounded-lg hover:bg-surface-100 dark:hover:bg-surface-800 text-surface-500"
            onClick={onClose}
            disabled={busy}
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={(event) => void onSubmit(event)} className="px-5 py-4 space-y-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-surface-500 mb-1">
              Source
            </p>
            <p className="text-sm text-surface-700 dark:text-surface-300">{target.sourceLabel}</p>
          </div>

          {excerpt && (
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-surface-500 mb-1">
                Content excerpt
              </p>
              <pre className="text-xs whitespace-pre-wrap break-words rounded-xl bg-surface-50 dark:bg-surface-950 border border-surface-200 dark:border-surface-800 p-3 max-h-32 overflow-y-auto text-surface-700 dark:text-surface-300">
                {excerpt}
              </pre>
            </div>
          )}

          <fieldset className="space-y-2">
            <legend className="text-xs font-semibold uppercase tracking-wide text-surface-500 mb-1">
              Why are you reporting this?
            </legend>
            {AI_CONTENT_REPORT_REASONS.map((item) => (
              <label
                key={item.id}
                className="flex items-center gap-2 text-sm text-surface-700 dark:text-surface-200 cursor-pointer"
              >
                <input
                  type="radio"
                  name="ai-report-reason"
                  value={item.id}
                  checked={reason === item.id}
                  onChange={() => setReason(item.id)}
                  disabled={busy}
                />
                {item.label}
              </label>
            ))}
          </fieldset>

          <div>
            <label htmlFor="ai-report-details" className="text-xs font-semibold uppercase tracking-wide text-surface-500">
              Additional details (optional)
            </label>
            <textarea
              id="ai-report-details"
              value={details}
              onChange={(event) => setDetails(event.target.value)}
              rows={3}
              disabled={busy}
              placeholder="Describe what is wrong with this AI output…"
              className="mt-1 w-full rounded-xl border border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-950 px-3 py-2 text-sm"
            />
          </div>

          {status && (
            <p className="text-sm text-green-700 dark:text-green-300" role="status">
              {status}
            </p>
          )}
          {error && (
            <p className="text-sm text-amber-700 dark:text-amber-300" role="alert">
              {error}
            </p>
          )}

          <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
            <button type="button" className="btn-secondary text-sm" onClick={onClose} disabled={busy}>
              {status ? 'Close' : 'Cancel'}
            </button>
            {!status && (
              <button type="submit" className="btn-primary text-sm inline-flex items-center gap-2" disabled={busy}>
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Flag className="w-4 h-4" />}
                Submit report
              </button>
            )}
          </div>
          <p className="text-[11px] text-surface-500">
            Or email {AI_CONTENT_REPORT_EMAIL} directly. We review reports and take action when content violates Store or app policies.
          </p>
        </form>
      </div>
    </div>
  );
}
