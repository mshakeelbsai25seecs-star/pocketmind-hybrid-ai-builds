import { useEffect, useMemo, useRef, useState } from 'react';
import { open } from '@tauri-apps/api/dialog';
import { listen } from '@tauri-apps/api/event';
import {
  ChevronDown, Database, FolderOpen, Loader2, Play, RefreshCw, ScanSearch, Trash2, CheckCircle2, AlertTriangle,
} from 'lucide-react';
import {
  kcCollectionHealth,
  kcCreateCollection,
  kcDeleteCollection,
  kcDiscoverEmbeddingModels,
  kcGetDefaultEmbeddingModel,
  kcIndexCollection,
  kcListCollections,
  kcPreviewPartitionMix,
  kcResolveEmbeddingModel,
  kcScanCollection,
  kcSetDefaultEmbeddingModel,
  kcValidateEmbeddingModel,
  humanError,
} from '../../knowledgeChat/api';
import { loadServerRagCredentials, serverRagListCollections } from '../../knowledgeChat/serverRag';
import { normalizeDisplayPath } from '../../platformPaths';
import { useKnowledgeChatStore } from '../../knowledgeChat/store';
import { useAppStore } from '../../store';
import { embeddingModelPlaceholder, joinPath, pathPlaceholder } from '../../platformPaths';
import type { KcCollection, KcCollectionHealth, KcFolderCategory, KcIndexProgress, KcIndexResult, KcPartitionMix } from '../../knowledgeChat/types';
import { KC_STATUS_LABELS, QA_CORPUS_NAME } from '../../knowledgeChat/types';
import { setCollectionImageRag } from '../../ocrImageRagConfig';

const FOLDER_CATEGORY_LABELS: Record<KcFolderCategory, string> = {
  mixed: 'Mixed (code + documents)',
  source_code_repo: 'Source code repository',
  documentation_library: 'Documentation library',
  security_runbooks: 'Security runbooks / SOPs',
  data_and_logs: 'Data & logs',
};

function looksLikeBge(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.includes('bge-m3') || lower.includes('bge_m3') || lower.includes('bgem3') || lower.includes('bge');
}

function looksLikeQwen3Embed(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.includes('qwen3') && (lower.includes('embed') || lower.includes('embedding'));
}

