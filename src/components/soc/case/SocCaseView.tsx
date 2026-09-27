import { useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '../../../store';
import { approveCase, closeCase, updateCaseConfidence, updateCaseDisposition } from '../../../soc/caseActions';
import { createEvidenceStep } from '../../../soc/caseFactory';
import { socExportCaseMarkdown, socPersistenceMode } from '../../../soc/caseStore';
import { useSocGroundedKnowledge } from '../../../hooks/useSocGroundedKnowledge';
import { runInvestigation } from '../../../soc/investigate/runInvestigation';
import { createMemoryEntry, socListMemory, socSaveMemory } from '../../../soc/memoryStore';
import { buildCaseMarkdown } from '../../../soc/report/caseMarkdown';
import type { SocCase, SocConfidence, SocDisposition, SocSeverity } from '../../../soc/types';
import { useSocActiveCase } from '../SocActiveCaseContext';
import EvidenceChain from './EvidenceChain';
import VerdictPanel from './VerdictPanel';

const APPROVER_KEY = 'pocketmind-soc-approver';

export default function SocCaseView() {
  const {
    activeCase, saveActiveCase, setStatus, busy, setBusy, refreshIndex, setNav,
  } = useSocActiveCase();
  const currentModel = useAppStore(s => s.currentModel);
  const defaultParams = useAppStore(s => s.defaultParams);
  const [approver, setApprover] = useState(() => localStorage.getItem(APPROVER_KEY) || '');
  const [draft, setDraft] = useState<SocCase | null>(null);
  const [draftNote, setDraftNote] = useState('');
  const [memKey, setMemKey] = useState('');
  const [memType, setMemType] = useState<'ip' | 'user' | 'host'>('ip');
  const [memNote, setMemNote] = useState('');
  const [memClass, setMemClass] = useState<'benign_expected' | 'suspicious_watch' | 'malicious_known' | 'context'>('benign_expected');
  const saveTimer = useRef<number | null>(null);

  useEffect(() => {
    if (!activeCase) {
      setDraft(null);
      return;
    }
    // Don't clobber in-flight edits for the same case id unless server is newer after investigate
    setDraft(prev => {
      if (!prev || prev.id !== activeCase.id) return activeCase;
      if ((activeCase.updatedAt || 0) >= (prev.updatedAt || 0)) return activeCase;
      return prev;
    });
  }, [activeCase]);

  useEffect(() => {
    if (approver.trim()) localStorage.setItem(APPROVER_KEY, approver.trim());
  }, [approver]);

  const c = draft;

  const workspaceInput = useMemo(() => ({
    alertSummary: c?.summary || '',
    rawLogs: c?.rawEvidence || '',
    sourceIp: c?.entities.sourceIp || '',
    destinationIp: c?.entities.destinationIp || '',
    username: c?.entities.username || '',
    asset: c?.entities.asset || '',
    severity: c?.severity || '',
    notes: c?.notes || '',
  }), [c]);

  const grounded = useSocGroundedKnowledge({
    action: 'investigation',
    workspaceInput,
    enabled: !!c,
  });

  if (!c) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm text-surface-500 p-6">
        Select a case from the queue.
      </div>
    );
  }

  const persist = (next: SocCase) => {
    setDraft(next);
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      void saveActiveCase(next).catch(err => setStatus(String(err)));
    }, 300);
  };

  const patch = (partial: Partial<SocCase>) => {
    const next: SocCase = {
      ...c,
      ...partial,
      entities: partial.entities ? { ...c.entities, ...partial.entities } : c.entities,
      updatedAt: Date.now(),
    };
    persist(next);
  };

  const flush = async (): Promise<SocCase> => {
    if (saveTimer.current) {
      window.clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    return saveActiveCase(c);
  };

  const onInvestigate = async () => {
    setBusy(true);
    setStatus(null);
    try {
      const current = await flush();
      const next = await runInvestigation(current, {
        currentModel: currentModel || '',
        defaultParams: defaultParams as unknown as Record<string, unknown>,
        knowledgeContext: grounded.knowledgeContext,
        knowledgeHitCount: grounded.contextHits.length,
        knowledgeTitles: grounded.mergedChunks.slice(0, 5).map(x => x.title || x.resourceTitle),
      });
      setDraft(next);
      await saveActiveCase(next);
      await refreshIndex();
      setStatus(`Investigation complete · ${next.disposition}`);
    } catch (err) {
      setStatus(String(err));
      try {
        const reloaded = await flush();
        setDraft(reloaded);
        await refreshIndex();
      } catch { /* ignore */ }
    } finally {
      setBusy(false);
    }
  };

  const onDisposition = async (d: SocDisposition) => {
    setBusy(true);
    try {
      const current = await flush();
      const next = await updateCaseDisposition(current, d, approver || 'analyst');
      setDraft(next);
      await saveActiveCase(next);
      await refreshIndex();
    } catch (err) {
      setStatus(String(err));
    } finally {
      setBusy(false);
    }
  };

  const onConfidence = async (conf: SocConfidence) => {
    setBusy(true);
    try {
      const current = await flush();
      const next = await updateCaseConfidence(current, conf, approver || 'analyst');
      setDraft(next);
      await saveActiveCase(next);
    } catch (err) {
      setStatus(String(err));
    } finally {
      setBusy(false);
    }
  };

  const onApprove = async (closeAfter: boolean) => {
    setBusy(true);
    setStatus(null);
    try {
      const current = await flush();
      const next = await approveCase(current, approver, closeAfter);
      setDraft(next);
      await saveActiveCase(next);
      await refreshIndex();
      setStatus(closeAfter ? `Approved and closed ${next.id}` : `Approved ${next.id}`);
    } catch (err) {
      setStatus(String(err));
    } finally {
      setBusy(false);
    }
  };

  const onClose = async () => {
    setBusy(true);
    try {
      const current = await flush();
      const next = await closeCase(current, approver || 'analyst');
      setDraft(next);
      await saveActiveCase(next);
      await refreshIndex();
      setStatus(`Closed ${next.id}`);
    } catch (err) {
      setStatus(String(err));
    } finally {
      setBusy(false);
    }
  };

  const onExport = async () => {
    setBusy(true);
    try {
      const current = await flush();
      const path = await socExportCaseMarkdown(current.id, buildCaseMarkdown(current));
      setStatus(`Exported ${path}`);
    } catch (err) {
      setStatus(String(err));
    } finally {
      setBusy(false);
    }
  };

  const addManualStep = async () => {
    if (!draftNote.trim()) {
      setStatus('Enter an evidence note first.');
      return;
    }
    const next = {
      ...c,
      evidenceChain: [...c.evidenceChain, createEvidenceStep('manual', 'Analyst note', draftNote.trim())],
      updatedAt: Date.now(),
    };
    setDraftNote('');
    setDraft(next);
    await saveActiveCase(next);
    setStatus('Evidence note added.');
  };

  const saveMemory = async () => {
    setBusy(true);
    try {
      const entries = await socListMemory();
      const entry = createMemoryEntry({
        entityType: memType,
        key: memKey || (memType === 'ip' ? c.entities.sourceIp : memType === 'user' ? c.entities.username : c.entities.asset),
        note: memNote,
        classification: memClass,
        createdBy: approver || 'analyst',
        createdFromCaseId: c.id,
      });
      await socSaveMemory([...entries, entry]);
      const next = {
        ...c,
        evidenceChain: [
          ...c.evidenceChain,
          createEvidenceStep('memory', 'Saved memory entry', `${entry.entityType}:${entry.key}`),
        ],
        updatedAt: Date.now(),
      };
      setDraft(next);
      await saveActiveCase(next);
      setMemNote('');
      setStatus('Memory entry saved.');
    } catch (err) {
      setStatus(String(err));
    } finally {
      setBusy(false);
    }
  };

  const copyInterview = async () => {
    const qs = c.verdict?.interviewQuestions || [];
    if (!qs.length) {
      setStatus('No interview questions on this verdict.');
      return;
    }
    await navigator.clipboard.writeText(qs.map((q, i) => `${i + 1}. ${q}`).join('\n'));
    setStatus('Interview questions copied.');
  };

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-4 sm:p-5 space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-bold text-surface-950 dark:text-white truncate">{c.id}</h2>
          <p className="text-xs text-surface-500">
            {c.status} · {c.severity} · {c.disposition}
            {socPersistenceMode() === 'browser' ? ' · browser store' : ''}
          </p>
        </div>
        <button type="button" className="btn-primary text-sm" disabled={busy || !currentModel} onClick={() => void onInvestigate()}>
          {busy ? 'Working…' : 'Investigate'}
        </button>
        <button type="button" className="btn-secondary text-sm" disabled={busy} onClick={() => void onApprove(false)}>Approve</button>
        <button type="button" className="btn-secondary text-sm" disabled={busy} onClick={() => void onApprove(true)}>Approve & close</button>
        <button type="button" className="btn-secondary text-sm" disabled={busy} onClick={() => void onClose()}>Close</button>
        <button type="button" className="btn-secondary text-sm" disabled={busy} onClick={() => void onExport()}>Export</button>
        <button type="button" className="btn-secondary text-sm" onClick={() => setNav('workspace')}>Workspace</button>
        <button type="button" className="btn-secondary text-sm" onClick={() => void copyInterview()}>Copy interview Qs</button>
      </div>

      {!currentModel && (
        <p className="text-xs text-amber-700 dark:text-amber-300">Select a model in Models before Investigate.</p>
      )}

      <label className="block max-w-xs">
        <span className="text-xs font-bold uppercase tracking-wide text-surface-500">Analyst / approver</span>
        <input className="input-field mt-1 text-sm" value={approver} onChange={e => setApprover(e.target.value)} placeholder="Name for audit log" />
      </label>

      <div className="grid xl:grid-cols-3 gap-3">
        <section className="rounded-2xl border border-surface-200 dark:border-surface-800 p-4 space-y-2">
          <h3 className="font-semibold text-sm">Alert & entities</h3>
          <input className="input-field text-sm" value={c.title} onChange={e => patch({ title: e.target.value })} placeholder="Title" />
          <textarea className="input-field text-sm min-h-[5rem]" value={c.summary} onChange={e => patch({ summary: e.target.value })} placeholder="Summary" />
          <div className="grid grid-cols-2 gap-2">
            <select className="input-field text-sm" value={c.severity} onChange={e => patch({ severity: e.target.value as SocSeverity })}>
              {['critical', 'high', 'medium', 'low', 'info', 'unknown'].map(s => <option key={s} value={s}>{s}</option>)}
            </select>
            <input className="input-field text-sm" value={c.assignee} onChange={e => patch({ assignee: e.target.value })} placeholder="Assignee" />
            <input className="input-field text-sm" value={c.entities.sourceIp} onChange={e => patch({ entities: { ...c.entities, sourceIp: e.target.value } })} placeholder="Source IP" />
            <input className="input-field text-sm" value={c.entities.destinationIp} onChange={e => patch({ entities: { ...c.entities, destinationIp: e.target.value } })} placeholder="Destination IP" />
            <input className="input-field text-sm" value={c.entities.username} onChange={e => patch({ entities: { ...c.entities, username: e.target.value } })} placeholder="User" />
            <input className="input-field text-sm" value={c.entities.asset} onChange={e => patch({ entities: { ...c.entities, asset: e.target.value } })} placeholder="Asset" />
          </div>
          <textarea className="input-field font-mono text-xs min-h-[8rem]" value={c.rawEvidence} onChange={e => patch({ rawEvidence: e.target.value })} placeholder="Raw evidence / logs" />
          <textarea className="input-field text-sm min-h-[3rem]" value={c.notes} onChange={e => patch({ notes: e.target.value })} placeholder="Analyst notes" />

          <div className="pt-2 border-t border-surface-200 dark:border-surface-800 space-y-2">
            <h4 className="text-xs font-bold uppercase tracking-wide text-surface-500">Save to memory</h4>
            <div className="grid grid-cols-2 gap-2">
              <select className="input-field text-sm" value={memType} onChange={e => setMemType(e.target.value as typeof memType)}>
                <option value="ip">ip</option>
                <option value="user">user</option>
                <option value="host">host</option>
              </select>
              <select className="input-field text-sm" value={memClass} onChange={e => setMemClass(e.target.value as typeof memClass)}>
                <option value="benign_expected">benign_expected</option>
                <option value="suspicious_watch">suspicious_watch</option>
                <option value="malicious_known">malicious_known</option>
                <option value="context">context</option>
              </select>
            </div>
            <input className="input-field text-sm" value={memKey} onChange={e => setMemKey(e.target.value)} placeholder="Key (defaults to entity field)" />
            <input className="input-field text-sm" value={memNote} onChange={e => setMemNote(e.target.value)} placeholder="Memory note" />
            <button type="button" className="btn-secondary text-xs" disabled={busy} onClick={() => void saveMemory()}>Save memory</button>
          </div>
        </section>

        <section className="rounded-2xl border border-surface-200 dark:border-surface-800 p-4 space-y-2">
          <h3 className="font-semibold text-sm">Evidence chain</h3>
          <EvidenceChain steps={c.evidenceChain} />
          <div className="pt-2 space-y-2 border-t border-surface-200 dark:border-surface-800">
            <textarea className="input-field text-sm min-h-[3rem]" value={draftNote} onChange={e => setDraftNote(e.target.value)} placeholder="Add analyst evidence note" />
            <button type="button" className="btn-secondary text-xs" disabled={busy} onClick={() => void addManualStep()}>Append note</button>
          </div>
        </section>

        <section className="rounded-2xl border border-surface-200 dark:border-surface-800 p-4 space-y-2">
          <h3 className="font-semibold text-sm">Verdict</h3>
          <p className="text-[11px] text-surface-500">
            {grounded.loading ? 'Retrieving knowledge…' : grounded.contextHits.length ? `${grounded.contextHits.length} knowledge hits ready` : 'No knowledge hits'}
          </p>
          <VerdictPanel socCase={c} onDisposition={d => void onDisposition(d)} onConfidence={conf => void onConfidence(conf)} />
        </section>
      </div>
    </div>
  );
}
