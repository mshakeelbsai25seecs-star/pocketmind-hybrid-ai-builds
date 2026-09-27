import type { SocCase, SocConfidence, SocDisposition } from '../../../soc/types';

const DISPOSITIONS: SocDisposition[] = [
  'undetermined', 'benign', 'suspicious', 'malicious', 'needs_evidence',
];
const CONFIDENCES: SocConfidence[] = ['unknown', 'low', 'medium', 'high'];

export default function VerdictPanel({
  socCase,
  onDisposition,
  onConfidence,
}: {
  socCase: SocCase;
  onDisposition: (d: SocDisposition) => void;
  onConfidence: (c: SocConfidence) => void;
}) {
  const v = socCase.verdict;
  if (!v) {
    return <p className="text-sm text-surface-500">No verdict yet. Run Investigate.</p>;
  }

  return (
    <div className="space-y-3 text-sm">
      <div className="grid sm:grid-cols-2 gap-2">
        <label className="block">
          <span className="text-xs font-bold uppercase tracking-wide text-surface-500">Disposition</span>
          <select
            className="input-field mt-1"
            value={socCase.disposition}
            onChange={e => onDisposition(e.target.value as SocDisposition)}
          >
            {DISPOSITIONS.map(d => <option key={d} value={d}>{d}</option>)}
          </select>
        </label>
        <label className="block">
          <span className="text-xs font-bold uppercase tracking-wide text-surface-500">Confidence</span>
          <select
            className="input-field mt-1"
            value={v.confidence}
            onChange={e => onConfidence(e.target.value as SocConfidence)}
          >
            {CONFIDENCES.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
      </div>
      <p className="font-medium text-surface-900 dark:text-surface-50">{v.summary}</p>
      <p className="text-surface-600 dark:text-surface-300 whitespace-pre-wrap">{v.reasoning}</p>
      <div>
        <p className="text-xs font-bold uppercase tracking-wide text-surface-500 mb-1">Evidence found</p>
        <ul className="list-disc pl-5 space-y-0.5">
          {(v.evidenceFound.length ? v.evidenceFound : ['—']).map(item => <li key={item}>{item}</li>)}
        </ul>
      </div>
      <div>
        <p className="text-xs font-bold uppercase tracking-wide text-surface-500 mb-1">Missing evidence</p>
        <ul className="list-disc pl-5 space-y-0.5">
          {(v.missingEvidence.length ? v.missingEvidence : ['—']).map(item => <li key={item}>{item}</li>)}
        </ul>
      </div>
      <div>
        <p className="text-xs font-bold uppercase tracking-wide text-surface-500 mb-1">Recommended actions</p>
        <ul className="list-disc pl-5 space-y-0.5">
          {(v.recommendedActions.length ? v.recommendedActions : ['—']).map(item => <li key={item}>{item}</li>)}
        </ul>
      </div>
      <div>
        <p className="text-xs font-bold uppercase tracking-wide text-surface-500 mb-1">Interview questions</p>
        <ul className="list-disc pl-5 space-y-0.5">
          {(v.interviewQuestions.length ? v.interviewQuestions : ['—']).map(item => <li key={item}>{item}</li>)}
        </ul>
      </div>
      {v.aiDisposition && v.aiDisposition !== socCase.disposition && (
        <p className="text-xs text-amber-700 dark:text-amber-300">
          AI disposition was {v.aiDisposition}; human override recorded.
        </p>
      )}
    </div>
  );
}
