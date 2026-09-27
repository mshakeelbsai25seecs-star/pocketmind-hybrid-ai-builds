import type { SocCase, SocMetricsSummary } from './types';

function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const idx = Math.round((sorted.length - 1) * p);
  return sorted[idx] ?? null;
}

export function computeSocMetrics(cases: SocCase[]): SocMetricsSummary {
  const disposition_mix: Record<string, number> = {};
  const source_mix: Record<string, number> = {};
  const timeToVerdict: number[] = [];
  const timeToClose: number[] = [];
  let closed = 0;
  let with_verdict = 0;
  let override_count = 0;
  let override_denom = 0;

  for (const c of cases) {
    disposition_mix[c.disposition] = (disposition_mix[c.disposition] || 0) + 1;
    source_mix[c.source.kind] = (source_mix[c.source.kind] || 0) + 1;
    if (c.status === 'closed' || c.closedAt) closed += 1;
    if (c.verdict) with_verdict += 1;
    if (c.timings.firstVerdictAt && c.createdAt) {
      timeToVerdict.push(c.timings.firstVerdictAt - c.createdAt);
    }
    if (c.closedAt && c.createdAt) {
      timeToClose.push(c.closedAt - c.createdAt);
    }
    if (c.status === 'closed' && c.verdict?.aiDisposition) {
      override_denom += 1;
      if (c.verdict.aiDisposition !== c.disposition) override_count += 1;
    }
  }

  timeToVerdict.sort((a, b) => a - b);
  timeToClose.sort((a, b) => a - b);
  const total = cases.length;

  return {
    total_cases: total,
    open_cases: Math.max(0, total - closed),
    closed_cases: closed,
    with_verdict,
    disposition_mix,
    source_mix,
    median_time_to_verdict_ms: percentile(timeToVerdict, 0.5),
    p90_time_to_verdict_ms: percentile(timeToVerdict, 0.9),
    median_time_to_close_ms: percentile(timeToClose, 0.5),
    p90_time_to_close_ms: percentile(timeToClose, 0.9),
    override_rate: override_denom > 0 ? override_count / override_denom : null,
    override_count,
    investigated_coverage: total > 0 ? with_verdict / total : 0,
    computed_at: Date.now(),
  };
}

export function formatDurationMs(ms?: number | null): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1)} s`;
  const min = sec / 60;
  if (min < 60) return `${min.toFixed(1)} min`;
  return `${(min / 60).toFixed(1)} h`;
}
