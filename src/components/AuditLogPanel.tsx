import { useEffect, useState } from 'react';
import { ClipboardList, Download, Loader2, RefreshCw } from 'lucide-react';
import { exportAuditLogCsv, fetchAuditLog, formatAuditTimestamp, type AuditLogEntry } from '../auditLog';

const CATEGORIES = ['all', 'soc', 'deployment', 'backup', 'audit', 'product', 'kc'] as const;

export default function AuditLogPanel() {
  const [entries, setEntries] = useState<AuditLogEntry[]>([]);
  const [category, setCategory] = useState<string>('all');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setBusy(true);
    setError(null);
    try {
      const items = await fetchAuditLog({
        limit: 300,
        category: category === 'all' ? undefined : category,
      });
      setEntries(items);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void load();
  }, [category]);

  const exportCsv = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const path = await exportAuditLogCsv({
        limit: 5000,
        category: category === 'all' ? undefined : category,
      });
      setNotice(path ? `Audit log exported to ${path}` : 'Export cancelled.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="glass-panel rounded-xl p-6 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <h3 className="font-semibold flex items-center gap-2">
            <ClipboardList className="w-5 h-5 text-primary-500" />
            SOC audit log
          </h3>
          <div className="flex flex-wrap gap-2">
            <select value={category} onChange={e => setCategory(e.target.value)} className="input-field w-40">
              {CATEGORIES.map(item => (
                <option key={item} value={item}>{item}</option>
              ))}
            </select>
            <button type="button" onClick={() => void load()} disabled={busy} className="btn-secondary flex items-center gap-2">
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
              Refresh
            </button>
            <button type="button" onClick={() => void exportCsv()} disabled={busy} className="btn-secondary flex items-center gap-2">
              <Download className="w-4 h-4" /> Export CSV
            </button>
          </div>
        </div>

        <p className="text-sm text-surface-600 dark:text-surface-300">
          Local record of exports, indexing, triage, reports, and settings changes.
        </p>

        {notice && <p className="text-sm text-emerald-600 dark:text-emerald-300">{notice}</p>}
        {error && <p className="text-sm text-red-600 dark:text-red-300">{error}</p>}

        <div className="max-h-[28rem] overflow-auto border border-surface-200 dark:border-surface-800 rounded-xl">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-surface-50 dark:bg-surface-900">
              <tr className="text-left text-xs uppercase tracking-wide text-surface-500">
                <th className="p-3">Time</th>
                <th className="p-3">Category</th>
                <th className="p-3">Event</th>
                <th className="p-3">Summary</th>
              </tr>
            </thead>
            <tbody>
              {entries.length === 0 ? (
                <tr>
                  <td colSpan={4} className="p-4 text-surface-500">No audit events yet.</td>
                </tr>
              ) : entries.map(entry => (
                <tr key={entry.id} className="border-t border-surface-100 dark:border-surface-800 align-top">
                  <td className="p-3 whitespace-nowrap text-xs">{formatAuditTimestamp(entry.created_at)}</td>
                  <td className="p-3 text-xs font-mono">{entry.category}</td>
                  <td className="p-3 text-xs font-mono">{entry.event_type}</td>
                  <td className="p-3">
                    <p className={entry.success ? '' : 'text-amber-700 dark:text-amber-300'}>{entry.summary}</p>
                    {entry.resource_path && (
                      <p className="mt-1 text-[11px] font-mono text-surface-500 truncate max-w-md">{entry.resource_path}</p>
                    )}
                    {entry.detail && (
                      <p className="mt-1 text-[11px] text-surface-500">{entry.detail}</p>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
