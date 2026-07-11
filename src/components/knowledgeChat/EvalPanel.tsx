import { useState } from 'react';
import { FlaskConical, Loader2 } from 'lucide-react';
import { kcRunEval, humanError } from '../../knowledgeChat/api';
import { useKnowledgeChatStore } from '../../knowledgeChat/store';
import type { KcEvalMode, KcEvalResult } from '../../knowledgeChat/types';
import { KC_CONFIDENCE_LABELS } from '../../knowledgeChat/types';

export default function EvalPanel() {
  const { collections, activeCollectionId } = useKnowledgeChatStore();
  const activeCollection = collections.find(item => item.id === activeCollectionId) || null;
  const [evalMode, setEvalMode] = useState<KcEvalMode>('generic');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<KcEvalResult | null>(null);

  const runEval = async () => {
    if (!activeCollection || activeCollection.status !== 'ready') return;
    setBusy(true);
    setError(null);
    try {
      const evalResult = await kcRunEval(activeCollection.id, 8, evalMode, true);
      setResult(evalResult);
    } catch (err) {
      setError(humanError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel-shell p-4 sm:p-6 space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-surface-500">Retrieval Eval</p>
          <h2 className="text-xl font-black text-surface-950 dark:text-white">Golden Query Harness</h2>
          <p className="mt-1 text-xs text-surface-500 dark:text-surface-400">
            Run golden queries against the active collection using the same retrieval path as chat (server embed + dense rerank).
          </p>
        </div>
        <div className="flex flex-col sm:flex-row gap-2 shrink-0">
          <select
            value={evalMode}
            onChange={e => setEvalMode(e.target.value as KcEvalMode)}
            className="input-field text-xs"
          >
            <option value="generic">Generic folder checks</option>
            <option value="soc">SOC golden queries</option>
            <option value="all">All cases</option>
          </select>
          <button
          type="button"
          onClick={runEval}
          disabled={!activeCollection || activeCollection.status !== 'ready' || busy}
          className="btn-secondary flex items-center justify-center gap-2 shrink-0"
        >
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <FlaskConical className="w-4 h-4" />}
          Run Eval
        </button>
        </div>
      </div>

      {error && (
        <div className="rounded-2xl border border-amber-200/70 dark:border-amber-900 bg-amber-50/85 dark:bg-amber-950/20 px-4 py-3 text-sm text-amber-800 dark:text-amber-200">
          {error}
        </div>
      )}

      {result && (
        <div className="space-y-4">
          <div className="grid sm:grid-cols-4 gap-2">
            <Metric label="Mode" value={result.eval_mode} />
            <Metric label="Cases passed" value={`${result.cases_passed}/${result.cases_run}`} />
            <Metric label="Avg recall@k" value={result.average_recall_at_k.toFixed(2)} />
            <Metric label="Production parity" value={result.production_parity ? 'Yes' : 'No'} />
          </div>
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-2">
            <Metric label="Avg term hit rate" value={result.average_term_hit_rate.toFixed(2)} />
            <Metric label="Avg MRR" value={result.average_mrr.toFixed(2)} />
            <Metric
              label="Avg context precision@k"
              value={(result.average_context_precision_at_k ?? 0).toFixed(2)}
            />
            <Metric
              label="Avg lexical faithfulness"
              value={(result.average_lexical_faithfulness ?? 0).toFixed(2)}
            />
          </div>

          <div className="rounded-2xl border border-white/70 dark:border-surface-800 overflow-hidden">
            <table className="w-full text-xs">
              <thead className="bg-surface-100/80 dark:bg-surface-900/60 text-surface-500">
                <tr>
                  <th className="text-left px-3 py-2 font-bold">Case</th>
                  <th className="text-left px-3 py-2 font-bold">Hits</th>
                  <th className="text-left px-3 py-2 font-bold">Recall</th>
                  <th className="text-left px-3 py-2 font-bold">Prec@k</th>
                  <th className="text-left px-3 py-2 font-bold">Faith</th>
                  <th className="text-left px-3 py-2 font-bold">Terms</th>
                  <th className="text-left px-3 py-2 font-bold">Confidence</th>
                  <th className="text-left px-3 py-2 font-bold">Pass</th>
                </tr>
              </thead>
              <tbody>
                {result.results.map(row => (
                  <tr key={row.case_id} className="border-t border-white/70 dark:border-surface-800">
                    <td className="px-3 py-2 align-top">
                      <p className="font-semibold text-surface-800 dark:text-surface-100">{row.case_id}</p>
                      <p className="text-surface-500 mt-0.5">{row.question}</p>
                      {row.top_file && <p className="text-surface-400 mt-1">Top: {row.top_file}</p>}
                    </td>
                    <td className="px-3 py-2">{row.hit_count}</td>
                    <td className="px-3 py-2">{row.recall_at_k.toFixed(2)}</td>
                    <td className="px-3 py-2">{(row.context_precision_at_k ?? 0).toFixed(2)}</td>
                    <td className="px-3 py-2">{(row.lexical_faithfulness ?? 0).toFixed(2)}</td>
                    <td className="px-3 py-2">{row.term_hit_rate.toFixed(2)}</td>
                    <td className="px-3 py-2">{KC_CONFIDENCE_LABELS[row.confidence]}</td>
                    <td className="px-3 py-2">{row.passed ? 'Yes' : 'No'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-white/70 dark:border-surface-800 bg-white/70 dark:bg-surface-900/45 p-3">
      <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-surface-500">{label}</p>
      <p className="text-lg font-black text-surface-950 dark:text-white">{value}</p>
    </div>
  );
}
