import { useCallback, useEffect, useMemo, useState } from 'react';
import { caseFromParsedAlert, normalizeSeverity } from '../../soc/caseFactory';
import {
  clearLegacySocLocalSeed,
  socEnsureDirs,
  socGetCase,
  socListCases,
  socUpsertCase,
} from '../../soc/caseStore';
import { newImportBatchId } from '../../soc/ids';
import type { SocCase, SocCaseIndexEntry } from '../../soc/types';
import type { SocDemoSample } from '../../socDemoSamples';
import SecuritySettingsPanel from '../SecuritySettingsPanel';
import SocExamplesPanel from '../SocExamplesPanel';
import SocKnowledgeBase from '../SocKnowledgeBase';
import SocKnowledgeCollection from '../SocKnowledgeCollection';
import SocReports from '../SocReports';
import SocValidators from '../SocValidators';
import SocWorkspace from '../SocWorkspace';
import SocCaseView from './case/SocCaseView';
import SocConnectorsView from './connectors/SocConnectorsView';
import SocImportView from './import/SocImportView';
import SocMemoryView from './memory/SocMemoryView';
import SocMetricsView from './metrics/SocMetricsView';
import SocQueueView from './queue/SocQueueView';
import {
  SocActiveCaseProvider,
  type SocNavId,
} from './SocActiveCaseContext';
import SocNav from './SocNav';

export default function SocShell() {
  const [nav, setNav] = useState<SocNavId>('queue');
  const [index, setIndex] = useState<SocCaseIndexEntry[]>([]);
  const [activeCaseId, setActiveCaseId] = useState<string | null>(null);
  const [activeCase, setActiveCase] = useState<SocCase | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);

  const refreshIndex = useCallback(async () => {
    const rows = await socListCases();
    setIndex(rows);
  }, []);

  const reloadActiveCase = useCallback(async () => {
    if (!activeCaseId) {
      setActiveCase(null);
      return;
    }
    const loaded = await socGetCase(activeCaseId);
    setActiveCase(loaded);
  }, [activeCaseId]);

  const saveActiveCase = useCallback(async (next: SocCase) => {
    const saved = await socUpsertCase(next);
    setActiveCase(saved);
    setActiveCaseId(saved.id);
    await refreshIndex();
    return saved;
  }, [refreshIndex]);

  useEffect(() => {
    clearLegacySocLocalSeed();
    let cancelled = false;
    (async () => {
      try {
        await socEnsureDirs();
        if (cancelled) return;
        await refreshIndex();
      } catch (err) {
        if (!cancelled) setStatus(String(err));
      } finally {
        if (!cancelled) setReady(true);
      }
    })();
    return () => { cancelled = true; };
  }, [refreshIndex]);

  useEffect(() => {
    if (!activeCaseId) {
      setActiveCase(null);
      return;
    }
    void reloadActiveCase().catch(err => setStatus(String(err)));
  }, [activeCaseId, reloadActiveCase]);

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

  const ctx = {
    nav,
    setNav,
    index,
    refreshIndex,
    activeCase,
    setActiveCaseId,
    reloadActiveCase,
    saveActiveCase,
    status,
    setStatus,
    busy,
    setBusy,
  };

  return (
    <SocActiveCaseProvider value={ctx}>
      <div className="flex-1 min-h-0 flex bg-surface-50/40 dark:bg-surface-950 text-surface-900 dark:text-surface-50">
        <SocNav
          nav={nav}
          onNavigate={setNav}
          caseSelected={!!activeCaseId}
        />
        <div className="flex-1 min-h-0 flex flex-col">
          <header className="px-4 sm:px-5 py-3 border-b border-surface-200 dark:border-surface-800 flex items-center justify-between gap-3">
            <div>
              <p className="text-[11px] uppercase tracking-[0.16em] text-surface-500">SOC</p>
              <h1 className="text-lg font-semibold">
                {nav === 'case' && activeCase ? activeCase.id : nav.charAt(0).toUpperCase() + nav.slice(1)}
              </h1>
            </div>
            {!ready && <span className="text-xs text-surface-500">Loading…</span>}
          </header>
          {status && (
            <p className="px-4 sm:px-5 py-2 text-xs border-b border-surface-200 dark:border-surface-800 text-primary-700 dark:text-primary-300">
              {status}
            </p>
          )}

          {nav === 'queue' && <SocQueueView />}
          {nav === 'case' && <SocCaseView />}
          {nav === 'import' && <SocImportView />}
          {nav === 'memory' && <SocMemoryView />}
          {nav === 'metrics' && <SocMetricsView />}
          {nav === 'connectors' && <SocConnectorsView />}
          {nav === 'security' && (
            <div className="flex-1 min-h-0 overflow-y-auto p-4 sm:p-5">
              <SecuritySettingsPanel />
            </div>
          )}
          {nav === 'knowledge' && (
            <div className="flex-1 min-h-0 overflow-y-auto p-4 sm:p-5 space-y-4">
              <SocKnowledgeCollection />
              <SocKnowledgeBase />
            </div>
          )}
          {nav === 'workspace' && (
            <div className="flex-1 min-h-0 overflow-y-auto">
              {activeCase && (
                <div className="px-4 sm:px-6 pt-4 text-xs text-surface-500">
                  Active case {activeCase.id} — copy fields into Workspace actions as needed.
                </div>
              )}
              <SocWorkspace />
            </div>
          )}
          {nav === 'validators' && (
            <div className="flex-1 min-h-0 overflow-y-auto">
              <SocValidators />
            </div>
          )}
          {nav === 'reports' && (
            <div className="flex-1 min-h-0 overflow-y-auto">
              <SocReports
                workspaceInput={workspaceInput}
                generatedPrompt={activeCase?.verdict?.reasoning || activeCase?.verdict?.summary || ''}
              />
            </div>
          )}
          {nav === 'practice' && (
            <div className="flex-1 min-h-0 overflow-y-auto p-4 sm:p-5 space-y-3">
              <p className="text-sm text-surface-500">
                Practice samples stay off the queue until you load one into a new case.
              </p>
              <SocExamplesPanel
                onApplySample={(sample: SocDemoSample) => {
                  void (async () => {
                    setBusy(true);
                    try {
                      const alert = {
                        title: sample.title,
                        summary: sample.input.alertSummary,
                        severity: normalizeSeverity(sample.input.severity || 'high'),
                        rawEvidence: sample.input.rawLogs,
                        entities: {
                          sourceIp: sample.input.sourceIp,
                          destinationIp: sample.input.destinationIp,
                          username: sample.input.username,
                          asset: sample.input.asset,
                          hostnames: sample.input.asset ? [sample.input.asset] : [],
                          urls: [],
                          hashes: [],
                          extra: {},
                        },
                        notes: sample.input.notes,
                        tags: ['practice'],
                        sourceLabel: 'practice',
                      };
                      let created = caseFromParsedAlert(alert, { importBatchId: newImportBatchId() });
                      created = {
                        ...created,
                        source: { kind: 'manual' },
                        title: sample.title,
                      };
                      created = await socUpsertCase(created);
                      await refreshIndex();
                      setActiveCaseId(created.id);
                      setNav('case');
                      setStatus(`Created practice case ${created.id}`);
                    } catch (err) {
                      setStatus(String(err));
                    } finally {
                      setBusy(false);
                    }
                  })();
                }}
              />
            </div>
          )}
        </div>
      </div>
    </SocActiveCaseProvider>
  );
}
