import { useMemo, useState } from 'react';
import { Plus, Upload } from 'lucide-react';
import { createBlankCase } from '../../../soc/caseFactory';
import { socDeleteCase, socUpsertCase } from '../../../soc/caseStore';
import type { SocCaseIndexEntry } from '../../../soc/types';
import { useSocActiveCase } from '../SocActiveCaseContext';

function ageLabel(ts: number): string {
  const ms = Date.now() - ts;
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}

export default function SocQueueView() {
  const {
    index, refreshIndex, setActiveCaseId, setNav, setStatus, busy, setBusy, saveActiveCase,
  } = useSocActiveCase();
  const [q, setQ] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');

  const rows = useMemo(() => {
    const query = q.trim().toLowerCase();
    return index.filter(row => {
      if (statusFilter !== 'all' && row.status !== statusFilter) return false;
      if (!query) return true;
      return [row.id, row.title, row.assignee, row.external_id || '']
        .join(' ')
        .toLowerCase()
        .includes(query);
    });
  }, [index, q, statusFilter]);

  const createCase = async () => {
    setBusy(true);
    setStatus(null);
    try {
      const created = await socUpsertCase(createBlankCase());
      await refreshIndex();
      setActiveCaseId(created.id);
      await saveActiveCase(created);
      setNav('case');
      setStatus(`Created ${created.id}`);
    } catch (err) {
      setStatus(String(err));
    } finally {
      setBusy(false);
    }
  };

  const openRow = (row: SocCaseIndexEntry) => {
    setActiveCaseId(row.id);
    setNav('case');
  };

  const removeRow = async (row: SocCaseIndexEntry) => {
    if (!window.confirm(`Delete ${row.id}? This cannot be undone.`)) return;
    setBusy(true);
    try {
      await socDeleteCase(row.id);
      await refreshIndex();
      setStatus(`Deleted ${row.id}`);
    } catch (err) {
      setStatus(String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col p-4 sm:p-5 gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <input
          className="input-field text-sm max-w-xs"
          placeholder="Search cases"
          value={q}
          onChange={e => setQ(e.target.value)}
        />
        <select
          className="input-field text-sm w-auto"
          value={statusFilter}
          onChange={e => setStatusFilter(e.target.value)}
        >
          <option value="all">All statuses</option>
          <option value="new">New</option>
          <option value="investigating">Investigating</option>
          <option value="needs_human">Needs human</option>
          <option value="pending_approval">Pending approval</option>
          <option value="closed">Closed</option>
        </select>
        <div className="flex-1" />
        <button type="button" className="btn-secondary text-sm inline-flex items-center gap-1" onClick={() => setNav('import')} disabled={busy}>
          <Upload className="w-4 h-4" /> Import
        </button>
        <button type="button" className="btn-primary text-sm inline-flex items-center gap-1" onClick={() => void createCase()} disabled={busy}>
          <Plus className="w-4 h-4" /> New case
        </button>
      </div>

      {rows.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-sm text-surface-500">
          No cases. Import alerts or create a case.
        </div>
      ) : (
        <div className="flex-1 min-h-0 overflow-auto rounded-2xl border border-surface-200 dark:border-surface-800">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-surface-50 dark:bg-surface-900 text-left text-xs uppercase tracking-wide text-surface-500">
              <tr>
                <th className="px-3 py-2 font-semibold">Case</th>
                <th className="px-3 py-2 font-semibold">Severity</th>
                <th className="px-3 py-2 font-semibold">Status</th>
                <th className="px-3 py-2 font-semibold">Disposition</th>
                <th className="px-3 py-2 font-semibold">Source</th>
                <th className="px-3 py-2 font-semibold">Age</th>
                <th className="px-3 py-2 font-semibold" />
              </tr>
            </thead>
            <tbody>
              {rows.map(row => (
                <tr
                  key={row.id}
                  className="border-t border-surface-100 dark:border-surface-800 hover:bg-surface-50/80 dark:hover:bg-surface-900/40 cursor-pointer"
                  onClick={() => openRow(row)}
                >
                  <td className="px-3 py-2">
                    <div className="font-semibold text-surface-900 dark:text-surface-50">{row.id}</div>
                    <div className="text-xs text-surface-500 truncate max-w-[16rem]">{row.title}</div>
                  </td>
                  <td className="px-3 py-2 capitalize">{row.severity}</td>
                  <td className="px-3 py-2">{row.status}</td>
                  <td className="px-3 py-2">{row.disposition}</td>
                  <td className="px-3 py-2">{row.source_kind}</td>
                  <td className="px-3 py-2">{ageLabel(row.created_at)}</td>
                  <td className="px-3 py-2 text-right">
                    <button
                      type="button"
                      className="text-xs text-red-600 dark:text-red-400"
                      onClick={e => {
                        e.stopPropagation();
                        void removeRow(row);
                      }}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
