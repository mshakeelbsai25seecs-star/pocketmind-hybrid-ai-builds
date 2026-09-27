import { useMemo, useState } from 'react';
import { useAppStore } from '../../../store';
import { approveCase, closeCase, updateCaseConfidence, updateCaseDisposition } from '../../../soc/caseActions';
import { createEvidenceStep } from '../../../soc/caseFactory';
import { socExportCaseMarkdown } from '../../../soc/caseStore';
import { useSocGroundedKnowledge } from '../../../hooks/useSocGroundedKnowledge';
import { runInvestigation } from '../../../soc/investigate/runInvestigation';
import { createMemoryEntry, socListMemory, socSaveMemory } from '../../../soc/memoryStore';
import { buildCaseMarkdown } from '../../../soc/report/caseMarkdown';
import type { SocConfidence, SocDisposition, SocSeverity } from '../../../soc/types';
import { useSocActiveCase } from '../SocActiveCaseContext';
import EvidenceChain from './EvidenceChain';
import VerdictPanel from './VerdictPanel';

export default function SocCaseView() {
  const {
    activeCase, saveActiveCase, setStatus, busy, setBusy, refreshIndex, setNav,
  } = useSocActiveCase();
  const currentModel = useAppStore(s => s.currentModel);
  const defaultParams = useAppStore(s => s.defaultParams);
  const [approver, setApprover] = useState('');

  const workspaceInput = useMemo(() => ({
    alertSummary: activeCase?.summary || '',
    rawLogs: activeCase?.rawEvidence || '',
    sourceIp: activeCase?.entities.sourceIp || '',
    destinationIp: activeCase?.entities.destinationIp || '',
    username: activeCase?.entities.username || '',
    asset: activeCase?.entities.asset || '',
    severity: activeCase?.severity || '',
    notes: activeCase?.notes || '',
  }), [activeCase]);

  const grounded = useSocGroundedKnowledge({
    action: 'investigation',
    workspaceInput,
    enabled: !!activeCase,
  });

  if (!activeCase) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm text-surface-500 p-6">
        Select a case from the queue.
      </div>
    );
  }

  const patch = async (partial: Partial<typeof activeCase>) => {
    const next = { ...activeCase, ...partial, updatedAt: Date.now() };
    if (partial.entities) {
      next.entities = { ...activeCase.entities, ...partial.entities };
    }
    await saveActiveCase(next);
  };

  const onInvestigate = async () => {
    setBusy(true);
    setStatus(null);
    try {
      const next = await runInvestigation(activeCase, {
        currentModel: currentModel || '',
        defaultParams: defaultParams as unknown as Record<string, unknown>,
        knowledgeContext: grounded.knowledgeContext,
        knowledgeHitCount: grounded.contextHits.length,
        knowledgeTitles: grounded.mergedChunks.slice(0, 5).map(c => c.title || c.resourceTitle),
      });
      await saveActiveCase(next);
      await refreshIndex();
      setStatus(`Investigation complete · ${next.disposition}`);
    } catch (err) {
      setStatus(String(err));
    } finally {
      setBusy(false);
    }
  };

  const onDisposition = async (d: SocDisposition) => {
    setBusy(true);
    try {
      const next = await updateCaseDisposition(activeCase, d, approver || 'analyst');
      await saveActiveCase(next);
      await refreshIndex();
    } catch (err) {
      setStatus(String(err));
    } finally {
      setBusy(false);
    }
  };

  const onConfidence = async (c: SocConfidence) => {
    setBusy(true);
    try {
      const next = await updateCaseConfidence(activeCase, c, approver || 'analyst');
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
      const next = await approveCase(activeCase, approver, closeAfter);
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
      const next = await closeCase(activeCase, approver || 'analyst');
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
      const md = buildCaseMarkdown(activeCase);
      const path = await socExportCaseMarkdown(activeCase.id, md);
      setStatus(`Exported ${path}`);
    } catch (err) {
      setStatus(String(err));
    } finally {
      setBusy(false);
    }
  };

  const saveEntityMemory = async (
    entityType: 'ip' | 'user' | 'host',
    key: string,
  ) => {
    if (!key.trim()) return;
    const note = window.prompt('Memory note', 'Expected in this environment');
    if (note == null) return;
    const classification = window.prompt(
      'Classification: benign_expected | suspicious_watch | malicious_known | context',
      'benign_expected',
    ) as 'benign_expected' | 'suspicious_watch' | 'malicious_known' | 'context' | null;
    if (!classification) return;
    setBusy(true);
    try {
      const entries = await socListMemory();
      const entry = createMemoryEntry({
        entityType,
        key,
        note,
        classification,
        createdBy: approver || 'analyst',
        createdFromCaseId: activeCase.id,
      });
      await socSaveMemory([...entries, entry]);
      const next = {
        ...activeCase,
        evidenceChain: [
          ...activeCase.evidenceChain,
          createEvidenceStep('memory', 'Saved memory entry', `${entityType}:${key}`),
        ],
      };
      await saveActiveCase(next);
      setStatus('Memory entry saved');
    } catch (err) {
      setStatus(String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-4 sm:p-5 space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-bold text-surface-950 dark:text-white truncate">{activeCase.id}</h2>
          <p className="text-xs text-surface-500">
            {activeCase.status} · {activeCase.severity} · {activeCase.disposition}
          </p>
        </div>
        <button type="button" className="btn-primary text-sm" disabled={busy} onClick={() => void onInvestigate()}>
          {busy ? 'Working…' : 'Investigate'}
        </button>
        <button type="button" className="btn-secondary text-sm" disabled={busy} onClick={() => void onApprove(false)}>Approve</button>
        <button type="button" className="btn-secondary text-sm" disabled={busy} onClick={() => void onApprove(true)}>Approve & close</button>
        <button type="button" className="btn-secondary text-sm" disabled={busy} onClick={() => void onClose()}>Close</button>
        <button type="button" className="btn-secondary text-sm" disabled={busy} onClick={() => void onExport()}>Export</button>
        <button type="button" className="btn-secondary text-sm" onClick={() => setNav('workspace')}>Workspace</button>
      </div>

      <label className="block max-w-xs">
        <span className="text-xs font-bold uppercase tracking-wide text-surface-500">Analyst / approver</span>
        <input className="input-field mt-1 text-sm" value={approver} onChange={e => setApprover(e.target.value)} placeholder="Name for audit log" />
      </label>

      <div className="grid xl:grid-cols-3 gap-3">
        <section className="rounded-2xl border border-surface-200 dark:border-surface-800 p-4 space-y-2">
          <h3 className="font-semibold text-sm">Alert & entities</h3>
          <input
            className="input-field text-sm"
            value={activeCase.title}
            onChange={e => void patch({ title: e.target.value })}
            placeholder="Title"
          />
          <textarea
            className="input-field text-sm min-h-[5rem]"
            value={activeCase.summary}
            onChange={e => void patch({ summary: e.target.value })}
            placeholder="Summary"
          />
          <div className="grid grid-cols-2 gap-2">
            <select
              className="input-field text-sm"
              value={activeCase.severity}
              onChange={e => void patch({ severity: e.target.value as SocSeverity })}
            >
              {['critical', 'high', 'medium', 'low', 'info', 'unknown'].map(s => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
            <input
              className="input-field text-sm"
              value={activeCase.assignee}
              onChange={e => void patch({ assignee: e.target.value })}
              placeholder="Assignee"
            />
            <input
              className="input-field text-sm"
              value={activeCase.entities.sourceIp}
              onChange={e => void patch({ entities: { ...activeCase.entities, sourceIp: e.target.value } })}
              placeholder="Source IP"
            />
            <button type="button" className="btn-secondary text-xs" onClick={() => void saveEntityMemory('ip', activeCase.entities.sourceIp)}>Remember IP</button>
            <input
              className="input-field text-sm"
              value={activeCase.entities.destinationIp}
              onChange={e => void patch({ entities: { ...activeCase.entities, destinationIp: e.target.value } })}
              placeholder="Destination IP"
            />
            <input
              className="input-field text-sm"
              value={activeCase.entities.username}
              onChange={e => void patch({ entities: { ...activeCase.entities, username: e.target.value } })}
              placeholder="User"
            />
            <button type="button" className="btn-secondary text-xs" onClick={() => void saveEntityMemory('user', activeCase.entities.username)}>Remember user</button>
            <input
              className="input-field text-sm"
              value={activeCase.entities.asset}
              onChange={e => void patch({ entities: { ...activeCase.entities, asset: e.target.value } })}
              placeholder="Asset"
            />
            <button type="button" className="btn-secondary text-xs" onClick={() => void saveEntityMemory('host', activeCase.entities.asset)}>Remember host</button>
          </div>
          <textarea
            className="input-field font-mono text-xs min-h-[8rem]"
            value={activeCase.rawEvidence}
            onChange={e => void patch({ rawEvidence: e.target.value })}
            placeholder="Raw evidence / logs"
          />
          <textarea
            className="input-field text-sm min-h-[3rem]"
            value={activeCase.notes}
            onChange={e => void patch({ notes: e.target.value })}
            placeholder="Analyst notes"
          />
        </section>

        <section className="rounded-2xl border border-surface-200 dark:border-surface-800 p-4 space-y-2">
          <h3 className="font-semibold text-sm">Evidence chain</h3>
          <EvidenceChain steps={activeCase.evidenceChain} />
        </section>

        <section className="rounded-2xl border border-surface-200 dark:border-surface-800 p-4 space-y-2">
          <h3 className="font-semibold text-sm">Verdict</h3>
          <p className="text-[11px] text-surface-500">
            {grounded.loading ? 'Retrieving knowledge…' : grounded.contextHits.length ? `${grounded.contextHits.length} knowledge hits ready` : 'No knowledge hits'}
          </p>
          <VerdictPanel
            socCase={activeCase}
            onDisposition={d => void onDisposition(d)}
            onConfidence={c => void onConfidence(c)}
          />
        </section>
      </div>
    </div>
  );
}
