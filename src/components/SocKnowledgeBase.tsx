import { useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/tauri';
import { open } from '@tauri-apps/api/dialog';
import {
  AlertTriangle, BarChart3, BookOpen, CheckCircle2, Copy, Database, FileSearch, Filter,
  FolderOpen, FolderPlus, Loader2, PackageCheck, Plus, RefreshCw, Search, ShieldCheck, Trash2, X
} from 'lucide-react';
import { useAppStore } from '../store';
import { SOC_SYSTEM_PROMPT } from '../socChatHandoff';
import SocExportButton from './SocExportButton';
import type {
  AttachmentContext,
  SocDenseEmbeddingBuildResult,
  SocDenseEmbeddingProviderMode,
  SocDenseEmbeddingProviderValidation,
  SocDenseIndexPersisted,
  SocKnowledgeCategory,
  SocKnowledgeChunk,
  SocKnowledgeProduct,
  SocKnowledgeResource,
  SocKnowledgeScanResult,
  SocPdfOcrResult,
  SocRetrievalMode,
} from '../types';
import {
  attachmentToSocChunks,
  buildSocRagIndexSummaryMarkdown,
  buildSocRetrievedSnippetContext,
  compactSocNumber,
  getSocRagHealthStats,
  isSocIndexableTextPath,
  normalizeSocPath,
  searchSocRagChunks,
  socFileExtension,
  SOC_DENSE_PROVIDER_MODE_LABELS,
  SOC_DENSE_PROVIDER_STATUS_LABELS,
  SOC_DENSE_INDEX_PATH,
  SOC_DENSE_EMBED_BATCH_SIZE,
  SOC_DENSE_EMBED_CONTEXT_SIZE,
  SOC_RAG_RETRIEVAL_MODE_LABELS,
  SOC_INDEXABLE_EXTENSIONS,
  SOC_MAX_INDEX_CHARS_PER_FILE,
  flattenSocChunks,
} from '../socKnowledgeIndex';
import { buildSocKnowledgePackSummaryMarkdown } from '../socDataPackChecklist';
import { useKnowledgeChatStore } from '../knowledgeChat/store';
import { kcHitsToSocRagResults, retrieveSocGroundedKnowledge } from '../socKnowledgeRetrieval';
import { isPathUnderDeploymentRoots } from '../deploymentConfig';
import { dialogDefaultPath, embeddingModelPlaceholder, joinPath, pathPlaceholder } from '../platformPaths';

const CATEGORY_OPTIONS: SocKnowledgeCategory[] = [
  'FortiSIEM Guide',
  'FortiSOAR Guide',
  'Fortinet KB / Forum Export',
  'Internal SOC SOP',
  'FortiSIEM Rule',
  'FortiSIEM Parser',
  'FortiSOAR Playbook',
  'Connector Documentation',
  'Incident Example',
  'Sample Logs',
];

const PRODUCT_OPTIONS: SocKnowledgeProduct[] = ['FortiSIEM', 'FortiSOAR', 'Fortinet', 'Internal', 'Other'];

type KnowledgeForm = {
  title: string;
  category: SocKnowledgeCategory;
  product: SocKnowledgeProduct;
  version: string;
  tags: string;
  filePath: string;
  notes: string;
};

const emptyForm: KnowledgeForm = {
  title: '',
  category: 'FortiSIEM Guide',
  product: 'FortiSIEM',
  version: '',
  tags: '',
  filePath: '',
  notes: '',
};

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function fileNameFromPath(value: string): string {
  const parts = normalizeSocPath(value).split('\\').filter(Boolean);
  return parts[parts.length - 1] || '';
}

function tagList(value: string): string[] {
  return value
    .split(',')
    .map(tag => tag.trim())
    .filter(Boolean)
    .slice(0, 12);
}

function readableDate(ts?: number): string {
  if (!ts) return 'Not indexed';
  try {
    return new Date(ts * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch {
    return 'Unknown';
  }
}

function matchesSearch(resource: SocKnowledgeResource, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const haystack = [
    resource.title,
    resource.category,
    resource.product,
    resource.version,
    resource.tags.join(' '),
    resource.filePath,
    resource.notes,
    resource.indexStatus || 'not_indexed',
    ...(resource.extractionWarnings || []),
  ].join('\n').toLowerCase();
  return haystack.includes(q);
}

function resourceToContextLine(resource: SocKnowledgeResource): string {
  const tags = resource.tags.length ? resource.tags.join(', ') : 'none';
  const warnings = resource.extractionWarnings?.length ? resource.extractionWarnings.join(' | ') : 'none';
  return [
    `Title: ${resource.title}`,
    `Category: ${resource.category}`,
    `Product: ${resource.product}`,
    `Version: ${resource.version || 'not specified'}`,
    `Tags: ${tags}`,
    `File: ${resource.filePath}`,
    `Index status: ${resource.indexStatus || 'not_indexed'}`,
    `Indexed at: ${readableDate(resource.indexedAt)}`,
    `Indexed kind: ${resource.indexedKind || 'not indexed'}`,
    `Indexed characters: ${resource.indexedCharCount || 0}`,
    `Indexed chunks: ${resource.indexedChunkCount || 0}`,
    `Extraction warnings: ${warnings}`,
    `Notes: ${resource.notes || 'none'}`,
  ].join('\n');
}

function snippetPreview(text: string, max = 360): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  return cleaned.length > max ? `${cleaned.slice(0, max)}...` : cleaned;
}

function compactForChat(text: string, max = 900): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  return cleaned.length > max ? `${cleaned.slice(0, max)}...` : cleaned;
}


function buildBreakdown(values: string[]): Array<{ label: string; count: number }> {
  const counts = values.reduce<Record<string, number>>((acc, value) => {
    const key = value || 'not specified';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  return Object.entries(counts)
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

function inferResourceMetadata(filePath: string): Pick<KnowledgeForm, 'title' | 'category' | 'product' | 'version' | 'tags' | 'notes'> {
  const normalized = normalizeSocPath(filePath);
  const lower = normalized.toLowerCase();
  const fileName = fileNameFromPath(normalized);
  const cleanTitle = fileName.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim() || fileName;
  const versionMatch = lower.match(/7[._-]?(4|5|6)(?:[._-]?\d+)?|7\.(4|5|6)(?:\.\d+)?/);
  const version = versionMatch ? versionMatch[0].replace(/_/g, '.').replace(/-/g, '.') : '';

  let product: SocKnowledgeProduct = 'Other';
  if (lower.includes('fortisiem')) product = 'FortiSIEM';
  else if (lower.includes('fortisoar')) product = 'FortiSOAR';
  else if (lower.includes('fortinet') || lower.includes('fortigate') || lower.includes('fortianalyzer')) product = 'Fortinet';
  else if (lower.includes('sop') || lower.includes('internal') || lower.includes('escalation')) product = 'Internal';

  let category: SocKnowledgeCategory = product === 'FortiSOAR' ? 'FortiSOAR Guide' : product === 'FortiSIEM' ? 'FortiSIEM Guide' : 'Fortinet KB / Forum Export';
  if (lower.includes('parser')) category = 'FortiSIEM Parser';
  else if (lower.includes('rule') || lower.includes('detection') || lower.includes('correlation')) category = 'FortiSIEM Rule';
  else if (lower.includes('playbook') || lower.includes('workflow')) category = 'FortiSOAR Playbook';
  else if (lower.includes('connector') || lower.includes('integration')) category = 'Connector Documentation';
  else if (lower.includes('incident') || lower.includes('alert') || lower.includes('case')) category = 'Incident Example';
  else if (lower.includes('sample') || lower.includes('log')) category = 'Sample Logs';
  else if (lower.includes('sop') || lower.includes('escalation') || lower.includes('severity') || lower.includes('approval')) category = 'Internal SOC SOP';

  const tagCandidates = [
    product.toLowerCase(),
    category.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    lower.includes('vpn') ? 'vpn' : '',
    lower.includes('brute') ? 'brute-force' : '',
    lower.includes('phishing') ? 'phishing' : '',
    lower.includes('mitre') ? 'mitre' : '',
    lower.includes('api') ? 'api' : '',
    lower.includes('connector') ? 'connector' : '',
  ].filter(Boolean);

  return {
    title: cleanTitle,
    category,
    product,
    version,
    tags: Array.from(new Set(tagCandidates)).slice(0, 8).join(', '),
    notes: 'Bulk registered from a local offline SOC knowledge folder. Review metadata before final company handoff.',
  };
}

function BreakdownList({ items }: { items: Array<{ label: string; count: number }> }) {
  if (!items.length) {
    return <p className="text-xs text-surface-500 dark:text-surface-400">No data yet.</p>;
  }

  return (
    <div className="space-y-1.5">
      {items.slice(0, 8).map(item => (
        <div key={item.label} className="flex items-center justify-between gap-3 text-xs text-surface-600 dark:text-surface-300">
          <span className="truncate">{item.label}</span>
          <span className="font-black text-surface-900 dark:text-white">{item.count}</span>
        </div>
      ))}
    </div>
  );
}

function humanError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object') {
    const maybe = err as { message?: unknown; error?: unknown };
    if (typeof maybe.message === 'string') return maybe.message;
    if (typeof maybe.error === 'string') return maybe.error;
    try { return JSON.stringify(err); } catch { return String(err); }
  }
  return String(err || 'Unknown error');
}

const DENSE_EMBED_BATCH_SIZE = 160;

function countDenseVectorsOnResources(resources: SocKnowledgeResource[]): number {
  return resources.reduce(
    (sum, resource) => sum + (resource.indexedChunks || []).filter(chunk => Array.isArray(chunk.denseVector) && chunk.denseVector.length > 0).length,
    0,
  );
}

function collectPendingDenseChunks(resources: SocKnowledgeResource[], limit: number): SocKnowledgeChunk[] {
  const pending: SocKnowledgeChunk[] = [];
  for (const resource of resources) {
    for (const chunk of resource.indexedChunks || []) {
      if (!chunk.text?.trim()) continue;
      if (Array.isArray(chunk.denseVector) && chunk.denseVector.length > 0) continue;
      pending.push(chunk);
      if (pending.length >= limit) return pending;
    }
  }
  return pending;
}

function buildDenseIndexPayload(resources: SocKnowledgeResource[], modelPath: string): SocDenseIndexPersisted {
  const vectors: Record<string, number[]> = {};
  let dimension = 0;
  for (const chunk of flattenSocChunks(resources)) {
    if (Array.isArray(chunk.denseVector) && chunk.denseVector.length > 0) {
      vectors[chunk.id] = chunk.denseVector;
      dimension = chunk.denseVector.length;
    }
  }
  return {
    model_path: modelPath,
    dimension,
    updated_at: nowSeconds(),
    vectors,
  };
}

export default function SocKnowledgeBase() {
  const store = useAppStore();
  const {
    socKnowledgeResources,
    selectedSocKnowledgeResourceIds,
    selectedSocKnowledgeChunkIds,
    addSocKnowledgeResource,
    updateSocKnowledgeResource,
    removeSocKnowledgeResource,
    setSelectedSocKnowledgeResourceIds,
    toggleSelectedSocKnowledgeResource,
    setSelectedSocKnowledgeChunkIds,
    toggleSelectedSocKnowledgeChunk,
    clearSelectedSocKnowledgeChunks,
    setPendingChatPrompt,
    setActiveView,
    socDataPackChecklist,
    socDenseEmbeddingSettings,
    setSocDenseEmbeddingSettings,
    socKnowledgeCollectionId,
    socKnowledgeCollectionRoot,
    deploymentConfig,
  } = store;
  const { embeddingModelPath } = useKnowledgeChatStore();

  const pathAllowed = (value: string) => {
    if (!deploymentConfig) return value.trim().length > 0;
    return isPathUnderDeploymentRoots(value, deploymentConfig);
  };

  const bulkPathAllowed = (value: string) => pathAllowed(value);

  const [form, setForm] = useState<KnowledgeForm>(emptyForm);
  const [query, setQuery] = useState('');
  const [retrievalQuery, setRetrievalQuery] = useState('');
  const [retrievalMode, setRetrievalMode] = useState<SocRetrievalMode>('hybrid_lexical');
  const [topK, setTopK] = useState(8);
  const [categoryFilter, setCategoryFilter] = useState<'all' | SocKnowledgeCategory>('all');
  const [productFilter, setProductFilter] = useState<'all' | SocKnowledgeProduct>('all');
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [indexingIds, setIndexingIds] = useState<string[]>([]);
  const [ocrBusyIds, setOcrBusyIds] = useState<string[]>([]);
  const [bulkFolderPath, setBulkFolderPath] = useState(
    () => socKnowledgeCollectionRoot || deploymentConfig?.socDataRoot || '',
  );
  const [bulkScan, setBulkScan] = useState<SocKnowledgeScanResult | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkSkippedDuplicates, setBulkSkippedDuplicates] = useState(0);
  const [denseBusy, setDenseBusy] = useState(false);
  const [denseSearchBusy, setDenseSearchBusy] = useState(false);
  const [denseQueryVector, setDenseQueryVector] = useState<number[] | undefined>(undefined);
  const [kcRetrievalResults, setKcRetrievalResults] = useState<ReturnType<typeof searchSocRagChunks>>([]);
  const [kcRetrievalBusy, setKcRetrievalBusy] = useState(false);

  const legacyRetrievalResults = useMemo(
    () => searchSocRagChunks(socKnowledgeResources, retrievalQuery, retrievalMode, topK, socDenseEmbeddingSettings, denseQueryVector),
    [socKnowledgeResources, retrievalQuery, retrievalMode, topK, socDenseEmbeddingSettings, denseQueryVector]
  );

  useEffect(() => {
    if (!socKnowledgeCollectionId || !retrievalQuery.trim()) {
      setKcRetrievalResults([]);
      return;
    }
    const timer = window.setTimeout(() => {
      void (async () => {
        setKcRetrievalBusy(true);
        try {
          const result = await retrieveSocGroundedKnowledge({
            collectionId: socKnowledgeCollectionId,
            query: retrievalQuery,
            embeddingModelPath,
            retrievalMode: retrievalMode === 'hybrid_dense' ? 'hybrid_dense' : retrievalMode === 'dense_vector' ? 'dense_vector' : retrievalMode === 'keyword' ? 'keyword' : 'hybrid_lexical',
            topK,
          });
          setKcRetrievalResults(kcHitsToSocRagResults(result.contextHits, result.retrievalModeUsed));
        } catch {
          setKcRetrievalResults([]);
        } finally {
          setKcRetrievalBusy(false);
        }
      })();
    }, 400);
    return () => window.clearTimeout(timer);
  }, [socKnowledgeCollectionId, retrievalQuery, embeddingModelPath, retrievalMode, topK]);

  const retrievalResults = socKnowledgeCollectionId ? kcRetrievalResults : legacyRetrievalResults;

  const filteredResources = useMemo(() => {
    return socKnowledgeResources
      .filter(resource => matchesSearch(resource, query))
      .filter(resource => categoryFilter === 'all' || resource.category === categoryFilter)
      .filter(resource => productFilter === 'all' || resource.product === productFilter)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }, [socKnowledgeResources, query, categoryFilter, productFilter]);

  const selectedResources = useMemo(() => {
    const selected = new Set(selectedSocKnowledgeResourceIds);
    return socKnowledgeResources.filter(resource => selected.has(resource.id));
  }, [socKnowledgeResources, selectedSocKnowledgeResourceIds]);

  const selectedRetrievedChunks = useMemo(() => {
    const selected = new Set(selectedSocKnowledgeChunkIds);
    return socKnowledgeResources
      .flatMap(resource => resource.indexedChunks || [])
      .filter(chunk => selected.has(chunk.id));
  }, [socKnowledgeResources, selectedSocKnowledgeChunkIds]);

  const indexedCount = socKnowledgeResources.filter(resource => resource.indexStatus === 'indexed' || resource.indexStatus === 'warning').length;
  const totalChunkCount = socKnowledgeResources.reduce((sum, resource) => sum + (resource.indexedChunkCount || 0), 0);
  const ragHealthStats = useMemo(() => getSocRagHealthStats(socKnowledgeResources, socDenseEmbeddingSettings), [socKnowledgeResources, socDenseEmbeddingSettings]);
  const denseStatusLabel = useMemo(() => {
    if (ragHealthStats.denseAvailable) return 'Ready';
    if (socDenseEmbeddingSettings.status === 'indexing') return 'Indexing';
    if (socDenseEmbeddingSettings.status === 'failed') return 'Failed';
    if (ragHealthStats.denseVectorChunks > 0) return 'Partial';
    if (socDenseEmbeddingSettings.runtimePath || socDenseEmbeddingSettings.modelFormat) return 'Validated';
    return SOC_DENSE_PROVIDER_STATUS_LABELS[socDenseEmbeddingSettings.status];
  }, [ragHealthStats.denseAvailable, ragHealthStats.denseVectorChunks, socDenseEmbeddingSettings]);
  const denseModeSelected = retrievalMode === 'dense_vector' || retrievalMode === 'hybrid_dense';

  const healthStats = useMemo(() => {
    const failed = socKnowledgeResources.filter(resource => resource.indexStatus === 'error').length;
    const unindexed = socKnowledgeResources.filter(resource => !resource.indexStatus || resource.indexStatus === 'not_indexed').length;
    const metadataOnly = socKnowledgeResources.filter(resource => !isSocIndexableTextPath(resource.filePath)).length;
    const productBreakdown = buildBreakdown(socKnowledgeResources.map(resource => resource.product || 'Other'));
    const categoryBreakdown = buildBreakdown(socKnowledgeResources.map(resource => resource.category || 'Other'));
    const versionBreakdown = buildBreakdown(socKnowledgeResources.map(resource => resource.version || 'not specified'));
    return { failed, unindexed, metadataOnly, productBreakdown, categoryBreakdown, versionBreakdown };
  }, [socKnowledgeResources]);

  const knowledgePackSummary = useMemo(
    () => buildSocKnowledgePackSummaryMarkdown(socKnowledgeResources, socDataPackChecklist),
    [socKnowledgeResources, socDataPackChecklist]
  );

  const ragIndexSummary = useMemo(
    () => buildSocRagIndexSummaryMarkdown(socKnowledgeResources, socDenseEmbeddingSettings),
    [socKnowledgeResources, socDenseEmbeddingSettings]
  );

  const updateForm = <K extends keyof KnowledgeForm>(key: K, value: KnowledgeForm[K]) => {
    setForm(prev => ({ ...prev, [key]: value }));
    setError(null);
  };

  const chooseFile = async () => {
    setError(null);
    setNotice(null);
    try {
      const selected = await open({
        multiple: false,
        directory: false,
        defaultPath: dialogDefaultPath(deploymentConfig, 'data') || undefined,
        filters: [
          {
            name: 'SOC knowledge files',
            extensions: ['pdf', 'html', 'htm', 'txt', 'md', 'csv', 'json', 'xml', 'yaml', 'yml', 'log', 'docx'],
          },
          { name: 'All files', extensions: ['*'] },
        ],
      });

      if (!selected || Array.isArray(selected)) return;
      const normalized = normalizeSocPath(selected);
      if (!pathAllowed(normalized)) {
        setError('File path must be under configured NexusAI data roots. Update Settings → Deployment.');
        return;
      }
      setForm(prev => ({
        ...prev,
        filePath: normalized,
        title: prev.title.trim() || fileNameFromPath(normalized),
      }));
      setNotice('File selected. Register it, then Index (PDFs use text extraction; scanned PDFs need OCR first).');
    } catch (err) {
      setError(`File picker failed: ${humanError(err)}`);
    }
  };

  const registerResource = () => {
    const filePath = normalizeSocPath(form.filePath);
    const title = form.title.trim() || fileNameFromPath(filePath);
    if (!filePath) {
      setError('Please choose or paste a file path under your configured data roots before registering.');
      return;
    }
    if (!pathAllowed(filePath)) {
      setError('File path must be under configured NexusAI data roots.');
      return;
    }
    if (!title) {
      setError('Please add a title or select a file with a readable filename.');
      return;
    }

    const duplicate = socKnowledgeResources.some(resource => normalizeSocPath(resource.filePath).toLowerCase() === filePath.toLowerCase());
    if (duplicate) {
      setError('This file path is already registered in the offline knowledge library.');
      return;
    }

    const timestamp = nowSeconds();
    const resource: SocKnowledgeResource = {
      id: `soc-kb-${timestamp}-${Math.random().toString(36).slice(2, 8)}`,
      title,
      category: form.category,
      product: form.product,
      version: form.version.trim(),
      tags: tagList(form.tags),
      filePath,
      notes: form.notes.trim(),
      createdAt: timestamp,
      updatedAt: timestamp,
      indexStatus: 'not_indexed',
      indexedChunkCount: 0,
      indexedCharCount: 0,
      extractionWarnings: [],
      indexedChunks: [],
    };

    addSocKnowledgeResource(resource);
    setSelectedSocKnowledgeResourceIds([...new Set([...selectedSocKnowledgeResourceIds, resource.id])]);
    setForm(emptyForm);
    setNotice('Resource registered locally and selected for SOC prompt metadata context. No file content was sent online.');
    setError(null);
  };

  const clearSelection = () => {
    setSelectedSocKnowledgeResourceIds([]);
    clearSelectedSocKnowledgeChunks();
    setNotice('Selected metadata and retrieved snippet context cleared from SOC prompts.');
  };

  const clearResourceIndex = (resource: SocKnowledgeResource) => {
    updateSocKnowledgeResource(resource.id, {
      indexStatus: 'not_indexed',
      indexedAt: undefined,
      indexedKind: undefined,
      indexedCharCount: 0,
      indexedChunkCount: 0,
      extractionWarnings: [],
      indexedChunks: [],
    });
    setSelectedSocKnowledgeChunkIds(selectedSocKnowledgeChunkIds.filter(chunkId => !chunkId.startsWith(`${resource.id}::`)));
    setNotice(`Cleared local index for ${resource.title}. Metadata remains registered.`);
  };


  const updateDenseProviderMode = (mode: SocDenseEmbeddingProviderMode) => {
    setError(null);
    setNotice(null);
    setSocDenseEmbeddingSettings({
      providerMode: mode,
      status: 'not_configured',
      providerName: mode === 'local_dense' ? 'Local dense embedding provider' : 'Not configured',
      error: undefined,
    });
    if (mode === 'local_dense') {
      setNotice('Local dense provider mode selected. Add a local embedding model path when an embedding runtime is available.');
    }
  };

  const validateDenseProviderSettings = async () => {
    setError(null);
    setNotice(null);
    const modelPath = normalizeSocPath(socDenseEmbeddingSettings.modelPath || '');

    if (socDenseEmbeddingSettings.providerMode !== 'local_dense') {
      setSocDenseEmbeddingSettings({
        status: 'not_configured',
        providerName: 'Not configured',
        runtimePath: undefined,
        modelFormat: undefined,
        error: undefined,
      });
      setNotice('Dense vector retrieval is not configured. Keyword and Hybrid lexical RAG remain active.');
      return;
    }

    if (!modelPath) {
      setSocDenseEmbeddingSettings({
        status: 'failed',
        providerName: 'Local llama.cpp embeddings',
        error: 'A local .gguf embedding model path is required before dense vectors can be built.',
      });
      setError('Add a local .gguf embedding model path first.');
      return;
    }

    if (!pathAllowed(modelPath)) {
      setSocDenseEmbeddingSettings({
        status: 'failed',
        providerName: 'Local llama.cpp embeddings',
        modelPath,
        error: 'Embedding model path must be under configured NexusAI data roots.',
      });
      setError('Embedding model path must be under configured NexusAI data roots.');
      return;
    }

    setDenseBusy(true);
    try {
      const result = await invoke<SocDenseEmbeddingProviderValidation>('validate_soc_dense_embedding_provider', { modelPath });
      setSocDenseEmbeddingSettings({
        modelPath: normalizeSocPath(result.model_path),
        providerName: result.provider_name,
        runtimePath: result.runtime_path ? normalizeSocPath(result.runtime_path) : undefined,
        modelFormat: result.model_format || 'gguf',
        status: 'not_configured',
        error: undefined,
      });
      setNotice(`${result.message} Next: click Build Dense Index (All Indexed).${result.warnings.length ? ` Warning: ${result.warnings.join(' ')}` : ''}`);
    } catch (err) {
      setSocDenseEmbeddingSettings({
        modelPath,
        providerName: 'Local llama.cpp embeddings',
        status: 'failed',
        error: humanError(err),
      });
      setError(`Dense provider validation failed: ${humanError(err)}`);
    } finally {
      setDenseBusy(false);
    }
  };

  const applyDenseBuildResult = (result: SocDenseEmbeddingBuildResult) => {
    const vectorMap = new Map(result.vectors.map(item => [item.chunk_id, item]));
    const embeddedAt = nowSeconds();
    let updatedCount = 0;
    const resources = useAppStore.getState().socKnowledgeResources;

    resources.forEach(resource => {
      if (!(resource.indexedChunks || []).length) return;
      let changed = false;
      const nextChunks = (resource.indexedChunks || []).map(chunk => {
        const embedded = vectorMap.get(chunk.id);
        if (!embedded) return chunk;
        changed = true;
        updatedCount += 1;
        return {
          ...chunk,
          denseVector: embedded.vector,
          denseVectorDimensions: embedded.dimension,
          denseEmbeddingProvider: result.provider_name,
          denseEmbeddingModelPath: normalizeSocPath(result.model_path),
          denseEmbeddedAt: embeddedAt,
          denseEmbeddingStatus: 'ready' as const,
        };
      });
      if (changed) {
        updateSocKnowledgeResource(resource.id, {
          indexedChunks: nextChunks,
          updatedAt: embeddedAt,
        });
      }
    });

    return { updatedCount, embeddedAt };
  };

  const saveDenseIndexToDisk = async (modelPath: string) => {
    const resources = useAppStore.getState().socKnowledgeResources;
    const payload = buildDenseIndexPayload(resources, normalizeSocPath(modelPath));
    if (!Object.keys(payload.vectors).length) return;
    await invoke('save_soc_dense_index', {
      filePath: SOC_DENSE_INDEX_PATH,
      payload,
    });
  };

  const loadPersistedDenseIndex = async () => {
    try {
      const saved = await invoke<SocDenseIndexPersisted>('load_soc_dense_index', { filePath: SOC_DENSE_INDEX_PATH });
      const vectorEntries = Object.entries(saved.vectors || {});
      if (!vectorEntries.length) return;

      const resources = useAppStore.getState().socKnowledgeResources;
      const vectorMap = new Map(vectorEntries);
      let applied = 0;
      const embeddedAt = saved.updated_at || nowSeconds();

      resources.forEach(resource => {
        if (!(resource.indexedChunks || []).length) return;
        let changed = false;
        const nextChunks = (resource.indexedChunks || []).map(chunk => {
          const vector = vectorMap.get(chunk.id);
          if (!vector?.length) return chunk;
          changed = true;
          applied += 1;
          return {
            ...chunk,
            denseVector: vector,
            denseVectorDimensions: saved.dimension || vector.length,
            denseEmbeddingProvider: 'Local llama.cpp embeddings',
            denseEmbeddingModelPath: normalizeSocPath(saved.model_path || socDenseEmbeddingSettings.modelPath || ''),
            denseEmbeddedAt: embeddedAt,
            denseEmbeddingStatus: 'ready' as const,
          };
        });
        if (changed) {
          updateSocKnowledgeResource(resource.id, {
            indexedChunks: nextChunks,
            updatedAt: embeddedAt,
          });
        }
      });

      if (applied > 0) {
        setSocDenseEmbeddingSettings({
          providerMode: 'local_dense',
          providerName: 'Local llama.cpp embeddings',
          modelPath: normalizeSocPath(saved.model_path || socDenseEmbeddingSettings.modelPath || ''),
          status: 'ready',
          vectorDimension: saved.dimension || vectorEntries[0][1].length,
          vectorizedChunkCount: applied,
          failedChunkCount: 0,
          lastIndexedAt: embeddedAt,
          error: undefined,
        });
        setRetrievalMode('hybrid_dense');
        setNotice(`Restored ${applied} dense vector(s) from ${SOC_DENSE_INDEX_PATH}.`);
      }
    } catch {
      // Ignore missing or invalid saved dense index on startup.
    }
  };

  useEffect(() => {
    void loadPersistedDenseIndex();
  }, []);

  const embedDenseChunkBatch = async (chunksToEmbed: SocKnowledgeChunk[], modelPath: string) => {
    return invoke<SocDenseEmbeddingBuildResult>('embed_soc_dense_texts', {
      request: {
        model_path: modelPath,
        texts: chunksToEmbed.map(chunk => ({ chunk_id: chunk.id, text: chunk.text })),
        context_size: SOC_DENSE_EMBED_CONTEXT_SIZE,
        batch_size: SOC_DENSE_EMBED_BATCH_SIZE,
      },
    });
  };

  const finalizeDenseBuildSettings = (result: SocDenseEmbeddingBuildResult, embeddedAt: number) => {
    const totalDense = countDenseVectorsOnResources(useAppStore.getState().socKnowledgeResources);
    setSocDenseEmbeddingSettings({
      providerMode: 'local_dense',
      providerName: result.provider_name,
      modelPath: normalizeSocPath(result.model_path),
      runtimePath: normalizeSocPath(result.runtime_path),
      modelFormat: result.model_format,
      status: 'ready',
      vectorDimension: result.dimension,
      vectorizedChunkCount: totalDense,
      failedChunkCount: 0,
      lastIndexedAt: embeddedAt,
      error: undefined,
    });
    if (totalDense > 0) setRetrievalMode('hybrid_dense');
  };

  const buildDenseIndexForAllIndexed = async () => {
    setError(null);
    setNotice(null);
    const modelPath = normalizeSocPath(socDenseEmbeddingSettings.modelPath || '');

    if (socDenseEmbeddingSettings.providerMode !== 'local_dense' || !modelPath) {
      setError('Set the embedding model path in Settings → Deployment first.');
      return;
    }
    if (!pathAllowed(modelPath)) {
      setError('Embedding model must be under configured NexusAI data roots.');
      return;
    }

    const indexedResources = useAppStore.getState().socKnowledgeResources.filter(resource => (resource.indexedChunks || []).length > 0);
    if (!indexedResources.length) {
      setError('No indexed resources found. Index your files first.');
      return;
    }

    setSelectedSocKnowledgeResourceIds(indexedResources.map(resource => resource.id));
    setDenseBusy(true);
    setSocDenseEmbeddingSettings({ status: 'indexing', error: undefined });

    try {
      let batchNumber = 0;
      let lastResult: SocDenseEmbeddingBuildResult | null = null;
      let lastEmbeddedAt = nowSeconds();

      while (true) {
        const resources = useAppStore.getState().socKnowledgeResources.filter(resource => (resource.indexedChunks || []).length > 0);
        const pending = collectPendingDenseChunks(resources, DENSE_EMBED_BATCH_SIZE);
        if (!pending.length) break;

        batchNumber += 1;
        const doneSoFar = countDenseVectorsOnResources(resources);
        setNotice(`Building dense vectors: batch ${batchNumber}, ${doneSoFar} done, processing ${pending.length} more...`);

        const result = await embedDenseChunkBatch(pending, modelPath);
        const { embeddedAt } = applyDenseBuildResult(result);
        lastResult = result;
        lastEmbeddedAt = embeddedAt;
        await saveDenseIndexToDisk(modelPath);
      }

      if (!lastResult) {
        setNotice('All indexed chunks already have dense vectors.');
        return;
      }

      finalizeDenseBuildSettings(lastResult, lastEmbeddedAt);
      const totalDense = countDenseVectorsOnResources(useAppStore.getState().socKnowledgeResources);
      setNotice(`Dense index complete: ${totalDense} chunk(s). Hybrid dense RAG is now active.${lastResult.warnings.length ? ` Warning: ${lastResult.warnings.slice(0, 1).join(' ')}` : ''}`);
    } catch (err) {
      setSocDenseEmbeddingSettings({
        status: 'failed',
        providerName: socDenseEmbeddingSettings.providerName || 'Local llama.cpp embeddings',
        error: humanError(err),
      });
      setError(`Dense embedding build failed: ${humanError(err)}`);
    } finally {
      setDenseBusy(false);
    }
  };

  const buildDenseIndexForSelected = async () => {
    setError(null);
    setNotice(null);
    if (!selectedResources.length) {
      setError('Select at least one indexed resource before building dense vectors.');
      return;
    }
    if (socDenseEmbeddingSettings.providerMode !== 'local_dense' || !socDenseEmbeddingSettings.modelPath) {
      setError('Configure a local dense embedding GGUF model path first. Keyword and Hybrid lexical RAG remain available.');
      return;
    }

    const chunksToEmbed = collectPendingDenseChunks(selectedResources, DENSE_EMBED_BATCH_SIZE);
    if (!chunksToEmbed.length) {
      setError('Selected resources already have dense vectors, or no indexed chunks were found.');
      return;
    }

    const modelPath = normalizeSocPath(socDenseEmbeddingSettings.modelPath);
    setDenseBusy(true);
    setSocDenseEmbeddingSettings({ status: 'indexing', error: undefined });

    try {
      const result = await embedDenseChunkBatch(chunksToEmbed, modelPath);
      const { updatedCount, embeddedAt } = applyDenseBuildResult(result);
      await saveDenseIndexToDisk(modelPath);
      finalizeDenseBuildSettings(result, embeddedAt);

      const remaining = collectPendingDenseChunks(useAppStore.getState().socKnowledgeResources, Number.MAX_SAFE_INTEGER).length;
      setNotice(`Dense vectors built for ${updatedCount} chunk(s).${remaining > 0 ? ` ${remaining} chunk(s) still pending — use Build Dense Index (All Indexed) to finish.` : ' Hybrid dense RAG is now active.'}${result.warnings.length ? ` Warning: ${result.warnings.slice(0, 1).join(' ')}` : ''}`);
    } catch (err) {
      setSocDenseEmbeddingSettings({
        status: 'failed',
        providerName: socDenseEmbeddingSettings.providerName || 'Local llama.cpp embeddings',
        failedChunkCount: chunksToEmbed.length,
        error: humanError(err),
      });
      setError(`Dense embedding build failed: ${humanError(err)}`);
    } finally {
      setDenseBusy(false);
    }
  };

  const clearDenseIndexOnly = () => {
    setError(null);
    setNotice(null);
    const denseChunkCount = socKnowledgeResources.reduce(
      (sum, resource) => sum + (resource.indexedChunks || []).filter(chunk => Array.isArray(chunk.denseVector) && chunk.denseVector.length > 0).length,
      0,
    );
    if (!denseChunkCount) {
      setNotice('No dense vectors are stored. Keyword and Hybrid lexical indexes are unchanged.');
      return;
    }
    const ok = window.confirm('Clear dense vectors only? Source documents, metadata, keyword chunks, and hybrid lexical vectors will remain untouched.');
    if (!ok) return;

    socKnowledgeResources.forEach(resource => {
      if (!(resource.indexedChunks || []).length) return;
      updateSocKnowledgeResource(resource.id, {
        indexedChunks: (resource.indexedChunks || []).map(chunk => ({
          ...chunk,
          denseVector: undefined,
          denseVectorDimensions: undefined,
          denseEmbeddingProvider: undefined,
          denseEmbeddedAt: undefined,
          denseEmbeddingStatus: undefined,
        })),
      });
    });
    setSocDenseEmbeddingSettings({ vectorizedChunkCount: 0, vectorDimension: undefined, lastIndexedAt: undefined, failedChunkCount: 0, status: 'not_configured', error: undefined });
    setDenseQueryVector(undefined);
    void invoke('save_soc_dense_index', {
      filePath: SOC_DENSE_INDEX_PATH,
      payload: { model_path: '', dimension: 0, updated_at: nowSeconds(), vectors: {} },
    }).catch(() => undefined);
    setNotice('Dense vector index cleared. Keyword retrieval and Hybrid lexical RAG indexes remain available.');
  };

  const ocrPdfResource = async (resource: SocKnowledgeResource) => {
    setError(null);
    setNotice(null);
    const path = normalizeSocPath(resource.filePath);
    if (socFileExtension(path) !== 'pdf') {
      setError('OCR is only available for PDF resources.');
      return;
    }
    if (!pathAllowed(path)) {
      setError('PDF OCR path must be under configured NexusAI data roots.');
      return;
    }

    setOcrBusyIds(prev => [...new Set([...prev, resource.id])]);
    try {
      setNotice('Running offline PDF OCR. Large scanned documents may take several minutes...');
      const result = await invoke<SocPdfOcrResult>('ocr_soc_pdf', {
        pdfPath: path,
        outputMarkdown: null,
        maxPages: null,
        dpi: 200,
      });
      const mdPath = normalizeSocPath(result.output_markdown);
      const updated: SocKnowledgeResource = {
        ...resource,
        filePath: mdPath,
        title: `${resource.title} (OCR text)`,
        notes: [resource.notes, `OCR extracted locally from ${path}. Pages: ${result.pages_processed}, OCR pages: ${result.ocr_pages}.`].filter(Boolean).join(' '),
        updatedAt: nowSeconds(),
        indexStatus: 'not_indexed',
        indexedChunkCount: 0,
        indexedCharCount: 0,
        indexedChunks: [],
        extractionWarnings: result.warnings,
      };
      updateSocKnowledgeResource(resource.id, updated);
      await indexResource(updated);
      setNotice(`PDF OCR complete: ${result.pages_processed} page(s), ${compactSocNumber(result.char_count)} characters saved to ${mdPath}.`);
    } catch (err) {
      setError(`PDF OCR failed: ${humanError(err)}. Install Python 3 and run: pip install pymupdf pillow winsdk`);
    } finally {
      setOcrBusyIds(prev => prev.filter(id => id !== resource.id));
    }
  };

  const indexResource = async (resource: SocKnowledgeResource) => {
    setError(null);
    setNotice(null);
    const path = normalizeSocPath(resource.filePath);

    if (!pathAllowed(path)) {
      setError(`Cannot index ${resource.title}. Path must be under configured NexusAI data roots.`);
      return;
    }

    if (!isSocIndexableTextPath(path)) {
      const ext = socFileExtension(path) || 'unknown';
      updateSocKnowledgeResource(resource.id, {
        indexStatus: 'error',
        extractionWarnings: [`Basic retrieval indexes safe text files only. .${ext} is registered as metadata but is not text-indexed yet.`],
        indexedAt: nowSeconds(),
        indexedCharCount: 0,
        indexedChunkCount: 0,
        indexedChunks: [],
      });
      setError(`Basic retrieval indexes safe text files only. Supported: ${SOC_INDEXABLE_EXTENSIONS.join(', ')}. This ${ext.toUpperCase()} file remains usable as metadata.`);
      return;
    }

    setIndexingIds(prev => [...new Set([...prev, resource.id])]);
    try {
      const processed = await invoke<AttachmentContext[]>('process_attachments', {
        paths: [path],
        maxCharsPerFile: SOC_MAX_INDEX_CHARS_PER_FILE,
        maxTotalChars: SOC_MAX_INDEX_CHARS_PER_FILE,
      });
      const attachment = processed[0];
      if (!attachment) throw new Error('No extracted attachment context was returned.');

      const chunks = attachmentToSocChunks(resource, attachment);
      const warnings = attachment.warnings || [];
      updateSocKnowledgeResource(resource.id, {
        filePath: attachment.path || path,
        indexStatus: warnings.length ? 'warning' : 'indexed',
        indexedAt: nowSeconds(),
        indexedKind: attachment.kind,
        indexedCharCount: attachment.indexed_chars || attachment.text?.length || 0,
        indexedChunkCount: chunks.length,
        extractionWarnings: warnings,
        indexedChunks: chunks,
      });
      setNotice(`Indexed ${resource.title} locally: ${chunks.length} chunk(s), ${compactSocNumber(attachment.indexed_chars || 0)} characters. Hybrid lexical RAG is available. Build Dense Index for Selected to generate real local dense vectors with a configured GGUF embedding model.`);
    } catch (err) {
      updateSocKnowledgeResource(resource.id, {
        indexStatus: 'error',
        indexedAt: nowSeconds(),
        indexedCharCount: 0,
        indexedChunkCount: 0,
        extractionWarnings: [humanError(err)],
        indexedChunks: [],
      });
      setError(`Indexing failed for ${resource.title}: ${humanError(err)}`);
    } finally {
      setIndexingIds(prev => prev.filter(id => id !== resource.id));
    }
  };

  const indexSelectedResources = async () => {
    if (!selectedResources.length) {
      setError('Select at least one registered resource first.');
      return;
    }
    for (const resource of selectedResources) {
      // Sequential indexing keeps the UI predictable and avoids large memory bursts.
      // eslint-disable-next-line no-await-in-loop
      await indexResource(resource);
    }
  };

  const buildSelectedContextText = () => {
    const resourceText = selectedResources.length
      ? selectedResources.map((resource, index) => `# Resource ${index + 1}\n${resourceToContextLine(resource)}`).join('\n\n---\n\n')
      : '';
    const snippetText = selectedRetrievedChunks.length
      ? `# RAG retrieved snippets\n${buildSocRetrievedSnippetContext(selectedRetrievedChunks)}`
      : '';
    return [resourceText, snippetText].filter(Boolean).join('\n\n===\n\n');
  };

  const selectedContextText = buildSelectedContextText();

  const copySelectedContext = async () => {
    if (!selectedResources.length && !selectedRetrievedChunks.length) {
      setError('Select at least one knowledge resource or retrieved snippet first.');
      return;
    }
    await navigator.clipboard.writeText(selectedContextText);
    setCopied(true);
    setNotice('Selected SOC knowledge metadata/snippet context copied.');
    setTimeout(() => setCopied(false), 1600);
  };

  const useResultsInSocPrompt = () => {
    if (!retrievalResults.length) {
      setError('Run a retrieval query first. Matching indexed chunks will appear here.');
      return;
    }
    const topIds = retrievalResults.slice(0, topK).map(result => result.chunk.id);
    setSelectedSocKnowledgeChunkIds(topIds);
    setNotice(`Selected top ${topIds.length} ${SOC_RAG_RETRIEVAL_MODE_LABELS[retrievalMode]} result(s). They will be appended to generated SOC prompts above.`);
  };

  const sendSelectedContextToChat = (handoffMode: 'compact' | 'full') => {
    if (!selectedResources.length && !selectedRetrievedChunks.length) {
      setError('Select at least one knowledge resource or retrieved snippet first.');
      return;
    }

    if (handoffMode === 'full') {
      setPendingChatPrompt([
        SOC_SYSTEM_PROMPT,
        'Review the full selected knowledge context below. Preserve source references, call out assumptions, and keep response actions behind human approval.',
        'Retrieval status: current mode is ' + SOC_RAG_RETRIEVAL_MODE_LABELS[retrievalMode] + '. Dense vector retrieval is only active when a local embedding provider is configured and dense vectors have been generated.',
        '',
        'FULL SELECTED CONTEXT:',
        selectedContextText || 'No full context was generated.',
        '',
        'TASK: Explain how this context supports the current SOC task, identify missing evidence, and propose the next analyst-approved steps.',
      ].join('\n'), { soc: true, autoSend: true });
      setActiveView('chat');
      setNotice('Full selected knowledge context sent to Chat for generation.');
      return;
    }

    const resourceSummary = selectedResources.slice(0, 8).map((resource, index) => [
      `Resource ${index + 1}: ${resource.title}`,
      `Category/Product/Version: ${resource.category} / ${resource.product} / ${resource.version || 'not specified'}`,
      `Tags: ${resource.tags.join(', ') || 'none'}`,
      `Index status: ${resource.indexStatus || 'not_indexed'}, chunks: ${resource.indexedChunkCount || 0}`,
    ].join('\n')).join('\n\n');

    const snippetSummary = selectedRetrievedChunks.slice(0, 5).map((chunk, index) => [
      `Snippet ${index + 1}: ${chunk.resourceTitle} / ${chunk.title}`,
      `Source: ${chunk.filePath}`,
      `Top terms: ${(chunk.topTerms || []).join(', ') || 'not available'}`,
      compactForChat(chunk.text, 1100),
    ].join('\n')).join('\n\n');

    setPendingChatPrompt([
      SOC_SYSTEM_PROMPT,
      'Use the compact offline knowledge summary below to plan the next investigation, detection engineering, parser, playbook, or connector task.',
      `Retrieval mode: ${SOC_RAG_RETRIEVAL_MODE_LABELS[retrievalMode]}. No live FortiSIEM/FortiSOAR integration or cloud retrieval is used.`,
      '',
      'SELECTED METADATA SUMMARY:',
      resourceSummary || 'No metadata references selected.',
      '',
      'SELECTED RAG SNIPPET SUMMARY:',
      snippetSummary || 'No retrieved snippets selected.',
      '',
      'TASK: Explain what the selected resources/snippets support, what Fortinet SOC task they help with, and what additional evidence is needed before production use.',
    ].join('\n'), { soc: true, autoSend: true });
    setActiveView('chat');
    setNotice('Compact knowledge summary sent to Chat for generation. Use Full Context to Chat for the complete selected context.');
  };

  const embedDenseQuery = async (silent = false) => {
    if (!silent) {
      setError(null);
      setNotice(null);
    }
    const modelPath = normalizeSocPath(socDenseEmbeddingSettings.modelPath || '');
    if (!denseModeSelected) {
      if (!silent) setNotice('Dense query embedding is only needed for Dense vector RAG or Hybrid dense RAG modes.');
      return;
    }
    if (!retrievalQuery.trim()) {
      if (!silent) setError('Type a retrieval query before generating a dense query vector.');
      return;
    }
    if (!ragHealthStats.denseAvailable || !modelPath) {
      if (!silent) setError('Dense retrieval is not ready. Build dense vectors with a local embedding GGUF model first.');
      return;
    }

    setDenseSearchBusy(true);
    try {
      const result = await invoke<SocDenseEmbeddingBuildResult>('embed_soc_dense_texts', {
        request: {
          model_path: modelPath,
          texts: [{ chunk_id: 'query', text: retrievalQuery }],
          context_size: SOC_DENSE_EMBED_CONTEXT_SIZE,
          batch_size: SOC_DENSE_EMBED_BATCH_SIZE,
        },
      });
      const queryVector = result.vectors[0]?.vector;
      if (!queryVector?.length) throw new Error('Local embedding provider returned no query vector.');
      setDenseQueryVector(queryVector);
      setSocDenseEmbeddingSettings({
        providerName: result.provider_name,
        runtimePath: normalizeSocPath(result.runtime_path),
        modelFormat: result.model_format,
        status: 'ready',
        vectorDimension: result.dimension,
        error: undefined,
      });
      if (!silent) {
        setNotice('Dense query vector generated locally. Dense retrieval results are now ranked by semantic similarity.');
      }
    } catch (err) {
      setDenseQueryVector(undefined);
      setSocDenseEmbeddingSettings({ status: 'failed', error: humanError(err) });
      if (!silent) setError(`Dense query embedding failed: ${humanError(err)}`);
    } finally {
      setDenseSearchBusy(false);
    }
  };

  const runDenseQueryEmbedding = async () => {
    await embedDenseQuery(false);
  };

  useEffect(() => {
    if (!denseModeSelected || !retrievalQuery.trim() || !ragHealthStats.denseAvailable) {
      setDenseQueryVector(undefined);
      return undefined;
    }

    const timer = window.setTimeout(() => {
      void embedDenseQuery(true);
    }, 700);

    return () => window.clearTimeout(timer);
  }, [
    retrievalQuery,
    retrievalMode,
    denseModeSelected,
    ragHealthStats.denseAvailable,
    socDenseEmbeddingSettings.modelPath,
    socDenseEmbeddingSettings.vectorizedChunkCount,
  ]);

  const chooseBulkFolder = async () => {
    setError(null);
    setNotice(null);
    try {
      const selected = await open({ multiple: false, directory: true, defaultPath: dialogDefaultPath(deploymentConfig, 'soc') || undefined });
      if (!selected || Array.isArray(selected)) return;
      const normalized = normalizeSocPath(selected);
      if (!bulkPathAllowed(normalized)) {
        setError('Bulk import path must be under configured NexusAI data roots.');
        return;
      }
      setBulkFolderPath(normalized);
      setNotice('Bulk folder selected. Click Scan Folder to preview supported offline knowledge files before registering them.');
    } catch (err) {
      setError(`Folder picker failed: ${humanError(err)}`);
    }
  };

  const scanBulkFolder = async () => {
    const folderPath = normalizeSocPath(bulkFolderPath);
    setError(null);
    setNotice(null);
    setBulkScan(null);
    setBulkSkippedDuplicates(0);

    if (!folderPath) {
      setError(`Paste or choose a company data folder before scanning. Example: ${pathPlaceholder(deploymentConfig, 'soc')}`);
      return;
    }
    if (!bulkPathAllowed(folderPath)) {
      setError('Bulk import path must be under configured NexusAI data roots.');
      return;
    }

    setBulkBusy(true);
    try {
      const result = await invoke<SocKnowledgeScanResult>('scan_soc_knowledge_folder', {
        folderPath,
        maxFiles: 1500,
      });
      setBulkScan(result);
      setNotice(`Scanned ${result.scanned_files} file(s): ${result.supported_files} supported for bulk registration, ${result.unsupported_files} unsupported/metadata-only candidate(s).`);
    } catch (err) {
      setError(`Bulk scan failed: ${humanError(err)}`);
    } finally {
      setBulkBusy(false);
    }
  };

  const registerBulkSupportedFiles = () => {
    if (!bulkScan) {
      setError('Scan a company data folder first, then register the supported files.');
      return;
    }

    const existingPaths = new Set(socKnowledgeResources.map(resource => normalizeSocPath(resource.filePath).toLowerCase()));
    const scanSeen = new Set<string>();
    const timestamp = nowSeconds();
    const newResources: SocKnowledgeResource[] = [];
    let skipped = 0;

    bulkScan.files.filter(file => file.supported).forEach((file, index) => {
      const filePath = normalizeSocPath(file.path);
      const key = filePath.toLowerCase();
      if (existingPaths.has(key) || scanSeen.has(key)) {
        skipped += 1;
        return;
      }
      scanSeen.add(key);
      const metadata = inferResourceMetadata(filePath);
      newResources.push({
        id: `soc-kb-bulk-${timestamp}-${index}-${Math.random().toString(36).slice(2, 8)}`,
        title: metadata.title,
        category: metadata.category,
        product: metadata.product,
        version: metadata.version,
        tags: tagList(metadata.tags),
        filePath,
        notes: metadata.notes,
        createdAt: timestamp,
        updatedAt: timestamp,
        indexStatus: 'not_indexed',
        indexedChunkCount: 0,
        indexedCharCount: 0,
        extractionWarnings: [],
        indexedChunks: [],
      });
    });

    newResources.forEach(resource => addSocKnowledgeResource(resource));
    setSelectedSocKnowledgeResourceIds([...new Set([...selectedSocKnowledgeResourceIds, ...newResources.map(resource => resource.id)])]);
    setBulkSkippedDuplicates(skipped);
    setNotice(`Bulk registered ${newResources.length} supported file(s). Skipped ${skipped} duplicate(s). Select Index Selected when ready to build local keyword chunks.`);
  };
  return (
    <section className="panel-shell p-4 sm:p-6 space-y-6">
      <div className="inline-flex items-center gap-2 rounded-full border border-emerald-200/80 dark:border-emerald-800/70 bg-emerald-50/85 dark:bg-emerald-950/30 px-3 py-1 text-xs font-bold uppercase tracking-[0.18em] text-emerald-700 dark:text-emerald-300">
        <BookOpen className="w-4 h-4" /> Knowledge Base
      </div>
      <h2 className="text-xl font-black text-surface-950 dark:text-white">Registered Resources</h2>

      <div className="grid md:grid-cols-3 gap-3">
        <div className="rounded-2xl border border-white/70 dark:border-surface-800 bg-surface-50/85 dark:bg-surface-950/55 p-4">
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-surface-500">Registered</p>
          <p className="mt-1 text-2xl font-black text-surface-950 dark:text-white">{socKnowledgeResources.length}</p>
          <p className="text-xs text-surface-500 dark:text-surface-400">metadata records</p>
        </div>
        <div className="rounded-2xl border border-white/70 dark:border-surface-800 bg-surface-50/85 dark:bg-surface-950/55 p-4">
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-surface-500">Indexed</p>
          <p className="mt-1 text-2xl font-black text-surface-950 dark:text-white">{indexedCount}</p>
          <p className="text-xs text-surface-500 dark:text-surface-400">safe text resources</p>
        </div>
        <div className="rounded-2xl border border-white/70 dark:border-surface-800 bg-surface-50/85 dark:bg-surface-950/55 p-4">
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-surface-500">Chunks</p>
          <p className="mt-1 text-2xl font-black text-surface-950 dark:text-white">{totalChunkCount}</p>
          <p className="text-xs text-surface-500 dark:text-surface-400">RAG-ready local sections</p>
        </div>
      </div>

      <div className="grid md:grid-cols-5 gap-3">
        <div className="rounded-2xl border border-sky-200/70 dark:border-sky-900/70 bg-sky-50/75 dark:bg-sky-950/20 p-4">
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-sky-700 dark:text-sky-300">Retrieval Mode</p>
          <p className="mt-1 text-sm font-black text-surface-950 dark:text-white">{SOC_RAG_RETRIEVAL_MODE_LABELS[retrievalMode]}</p>
        </div>
        <div className="rounded-2xl border border-white/70 dark:border-surface-800 bg-surface-50/85 dark:bg-surface-950/55 p-4">
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-surface-500">Vectorized</p>
          <p className="mt-1 text-2xl font-black text-surface-950 dark:text-white">{ragHealthStats.vectorizedChunks}</p>
          <p className="text-xs text-surface-500 dark:text-surface-400">lexical-vector chunks</p>
        </div>
        <div className="rounded-2xl border border-white/70 dark:border-surface-800 bg-surface-50/85 dark:bg-surface-950/55 p-4">
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-surface-500">Keyword-indexed</p>
          <p className="mt-1 text-2xl font-black text-surface-950 dark:text-white">{ragHealthStats.keywordIndexedChunks}</p>
          <p className="text-xs text-surface-500 dark:text-surface-400">fallback chunks</p>
        </div>
        <div className="rounded-2xl border border-white/70 dark:border-surface-800 bg-surface-50/85 dark:bg-surface-950/55 p-4">
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-surface-500">Stale</p>
          <p className="mt-1 text-2xl font-black text-surface-950 dark:text-white">{ragHealthStats.staleChunks}</p>
          <p className="text-xs text-surface-500 dark:text-surface-400">legacy chunks</p>
        </div>
        <div className="rounded-2xl border border-amber-200/70 dark:border-amber-900/70 bg-amber-50/75 dark:bg-amber-950/20 p-4">
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-amber-700 dark:text-amber-300">Dense RAG</p>
          <p className="mt-1 text-sm font-black text-surface-950 dark:text-white">{ragHealthStats.denseAvailable ? 'Available' : ragHealthStats.denseVectorChunks > 0 ? 'Partial' : 'Not active'}</p>
          <p className="text-xs text-surface-500 dark:text-surface-400">{ragHealthStats.denseVectorChunks} / {ragHealthStats.totalChunks} chunks</p>
        </div>
      </div>

      <div className="rounded-2xl border border-indigo-200/70 dark:border-indigo-900/70 bg-indigo-50/75 dark:bg-indigo-950/20 px-4 py-3 text-sm leading-6 text-indigo-800 dark:text-indigo-300">
        {ragHealthStats.embeddingStatus} No cloud retrieval or external API is used. Next action: {ragHealthStats.nextRecommendedAction}
      </div>

      <div className="rounded-2xl border border-white/70 dark:border-surface-800 bg-surface-50/85 dark:bg-surface-950/55 p-4 space-y-4">
        <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-3">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.16em] text-surface-500">Dense Embedding Provider</p>
            <h3 className="font-black text-surface-950 dark:text-white">Dense Embedding Provider</h3>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 min-w-[18rem]">
            <div className="rounded-xl border border-white/70 dark:border-surface-800 bg-white/70 dark:bg-surface-900/45 p-3">
              <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-surface-500">Mode</p>
              <p className="mt-1 text-xs font-black text-surface-950 dark:text-white">{SOC_DENSE_PROVIDER_MODE_LABELS[socDenseEmbeddingSettings.providerMode]}</p>
            </div>
            <div className="rounded-xl border border-white/70 dark:border-surface-800 bg-white/70 dark:bg-surface-900/45 p-3">
              <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-surface-500">Status</p>
              <p className="mt-1 text-xs font-black text-surface-950 dark:text-white">{denseStatusLabel}</p>
            </div>
            <div className="rounded-xl border border-white/70 dark:border-surface-800 bg-white/70 dark:bg-surface-900/45 p-3">
              <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-surface-500">Dense vectors</p>
              <p className="mt-1 text-xs font-black text-surface-950 dark:text-white">{ragHealthStats.denseVectorChunks}</p>
            </div>
            <div className="rounded-xl border border-white/70 dark:border-surface-800 bg-white/70 dark:bg-surface-900/45 p-3">
              <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-surface-500">Dimension</p>
              <p className="mt-1 text-xs font-black text-surface-950 dark:text-white">{socDenseEmbeddingSettings.vectorDimension || 'N/A'}</p>
            </div>
          </div>
        </div>

        <div className="grid lg:grid-cols-[16rem_minmax(0,1fr)] gap-2">
          <select value={socDenseEmbeddingSettings.providerMode} onChange={e => updateDenseProviderMode(e.target.value as SocDenseEmbeddingProviderMode)} className="input-field">
            <option value="disabled">Disabled</option>
            <option value="hybrid_lexical_only">Hybrid lexical only</option>
            <option value="local_dense">Local dense embeddings</option>
          </select>
          <input
            value={socDenseEmbeddingSettings.modelPath}
            onChange={e => setSocDenseEmbeddingSettings({ modelPath: normalizeSocPath(e.target.value), status: 'not_configured', error: undefined })}
            className="input-field font-mono text-xs"
            placeholder={embeddingModelPlaceholder(deploymentConfig)}
          />
        </div>

        <div className="flex flex-col sm:flex-row flex-wrap gap-2">
          <button type="button" onClick={buildDenseIndexForAllIndexed} disabled={denseBusy} className="btn-primary flex items-center justify-center gap-2">
            {denseBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />} {denseBusy ? 'Building Dense Index...' : 'Build Dense Index (All Indexed)'}
          </button>
          <button type="button" onClick={validateDenseProviderSettings} disabled={denseBusy} className="btn-secondary flex items-center justify-center gap-2">
            {denseBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <ShieldCheck className="w-4 h-4" />} Validate Provider
          </button>
          <button type="button" onClick={buildDenseIndexForSelected} disabled={denseBusy} className="btn-secondary flex items-center justify-center gap-2">
            {denseBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />} Build Selected Only
          </button>
          <button type="button" onClick={clearDenseIndexOnly} className="btn-secondary flex items-center justify-center gap-2 text-red-600 dark:text-red-300">
            <Trash2 className="w-4 h-4" /> Clear Dense Index Only
          </button>
        </div>

        <div className="rounded-2xl border border-amber-200/70 dark:border-amber-900/70 bg-amber-50/75 dark:bg-amber-950/20 px-4 py-3 text-xs leading-5 text-amber-800 dark:text-amber-300">
Dense vectors are generated locally from indexed chunks when a local GGUF embedding model is configured under your deployment paths.
          {socDenseEmbeddingSettings.runtimePath ? <span className="block mt-1 font-mono break-all">Runtime: {socDenseEmbeddingSettings.runtimePath}</span> : null}
          {socDenseEmbeddingSettings.modelFormat ? <span className="block mt-1">Model format: {socDenseEmbeddingSettings.modelFormat}</span> : null}
          {socDenseEmbeddingSettings.lastIndexedAt ? <span className="block mt-1">Last dense index: {readableDate(socDenseEmbeddingSettings.lastIndexedAt)}</span> : null}
          {socDenseEmbeddingSettings.error ? <span className="block mt-1 font-bold">Status detail: {socDenseEmbeddingSettings.error}</span> : null}
        </div>
      </div>



      <div className="grid xl:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)] gap-5">
        <div className="rounded-2xl border border-white/70 dark:border-surface-800 bg-surface-50/85 dark:bg-surface-950/55 p-4 space-y-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-xs font-bold uppercase tracking-[0.16em] text-surface-500">Knowledge Pack Health</p>
              <h3 className="font-black text-surface-950 dark:text-white">Import/index readiness</h3>
              <p className="mt-1 text-xs leading-5 text-surface-500 dark:text-surface-400">
                Shows what is registered, indexed, unindexed, metadata-only, and failed before a company data pack arrives.
              </p>
            </div>
            <BarChart3 className="w-5 h-5 text-sky-500 shrink-0" />
          </div>

          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <div className="rounded-2xl border border-white/70 dark:border-surface-800 bg-white/70 dark:bg-surface-900/45 p-3">
              <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-surface-500">Unindexed</p>
              <p className="mt-1 text-xl font-black text-surface-950 dark:text-white">{healthStats.unindexed}</p>
            </div>
            <div className="rounded-2xl border border-white/70 dark:border-surface-800 bg-white/70 dark:bg-surface-900/45 p-3">
              <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-surface-500">Failed</p>
              <p className="mt-1 text-xl font-black text-surface-950 dark:text-white">{healthStats.failed}</p>
            </div>
            <div className="rounded-2xl border border-white/70 dark:border-surface-800 bg-white/70 dark:bg-surface-900/45 p-3">
              <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-surface-500">Metadata only</p>
              <p className="mt-1 text-xl font-black text-surface-950 dark:text-white">{healthStats.metadataOnly}</p>
            </div>
            <div className="rounded-2xl border border-white/70 dark:border-surface-800 bg-white/70 dark:bg-surface-900/45 p-3">
              <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-surface-500">Duplicate skips</p>
              <p className="mt-1 text-xl font-black text-surface-950 dark:text-white">{bulkSkippedDuplicates}</p>
            </div>
          </div>

          <div className="grid md:grid-cols-3 gap-3">
            <div className="rounded-2xl border border-white/70 dark:border-surface-800 bg-white/70 dark:bg-surface-900/45 p-3">
              <p className="mb-2 text-xs font-bold uppercase tracking-[0.14em] text-surface-500">Products</p>
              <BreakdownList items={healthStats.productBreakdown} />
            </div>
            <div className="rounded-2xl border border-white/70 dark:border-surface-800 bg-white/70 dark:bg-surface-900/45 p-3">
              <p className="mb-2 text-xs font-bold uppercase tracking-[0.14em] text-surface-500">Versions</p>
              <BreakdownList items={healthStats.versionBreakdown} />
            </div>
            <div className="rounded-2xl border border-white/70 dark:border-surface-800 bg-white/70 dark:bg-surface-900/45 p-3">
              <p className="mb-2 text-xs font-bold uppercase tracking-[0.14em] text-surface-500">Categories</p>
              <BreakdownList items={healthStats.categoryBreakdown} />
            </div>
          </div>

          <div className="rounded-2xl border border-sky-200/70 dark:border-sky-900/70 bg-sky-50/75 dark:bg-sky-950/20 px-4 py-3 text-xs leading-5 text-sky-800 dark:text-sky-300">
            Compact mode is faster. Full mode sends the complete selected context/report when deeper local model review is needed.
          </div>

          <SocExportButton
            label="Export Knowledge Pack Summary"
            defaultFileName="nexus-soc-knowledge-pack-summary.md"
            contents={knowledgePackSummary}
            kind="md"
            disabled={!socKnowledgeResources.length}
            onStatus={(message) => setNotice(message)}
          />
          <SocExportButton
            label="Export RAG Index Summary"
            defaultFileName="nexus-soc-rag-index-summary.md"
            contents={ragIndexSummary}
            kind="md"
            disabled={!socKnowledgeResources.length}
            onStatus={(message) => setNotice(message)}
          />
        </div>

        <div className="rounded-2xl border border-white/70 dark:border-surface-800 bg-surface-50/85 dark:bg-surface-950/55 p-4 space-y-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-xs font-bold uppercase tracking-[0.16em] text-surface-500">Bulk Knowledge Import</p>
              <h3 className="font-black text-surface-950 dark:text-white">Scan a company data folder</h3>
              <p className="mt-1 text-xs leading-5 text-surface-500 dark:text-surface-400">
                Register supported offline text resources in one batch. Indexing remains explicit and local.
              </p>
            </div>
            <FolderPlus className="w-5 h-5 text-emerald-500 shrink-0" />
          </div>

          <label className="block">
            <span className="text-xs font-bold uppercase tracking-[0.14em] text-surface-500">Folder path</span>
            <div className="mt-1 flex flex-col sm:flex-row gap-2">
              <input value={bulkFolderPath} onChange={e => setBulkFolderPath(e.target.value)} className="input-field flex-1 font-mono text-xs" placeholder={pathPlaceholder(deploymentConfig, 'soc')} />
              <button type="button" onClick={chooseBulkFolder} className="btn-secondary flex items-center justify-center gap-2">
                <FolderOpen className="w-4 h-4" /> Choose
              </button>
            </div>
          </label>

          <div className="grid sm:grid-cols-2 gap-2">
            <button type="button" onClick={scanBulkFolder} disabled={bulkBusy} className="btn-secondary flex items-center justify-center gap-2">
              {bulkBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
              {bulkBusy ? 'Scanning' : 'Scan Folder'}
            </button>
            <button type="button" onClick={registerBulkSupportedFiles} disabled={!bulkScan || bulkBusy || bulkScan.supported_files === 0} className="btn-primary flex items-center justify-center gap-2">
              <PackageCheck className="w-4 h-4" /> Register Supported
            </button>
          </div>

          {bulkScan ? (
            <div className="space-y-3">
              <div className="grid sm:grid-cols-3 gap-2">
                <div className="rounded-xl border border-white/70 dark:border-surface-800 bg-white/70 dark:bg-surface-900/45 p-3 text-center">
                  <p className="text-lg font-black text-surface-950 dark:text-white">{bulkScan.scanned_files}</p>
                  <p className="text-[11px] text-surface-500 dark:text-surface-400">scanned</p>
                </div>
                <div className="rounded-xl border border-white/70 dark:border-surface-800 bg-white/70 dark:bg-surface-900/45 p-3 text-center">
                  <p className="text-lg font-black text-emerald-700 dark:text-emerald-300">{bulkScan.supported_files}</p>
                  <p className="text-[11px] text-surface-500 dark:text-surface-400">supported</p>
                </div>
                <div className="rounded-xl border border-white/70 dark:border-surface-800 bg-white/70 dark:bg-surface-900/45 p-3 text-center">
                  <p className="text-lg font-black text-amber-700 dark:text-amber-300">{bulkScan.unsupported_files}</p>
                  <p className="text-[11px] text-surface-500 dark:text-surface-400">unsupported</p>
                </div>
              </div>
              {bulkScan.truncated && (
                <div className="rounded-xl border border-amber-200/80 dark:border-amber-900/70 bg-amber-50/80 dark:bg-amber-950/25 px-3 py-2 text-xs leading-5 text-amber-800 dark:text-amber-300">
                  Scan was limited to the first 1,500 files for UI safety. Narrow the folder if needed.
                </div>
              )}
              <div className="max-h-56 overflow-y-auto space-y-2 pr-1">
                {bulkScan.files.slice(0, 18).map(file => (
                  <div key={file.path} className="rounded-xl border border-white/70 dark:border-surface-800 bg-white/70 dark:bg-surface-900/45 p-3">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-xs font-bold text-surface-800 dark:text-surface-200 truncate">{file.name}</p>
                      <span className={`rounded-full px-2 py-1 text-[10px] font-bold ${file.supported ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300' : 'bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-300'}`}>
                        {file.supported ? 'supported' : 'metadata-only'}
                      </span>
                    </div>
                    <p className="mt-1 text-[11px] font-mono text-surface-400 break-all">{file.path}</p>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="rounded-2xl border border-dashed border-surface-300 dark:border-surface-700 p-5 text-center text-sm text-surface-500 dark:text-surface-400">
              No bulk scan yet. Choose or paste a company data folder, then scan before registering files.
            </div>
          )}
        </div>
      </div>
      <div className="grid xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] gap-6">
        <div className="rounded-2xl border border-white/70 dark:border-surface-800 bg-surface-50/85 dark:bg-surface-950/55 p-4 space-y-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-xs font-bold uppercase tracking-[0.16em] text-surface-500">Register Resource</p>
              <h3 className="font-black text-surface-950 dark:text-white">Knowledge item</h3>
            </div>
            <Database className="w-5 h-5 text-surface-400" />
          </div>

          <div className="grid sm:grid-cols-2 gap-3">
            <label className="block sm:col-span-2">
              <span className="text-xs font-bold uppercase tracking-[0.14em] text-surface-500">Title</span>
              <input value={form.title} onChange={e => updateForm('title', e.target.value)} className="input-field mt-1" placeholder="FortiSIEM parser guide, VPN brute force rule, phishing SOP..." />
            </label>

            <label className="block">
              <span className="text-xs font-bold uppercase tracking-[0.14em] text-surface-500">Category</span>
              <select value={form.category} onChange={e => updateForm('category', e.target.value as SocKnowledgeCategory)} className="input-field mt-1">
                {CATEGORY_OPTIONS.map(category => <option key={category} value={category}>{category}</option>)}
              </select>
            </label>

            <label className="block">
              <span className="text-xs font-bold uppercase tracking-[0.14em] text-surface-500">Product</span>
              <select value={form.product} onChange={e => updateForm('product', e.target.value as SocKnowledgeProduct)} className="input-field mt-1">
                {PRODUCT_OPTIONS.map(product => <option key={product} value={product}>{product}</option>)}
              </select>
            </label>

            <label className="block">
              <span className="text-xs font-bold uppercase tracking-[0.14em] text-surface-500">Version</span>
              <input value={form.version} onChange={e => updateForm('version', e.target.value)} className="input-field mt-1" placeholder="7.5, 7.6.5, internal-v1..." />
            </label>

            <label className="block">
              <span className="text-xs font-bold uppercase tracking-[0.14em] text-surface-500">Tags</span>
              <input value={form.tags} onChange={e => updateForm('tags', e.target.value)} className="input-field mt-1" placeholder="vpn, brute-force, parser, phishing" />
            </label>

            <label className="block sm:col-span-2">
              <span className="text-xs font-bold uppercase tracking-[0.14em] text-surface-500">File path</span>
              <div className="mt-1 flex flex-col sm:flex-row gap-2">
                <input value={form.filePath} onChange={e => updateForm('filePath', e.target.value)} className="input-field flex-1 font-mono text-xs" placeholder={joinPath(pathPlaceholder(deploymentConfig, 'soc'), 'rules', 'example.xml')} />
                <button type="button" onClick={chooseFile} className="btn-secondary flex items-center justify-center gap-2">
                  <FolderOpen className="w-4 h-4" /> Choose
                </button>
              </div>
            </label>

            <label className="block sm:col-span-2">
              <span className="text-xs font-bold uppercase tracking-[0.14em] text-surface-500">Notes</span>
              <textarea value={form.notes} onChange={e => updateForm('notes', e.target.value)} rows={4} className="input-field mt-1" placeholder="What this document/export contains, when to use it, source reliability, import caveats..." />
            </label>
          </div>

          {error && (
            <div className="rounded-2xl border border-red-200/80 dark:border-red-900/70 bg-red-50/90 dark:bg-red-950/25 px-4 py-3 text-sm text-red-700 dark:text-red-300">
              {error}
            </div>
          )}
          {notice && (
            <div className="rounded-2xl border border-sky-200/80 dark:border-sky-900/70 bg-sky-50/90 dark:bg-sky-950/25 px-4 py-3 text-sm text-sky-700 dark:text-sky-300">
              {notice}
            </div>
          )}

          <button type="button" onClick={registerResource} className="btn-primary w-full flex items-center justify-center gap-2">
            <Plus className="w-4 h-4" /> Register Offline Resource
          </button>
        </div>

        <div className="rounded-2xl border border-white/70 dark:border-surface-800 bg-surface-50/85 dark:bg-surface-950/55 p-4 space-y-4">
          <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
            <div>
              <p className="text-xs font-bold uppercase tracking-[0.16em] text-surface-500">Library Search</p>
              <h3 className="font-black text-surface-950 dark:text-white">Metadata records</h3>
            </div>
            <div className="flex flex-col sm:flex-row gap-2">
              <button type="button" onClick={indexSelectedResources} disabled={!selectedResources.length || indexingIds.length > 0} className="btn-secondary flex items-center justify-center gap-2 text-sm">
                {indexingIds.length ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                Index Selected
              </button>
              <button type="button" onClick={clearSelection} className="btn-secondary flex items-center justify-center gap-2 text-sm">
                <X className="w-4 h-4" /> Clear Context
              </button>
            </div>
          </div>

          <div className="grid sm:grid-cols-[minmax(0,1fr)_11rem_10rem] gap-2">
            <label className="relative block">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-surface-400" />
              <input value={query} onChange={e => setQuery(e.target.value)} className="input-field pl-10" placeholder="Search metadata, tags, notes, paths, warnings..." />
            </label>
            <select value={categoryFilter} onChange={e => setCategoryFilter(e.target.value as 'all' | SocKnowledgeCategory)} className="input-field">
              <option value="all">All categories</option>
              {CATEGORY_OPTIONS.map(category => <option key={category} value={category}>{category}</option>)}
            </select>
            <select value={productFilter} onChange={e => setProductFilter(e.target.value as 'all' | SocKnowledgeProduct)} className="input-field">
              <option value="all">All products</option>
              {PRODUCT_OPTIONS.map(product => <option key={product} value={product}>{product}</option>)}
            </select>
          </div>

          <div className="max-h-[31rem] overflow-y-auto space-y-3 pr-1">
            {filteredResources.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-surface-300 dark:border-surface-700 p-6 text-center text-sm text-surface-500 dark:text-surface-400">
                No registered resource matches the current filters.
              </div>
            ) : filteredResources.map(resource => {
              const selected = selectedSocKnowledgeResourceIds.includes(resource.id);
              const indexing = indexingIds.includes(resource.id);
              const ocrBusy = ocrBusyIds.includes(resource.id);
              const isPdf = socFileExtension(resource.filePath) === 'pdf';
              const indexable = isSocIndexableTextPath(resource.filePath);
              const status = resource.indexStatus || 'not_indexed';
              return (
                <article key={resource.id} className={`rounded-2xl border p-4 transition-all ${selected ? 'border-sky-300 dark:border-sky-700 bg-sky-50/75 dark:bg-sky-950/25' : 'border-white/70 dark:border-surface-800 bg-white/70 dark:bg-surface-900/45'}`}>
                  <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h4 className="font-black text-surface-950 dark:text-white break-words">{resource.title}</h4>
                        <span className="rounded-full bg-white/80 dark:bg-surface-950/80 px-2 py-1 text-[11px] font-bold text-surface-600 dark:text-surface-300 border border-white/70 dark:border-surface-800">{resource.product}</span>
                        <span className="rounded-full bg-emerald-50 dark:bg-emerald-950/30 px-2 py-1 text-[11px] font-bold text-emerald-700 dark:text-emerald-300 border border-emerald-200/70 dark:border-emerald-900/70">{resource.category}</span>
                        <span className={`rounded-full px-2 py-1 text-[11px] font-bold border ${status === 'indexed' ? 'bg-green-50 text-green-700 border-green-200 dark:bg-green-950/25 dark:text-green-300 dark:border-green-900/70' : status === 'warning' ? 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/25 dark:text-amber-300 dark:border-amber-900/70' : status === 'error' ? 'bg-red-50 text-red-700 border-red-200 dark:bg-red-950/25 dark:text-red-300 dark:border-red-900/70' : 'bg-surface-100 text-surface-600 border-surface-200 dark:bg-surface-800 dark:text-surface-300 dark:border-surface-700'}`}>{status}</span>
                      </div>
                      <p className="mt-2 text-xs font-mono text-surface-500 dark:text-surface-400 break-all">{resource.filePath}</p>
                      <p className="mt-2 text-sm leading-6 text-surface-600 dark:text-surface-300">{resource.notes || 'No notes yet.'}</p>
                      <div className="mt-3 flex flex-wrap gap-2 text-[11px] font-semibold text-surface-500 dark:text-surface-400">
                        <span>Version: {resource.version || 'not specified'}</span>
                        <span>•</span>
                        <span>Ext: {socFileExtension(resource.filePath) || 'unknown'}</span>
                        <span>•</span>
                        <span>Indexed: {readableDate(resource.indexedAt)}</span>
                        <span>•</span>
                        <span>{resource.indexedChunkCount || 0} chunks / {compactSocNumber(resource.indexedCharCount)} chars</span>
                      </div>
                      {resource.tags.length > 0 && (
                        <div className="mt-3 flex flex-wrap gap-1.5">
                          {resource.tags.map(tag => <span key={tag} className="rounded-full bg-surface-100 dark:bg-surface-800 px-2 py-1 text-[11px] font-semibold text-surface-600 dark:text-surface-300">#{tag}</span>)}
                        </div>
                      )}
                      {resource.extractionWarnings && resource.extractionWarnings.length > 0 && (
                        <div className="mt-3 rounded-xl border border-amber-200/70 dark:border-amber-900/70 bg-amber-50/80 dark:bg-amber-950/25 px-3 py-2 text-xs leading-5 text-amber-800 dark:text-amber-300">
                          {resource.extractionWarnings.slice(0, 2).join(' ')}
                        </div>
                      )}
                    </div>
                    <div className="flex lg:flex-col gap-2 shrink-0">
                      <button type="button" onClick={() => toggleSelectedSocKnowledgeResource(resource.id)} className="btn-secondary text-xs flex items-center justify-center gap-2">
                        {selected ? <CheckCircle2 className="w-4 h-4" /> : <Filter className="w-4 h-4" />}
                        {selected ? 'Selected' : 'Select'}
                      </button>
                      <button type="button" onClick={() => indexResource(resource)} disabled={indexing || ocrBusy || !indexable} className="btn-secondary text-xs flex items-center justify-center gap-2" title={indexable ? 'Index this resource locally (PDF text layer or OCR markdown)' : 'Unsupported for text indexing'}>
                        {indexing ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileSearch className="w-4 h-4" />}
                        {indexing ? 'Indexing' : 'Index'}
                      </button>
                      {isPdf && (
                        <button type="button" onClick={() => ocrPdfResource(resource)} disabled={ocrBusy || indexing} className="btn-secondary text-xs flex items-center justify-center gap-2" title="OCR scanned PDF to markdown for full knowledge-base indexing">
                          {ocrBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                          {ocrBusy ? 'OCR...' : 'OCR PDF'}
                        </button>
                      )}
                      {(resource.indexedChunks?.length || 0) > 0 && (
                        <button type="button" onClick={() => clearResourceIndex(resource)} className="btn-secondary text-xs flex items-center justify-center gap-2">
                          <X className="w-4 h-4" /> Clear Index
                        </button>
                      )}
                      <button type="button" onClick={() => removeSocKnowledgeResource(resource.id)} className="btn-secondary text-xs flex items-center justify-center gap-2 text-red-600 dark:text-red-300">
                        <Trash2 className="w-4 h-4" /> Remove
                      </button>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        </div>
      </div>

      <div className="rounded-2xl border border-white/70 dark:border-surface-800 bg-surface-50/85 dark:bg-surface-950/55 p-4 space-y-4">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.16em] text-surface-500">Hybrid RAG Retrieval</p>
            <h3 className="font-black text-surface-950 dark:text-white">Source-backed search across indexed chunks</h3>
            <p className="mt-1 text-xs leading-5 text-surface-500 dark:text-surface-400">
              Current retrieval mode: {SOC_RAG_RETRIEVAL_MODE_LABELS[retrievalMode]}. Dense vector retrieval is available only when a configured local provider has generated dense vectors.
            </p>
          </div>
          <div className="flex flex-col sm:flex-row gap-2">
            <button type="button" onClick={useResultsInSocPrompt} className="btn-secondary flex items-center justify-center gap-2 text-sm">
              <ShieldCheck className="w-4 h-4" /> Use Top Results in SOC Prompt
            </button>
            <button type="button" onClick={() => sendSelectedContextToChat('compact')} className="btn-secondary flex items-center justify-center gap-2 text-sm">
              <FileSearch className="w-4 h-4" /> Send Compact to Chat
            </button>
            <button type="button" onClick={() => sendSelectedContextToChat('full')} className="btn-primary flex items-center justify-center gap-2 text-sm">
              <FileSearch className="w-4 h-4" /> Send Full Context to Chat
            </button>
          </div>
        </div>

        <div className="grid md:grid-cols-[minmax(0,1fr)_13rem_8rem] gap-2">
          <label className="relative block">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-surface-400" />
            <input value={retrievalQuery} onChange={e => setRetrievalQuery(e.target.value)} className="input-field pl-10" placeholder="Search indexed text: parser recognizer, failed login, playbook approval, connector auth, incident severity..." />
          </label>
          <select value={retrievalMode} onChange={e => setRetrievalMode(e.target.value as SocRetrievalMode)} className="input-field">
            <option value="keyword">Keyword</option>
            <option value="hybrid_lexical">Hybrid lexical RAG</option>
            <option value="dense_vector" disabled={!ragHealthStats.denseAvailable}>Dense vector RAG {ragHealthStats.denseAvailable ? '' : 'unavailable'}</option>
            <option value="hybrid_dense" disabled={!ragHealthStats.denseAvailable}>Hybrid dense RAG {ragHealthStats.denseAvailable ? '' : 'unavailable'}</option>
          </select>
          <select value={topK} onChange={e => setTopK(Number(e.target.value))} className="input-field">
            {[3, 5, 8, 10].map(value => <option key={value} value={value}>Top {value}</option>)}
          </select>
        </div>
        {denseModeSelected && (
          <div className="rounded-2xl border border-indigo-200/70 dark:border-indigo-900/70 bg-indigo-50/75 dark:bg-indigo-950/20 px-4 py-3 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
            <p className="text-xs leading-5 text-indigo-800 dark:text-indigo-300">
              Dense search uses a locally generated query embedding. Build dense vectors first, then generate the query vector to rank by semantic similarity.
              {denseQueryVector?.length ? <span className="block font-bold">Dense query vector ready: {denseQueryVector.length} dimensions.</span> : null}
            </p>
            <button type="button" onClick={runDenseQueryEmbedding} disabled={denseSearchBusy || !ragHealthStats.denseAvailable || !retrievalQuery.trim()} className="btn-primary flex items-center justify-center gap-2 text-sm">
              {denseSearchBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
              {denseSearchBusy ? 'Embedding Query' : 'Refresh Dense Query Vector'}
            </button>
          </div>
        )}

        <div className="grid xl:grid-cols-[minmax(0,1fr)_minmax(18rem,0.42fr)] gap-4">
          <div className="space-y-3 max-h-[30rem] overflow-y-auto pr-1">
            {!retrievalQuery.trim() ? (
              <div className="rounded-2xl border border-dashed border-surface-300 dark:border-surface-700 p-6 text-center text-sm text-surface-500 dark:text-surface-400">
                Type a retrieval query after indexing at least one safe text resource.
              </div>
            ) : kcRetrievalBusy ? (
              <div className="rounded-2xl border border-dashed border-surface-300 dark:border-surface-700 p-6 text-center text-sm text-surface-500 dark:text-surface-400 flex items-center justify-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin" />
                Searching company Knowledge Chat index…
              </div>
            ) : retrievalResults.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-surface-300 dark:border-surface-700 p-6 text-center text-sm text-surface-500 dark:text-surface-400">
                No indexed chunk matched this query. In Dense modes, build dense vectors first (query vectors auto-embed after you pause typing); otherwise try broader SOC keywords or index more company resources.
              </div>
            ) : retrievalResults.map((result, index) => {
              const chunk: SocKnowledgeChunk = result.chunk;
              const selected = selectedSocKnowledgeChunkIds.includes(chunk.id);
              return (
                <article key={chunk.id} className={`rounded-2xl border p-4 ${selected ? 'border-sky-300 dark:border-sky-700 bg-sky-50/80 dark:bg-sky-950/25' : 'border-white/70 dark:border-surface-800 bg-white/70 dark:bg-surface-900/45'}`}>
                  <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
                    <div>
                      <p className="text-xs font-bold uppercase tracking-[0.16em] text-surface-500">Result {index + 1}</p>
                      <h4 className="mt-1 font-black text-surface-950 dark:text-white">{chunk.resourceTitle}</h4>
                      <p className="mt-1 text-xs text-surface-500 dark:text-surface-400">{chunk.title} • chars {chunk.startChar}-{chunk.endChar}</p>
                      <p className="mt-2 text-[11px] font-bold text-surface-500 dark:text-surface-400">Combined {result.combinedScore} • keyword {result.keywordScore} • lexical similarity {result.similarityScore} • dense similarity {result.denseSimilarityScore || 0}</p>
                    </div>
                    <button type="button" onClick={() => toggleSelectedSocKnowledgeChunk(chunk.id)} className="btn-secondary text-xs flex items-center justify-center gap-2">
                      {selected ? <CheckCircle2 className="w-4 h-4" /> : <Plus className="w-4 h-4" />}
                      {selected ? 'In prompt' : 'Add'}
                    </button>
                  </div>
                  <p className="mt-3 rounded-xl border border-white/70 dark:border-surface-800 bg-surface-50/80 dark:bg-surface-950/55 p-3 text-xs leading-5 text-surface-700 dark:text-surface-200 whitespace-pre-wrap">
                    {snippetPreview(chunk.text)}
                  </p>
                  <p className="mt-2 text-[11px] font-mono text-surface-400 break-all">{chunk.filePath}</p>
                </article>
              );
            })}
          </div>

          <aside className="rounded-2xl border border-white/70 dark:border-surface-800 bg-white/70 dark:bg-surface-900/45 p-4 space-y-3">
            <div>
              <p className="text-xs font-bold uppercase tracking-[0.16em] text-surface-500">Selected Context</p>
              <h4 className="font-black text-surface-950 dark:text-white">SOC prompt add-ons</h4>
            </div>
            <div className="space-y-2 text-sm text-surface-600 dark:text-surface-300">
              <p>{selectedResources.length} metadata reference{selectedResources.length === 1 ? '' : 's'} selected.</p>
              <p>{selectedRetrievedChunks.length} retrieved snippet{selectedRetrievedChunks.length === 1 ? '' : 's'} selected.</p>
            </div>
            <div className="flex flex-col gap-2">
              <button type="button" onClick={copySelectedContext} className="btn-secondary flex items-center justify-center gap-2">
                {copied ? <CheckCircle2 className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                {copied ? 'Copied' : 'Copy Context'}
              </button>
              <SocExportButton
                label="Export Context"
                defaultFileName="nexus-soc-selected-knowledge-context.md"
                contents={selectedContextText}
                kind="md"
                disabled={!selectedResources.length && !selectedRetrievedChunks.length}
                onStatus={(message) => setNotice(message)}
              />
              <SocExportButton
                label="Export Snippets"
                defaultFileName="nexus-soc-retrieved-snippets.md"
                contents={selectedRetrievedChunks.length ? buildSocRetrievedSnippetContext(selectedRetrievedChunks) : ''}
                kind="md"
                disabled={!selectedRetrievedChunks.length}
                onStatus={(message) => setNotice(message)}
              />
              <button type="button" onClick={clearSelection} className="btn-secondary flex items-center justify-center gap-2">
                <X className="w-4 h-4" /> Clear All Context
              </button>
            </div>
            {selectedRetrievedChunks.length > 0 && (
              <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
                {selectedRetrievedChunks.map(chunk => (
                  <div key={chunk.id} className="rounded-xl border border-white/70 dark:border-surface-800 bg-surface-50/80 dark:bg-surface-950/55 p-3">
                    <p className="text-xs font-bold text-surface-800 dark:text-surface-200">{chunk.resourceTitle}</p>
                    <p className="mt-1 text-[11px] text-surface-500 dark:text-surface-400">{chunk.title}</p>
                    <button type="button" onClick={() => toggleSelectedSocKnowledgeChunk(chunk.id)} className="mt-2 text-[11px] font-bold text-red-600 dark:text-red-300">Remove snippet</button>
                  </div>
                ))}
              </div>
            )}
          </aside>
        </div>
      </div>
    </section>
  );
}