function fmtBytes(value?: number | null): string {
  if (!value || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = value;
  let i = 0;
  while (size >= 1024 && i < units.length - 1) {
    size /= 1024;
    i += 1;
  }
  return `${size.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function shortenWarning(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return trimmed;
  const lower = trimmed.toLowerCase();
  if (
    lower.includes('outofdevicememory')
    || lower.includes('cpu_repack')
    || lower.includes('qwen3-embedding')
    || lower.includes('embedding server exited')
  ) {
    return 'Dense/meaning search skipped: not enough RAM/VRAM for the selected embedding model. Set the document model to BGE-M3, then rebuild. Word search still works.';
  }
  // Keep path skips readable; truncate llama-server dumps.
  if (trimmed.length > 320) return `${trimmed.slice(0, 300).trim()}…`;
  return trimmed;
}

function formatIndexSummary(result: KcIndexResult): { notice: string; warnings: string[] } {
  const totalIndexed = result.total_indexed_files ?? 0;
  const totalFiles = result.total_files ?? 0;
  const warnings = [...(result.warnings || [])].map(shortenWarning);
  for (const issue of result.file_issues || []) {
    const detail = issue.message?.trim() || issue.status;
    warnings.push(shortenWarning(`${issue.relative_path} — ${detail}`));
  }

  let notice: string;
  if (result.unchanged_files > 0 && result.indexed_files === 0 && result.failed_files === 0) {
    notice = `Index up to date — ${totalIndexed} of ${totalFiles} files indexed (${result.chunk_count} searchable sections).`;
  } else {
    notice = `Index ready — ${totalIndexed} of ${totalFiles} files indexed (${result.chunk_count} searchable sections).`;
  }

  if (result.dense_chunk_count > 0) {
    notice += ' Meaning search is on.';
  } else if (totalIndexed > 0 && warnings.length === 0) {
    warnings.push('Meaning search is off — word search still works. Choose search models above and click Rebuild.');
  }

  return { notice, warnings };
}

function filesStatLabel(collection: KcCollection): string {
  const indexed = collection.indexed_file_count;
  const total = collection.file_count;
  if (total <= 0) return '0';
  if (indexed === total) return `${indexed} indexed`;
  return `${indexed} of ${total} indexed`;
}

function formatElapsed(ms?: number | null): string {
  if (!ms || ms < 0) return '';
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function phaseLabel(phase: string): string {
  if (phase === 'prepare') return 'Preparing';
  if (phase === 'extract' || phase === 'write') return phase === 'write' ? 'Writing index' : 'Extracting / OCR';
  if (phase.startsWith('dense_')) return `Embedding (${phase.replace('dense_', '')})`;
  if (phase === 'complete') return 'Finished';
  return phase;
}

export default function CollectionPanel() {
  const store = useKnowledgeChatStore();
  const { deploymentConfig } = useAppStore();
  const {
    collections,
    activeCollectionId,
    embeddingModelPath,
    setCollections,
    setActiveCollectionId,
    upsertCollection,
    removeCollection,
    setEmbeddingModelPath,
    setIndexProgress,
    indexProgress,
    notice,
    error,
    setNotice,
    setError,
  } = store;

  const [name, setName] = useState('Company Data');
  const [folderPath, setFolderPath] = useState('');
  const [busy, setBusy] = useState<'scan' | 'index' | 'create' | 'validate' | null>(null);
  const [incrementalIndex, setIncrementalIndex] = useState(true);
  const [embeddingSetupHint, setEmbeddingSetupHint] = useState<string | null>(null);
  const [folderCategory, setFolderCategory] = useState<KcFolderCategory>('mixed');
  const [knowledgeModelPath, setKnowledgeModelPath] = useState('');
  const [partitionMix, setPartitionMix] = useState<KcPartitionMix | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [collectionWarnings, setCollectionWarnings] = useState<string[]>([]);
  const [collectionHealth, setCollectionHealth] = useState<KcCollectionHealth | null>(null);

  const activeCollection = useMemo(
    () => collections.find(item => item.id === activeCollectionId) || null,
    [collections, activeCollectionId],
  );

  useEffect(() => {
    setCollectionWarnings([]);
    setCollectionHealth(null);
  }, [activeCollectionId]);

  useEffect(() => {
    if (!activeCollectionId) return;
    let cancelled = false;
    (async () => {
      try {
        const health = await kcCollectionHealth(activeCollectionId);
        if (cancelled) return;
        setCollectionHealth(health);
        const warnings: string[] = [];
        if (health.code_entity_rebuild_required) {
          warnings.push('Rebuild needed so code functions and methods are listed correctly.');
        }
        if (health.dual_model_reindex_recommended) {
          warnings.push('This collection uses one search model for code and documents — rebuild with separate code and document models for better results.');
        }
        if (health.failed_files > 0) {
          warnings.push(`${health.failed_files} file(s) failed indexing.`);
        }
        setCollectionWarnings(prev => [...new Set([...prev, ...warnings])]);
      } catch {
        if (!cancelled) setCollectionHealth(null);
      }
    })();
    return () => { cancelled = true; };
  }, [activeCollectionId, activeCollection?.updated_at, activeCollection?.status]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const serverCreds = await loadServerRagCredentials();
        if (serverCreds) {
          const items = await serverRagListCollections(serverCreds);
          if (cancelled) return;
          setCollections(items);
          const persistedId = useKnowledgeChatStore.getState().activeCollectionId;
          const validPersisted = persistedId && items.some(item => item.id === persistedId);
          if (validPersisted) {
            setActiveCollectionId(persistedId);
          } else if (items[0]) {
            setActiveCollectionId(items[0].id);
          }
          setNotice('Server RAG mode: collections loaded from the organization gateway.');
          return;
        }

        // Do not auto-index/embed on mount — use Scan Folder / Build Index (or kc_ensure_qa_corpus) manually.
        const items = await kcListCollections();

        if (cancelled) return;
        setCollections(items);

        const qaCollection = items.find(item => item.name === QA_CORPUS_NAME);
        const persistedId = useKnowledgeChatStore.getState().activeCollectionId;
        const validPersisted = persistedId && items.some(item => item.id === persistedId);

        if (validPersisted) {
          setActiveCollectionId(persistedId);
        } else if (qaCollection) {
          setActiveCollectionId(qaCollection.id);
        } else if (items[0]) {
          setActiveCollectionId(items[0].id);
        }
        const defaultModel = await kcGetDefaultEmbeddingModel();
        const discovered = await kcDiscoverEmbeddingModels();
        let resolved = '';
        if (defaultModel) {
          try {
            resolved = await kcResolveEmbeddingModel(defaultModel);
          } catch {
            resolved = '';
          }
        }
        if (!resolved && discovered.length > 0) {
          resolved = discovered.find(looksLikeQwen3Embed) || discovered[0];
        }
        const bgeModel = discovered.find(looksLikeBge) || '';
        if (!cancelled) {
          if (bgeModel) {
            setKnowledgeModelPath(bgeModel);
          }
          if (resolved) {
            setEmbeddingModelPath(resolved);
            setEmbeddingSetupHint(null);
          } else {
            const hintPath = joinPath(
              pathPlaceholder(deploymentConfig, 'embeddings'),
              'Qwen3-Embedding-8B-Q4_K_M.gguf',
            );
            setEmbeddingModelPath(deploymentConfig?.embeddingModelPath || '');
            setEmbeddingSetupHint(
              `No code search model found. Place Qwen3-Embedding-8B-Q4_K_M.gguf at ${hintPath}, or click Browse. Word search still works without it.`,
            );
          }
        }
      } catch (err) {
        if (!cancelled) setError(humanError(err));
      }
    })();
    return () => { cancelled = true; };
  }, [deploymentConfig?.embeddingModelPath, setActiveCollectionId, setCollections, setEmbeddingModelPath, setError, setNotice]);

  useEffect(() => {
    const unlisten = listen<KcIndexProgress>('kc-index-progress', (event) => {
      const payload = event.payload;
      if (activeCollectionId && payload.collection_id && payload.collection_id !== activeCollectionId) {
        return;
      }
      setIndexProgress(payload);
    });
    return () => { unlisten.then(fn => fn()); };
  }, [activeCollectionId, setIndexProgress]);

  // While indexing, refresh collection stats so the UI reflects DB progress even if an event is missed.
  useEffect(() => {
    const indexing = busy === 'index' || activeCollection?.status === 'indexing';
    if (!indexing || !activeCollectionId) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const refreshed = await kcListCollections();
        if (cancelled) return;
        setCollections(refreshed);
        const current = refreshed.find(item => item.id === activeCollectionId);
        if (current && (current.status === 'ready' || current.status === 'failed') && busy === 'index') {
          // Backend finished (or failed) while the invoke may still be unwinding.
          setNotice(
            current.status === 'ready'
              ? 'Index finished — refreshing…'
              : `Indexing failed${current.last_error ? `: ${current.last_error}` : '.'}`,
          );
        }
      } catch {
        // ignore poll errors
      }
    };
    void tick();
    const id = window.setInterval(() => { void tick(); }, 4000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [busy, activeCollection?.status, activeCollectionId, setCollections, setNotice]);

  const previewPartitions = async (rawPath: string) => {
    const path = rawPath.trim();
    if (!path) {
      setPartitionMix(null);
      return;
    }
    setPreviewing(true);
    try {
      const mix = await kcPreviewPartitionMix(path);
      setPartitionMix(mix);
      // Auto-suggest a folder category from the file mix.
      if (mix.total_supported > 0) {
        const codeRatio = mix.code_files / mix.total_supported;
        if (codeRatio >= 0.7) setFolderCategory('source_code_repo');
        else if (codeRatio <= 0.1) setFolderCategory('documentation_library');
        else setFolderCategory('mixed');
      }
    } catch {
      setPartitionMix(null);
    } finally {
      setPreviewing(false);
    }
  };

  const chooseFolder = async () => {
    const selected = await open({ directory: true, multiple: false });
    if (!selected || Array.isArray(selected)) return;
    const normalized = normalizeDisplayPath(selected);
    setFolderPath(normalized);
    void previewPartitions(normalized);
  };

  const chooseEmbeddingModel = async () => {
    const selected = await open({
      multiple: false,
      filters: [{ name: 'GGUF embedding model', extensions: ['gguf'] }],
    });
    if (!selected || Array.isArray(selected)) return;
    setEmbeddingModelPath(normalizeDisplayPath(selected));
  };

  const chooseKnowledgeModel = async () => {
    const selected = await open({
      multiple: false,
      filters: [{ name: 'GGUF embedding model', extensions: ['gguf'] }],
    });
    if (!selected || Array.isArray(selected)) return;
    setKnowledgeModelPath(normalizeDisplayPath(selected));
  };

  const validateEmbeddingModel = async () => {
    setBusy('validate');
    setError(null);
    setEmbeddingSetupHint(null);
    try {
      const raw = embeddingModelPath.trim();
      if (!raw) throw new Error('Enter a search model .gguf path first.');
      const resolved = await kcResolveEmbeddingModel(raw);
      const validation = await kcValidateEmbeddingModel(resolved);
      await kcSetDefaultEmbeddingModel(validation.model_path);
      setEmbeddingModelPath(validation.model_path);
      setNotice(validation.message);
    } catch (err) {
      setError(humanError(err));
    } finally {
      setBusy(null);
    }
  };

  const createCollection = async () => {
    setBusy('create');
    setError(null);
    setNotice(null);
    try {
      if (!folderPath.trim()) throw new Error('Choose a folder first.');
      let codeModel = embeddingModelPath.trim();
      if (codeModel) {
        try {
          const validation = await kcValidateEmbeddingModel(codeModel);
          codeModel = validation.model_path;
          setEmbeddingModelPath(codeModel);
        } catch {
          // Allow create with lexical-only index; dense build will require Validate later.
        }
      }
      let knowledgeModel = knowledgeModelPath.trim();
      if (knowledgeModel) {
        try {
          const validation = await kcValidateEmbeddingModel(knowledgeModel);
          knowledgeModel = validation.model_path;
          setKnowledgeModelPath(knowledgeModel);
        } catch {
          // Lexical-only fallback for the knowledge partition.
        }
      }
      const collection = await kcCreateCollection({
        name: name.trim() || 'Company Data',
        root_path: folderPath.trim(),
        folder_category: folderCategory,
        code_model_path: codeModel || undefined,
        knowledge_model_path: knowledgeModel || undefined,
        embedding_model_path: codeModel || undefined,
      });
      upsertCollection(collection);
      setActiveCollectionId(collection.id);
      setNotice('Collection created. Scan the folder, then build the index.');
    } catch (err) {
      setError(humanError(err));
    } finally {
      setBusy(null);
    }
  };

  const scanCollection = async () => {
    if (!activeCollection) return;
    setBusy('scan');
    setError(null);
    try {
      const result = await kcScanCollection(activeCollection.id);
      const refreshed = await kcListCollections();
      setCollections(refreshed);
      setNotice(
        result.scanned_files > 0
          ? `Scan complete: ${result.supported_files} supported / ${result.scanned_files} scanned files.${result.truncated ? ' Warning: scan stopped at the file limit — split very large folders into multiple collections.' : ''}`
          : `Scan found no files under ${activeCollection.root_path}. Check that the folder exists and contains supported documents (e.g. .java, .md, .txt, .pdf).`,
      );
    } catch (err) {
      setError(humanError(err));
    } finally {
      setBusy(null);
    }
  };

  const buildIndex = async (rebuild = false) => {
    if (!activeCollection) return;
    setBusy('index');
    setError(null);
    setIndexProgress({
      collection_id: activeCollection.id,
      phase: 'prepare',
      current: 0,
      total: activeCollection.file_count || 0,
      message: rebuild ? 'Starting full rebuild…' : 'Starting index…',
      detail: 'prepare',
      state: 'running',
      elapsed_ms: 0,
      files_done: 0,
      files_failed: 0,
    });
    try {
      const result = await kcIndexCollection(activeCollection.id, {
        rebuild,
        build_dense: true,
        incremental: incrementalIndex && !rebuild,
        embedding_model_path: embeddingModelPath.trim() || undefined,
        // Documents/runbooks must use a compact model (BGE-M3). Qwen3-8B OOMs here.
        knowledge_model_path: knowledgeModelPath.trim() || undefined,
      });
      const refreshed = await kcListCollections();
      setCollections(refreshed);
      const { notice: indexNotice, warnings } = formatIndexSummary(result);
      setNotice(indexNotice);
      setCollectionWarnings(warnings);
      setIndexProgress({
        collection_id: activeCollection.id,
        phase: 'complete',
        current: result.total_files,
        total: result.total_files,
        message: indexNotice,
        detail: 'complete',
        state: result.status === 'failed' ? 'failed' : 'finished',
        files_done: result.total_indexed_files,
        files_failed: result.failed_files,
      });
      if (warnings.length > 0) {
        setError(null);
      }
    } catch (err) {
      const message = humanError(err);
      setError(message);
      setIndexProgress({
        collection_id: activeCollection.id,
        phase: 'complete',
        current: 0,
        total: activeCollection.file_count || 0,
        message,
        detail: 'failed',
        state: 'failed',
      });
    } finally {
      setBusy(null);
    }
  };

  const deleteCollection = async () => {
    if (!activeCollection) return;
    if (!confirm(`Delete collection "${activeCollection.name}" and its local index?`)) return;
    try {
      await kcDeleteCollection(activeCollection.id);
      removeCollection(activeCollection.id);
      const refreshed = await kcListCollections();
      setCollections(refreshed);
      setActiveCollectionId(refreshed[0]?.id || null);
      setNotice('Collection deleted.');
    } catch (err) {
      setError(humanError(err));
    }
  };

  return (
    <section className="panel-shell p-4 sm:p-6 space-y-5 relative z-20">      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-surface-500">Folder Collections</p>
          <h2 className="text-xl font-black text-surface-950 dark:text-white">Prepare a folder</h2>
          <p className="mt-1 text-xs text-surface-500 dark:text-surface-400">
            Scan a local folder so Knowledge Chat can search it and cite answers.
          </p>
        </div>
        <Database className="w-5 h-5 text-primary-500 shrink-0" />
      </div>

      <div className="grid lg:grid-cols-2 gap-4">
        <label className="block space-y-1">
          <span className="text-xs font-bold uppercase tracking-[0.14em] text-surface-500">Collection name</span>
          <input value={name} onChange={e => setName(e.target.value)} className="input-field" placeholder="Company Policies" />
        </label>
        <label className="block space-y-1">
          <span className="text-xs font-bold uppercase tracking-[0.14em] text-surface-500">Folder category</span>
          <select value={folderCategory} onChange={e => setFolderCategory(e.target.value as KcFolderCategory)} className="input-field text-sm">
            {(Object.keys(FOLDER_CATEGORY_LABELS) as KcFolderCategory[]).map(value => (
              <option key={value} value={value}>{FOLDER_CATEGORY_LABELS[value]}</option>
            ))}
          </select>
          <p className="text-[11px] text-surface-500">Chooses the default file types to search and which search models to prefer.</p>
        </label>
      </div>

      <div className="grid lg:grid-cols-2 gap-4">
        <label className="block space-y-1">
          <span className="text-xs font-bold uppercase tracking-[0.14em] text-surface-500">Code search model (.gguf)</span>
          <div className="flex gap-2">
            <input value={embeddingModelPath} onChange={e => setEmbeddingModelPath(e.target.value)} className="input-field font-mono text-xs flex-1" placeholder={embeddingModelPlaceholder(deploymentConfig)} />
            <button type="button" onClick={chooseEmbeddingModel} className="btn-secondary shrink-0">Browse</button>
            <button type="button" onClick={validateEmbeddingModel} disabled={busy === 'validate'} className="btn-secondary shrink-0">
              {busy === 'validate' ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Check'}
            </button>
          </div>
          <p className="text-[11px] text-surface-500">
            Optional for code folders only. Heavy on RAM — skip for Fortinet/docs collections. Prefer document model (BGE-M3) below.
          </p>
          {partitionMix && partitionMix.code_files > 0 && !embeddingModelPath.trim() && (
            <p className="text-[11px] text-amber-700 dark:text-amber-300">
              {partitionMix.code_files} code file(s) found but no code model selected — those use word search only.
            </p>
          )}
          {embeddingSetupHint && (
            <p className="text-[11px] text-amber-700 dark:text-amber-300">{embeddingSetupHint}</p>
          )}
        </label>
        <label className="block space-y-1">
          <span className="text-xs font-bold uppercase tracking-[0.14em] text-surface-500">Document search model (.gguf)</span>
          <div className="flex gap-2">
            <input value={knowledgeModelPath} onChange={e => setKnowledgeModelPath(e.target.value)} className="input-field font-mono text-xs flex-1" placeholder="bge-m3-Q4_K_M.gguf" />
            <button type="button" onClick={chooseKnowledgeModel} className="btn-secondary shrink-0">Browse</button>
          </div>
          <p className="text-[11px] text-surface-500">
            Use BGE-M3 for PDFs/docs/runbooks. Do not use Qwen3-Embedding-8B here — it is too large for this PC and will fail with out-of-memory errors.
          </p>
          {partitionMix && (partitionMix.documentation_files + partitionMix.runbooks_files + partitionMix.logs_data_files + partitionMix.general_files) > 0 && !knowledgeModelPath.trim() && (
            <p className="text-[11px] text-amber-700 dark:text-amber-300">
              {partitionMix.documentation_files + partitionMix.runbooks_files + partitionMix.logs_data_files + partitionMix.general_files} document file(s) found but no document model selected — pick BGE-M3 or meaning search stays off.
            </p>
          )}
        </label>
      </div>

      <label className="block space-y-1">
        <span className="text-xs font-bold uppercase tracking-[0.14em] text-surface-500">Folder path</span>
        <div className="flex flex-col sm:flex-row gap-2">
          <input
            value={folderPath}
            onChange={e => setFolderPath(e.target.value)}
            onBlur={e => void previewPartitions(e.target.value)}
            className="input-field flex-1 font-mono text-xs"
            placeholder="D:\Projects\my-docs or any folder path"
          />
          <button type="button" onClick={chooseFolder} className="btn-secondary flex items-center justify-center gap-2">
            <FolderOpen className="w-4 h-4" /> Browse
          </button>
          <button type="button" onClick={createCollection} disabled={busy === 'create'} className="btn-primary flex items-center justify-center gap-2">
            {busy === 'create' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Database className="w-4 h-4" />}
            Create
          </button>
        </div>
        {previewing && (
          <p className="text-[11px] text-primary-700 dark:text-primary-300 flex items-center gap-1.5">
            <Loader2 className="w-3 h-3 animate-spin" /> Checking folder contents…
          </p>
        )}
        {partitionMix && !previewing && (
          <p className="text-[11px] text-surface-500">
            Found{' '}
            <span className="font-semibold text-surface-700 dark:text-surface-200">{partitionMix.code_files}</span> code,{' '}
            <span className="font-semibold text-surface-700 dark:text-surface-200">{partitionMix.documentation_files}</span> documentation,{' '}
            <span className="font-semibold text-surface-700 dark:text-surface-200">{partitionMix.runbooks_files}</span> runbooks,{' '}
            <span className="font-semibold text-surface-700 dark:text-surface-200">{partitionMix.logs_data_files}</span> logs/data,{' '}
            <span className="font-semibold text-surface-700 dark:text-surface-200">{partitionMix.general_files}</span> general
            ({partitionMix.total_supported} supported total).
          </p>
        )}
      </label>

      <div className="rounded-2xl border border-white/70 dark:border-surface-800 bg-surface-50/85 dark:bg-surface-950/55 p-4 space-y-3 overflow-visible">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.14em] text-surface-500">Saved collections</p>
            <p className="text-sm font-semibold text-surface-800 dark:text-surface-100">
              {collections.length ? `${collections.length} collection(s)` : 'No collections yet'}
            </p>
          </div>
          <CollectionPicker
            collections={collections}
            value={activeCollectionId}
            onChange={setActiveCollectionId}
          />
        </div>
        {activeCollection && (
          <div className="grid sm:grid-cols-2 xl:grid-cols-4 gap-2">
            <StatCard label="Status" value={KC_STATUS_LABELS[activeCollection.status]} />
            <StatCard label="Files" value={filesStatLabel(activeCollection)} />
            <StatCard
              label="Code symbols"
              value={String(activeCollection.code_entity_count ?? collectionHealth?.code_entity_count ?? 0)}
            />
            <StatCard label="Sections" value={String(activeCollection.chunk_count)} />
            <StatCard label="Indexed text" value={fmtBytes(activeCollection.indexed_char_count)} />
          </div>
        )}
        {collectionHealth?.code_parse_summary && (
          <p className="text-[11px] text-surface-500">
            Code breakdown: {collectionHealth.code_parse_summary}
          </p>
        )}

        <div className="flex flex-col sm:flex-row flex-wrap gap-2 items-center">
          <label className="inline-flex items-center gap-2 text-xs text-surface-600 dark:text-surface-300 mr-2">
            <input
              type="checkbox"
              checked={incrementalIndex}
              onChange={e => setIncrementalIndex(e.target.checked)}
              className="rounded border-surface-300"
            />
            Only update changed files
          </label>
          {activeCollection && (
            <label className="inline-flex items-center gap-2 text-xs text-surface-600 dark:text-surface-300 mr-2 max-w-md">
              <input
                type="checkbox"
                checked={Boolean(activeCollection.image_rag_opt_in && activeCollection.allow_cloud_media)}
                onChange={async (e) => {
                  const on = e.target.checked;
                  if (on) {
                    const ok = window.confirm(
                      'Allow page images from this folder to be sent online?\n\n'
                      + 'Only turn this on for non-sensitive files. Search still works offline when this is off.\n'
                      + 'You also need the master switch and API details under Settings → Security.',
                    );
                    if (!ok) return;
                  }
                  try {
                    await setCollectionImageRag(activeCollection.id, on, on);
                    const items = await kcListCollections();
                    setCollections(items);
                    setNotice(on
                      ? 'Online page images allowed for this folder (also turn on the master switch in Settings).'
                      : 'Online page images turned off for this folder.');
                  } catch (err) {
                    setError(humanError(err));
                  }
                }}
                className="rounded border-surface-300"
              />
              Allow online page images for this folder
            </label>
          )}
          <button type="button" onClick={scanCollection} disabled={!activeCollection || busy === 'scan'} className="btn-secondary flex items-center justify-center gap-2">
            {busy === 'scan' ? <Loader2 className="w-4 h-4 animate-spin" /> : <ScanSearch className="w-4 h-4" />}
            Scan folder
          </button>
          <button type="button" onClick={() => buildIndex(false)} disabled={!activeCollection || busy === 'index'} className="btn-primary flex items-center justify-center gap-2">
            {busy === 'index' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
            Build index
          </button>
          <button type="button" onClick={() => buildIndex(true)} disabled={!activeCollection || busy === 'index'} className="btn-secondary flex items-center justify-center gap-2">
            <RefreshCw className="w-4 h-4" /> Rebuild
          </button>
          <button type="button" onClick={deleteCollection} disabled={!activeCollection} className="btn-secondary flex items-center justify-center gap-2 text-red-600 dark:text-red-300">
            <Trash2 className="w-4 h-4" /> Delete
          </button>
        </div>

        {(busy === 'index' || activeCollection?.status === 'indexing' || indexProgress) && (
          <div className="rounded-xl border border-primary-200/70 dark:border-primary-800 bg-primary-50/85 dark:bg-primary-950/25 px-4 py-3 text-sm text-primary-800 dark:text-primary-200 space-y-2">
            <div className="flex items-start justify-between gap-3">
              <p className="font-semibold">
                {indexProgress?.message
                  || (activeCollection?.status === 'indexing'
                    ? 'Indexing is running (or was interrupted). Live progress appears after you restart the app with the latest build and start/resume indexing.'
                    : 'Indexing…')}
              </p>
              {(busy === 'index' || indexProgress?.state === 'running') && (
                <Loader2 className="w-4 h-4 animate-spin shrink-0 mt-0.5" />
              )}
            </div>
            {indexProgress && (
              <>
                <div className="h-2 rounded-full bg-primary-100 dark:bg-primary-900/60 overflow-hidden">
                  <div
                    className="h-full bg-primary-500 transition-all duration-300"
                    style={{
                      width: `${indexProgress.total > 0
                        ? Math.min(100, Math.round((indexProgress.current / indexProgress.total) * 100))
                        : indexProgress.state === 'finished' ? 100 : 8}%`,
                    }}
                  />
                </div>
                <p className="text-xs">
                  {phaseLabel(indexProgress.phase)}
                  {indexProgress.total > 0
                    ? ` • ${indexProgress.current}/${indexProgress.total} files (${Math.min(100, Math.round((indexProgress.current / indexProgress.total) * 100))}%)`
                    : ''}
                  {typeof indexProgress.files_failed === 'number' && indexProgress.files_failed > 0
                    ? ` • ${indexProgress.files_failed} failed`
                    : ''}
                  {formatElapsed(indexProgress.elapsed_ms) ? ` • elapsed ${formatElapsed(indexProgress.elapsed_ms)}` : ''}
                  {indexProgress.state ? ` • ${indexProgress.state}` : ''}
                </p>
                {indexProgress.file_name && (
                  <p className="text-xs break-all opacity-90">
                    Current file: {indexProgress.file_name}
                    {indexProgress.detail && indexProgress.detail !== 'heartbeat'
                      ? ` (${indexProgress.detail})`
                      : ''}
                  </p>
                )}
                {indexProgress.detail === 'heartbeat' && (
                  <p className="text-xs opacity-80">
                    Still alive — large scanned PDFs can sit on one file for several minutes during OCR.
                  </p>
                )}
              </>
            )}
            {!indexProgress && activeCollection?.status === 'indexing' && (
              <p className="text-xs opacity-90">
                Collection status is still <strong>indexing</strong>
                {activeCollection.file_count > 0
                  ? ` (${activeCollection.indexed_file_count}/${activeCollection.file_count} files written so far)`
                  : ''}
                . If this has been unchanged for many hours, stop the app and rebuild with the progress fix, then run Rebuild (or Build index) again.
              </p>
            )}
          </div>
        )}

        {activeCollection?.status === 'ready' && collectionWarnings.length === 0 && (
          <div className="flex items-center gap-2 text-sm text-emerald-700 dark:text-emerald-300">
            <CheckCircle2 className="w-4 h-4" />
            Ready — you can ask questions about this folder.
          </div>
        )}

        {collectionWarnings.length > 0 && (
          <div className="rounded-2xl border border-amber-200/70 dark:border-amber-900 bg-amber-50/85 dark:bg-amber-950/20 px-4 py-3 text-sm text-amber-900 dark:text-amber-100 space-y-2">
            <p className="font-semibold flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              Needs attention
            </p>
            <ul className="text-xs space-y-1 list-disc pl-5">
              {collectionWarnings.map(item => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {(notice || error) && (
        <div className="space-y-2">
          {notice && <div className="rounded-2xl border border-emerald-200/70 dark:border-emerald-900 bg-emerald-50/85 dark:bg-emerald-950/20 px-4 py-3 text-sm text-emerald-700 dark:text-emerald-300">{notice}</div>}
          {error && <div className="rounded-2xl border border-amber-200/70 dark:border-amber-900 bg-amber-50/85 dark:bg-amber-950/20 px-4 py-3 text-sm text-amber-800 dark:text-amber-200 flex gap-2"><AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />{error}</div>}
        </div>
      )}
    </section>
  );
}

function CollectionPicker({
  collections,
  value,
  onChange,
}: {
  collections: KcCollection[];
  value: string | null;
  onChange: (id: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const selected = collections.find(item => item.id === value) || null;

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative w-full sm:max-w-md">
      <button
        type="button"
        onClick={() => setOpen(prev => !prev)}
        className="input-field flex items-center justify-between gap-2 text-left text-sm"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="truncate">
          {selected ? `${selected.name} — ${selected.root_path}` : 'Select collection...'}
        </span>
        <ChevronDown className={`w-4 h-4 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <ul
          role="listbox"
          className="absolute z-50 mt-1 max-h-56 w-full overflow-y-auto rounded-xl border border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-900 shadow-lg"
        >
          {collections.length === 0 ? (
            <li className="px-3 py-2 text-sm text-surface-500">No collections yet</li>
          ) : (
            collections.map(item => (
              <li key={item.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={item.id === value}
                  onClick={() => {
                    onChange(item.id);
                    setOpen(false);
                  }}
                  className={`w-full px-3 py-2 text-left text-sm hover:bg-surface-100 dark:hover:bg-surface-800 ${
                    item.id === value ? 'bg-primary-50 dark:bg-primary-950/40 text-primary-800 dark:text-primary-200' : ''
                  }`}
                >
                  <span className="block font-semibold truncate">{item.name}</span>
                  <span className="block text-xs text-surface-500 truncate">{item.root_path}</span>
                </button>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}
function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-white/70 dark:border-surface-800 bg-white/70 dark:bg-surface-900/45 p-3">
      <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-surface-500">{label}</p>
      <p className="text-lg font-black text-surface-950 dark:text-white">{value}</p>
    </div>
  );
}
