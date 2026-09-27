import { useEffect, useState } from 'react';
import {
  createMemoryEntry,
  socListMemory,
  socSaveMemory,
} from '../../../soc/memoryStore';
import type { SocMemoryEntry } from '../../../soc/types';
import { useSocActiveCase } from '../SocActiveCaseContext';

export default function SocMemoryView() {
  const { setStatus, busy, setBusy } = useSocActiveCase();
  const [entries, setEntries] = useState<SocMemoryEntry[]>([]);
  const [entityType, setEntityType] = useState<SocMemoryEntry['entityType']>('ip');
  const [key, setKey] = useState('');
  const [note, setNote] = useState('');
  const [classification, setClassification] = useState<SocMemoryEntry['classification']>('benign_expected');
  const [createdBy, setCreatedBy] = useState('analyst');

  const reload = async () => {
    const rows = await socListMemory();
    setEntries(rows);
  };

  useEffect(() => {
    void reload().catch(err => setStatus(String(err)));
  }, [setStatus]);

  const add = async () => {
    if (!key.trim() || !note.trim()) {
      setStatus('Key and note are required.');
      return;
    }
    setBusy(true);
    try {
      const next = [
        ...entries,
        createMemoryEntry({ entityType, key, note, classification, createdBy }),
      ];
      const saved = await socSaveMemory(next);
      setEntries(saved);
      setKey('');
      setNote('');
      setStatus('Memory entry added.');
    } catch (err) {
      setStatus(String(err));
    } finally {
      setBusy(false);
    }
  };

  const deactivate = async (id: string) => {
    setBusy(true);
    try {
      const next = entries.map(e => (e.id === id ? { ...e, active: false, updatedAt: Date.now() } : e));
      const saved = await socSaveMemory(next);
      setEntries(saved);
      setStatus('Memory entry deactivated.');
    } catch (err) {
      setStatus(String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-4 sm:p-5 space-y-4">
      <div className="grid md:grid-cols-5 gap-2 items-end">
        <label className="block">
          <span className="text-xs font-bold uppercase tracking-wide text-surface-500">Type</span>
          <select className="input-field mt-1 text-sm" value={entityType} onChange={e => setEntityType(e.target.value as SocMemoryEntry['entityType'])}>
            {['ip', 'user', 'host', 'domain', 'process', 'other'].map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>
        <label className="block md:col-span-1">
          <span className="text-xs font-bold uppercase tracking-wide text-surface-500">Key</span>
          <input className="input-field mt-1 text-sm" value={key} onChange={e => setKey(e.target.value)} />
        </label>
        <label className="block md:col-span-1">
          <span className="text-xs font-bold uppercase tracking-wide text-surface-500">Classification</span>
          <select className="input-field mt-1 text-sm" value={classification} onChange={e => setClassification(e.target.value as SocMemoryEntry['classification'])}>
            {['benign_expected', 'suspicious_watch', 'malicious_known', 'context'].map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>
        <label className="block">
          <span className="text-xs font-bold uppercase tracking-wide text-surface-500">Analyst</span>
          <input className="input-field mt-1 text-sm" value={createdBy} onChange={e => setCreatedBy(e.target.value)} />
        </label>
        <button type="button" className="btn-primary text-sm" disabled={busy} onClick={() => void add()}>Add</button>
      </div>
      <label className="block">
        <span className="text-xs font-bold uppercase tracking-wide text-surface-500">Note</span>
        <textarea className="input-field mt-1 text-sm min-h-[4rem]" value={note} onChange={e => setNote(e.target.value)} />
      </label>

      {entries.length === 0 ? (
        <p className="text-sm text-surface-500">No memory entries.</p>
      ) : (
        <div className="rounded-2xl border border-surface-200 dark:border-surface-800 overflow-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-surface-500">
              <tr>
                <th className="px-3 py-2">Active</th>
                <th className="px-3 py-2">Type</th>
                <th className="px-3 py-2">Key</th>
                <th className="px-3 py-2">Class</th>
                <th className="px-3 py-2">Note</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {entries.map(entry => (
                <tr key={entry.id} className="border-t border-surface-100 dark:border-surface-800">
                  <td className="px-3 py-2">{entry.active ? 'yes' : 'no'}</td>
                  <td className="px-3 py-2">{entry.entityType}</td>
                  <td className="px-3 py-2 font-mono text-xs">{entry.key}</td>
                  <td className="px-3 py-2">{entry.classification}</td>
                  <td className="px-3 py-2">{entry.note}</td>
                  <td className="px-3 py-2 text-right">
                    {entry.active && (
                      <button type="button" className="text-xs text-amber-700 dark:text-amber-300" onClick={() => void deactivate(entry.id)}>
                        Deactivate
                      </button>
                    )}
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
