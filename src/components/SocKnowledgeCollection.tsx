import { useCallback, useEffect, useMemo, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import {
  Database, FolderOpen, Link2, Loader2, RefreshCw, ScanSearch, ShieldCheck,
} from 'lucide-react';
import { useAppStore } from '../store';
import { useKnowledgeChatStore } from '../knowledgeChat/store';
import { kcListCollections, kcRunEval } from '../knowledgeChat/api';
import { logAuditEvent } from '../auditLog';
import { pathPlaceholder } from '../platformPaths';
import type { KcCollection, KcIndexProgress } from '../knowledgeChat/types';
import { KC_STATUS_LABELS } from '../knowledgeChat/types';
import {
  ensureSocKnowledgeCollection,
  indexSocKnowledgeCollection,
  SOC_DEFAULT_COLLECTION_NAME,
  SOC_DEFAULT_KNOWLEDGE_ROOT,
} from '../socKnowledgeRetrieval';

function humanError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return 'Unexpected error';
}

export default function SocKnowledgeCollection() {
  const {
    socKnowledgeCollectionId,
    socKnowledgeCollectionRoot,
    socAutoRetrieveKnowledge,
    deploymentConfig,
    setSocKnowledgeCollectionId,
    setSocKnowledgeCollectionRoot,
    setSocAutoRetrieveKnowledge,
  } = useAppStore();
  const { upsertCollection, setCollections, embeddingModelPath } = useKnowledgeChatStore();

  const [collection, setCollection] = useState<KcCollection | null>(null);
  const [busy, setBusy] = useState(false);
  const [indexBusy, setIndexBusy] = useState(false);
  const [indexProgress, setIndexProgress] = useState<KcIndexProgress | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [evalBusy, setEvalBusy] = useState(false);

  const rootPath = socKnowledgeCollectionRoot || deploymentConfig?.socDataRoot || deploymentConfig?.dataRoot || '';

  const loadCollection = useCallback(async () => {
    try {
      const collections = await kcListCollections();
      setCollections(collections);
      const linked = socKnowledgeCollectionId
        ? collections.find(item => item.id === socKnowledgeCollectionId) || null
        : collections.find(item => item.root_path.replace(/\\+$/, '').toLowerCase() === rootPath.replace(/\\+$/, '').toLowerCase()) || null;
      setCollection(linked);
      if (linked && linked.id !== socKnowledgeCollectionId) {
        setSocKnowledgeCollectionId(linked.id);
      }
    } catch (err) {
      setError(humanError(err));
    }
  }, [rootPath, setCollections, setSocKnowledgeCollectionId, socKnowledgeCollectionId]);

  useEffect(() => {
    void loadCollection();
  }, [loadCollection]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    (async () => {
      unlisten = await listen<KcIndexProgress>('kc-index-progress', (event) => {
        if (!collection || event.payload.collection_id !== collection.id) return;
        setIndexProgress(event.payload);
      });
    })();
    return () => { unlisten?.(); };
  }, [collection?.id]);

  const statusLabel = useMemo(() => {
    if (!collection) return 'Not linked';
    return KC_STATUS_LABELS[collection.status] || collection.status;
  }, [collection]);

  const linkCollection = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const created = await ensureSocKnowledgeCollection(rootPath, {
        name: SOC_DEFAULT_COLLECTION_NAME,
        preferredId: socKnowledgeCollectionId,
        embeddingModelPath,
      });
      upsertCollection(created);
      setCollection(created);
      setSocKnowledgeCollectionId(created.id);
      useKnowledgeChatStore.getState().setActiveCollectionId(created.id);
      setNotice(`Linked company knowledge collection at ${created.root_path}.`);
    } catch (err) {
      setError(humanError(err));
    } finally {
      setBusy(false);
    }
  };

  const scanAndIndex = async (rebuild = false) => {
    setIndexBusy(true);
    setError(null);
    setNotice(null);
    setIndexProgress(null);
    try {
      let active = collection;
      if (!active) {
        active = await ensureSocKnowledgeCollection(rootPath, {
          name: SOC_DEFAULT_COLLECTION_NAME,
          preferredId: socKnowledgeCollectionId,
          embeddingModelPath,
        });
        setSocKnowledgeCollectionId(active.id);
      }
      const updated = await indexSocKnowledgeCollection(active.id, {
        rebuild,
        buildDense: true,
        embeddingModelPath,
      });
      upsertCollection(updated);
      setCollection(updated);
      setNotice(
        rebuild
          ? `Rebuilt index: ${updated.chunk_count} chunks across ${updated.indexed_file_count} files.`
          : `Indexed company folder: ${updated.chunk_count} chunks across ${updated.indexed_file_count} files.`,
      );
      void logAuditEvent({
        eventType: rebuild ? 'soc.index_rebuild' : 'soc.index',
        category: 'soc',
        summary: rebuild ? 'SOC knowledge index rebuilt' : 'SOC knowledge index built',
        detail: `chunks=${updated.chunk_count}; files=${updated.indexed_file_count}`,
        resourcePath: rootPath,
      });
    } catch (err) {
      setError(humanError(err));
    } finally {
      setIndexBusy(false);
      setIndexProgress(null);
    }
  };

  const runRetrievalEval = async () => {
    if (!collection?.id) {
      setError('Link a collection before running retrieval evaluation.');
      return;
    }
    setEvalBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await kcRunEval(collection.id);
      void logAuditEvent({
        eventType: 'kc.eval',
        category: 'kc',
        summary: `Retrieval eval ${result.cases_passed}/${result.cases_run} passed`,
        detail: `avg_recall=${result.average_recall_at_k.toFixed(3)}`,
      });
      setNotice(
        `Retrieval eval: ${result.cases_passed}/${result.cases_run} passed across ${result.cases_run} cases. Average recall@k ${(result.average_recall_at_k * 100).toFixed(1)}%, MRR ${result.average_mrr.toFixed(2)}.`,
      );
    } catch (err) {
      setError(humanError(err));
    } finally {
      setEvalBusy(false);
    }
  };

  return (
    <section className="panel-shell p-4 sm:p-6 space-y-4">
      <div className="inline-flex items-center gap-2 rounded-full border border-emerald-200/80 dark:border-emerald-900/70 bg-emerald-50/85 dark:bg-emerald-950/25 px-3 py-1 text-xs font-bold uppercase tracking-[0.18em] text-emerald-700 dark:text-emerald-300">
        <Database className="w-4 h-4" /> Company Knowledge Index
      </div>
      <div>
        <h2 className="text-xl font-black tracking-tight text-surface-950 dark:text-white">Company knowledge</h2>
        <p className="mt-1 text-sm text-surface-600 dark:text-surface-300">
          Point this at your company folder, then scan and index. Matching documents are added to triage and reports automatically.
        </p>
      </div>

      <div className="grid lg:grid-cols-[minmax(0,1fr)_auto] gap-3 items-end">
        <label className="block">
          <span className="text-xs font-bold uppercase tracking-[0.14em] text-surface-500">Company folder root</span>
          <input
            value={rootPath}
            onChange={e => setSocKnowledgeCollectionRoot(e.target.value)}
            className="input-field mt-1 font-mono text-xs"
            placeholder={pathPlaceholder(deploymentConfig || undefined, 'soc')}
          />
        </label>
        <label className="flex items-center gap-2 rounded-xl border border-white/70 dark:border-surface-800 bg-white/70 dark:bg-surface-900/45 px-3 py-2.5">
          <input
            type="checkbox"
            checked={socAutoRetrieveKnowledge}
            onChange={e => setSocAutoRetrieveKnowledge(e.target.checked)}
            className="rounded border-surface-300"
          />
          <span className="text-sm font-semibold text-surface-800 dark:text-surface-100">Use company documents in every SOC action</span>
        </label>
      </div>

      <div className="grid sm:grid-cols-2 xl:grid-cols-4 gap-3">
        <div className="rounded-2xl border border-white/70 dark:border-surface-800 bg-surface-50/85 dark:bg-surface-950/55 p-4">
          <p className="text-xs font-bold uppercase tracking-[0.14em] text-surface-500">Status</p>
          <p className="mt-1 text-lg font-black text-surface-950 dark:text-white">{statusLabel}</p>
        </div>
        <div className="rounded-2xl border border-white/70 dark:border-surface-800 bg-surface-50/85 dark:bg-surface-950/55 p-4">
          <p className="text-xs font-bold uppercase tracking-[0.14em] text-surface-500">Chunks</p>
          <p className="mt-1 text-lg font-black text-surface-950 dark:text-white">{collection?.chunk_count ?? 0}</p>
        </div>
        <div className="rounded-2xl border border-white/70 dark:border-surface-800 bg-surface-50/85 dark:bg-surface-950/55 p-4">
          <p className="text-xs font-bold uppercase tracking-[0.14em] text-surface-500">Indexed files</p>
          <p className="mt-1 text-lg font-black text-surface-950 dark:text-white">{collection?.indexed_file_count ?? 0}</p>
        </div>
        <div className="rounded-2xl border border-white/70 dark:border-surface-800 bg-surface-50/85 dark:bg-surface-950/55 p-4">
          <p className="text-xs font-bold uppercase tracking-[0.14em] text-surface-500">Dense vectors</p>
          <p className="mt-1 text-lg font-black text-surface-950 dark:text-white">{collection?.dense_chunk_count ?? 0}</p>
        </div>
      </div>

      {indexProgress && (
        <div className="rounded-2xl border border-primary-200/70 dark:border-primary-900/60 bg-primary-50/80 dark:bg-primary-950/20 px-4 py-3 text-sm text-primary-800 dark:text-primary-200">
          <p className="font-bold">{indexProgress.phase}</p>
          <p>{indexProgress.message}</p>
          {indexProgress.total > 0 && (
            <p className="text-xs mt-1">{indexProgress.current}/{indexProgress.total}{indexProgress.file_name ? ` — ${indexProgress.file_name}` : ''}</p>
          )}
        </div>
      )}

      <div className="flex flex-col sm:flex-row flex-wrap gap-2">
        <button type="button" onClick={linkCollection} disabled={busy || indexBusy} className="btn-secondary flex items-center justify-center gap-2 text-sm">
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Link2 className="w-4 h-4" />}
          Link Collection
        </button>
        <button type="button" onClick={() => scanAndIndex(false)} disabled={indexBusy} className="btn-primary flex items-center justify-center gap-2 text-sm">
          {indexBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <ScanSearch className="w-4 h-4" />}
          Scan &amp; Index
        </button>
        <button type="button" onClick={() => scanAndIndex(true)} disabled={indexBusy} className="btn-secondary flex items-center justify-center gap-2 text-sm">
          <FolderOpen className="w-4 h-4" /> Rebuild Index
        </button>
        <button type="button" onClick={() => void runRetrievalEval()} disabled={evalBusy || indexBusy || !collection} className="btn-secondary flex items-center justify-center gap-2 text-sm">
          {evalBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <ShieldCheck className="w-4 h-4" />}
          Test search quality
        </button>
        <button type="button" onClick={() => void loadCollection()} disabled={busy || indexBusy} className="btn-secondary flex items-center justify-center gap-2 text-sm">
          <RefreshCw className="w-4 h-4" /> Refresh Status
        </button>
      </div>

      <div className="rounded-2xl border border-white/70 dark:border-surface-800 bg-white/70 dark:bg-surface-900/45 p-4 flex items-start gap-3">
        <ShieldCheck className="w-5 h-5 text-emerald-600 dark:text-emerald-300 mt-0.5 shrink-0" />
        <p className="text-sm leading-6 text-surface-600 dark:text-surface-300">
          Recommended: index <span className="font-mono text-xs">{rootPath}</span> once, then every triage, investigation, rule/parser draft, and report will automatically pull relevant company SOP and policy snippets before the AI answers.
        </p>
      </div>

      {notice && (
        <div className="rounded-2xl border border-emerald-200/70 dark:border-emerald-900/60 bg-emerald-50/85 dark:bg-emerald-950/20 px-4 py-3 text-sm text-emerald-800 dark:text-emerald-200">
          {notice}
        </div>
      )}
      {error && (
        <div className="rounded-2xl border border-amber-200/70 dark:border-amber-900/60 bg-amber-50/85 dark:bg-amber-950/20 px-4 py-3 text-sm text-amber-800 dark:text-amber-200">
          {error}
        </div>
      )}
    </section>
  );
}
