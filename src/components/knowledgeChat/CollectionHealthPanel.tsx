import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/tauri';
import { Activity, AlertTriangle, CheckCircle2, Cloud, HardDrive, Loader2 } from 'lucide-react';
import { kcCollectionHealth, kcSystemReadiness, humanError } from '../../knowledgeChat/api';
import { useKnowledgeChatStore } from '../../knowledgeChat/store';
import type { KcCollectionHealth, KcPartitionHealth, KcSystemReadiness } from '../../knowledgeChat/types';
import { KC_STATUS_LABELS } from '../../knowledgeChat/types';
import type { EnterpriseServerConfig } from '../../types';

const PARTITION_LABELS: Record<string, string> = {
  code: 'Code (Nomic)',
  documentation: 'Documentation (BGE-M3)',
  runbooks: 'Runbooks (BGE-M3)',
  logs_data: 'Logs & data (BGE-M3)',
  general: 'General (BGE-M3)',
  knowledge: 'General (legacy)',
};

function partitionLabel(id: string): string {
  return PARTITION_LABELS[id] ?? id;
}

function basename(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const parts = normalized.split('/');
  return parts[parts.length - 1] || path;
}

export default function CollectionHealthPanel() {
  const { activeCollectionId } = useKnowledgeChatStore();
  const [health, setHealth] = useState<KcCollectionHealth | null>(null);
  const [readiness, setReadiness] = useState<KcSystemReadiness | null>(null);
  const [remoteEmbed, setRemoteEmbed] = useState<EnterpriseServerConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!activeCollectionId) {
      setHealth(null);
      return;
    }
    let cancelled = false;
    (async () => {
      setBusy(true);
      setError(null);
      try {
        const [data, system, enterprise] = await Promise.all([
          kcCollectionHealth(activeCollectionId),
          kcSystemReadiness(),
          invoke<EnterpriseServerConfig>('get_enterprise_server_config').catch(() => null),
        ]);
        if (!cancelled) {
          setHealth(data);
          setReadiness(system);
          setRemoteEmbed(enterprise);
        }
      } catch (err) {
        if (!cancelled) setError(humanError(err));
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();
    return () => { cancelled = true; };
  }, [activeCollectionId]);

  if (!activeCollectionId) return null;

  return (
    <section className="panel-shell p-4 sm:p-6 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-surface-500">Collection health</p>
          <h2 className="text-xl font-black text-surface-950 dark:text-white">Index diagnostics</h2>
          <p className="mt-1 text-xs text-surface-500 dark:text-surface-400">
            Dense coverage, per-partition models, HNSW indexes, FTS status, and failed files.
          </p>
        </div>
        {busy ? <Loader2 className="w-5 h-5 animate-spin text-sky-500" /> : <Activity className="w-5 h-5 text-sky-500" />}
      </div>

      {error && (
        <div className="rounded-2xl border border-amber-200/70 dark:border-amber-900 bg-amber-50/85 dark:bg-amber-950/20 px-4 py-3 text-sm text-amber-800 dark:text-amber-200 flex gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />{error}
        </div>
      )}

      {health && (
        <>
          {health.dual_model_reindex_recommended && (
            <div className="rounded-2xl border border-amber-200/70 dark:border-amber-900 bg-amber-50/85 dark:bg-amber-950/20 px-4 py-3 text-sm text-amber-800 dark:text-amber-200 flex gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <div>
                <p className="font-semibold">Multi-partition reindex recommended</p>
                <p className="text-xs mt-1">
                  This collection uses a legacy two-partition index or shares one embedding model across code and documents.
                  Run a full rebuild so files route into all five partitions (code, documentation, runbooks, logs &amp; data, general) with Nomic + BGE-M3.
                </p>
              </div>
            </div>
          )}

          {(() => {
            const remoteOn = Boolean(remoteEmbed?.embeddings_enabled);
            return (
              <div className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-xs ${remoteOn ? 'border-sky-200/70 dark:border-sky-900 bg-sky-50/70 dark:bg-sky-950/20 text-sky-800 dark:text-sky-200' : 'border-white/70 dark:border-surface-800 bg-surface-50/85 dark:bg-surface-950/55 text-surface-600 dark:text-surface-300'}`}>
                {remoteOn ? <Cloud className="w-4 h-4 shrink-0" /> : <HardDrive className="w-4 h-4 shrink-0" />}
                <span>
                  <strong>Embeddings:</strong> {remoteOn ? 'organization server (local fallback)' : 'local'}
                </span>
              </div>
            );
          })()}

          {readiness && (
            <div className="rounded-xl border border-white/70 dark:border-surface-800 bg-surface-50/85 dark:bg-surface-950/55 p-3 space-y-2">
              <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-surface-500">Search models</p>
              <div className="grid sm:grid-cols-2 gap-2 text-xs">
                <ModelReadinessRow
                  label="Code search model"
                  resolved={readiness.code_model_resolved}
                  path={readiness.code_model_path}
                />
                <ModelReadinessRow
                  label="Document search model"
                  resolved={readiness.knowledge_model_resolved}
                  path={readiness.knowledge_model_path}
                />
                {typeof readiness.llama_rerank_configured === 'boolean' && (
                  <ModelReadinessRow
                    label="Result ranking model"
                    resolved={readiness.llama_rerank_configured}
                    path={readiness.llama_rerank_model_path || ''}
                  />
                )}
              </div>
            </div>
          )}

          {health.partitions.length > 0 && (
            <div className="space-y-2">
              <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-surface-500">
                Content groups {health.folder_category ? `· ${health.folder_category.replace(/_/g, ' ')}` : ''}
              </p>
              <div className="grid lg:grid-cols-2 xl:grid-cols-3 gap-3">
                {health.partitions.map(partition => (
                  <PartitionCard key={partition.partition_id} partition={partition} />
                ))}
              </div>
            </div>
          )}

          <div className="grid sm:grid-cols-2 xl:grid-cols-4 gap-2">
            <Stat label="Status" value={KC_STATUS_LABELS[health.status]} />
            <Stat label="Meaning search coverage" value={`${health.dense_coverage_pct.toFixed(0)}%`} />
            <Stat label="Fast meaning index" value={health.hnsw_ready ? 'Ready' : 'Not built'} />
            <Stat label="Result ranking" value={readiness?.llama_rerank_configured ? 'Ready' : 'Not set up'} />
            <Stat label="Scanned PDF reading" value={health.pdf_ocr_available ? 'Ready' : 'Not available'} />
            <Stat label="PDF reader in use" value={
              (health.ocr_engine_hint || 'auto')
                .replace('auto→docling', 'Automatic (layout)')
                .replace('auto→legacy', 'Automatic (built-in)')
                .replace('legacy (docling unavailable)', 'Built-in')
                .replace('docling', 'Layout-aware')
                .replace('legacy', 'Built-in')
            } />
            <Stat
              label="Online page images"
              value={
                health.image_rag_opt_in
                  ? (health.image_rag_configured ? 'Allowed & set up' : 'Allowed (needs Settings)')
                  : 'Off for this folder'
              }
            />
            <Stat label="Word search index" value={health.fts_populated ? 'Ready' : 'Empty'} />
            <Stat label="Files" value={`${health.indexed_files} indexed / ${health.file_count} total`} />
            <Stat label="Searchable sections" value={String(health.chunk_count)} />
            <Stat label="Meaning-search sections" value={String(health.dense_chunk_count)} />
            <Stat label="Failed" value={String(health.failed_files)} />
            <Stat label="Skipped" value={String(health.skipped_files)} />
          </div>

          {readiness && (
            <div className="rounded-xl border border-sky-200/70 dark:border-sky-900 bg-sky-50/70 dark:bg-sky-950/20 p-3 space-y-2">
              <p className="text-xs font-bold uppercase tracking-[0.14em] text-sky-800 dark:text-sky-300">
                Server deployment targets
              </p>
              <p className="text-xs text-sky-900 dark:text-sky-100">
                Best-quality models for a server deployment (this machine may run smaller local fallbacks):
              </p>
              <ul className="text-xs text-sky-900 dark:text-sky-100 space-y-1 list-disc pl-4">
                <li><strong>Document search:</strong> BGE-M3 (or organization knowledge embeddings)</li>
                <li><strong>Code search:</strong> Qwen3-Embedding-8B when GPU/RAM allows</li>
                <li><strong>Result ranking:</strong> Qwen3-Reranker-4B under models/rerankers</li>
                <li><strong>Answer model:</strong> 70B-class instruct or organization OpenAI-compatible endpoint</li>
              </ul>
              <p className="text-[11px] text-sky-800/90 dark:text-sky-200/90">
                After chunking/retrieval upgrades, rebuild each collection index for best accuracy.
              </p>
            </div>
          )}

          {readiness && (() => {
            const fixItems = readiness.warnings.filter(
              (w) => !w.startsWith('Server deployment targets') && !w.startsWith('Chunking and retrieval'),
            );
            return fixItems.length > 0 ? <IssueList title="Things to fix" items={fixItems} /> : null;
          })()}
          {health.ocr_needed_files.length > 0 && (
            <IssueList title="PDFs that may need text reading" items={health.ocr_needed_files} />
          )}
          {health.failed_file_samples.length > 0 && (
            <IssueList title="Failed files" items={health.failed_file_samples} />
          )}
          {health.skipped_file_samples.length > 0 && (
            <IssueList title="Skipped files (sample)" items={health.skipped_file_samples.slice(0, 8)} />
          )}
          {health.last_error && (
            <p className="text-xs text-amber-700 dark:text-amber-300">Last error: {health.last_error}</p>
          )}
        </>
      )}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-white/70 dark:border-surface-800 bg-surface-50/85 dark:bg-surface-950/55 px-3 py-2">
      <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-surface-500">{label}</p>
      <p className="text-sm font-semibold text-surface-900 dark:text-surface-100">{value}</p>
    </div>
  );
}

function ModelReadinessRow({ label, resolved, path }: { label: string; resolved: boolean; path: string }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-white/60 dark:border-surface-800 bg-white/60 dark:bg-surface-900/40 px-3 py-2">
      {resolved
        ? <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5" />
        : <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />}
      <div className="min-w-0">
        <p className="font-semibold text-surface-800 dark:text-surface-100">{label}</p>
        <p className="text-[11px] text-surface-500 truncate font-mono" title={path || 'Not resolved'}>
          {path ? basename(path) : 'Not resolved'}
        </p>
      </div>
    </div>
  );
}

function PartitionCard({ partition }: { partition: KcPartitionHealth }) {
  const modelName = partition.embedding_model_path
    ? basename(partition.embedding_model_path)
    : 'Not configured';
  return (
    <div className="rounded-xl border border-white/70 dark:border-surface-800 bg-white/70 dark:bg-surface-900/45 p-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-bold text-surface-900 dark:text-surface-100">
          {partitionLabel(partition.partition_id)}
        </p>
        {partition.model_resolved
          ? <span className="text-[10px] font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-300">Model OK</span>
          : <span className="text-[10px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300">Model missing</span>}
      </div>
      <p className="text-[11px] font-mono text-surface-500 truncate" title={partition.embedding_model_path || undefined}>
        {modelName}
        {partition.profile_id ? ` · ${partition.profile_id}` : ''}
      </p>
      <div className="grid grid-cols-2 gap-2">
        <Stat label="Chunks" value={String(partition.chunk_count)} />
        <Stat label="Dense" value={`${partition.dense_chunk_count} (${partition.dense_coverage_pct.toFixed(0)}%)`} />
        <Stat
          label="HNSW"
          value={partition.hnsw_ready ? `${partition.hnsw_vector_count} vectors` : 'Not built'}
        />
        <Stat
          label="Dim"
          value={partition.vector_dimension != null ? String(partition.vector_dimension) : '—'}
        />
      </div>
    </div>
  );
}

function IssueList({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="rounded-xl border border-amber-200/60 dark:border-amber-900/60 bg-amber-50/50 dark:bg-amber-950/15 p-3">
      <p className="text-xs font-bold uppercase tracking-[0.14em] text-amber-800 dark:text-amber-300 mb-2">{title}</p>
      <ul className="text-xs text-amber-900 dark:text-amber-200 space-y-1 font-mono">
        {items.map(item => <li key={item}>{item}</li>)}
      </ul>
    </div>
  );
}
