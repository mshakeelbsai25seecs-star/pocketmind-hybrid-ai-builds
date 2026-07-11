import { useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/tauri';
import {
  AlertTriangle, Archive, CheckCircle2, ClipboardCheck, Database, FileCheck2, FileText,
  FolderTree, ListChecks, PackagePlus, RotateCcw, ScanSearch, ShieldCheck, Target
} from 'lucide-react';
import { useAppStore } from '../store';
import SocExportButton from './SocExportButton';
import type { SocCompanyDataScanFile, SocDataPackChecklistStatus, SocKnowledgeResource, SocKnowledgeScanResult } from '../types';
import { normalizeSocPath } from '../socKnowledgeIndex';
import {
  buildSocDataPackChecklistMarkdown,
  getCompanyIntakeReadinessStats,
  isStatusAtLeast,
  mergeSocDataPackChecklist,
  applyCompanyScanToChecklist,
  SOC_DATA_PACK_STATUS_LABELS,
  SOC_DATA_PACK_STATUS_ORDER,
} from '../socDataPackChecklist';
import {
  buildCompanyDatasetSummaryMarkdown,
  buildEvaluationSetTemplateMarkdown,
  companyDataTypeLabel,
  enrichCompanyScanFiles,
  isAllowedCompanyIntakePath,
  SOC_COMPANY_INTAKE_FOLDERS,
  SOC_COMPANY_INTAKE_SUBDIR,
  resolveSocIntakeRoot,
} from '../socCompanyDataIntake';
import {
  ensureSocKnowledgeCollection,
  indexSocKnowledgeCollection,
  SOC_DEFAULT_COLLECTION_NAME,
} from '../socKnowledgeRetrieval';
import { pathPlaceholder } from '../platformPaths';
import { useKnowledgeChatStore } from '../knowledgeChat/store';

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function fileNameFromPath(value: string): string {
  const normalized = normalizeSocPath(value);
  const parts = normalized.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || normalized;
}

function titleFromPath(value: string): string {
  return fileNameFromPath(value).replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function statusTone(status: SocDataPackChecklistStatus): string {
  if (status === 'tested') return 'border-emerald-300 dark:border-emerald-800 bg-emerald-50/75 dark:bg-emerald-950/20';
  if (status === 'indexed' || status === 'imported') return 'border-sky-300 dark:border-sky-800 bg-sky-50/75 dark:bg-sky-950/20';
  if (status === 'sanitized' || status === 'received') return 'border-amber-300 dark:border-amber-800 bg-amber-50/70 dark:bg-amber-950/15';
  return 'border-white/70 dark:border-surface-800 bg-surface-50/85 dark:bg-surface-950/55 hover:bg-white/90 dark:hover:bg-surface-900/60';
}

function humanError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object') {
    try { return JSON.stringify(err); } catch { return String(err); }
  }
  return String(err || 'Unknown error');
}

function countBy<T extends string>(values: T[]): Array<{ label: T; count: number }> {
  const counts = values.reduce<Record<string, number>>((acc, value) => {
    acc[value] = (acc[value] || 0) + 1;
    return acc;
  }, {});
  return Object.entries(counts)
    .map(([label, count]) => ({ label: label as T, count }))
    .sort((a, b) => b.count - a.count || String(a.label).localeCompare(String(b.label)));
}

function readinessLabel(percent: number): string {
  if (percent >= 80) return 'Company-specific build ready';
  if (percent >= 55) return 'Import and test next';
  if (percent >= 25) return 'Sanitized data arriving';
  return 'Awaiting first data pack';
}

