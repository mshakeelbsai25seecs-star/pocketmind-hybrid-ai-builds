import type { SocEvidenceStep } from '../../../soc/types';

export default function EvidenceChain({ steps }: { steps: SocEvidenceStep[] }) {
  if (!steps.length) {
    return <p className="text-sm text-surface-500">No evidence steps yet.</p>;
  }
  return (
    <ol className="space-y-2">
      {steps.map(step => (
        <li
          key={step.id}
          className={`rounded-xl border px-3 py-2 text-sm ${
            step.ok
              ? 'border-surface-200 dark:border-surface-700'
              : 'border-amber-300/70 dark:border-amber-800'
          }`}
        >
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="text-[11px] text-surface-500">{new Date(step.at).toLocaleString()}</span>
            <span className="text-[11px] uppercase tracking-wide text-primary-600 dark:text-primary-300">{step.source}</span>
            <span className="font-semibold text-surface-900 dark:text-surface-50">{step.action}</span>
          </div>
          <p className="mt-1 text-surface-600 dark:text-surface-300 whitespace-pre-wrap">{step.detail}</p>
          {step.hypothesis && (
            <p className="mt-1 text-xs text-surface-500">Hypothesis: {step.hypothesis}</p>
          )}
        </li>
      ))}
    </ol>
  );
}
