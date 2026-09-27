import { useEffect, useState } from 'react';
import { socRecomputeMetrics } from '../../../soc/caseStore';
import { formatDurationMs } from '../../../soc/metrics';
import type { SocMetricsSummary } from '../../../soc/types';
import { useSocActiveCase } from '../SocActiveCaseContext';

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-2xl border border-surface-200 dark:border-surface-800 p-4">
      <p className="text-xs font-bold uppercase tracking-wide text-surface-500">{label}</p>
      <p className="mt-2 text-2xl font-black text-surface-950 dark:text-white">{value}</p>
    </div>
  );
}

export default function SocMetricsView() {
  const { setStatus, busy, setBusy } = useSocActiveCase();
  const [metrics, setMetrics] = useState<SocMetricsSummary | null>(null);

  const reload = async () => {
    setBusy(true);
    try {
      const next = await socRecomputeMetrics();
      setMetrics(next);
    } catch (err) {
      setStatus(String(err));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!metrics) {
    return <div className="p-6 text-sm text-surface-500">{busy ? 'Computing…' : 'No metrics yet.'}</div>;
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-4 sm:p-5 space-y-4">
      <div className="flex justify-end gap-2">
        <button
          type="button"
          className="btn-secondary text-sm"
          disabled={busy || !metrics}
          onClick={() => {
            if (!metrics) return;
            const blob = new Blob([JSON.stringify(metrics, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `soc-metrics-${metrics.computed_at}.json`;
            a.click();
            URL.revokeObjectURL(url);
            setStatus('Metrics JSON downloaded.');
          }}
        >
          Export JSON
        </button>
        <button
          type="button"
          className="btn-secondary text-sm"
          disabled={busy || !metrics}
          onClick={() => {
            if (!metrics) return;
            const rows = [
              ['metric', 'value'],
              ['total_cases', String(metrics.total_cases)],
              ['open_cases', String(metrics.open_cases)],
              ['closed_cases', String(metrics.closed_cases)],
              ['with_verdict', String(metrics.with_verdict)],
              ['investigated_coverage', String(metrics.investigated_coverage)],
              ['override_rate', String(metrics.override_rate ?? '')],
              ['override_count', String(metrics.override_count)],
              ['median_time_to_verdict_ms', String(metrics.median_time_to_verdict_ms ?? '')],
              ['p90_time_to_close_ms', String(metrics.p90_time_to_close_ms ?? '')],
            ];
            const csv = rows.map(r => r.map(c => `"${c.replace(/"/g, '""')}"`).join(',')).join('\n');
            const blob = new Blob([csv], { type: 'text/csv' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `soc-metrics-${metrics.computed_at}.csv`;
            a.click();
            URL.revokeObjectURL(url);
            setStatus('Metrics CSV downloaded.');
          }}
        >
          Export CSV
        </button>
        <button type="button" className="btn-secondary text-sm" disabled={busy} onClick={() => void reload()}>
          Refresh
        </button>
      </div>
      <div className="grid sm:grid-cols-2 xl:grid-cols-4 gap-3">
        <Stat label="Total cases" value={metrics.total_cases} />
        <Stat label="Open" value={metrics.open_cases} />
        <Stat label="Closed" value={metrics.closed_cases} />
        <Stat label="With verdict" value={metrics.with_verdict} />
        <Stat label="Coverage" value={`${Math.round(metrics.investigated_coverage * 100)}%`} />
        <Stat label="Override rate" value={metrics.override_rate == null ? '—' : `${Math.round(metrics.override_rate * 100)}%`} />
        <Stat label="Median time to verdict" value={formatDurationMs(metrics.median_time_to_verdict_ms)} />
        <Stat label="P90 time to close" value={formatDurationMs(metrics.p90_time_to_close_ms)} />
      </div>
      <div className="grid md:grid-cols-2 gap-3">
        <section className="rounded-2xl border border-surface-200 dark:border-surface-800 p-4">
          <h3 className="font-semibold text-sm mb-2">Disposition mix</h3>
          <ul className="text-sm space-y-1">
            {Object.entries(metrics.disposition_mix || {}).map(([k, v]) => (
              <li key={k} className="flex justify-between gap-3"><span>{k}</span><span>{v}</span></li>
            ))}
            {!Object.keys(metrics.disposition_mix || {}).length && <li className="text-surface-500">—</li>}
          </ul>
        </section>
        <section className="rounded-2xl border border-surface-200 dark:border-surface-800 p-4">
          <h3 className="font-semibold text-sm mb-2">Source mix</h3>
          <ul className="text-sm space-y-1">
            {Object.entries(metrics.source_mix || {}).map(([k, v]) => (
              <li key={k} className="flex justify-between gap-3"><span>{k}</span><span>{v}</span></li>
            ))}
            {!Object.keys(metrics.source_mix || {}).length && <li className="text-surface-500">—</li>}
          </ul>
        </section>
      </div>
    </div>
  );
}