export default function SocDataPackIntake() {
  const {
    socDataPackChecklist,
    socKnowledgeResources,
    selectedSocKnowledgeResourceIds,
    setSocDataPackChecklistItemStatus,
    setSocDataPackChecklistItemNotes,
    setSocDataPackChecklist,
    resetSocDataPackChecklist,
    addSocKnowledgeResource,
    setSelectedSocKnowledgeResourceIds,
    setSocKnowledgeCollectionId,
    socKnowledgeCollectionId,
    deploymentConfig,
  } = useAppStore();
  const { upsertCollection, embeddingModelPath } = useKnowledgeChatStore();

  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [intakeFolderPath, setIntakeFolderPath] = useState(
    () => resolveSocIntakeRoot(deploymentConfig || undefined) || deploymentConfig?.socDataRoot || '',
  );
  const [scanBusy, setScanBusy] = useState(false);
  const [companyScanFiles, setCompanyScanFiles] = useState<SocCompanyDataScanFile[]>([]);
  const [importedThisSession, setImportedThisSession] = useState(0);

  const checklist = useMemo(() => mergeSocDataPackChecklist(socDataPackChecklist), [socDataPackChecklist]);
  const readiness = useMemo(() => getCompanyIntakeReadinessStats(checklist), [checklist]);
  const markdown = useMemo(() => buildSocDataPackChecklistMarkdown(checklist), [checklist]);

  const scanStats = useMemo(() => {
    const supported = companyScanFiles.filter(file => file.supported);
    const unsupported = companyScanFiles.filter(file => !file.supported);
    const duplicates = companyScanFiles.filter(file => file.duplicate);
    const importable = supported.filter(file => !file.duplicate);
    const typeBreakdown = countBy(companyScanFiles.map(file => companyDataTypeLabel(file.dataType)));
    const missingRequired = checklist.filter(item => item.priority === 'required' && !isStatusAtLeast(item.status, 'received'));
    const indexed = socKnowledgeResources.filter(resource => resource.indexStatus === 'indexed' || resource.indexStatus === 'warning');
    const denseVectorized = socKnowledgeResources.reduce(
      (sum, resource) => sum + (resource.indexedChunks || []).filter(chunk => Array.isArray(chunk.denseVector) && chunk.denseVector.length > 0).length,
      0,
    );
    return { supported, unsupported, duplicates, importable, typeBreakdown, missingRequired, indexed, denseVectorized };
  }, [companyScanFiles, checklist, socKnowledgeResources]);

  const datasetSummary = useMemo(() => buildCompanyDatasetSummaryMarkdown({
    intakeFolderPath,
    checklist,
    resources: socKnowledgeResources,
    scannedFiles: companyScanFiles,
    importedThisSession,
  }), [intakeFolderPath, checklist, socKnowledgeResources, companyScanFiles, importedThisSession]);

  const evaluationTemplate = useMemo(() => buildEvaluationSetTemplateMarkdown(), []);

  const reset = () => {
    resetSocDataPackChecklist();
    setCompanyScanFiles([]);
    setImportedThisSession(0);
    setError(null);
    setNotice('Company data pack checklist reset to the default final-product intake tracker. Local knowledge resources were not changed.');
  };

  const scanCompanyFolder = async () => {
    setError(null);
    setNotice(null);
    const folderPath = normalizeSocPath(intakeFolderPath);
    if (!folderPath) {
      setError('Paste the company intake folder path before scanning.');
      return;
    }
    if (!isAllowedCompanyIntakePath(folderPath, deploymentConfig || undefined)) {
      setError('Company data intake must use a path under the configured NexusAI data roots. Update Settings → Deployment if needed.');
      return;
    }

    setScanBusy(true);
    try {
      const result = await invoke<SocKnowledgeScanResult>('scan_soc_knowledge_folder', {
        folderPath,
        maxFiles: 800,
      });
      const enriched = enrichCompanyScanFiles(result.files, socKnowledgeResources);
      setCompanyScanFiles(enriched);
      setImportedThisSession(0);
      setSocDataPackChecklist(applyCompanyScanToChecklist(socDataPackChecklist, enriched, 'sanitized'));
      setNotice(`Scanned ${result.scanned_files} file(s). ${result.supported_files} supported, ${result.unsupported_files} unsupported, ${enriched.filter(file => file.duplicate).length} duplicate candidate(s). Checklist updated from detected company data types.`);
    } catch (err) {
      setError(`Company intake scan failed: ${humanError(err)}`);
    } finally {
      setScanBusy(false);
    }
  };

  const importSupportedCompanyFiles = async () => {
    setError(null);
    setNotice(null);
    const importable = scanStats.importable;
    if (!importable.length) {
      setError('No new supported company intake files are available to import. Scan the sanitized intake folder first or remove duplicates.');
      return;
    }

    const timestamp = nowSeconds();
    const newResources: SocKnowledgeResource[] = importable.map((file, index) => {
      const filePath = normalizeSocPath(file.path);
      const tags = Array.from(new Set(['company-data', 'sanitized-intake', ...file.inferredTags])).slice(0, 12);
      return {
        id: `soc-company-data-${timestamp}-${index}-${Math.random().toString(36).slice(2, 8)}`,
        title: titleFromPath(filePath) || file.name,
        category: file.inferredCategory,
        product: file.inferredProduct,
        version: file.inferredVersion,
        tags,
        filePath,
        notes: [
          `Imported from company data intake workflow as ${companyDataTypeLabel(file.dataType)}.`,
          'Confirm sanitization status before using for company-specific reasoning or final handoff.',
        ].join(' '),
        createdAt: timestamp,
        updatedAt: timestamp,
        indexStatus: 'not_indexed',
        indexedChunkCount: 0,
        indexedCharCount: 0,
        extractionWarnings: [],
        indexedChunks: [],
      };
    });

    newResources.forEach(resource => addSocKnowledgeResource(resource));
    setSelectedSocKnowledgeResourceIds([...new Set([...selectedSocKnowledgeResourceIds, ...newResources.map(resource => resource.id)])]);
    setImportedThisSession(newResources.length);
    setSocDataPackChecklist(applyCompanyScanToChecklist(socDataPackChecklist, importable, 'imported'));
    setCompanyScanFiles(prev => prev.map(file => ({ ...file, duplicate: file.duplicate || importable.some(item => normalizeSocPath(item.path).toLowerCase() === normalizeSocPath(file.path).toLowerCase()) })));

    try {
      const collection = await ensureSocKnowledgeCollection(intakeFolderPath, {
        name: SOC_DEFAULT_COLLECTION_NAME,
        preferredId: socKnowledgeCollectionId,
        embeddingModelPath,
      });
      upsertCollection(collection);
      setSocKnowledgeCollectionId(collection.id);
      const updated = await indexSocKnowledgeCollection(collection.id, {
        rebuild: false,
        buildDense: true,
        embeddingModelPath,
      });
      upsertCollection(updated);
      setNotice(`Imported ${newResources.length} file(s) and indexed company folder (${updated.chunk_count} chunks). SOC prompts and reports will auto-retrieve from this index.`);
    } catch (err) {
      setNotice(`Imported ${newResources.length} file(s) into metadata. Knowledge Chat indexing failed: ${humanError(err)}. Use Grounded SOC Knowledge to index manually.`);
    }
  };

  return (
    <section className="panel-shell p-4 sm:p-6 space-y-6">
      <div className="inline-flex items-center gap-2 rounded-full border border-cyan-200/80 dark:border-cyan-900/70 bg-cyan-50/85 dark:bg-cyan-950/25 px-3 py-1 text-xs font-bold uppercase tracking-[0.18em] text-cyan-700 dark:text-cyan-300">
        <ClipboardCheck className="w-4 h-4" /> Company Data Intake
      </div>
      <h2 className="text-xl font-black tracking-tight text-surface-950 dark:text-white">Company Data Intake</h2>

      <div className="grid sm:grid-cols-2 xl:grid-cols-6 gap-3">
        <div className="rounded-2xl border border-white/70 dark:border-surface-800 bg-surface-50/85 dark:bg-surface-950/55 p-4 xl:col-span-2">
          <p className="text-xs font-bold uppercase tracking-[0.14em] text-surface-500">Company-Specific Readiness</p>
          <p className="mt-1 text-2xl font-black text-surface-950 dark:text-white">{readiness.readinessPercent}%</p>
          <p className="text-xs text-surface-500 dark:text-surface-400">{readinessLabel(readiness.readinessPercent)}</p>
        </div>
        <div className="rounded-2xl border border-white/70 dark:border-surface-800 bg-surface-50/85 dark:bg-surface-950/55 p-4">
          <p className="text-xs font-bold uppercase tracking-[0.14em] text-surface-500">Received</p>
          <p className="mt-1 text-2xl font-black text-surface-950 dark:text-white">{readiness.receivedOrBetter}/{readiness.totalChecklistItems}</p>
        </div>
        <div className="rounded-2xl border border-white/70 dark:border-surface-800 bg-surface-50/85 dark:bg-surface-950/55 p-4">
          <p className="text-xs font-bold uppercase tracking-[0.14em] text-surface-500">Imported</p>
          <p className="mt-1 text-2xl font-black text-surface-950 dark:text-white">{readiness.importedOrBetter}</p>
        </div>
        <div className="rounded-2xl border border-white/70 dark:border-surface-800 bg-surface-50/85 dark:bg-surface-950/55 p-4">
          <p className="text-xs font-bold uppercase tracking-[0.14em] text-surface-500">Indexed</p>
          <p className="mt-1 text-2xl font-black text-surface-950 dark:text-white">{readiness.indexedOrBetter}</p>
        </div>
        <div className="rounded-2xl border border-white/70 dark:border-surface-800 bg-surface-50/85 dark:bg-surface-950/55 p-4">
          <p className="text-xs font-bold uppercase tracking-[0.14em] text-surface-500">Missing required</p>
          <p className="mt-1 text-2xl font-black text-surface-950 dark:text-white">{readiness.requiredMissing}</p>
        </div>
      </div>

      <div className="rounded-2xl border border-sky-200/70 dark:border-sky-900/70 bg-sky-50/80 dark:bg-sky-950/20 p-4">
        <div className="flex items-start gap-3">
          <FolderTree className="w-5 h-5 text-sky-600 dark:text-sky-300 mt-0.5 shrink-0" />
          <div className="min-w-0 flex-1">
            <h3 className="font-black text-surface-950 dark:text-white">Company intake folder guide</h3>
            <p className="mt-1 text-sm leading-6 text-surface-600 dark:text-surface-300">
              Recommended intake root: <span className="font-mono text-xs">{resolveSocIntakeRoot(deploymentConfig || undefined) || 'Configure in Settings → Deployment'}</span>.
            </p>
            <div className="mt-3 grid md:grid-cols-2 xl:grid-cols-3 gap-2">
              {SOC_COMPANY_INTAKE_FOLDERS.map(item => (
                <div key={item.folder} className="rounded-xl border border-white/70 dark:border-surface-800 bg-white/70 dark:bg-surface-900/45 p-3">
                  <p className="font-mono text-[11px] font-bold text-surface-800 dark:text-surface-100 truncate">{item.folder}</p>
                  <p className="mt-1 text-xs font-bold text-surface-700 dark:text-surface-200">{item.label}</p>
                  <p className="mt-1 text-[11px] leading-4 text-surface-500 dark:text-surface-400">{item.purpose}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="grid xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-5">
        <div className="rounded-2xl border border-white/70 dark:border-surface-800 bg-surface-50/85 dark:bg-surface-950/55 p-4 space-y-4">
          <div className="flex items-center gap-2">
            <ListChecks className="w-5 h-5 text-cyan-600 dark:text-cyan-300" />
            <h3 className="font-black text-surface-950 dark:text-white">Data Pack Readiness</h3>
          </div>

          <div className="space-y-3 max-h-[38rem] overflow-auto pr-1">
            {checklist.map(item => (
              <div key={item.id} className={`rounded-2xl border p-4 transition-all ${statusTone(item.status)}`}>
                <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h4 className="font-black text-surface-950 dark:text-white">{item.label}</h4>
                      <span className={`rounded-full px-2 py-1 text-[10px] font-black uppercase tracking-[0.12em] ${item.priority === 'required' ? 'bg-red-50 text-red-700 dark:bg-red-950/30 dark:text-red-300' : item.priority === 'recommended' ? 'bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-300' : 'bg-surface-100 text-surface-600 dark:bg-surface-800 dark:text-surface-300'}`}>
                        {item.priority}
                      </span>
                      {isStatusAtLeast(item.status, 'received') && <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-300" />}
                    </div>
                  </div>
                  <select
                    value={item.status === 'missing' ? 'not_received' : item.status}
                    onChange={e => setSocDataPackChecklistItemStatus(item.id, e.target.value as SocDataPackChecklistStatus)}
                    className="input-field sm:w-44"
                  >
                    {SOC_DATA_PACK_STATUS_ORDER.map(status => (
                      <option key={status} value={status}>{SOC_DATA_PACK_STATUS_LABELS[status]}</option>
                    ))}
                  </select>
                </div>
                <textarea
                  value={item.notes || ''}
                  onChange={e => setSocDataPackChecklistItemNotes(item.id, e.target.value)}
                  placeholder="Notes: source, sanitization status, file location, analyst owner, or import/test result."
                  className="input-field mt-3 min-h-[4.5rem] resize-y"
                />
              </div>
            ))}
          </div>
        </div>

        <div className="space-y-5">
          <div className="rounded-2xl border border-white/70 dark:border-surface-800 bg-surface-50/85 dark:bg-surface-950/55 p-4 space-y-4">
            <div className="flex items-center gap-2">
              <ScanSearch className="w-5 h-5 text-sky-600 dark:text-sky-300" />
              <div>
                <h3 className="font-black text-surface-950 dark:text-white">Bulk Company Data Scan</h3>
                <p className="text-xs text-surface-500 dark:text-surface-400">Scan a sanitized intake folder, classify files, then import supported items into the Offline Knowledge Base.</p>
              </div>
            </div>
            <input
              value={intakeFolderPath}
              onChange={e => setIntakeFolderPath(e.target.value)}
              className="input-field font-mono text-xs"
              placeholder={pathPlaceholder(deploymentConfig || undefined, 'intake')}
            />
            <div className="grid sm:grid-cols-4 gap-2">
              <button type="button" disabled={scanBusy} onClick={scanCompanyFolder} className="btn-secondary flex items-center justify-center gap-2 sm:col-span-2 disabled:opacity-60">
                <ScanSearch className="w-4 h-4" /> {scanBusy ? 'Scanning...' : 'Scan Intake Folder'}
              </button>
              <button type="button" onClick={() => void importSupportedCompanyFiles()} className="btn-primary flex items-center justify-center gap-2 sm:col-span-2">
                <PackagePlus className="w-4 h-4" /> Import Supported
              </button>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <div className="rounded-xl border border-white/70 dark:border-surface-800 bg-white/70 dark:bg-surface-900/45 p-3"><p className="text-[10px] font-bold uppercase tracking-[0.12em] text-surface-500">Scanned</p><p className="text-lg font-black text-surface-950 dark:text-white">{companyScanFiles.length}</p></div>
              <div className="rounded-xl border border-white/70 dark:border-surface-800 bg-white/70 dark:bg-surface-900/45 p-3"><p className="text-[10px] font-bold uppercase tracking-[0.12em] text-surface-500">Supported</p><p className="text-lg font-black text-surface-950 dark:text-white">{scanStats.supported.length}</p></div>
              <div className="rounded-xl border border-white/70 dark:border-surface-800 bg-white/70 dark:bg-surface-900/45 p-3"><p className="text-[10px] font-bold uppercase tracking-[0.12em] text-surface-500">Duplicates</p><p className="text-lg font-black text-surface-950 dark:text-white">{scanStats.duplicates.length}</p></div>
              <div className="rounded-xl border border-white/70 dark:border-surface-800 bg-white/70 dark:bg-surface-900/45 p-3"><p className="text-[10px] font-bold uppercase tracking-[0.12em] text-surface-500">Imported</p><p className="text-lg font-black text-surface-950 dark:text-white">{importedThisSession}</p></div>
            </div>

            {companyScanFiles.length > 0 ? (
              <div className="space-y-2 max-h-[18rem] overflow-auto pr-1">
                {companyScanFiles.slice(0, 60).map(file => (
                  <div key={file.path} className={`rounded-xl border p-3 ${file.duplicate ? 'border-amber-200 dark:border-amber-900 bg-amber-50/70 dark:bg-amber-950/15' : file.supported ? 'border-emerald-200 dark:border-emerald-900 bg-emerald-50/60 dark:bg-emerald-950/15' : 'border-surface-200 dark:border-surface-800 bg-white/60 dark:bg-surface-900/35'}`}>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-xs font-black text-surface-950 dark:text-white">{file.name}</span>
                      <span className="rounded-full bg-surface-100 dark:bg-surface-800 px-2 py-0.5 text-[10px] font-bold text-surface-600 dark:text-surface-300">{companyDataTypeLabel(file.dataType)}</span>
                      <span className="rounded-full bg-sky-100 dark:bg-sky-950/40 px-2 py-0.5 text-[10px] font-bold text-sky-700 dark:text-sky-300">{file.inferredCategory}</span>
                      {file.duplicate && <span className="rounded-full bg-amber-100 dark:bg-amber-950/40 px-2 py-0.5 text-[10px] font-bold text-amber-700 dark:text-amber-300">duplicate</span>}
                    </div>
                    <p className="mt-1 font-mono text-[11px] text-surface-500 dark:text-surface-400 truncate">{file.path}</p>
                  </div>
                ))}
              </div>
            ) : (
              <div className="rounded-xl border border-dashed border-surface-300 dark:border-surface-800 p-4 text-sm text-surface-500 dark:text-surface-400">
                No intake scan yet. Paste the sanitized intake folder path and click Scan Intake Folder.
              </div>
            )}
          </div>

          <div className="rounded-2xl border border-white/70 dark:border-surface-800 bg-surface-50/85 dark:bg-surface-950/55 p-4 space-y-4">
            <div className="flex items-center gap-2">
              <Target className="w-5 h-5 text-indigo-600 dark:text-indigo-300" />
              <div>
                <h3 className="font-black text-surface-950 dark:text-white">Import Readiness Dashboard</h3>
                <p className="text-xs text-surface-500 dark:text-surface-400">A local snapshot of company data readiness, RAG readiness, and next actions.</p>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="rounded-xl border border-white/70 dark:border-surface-800 bg-white/70 dark:bg-surface-900/45 p-3"><p className="text-[10px] font-bold uppercase tracking-[0.12em] text-surface-500">Knowledge resources</p><p className="text-lg font-black text-surface-950 dark:text-white">{socKnowledgeResources.length}</p></div>
              <div className="rounded-xl border border-white/70 dark:border-surface-800 bg-white/70 dark:bg-surface-900/45 p-3"><p className="text-[10px] font-bold uppercase tracking-[0.12em] text-surface-500">Indexed resources</p><p className="text-lg font-black text-surface-950 dark:text-white">{scanStats.indexed.length}</p></div>
              <div className="rounded-xl border border-white/70 dark:border-surface-800 bg-white/70 dark:bg-surface-900/45 p-3"><p className="text-[10px] font-bold uppercase tracking-[0.12em] text-surface-500">Dense chunks</p><p className="text-lg font-black text-surface-950 dark:text-white">{scanStats.denseVectorized}</p></div>
              <div className="rounded-xl border border-white/70 dark:border-surface-800 bg-white/70 dark:bg-surface-900/45 p-3"><p className="text-[10px] font-bold uppercase tracking-[0.12em] text-surface-500">Unsupported scan files</p><p className="text-lg font-black text-surface-950 dark:text-white">{scanStats.unsupported.length}</p></div>
            </div>
            <div className="rounded-xl border border-indigo-200/70 dark:border-indigo-900/70 bg-indigo-50/75 dark:bg-indigo-950/20 p-3 text-sm leading-6 text-indigo-800 dark:text-indigo-300">
              Next recommended action: {readiness.nextRecommendedAction}
            </div>
            <div className="grid sm:grid-cols-2 gap-2">
              {scanStats.typeBreakdown.slice(0, 8).map(item => (
                <div key={item.label} className="flex items-center justify-between rounded-xl border border-white/70 dark:border-surface-800 bg-white/70 dark:bg-surface-900/45 px-3 py-2 text-xs">
                  <span className="text-surface-600 dark:text-surface-300 truncate">{item.label}</span>
                  <span className="font-black text-surface-950 dark:text-white">{item.count}</span>
                </div>
              ))}
              {!scanStats.typeBreakdown.length && <p className="text-xs text-surface-500 dark:text-surface-400">No scan type breakdown yet.</p>}
            </div>
          </div>
        </div>
      </div>

      <div className="rounded-2xl border border-white/70 dark:border-surface-800 bg-surface-50/85 dark:bg-surface-950/55 p-4 space-y-4">
        <div className="flex items-start gap-3">
          <FileCheck2 className="w-5 h-5 text-emerald-600 dark:text-emerald-300 mt-0.5 shrink-0" />
          <div>
            <h3 className="font-black text-surface-950 dark:text-white">SOC Artifact Mapping + Evaluation Preparation</h3>
            <p className="mt-1 text-sm leading-6 text-surface-600 dark:text-surface-300">
              Rules map to rule review; parsers + logs map to parser validation; alerts/incidents map to triage; TP/FP examples map to analyst decision tuning; SOPs map to severity/escalation; connectors map to playbook actions; expected outputs map to report formatting.
            </p>
          </div>
        </div>
        <div className="grid md:grid-cols-3 gap-2 text-xs text-surface-600 dark:text-surface-300">
          <div className="rounded-xl border border-white/70 dark:border-surface-800 bg-white/70 dark:bg-surface-900/45 p-3"><FileText className="w-4 h-4 mb-2 text-sky-500" />Rules / parsers / logs → detection engineering and validator workflows.</div>
          <div className="rounded-xl border border-white/70 dark:border-surface-800 bg-white/70 dark:bg-surface-900/45 p-3"><Database className="w-4 h-4 mb-2 text-indigo-500" />Alerts / TP / FP → triage, decision tuning, and evaluation cases.</div>
          <div className="rounded-xl border border-white/70 dark:border-surface-800 bg-white/70 dark:bg-surface-900/45 p-3"><Archive className="w-4 h-4 mb-2 text-emerald-500" />SOPs / connectors / playbooks → safe response planning and report exports.</div>
        </div>
      </div>

      {error && (
        <div className="rounded-2xl border border-red-200/80 dark:border-red-900/70 bg-red-50/90 dark:bg-red-950/25 px-4 py-3 text-sm text-red-700 dark:text-red-300 flex gap-2">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" /> {error}
        </div>
      )}
      {notice && (
        <div className="rounded-2xl border border-sky-200/80 dark:border-sky-900/70 bg-sky-50/90 dark:bg-sky-950/25 px-4 py-3 text-sm text-sky-700 dark:text-sky-300">
          {notice}
        </div>
      )}

      <div className="flex flex-col sm:flex-row flex-wrap gap-3">
        <SocExportButton
          label="Export Intake Checklist"
          defaultFileName="nexus-soc-company-data-pack-checklist.md"
          contents={markdown}
          kind="md"
          onStatus={(message) => setNotice(message)}
        />
        <SocExportButton
          label="Export Company Dataset Summary"
          defaultFileName="nexus-soc-company-dataset-intake-summary.md"
          contents={datasetSummary}
          kind="md"
          onStatus={(message) => setNotice(message)}
        />
        <SocExportButton
          label="Export Evaluation Template"
          defaultFileName="nexus-soc-company-evaluation-template.md"
          contents={evaluationTemplate}
          kind="md"
          onStatus={(message) => setNotice(message)}
        />
        <button type="button" onClick={reset} className="btn-secondary flex items-center justify-center gap-2">
          <RotateCcw className="w-4 h-4" /> Reset Intake Tracker
        </button>
      </div>
    </section>
  );
}
