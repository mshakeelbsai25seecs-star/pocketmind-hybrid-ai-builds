import { useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/tauri';
import { open } from '@tauri-apps/api/dialog';
import { HardDrive, Trash2, RefreshCw, AlertTriangle, Database, FolderOpen, CheckCircle2, Scan, FolderInput } from 'lucide-react';
import { useAppStore } from '../store';
import { LocalModelRecord } from '../types';
import { FEATURE_FLAGS } from '../featureFlags';
import {
  batchProcessFolder,
  deleteOrphanFiles,
  scanOrphanFiles,
  verifyLocalModelIntegrity,
} from '../api/powerFeatures';
import type { BatchFileResult, IntegrityResult, OrphanItem } from '../codeWorkspace/types';

function formatBytes(bytes?: number | null) {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i++; }
  return `${value.toFixed(value >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export default function StorageManager() {
  const store = useAppStore();
  const { localModels, conversations, messages, systemInfo, setLocalModels } = store;
  const [busyId, setBusyId] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [orphans, setOrphans] = useState<OrphanItem[]>([]);
  const [orphanBusy, setOrphanBusy] = useState(false);
  const [batchResults, setBatchResults] = useState<BatchFileResult[]>([]);
  const [verifyResult, setVerifyResult] = useState<IntegrityResult | null>(null);

  const totalModelBytes = useMemo(() => localModels.reduce((sum, m) => sum + Math.max(0, m.size_bytes || 0), 0), [localModels]);
  const messageCount = useMemo(() => Object.values(messages).reduce((sum, list) => sum + list.length, 0), [messages]);

  const refreshModels = async () => {
    const models = await invoke<LocalModelRecord[]>('get_local_models');
    setLocalModels(models);
    setStatus('Model library refreshed.');
  };

  const removeModelRecord = async (model: LocalModelRecord) => {
    const confirmText = `Remove ${model.name} from the PocketMind Hybrid AI library?\n\nThis removes the library record only. It does not delete the GGUF file from disk.`;
    if (!window.confirm(confirmText)) return;
    setBusyId(model.id);
    try {
      await invoke('delete_local_model', { id: model.id });
      await refreshModels();
      setStatus(`Removed ${model.name} from the library.`);
    } catch (err) {
      setStatus(`Failed to remove model: ${String(err)}`);
    } finally {
      setBusyId(null);
    }
  };

  const scanOrphans = async () => {
    if (!FEATURE_FLAGS.orphanCleaner) return;
    setOrphanBusy(true);
    try {
      const rows = await scanOrphanFiles();
      setOrphans(rows);
      setStatus(`Found ${rows.length} orphan / stale file(s) (dry-run).`);
    } catch (err) {
      setStatus(String(err));
    } finally {
      setOrphanBusy(false);
    }
  };

  const confirmDeleteOrphans = async () => {
    const safe = orphans.filter(o => o.safe_to_delete);
    if (safe.length === 0) {
      setStatus('No safe-to-delete orphans selected.');
      return;
    }
    if (!window.confirm(`Delete ${safe.length} orphan file(s)? This cannot be undone.`)) return;
    setOrphanBusy(true);
    try {
      const n = await deleteOrphanFiles(safe.map(o => o.path));
      setStatus(`Deleted ${n} file(s).`);
      await scanOrphans();
    } catch (err) {
      setStatus(String(err));
    } finally {
      setOrphanBusy(false);
    }
  };

  const runBatchProcess = async () => {
    if (!FEATURE_FLAGS.batchDocumentProcessing) return;
    const folder = await open({ directory: true, multiple: false });
    if (typeof folder !== 'string') return;
    setOrphanBusy(true);
    try {
      const rows = await batchProcessFolder(folder);
      setBatchResults(rows);
      setStatus(`Batch processed ${rows.length} file(s).`);
    } catch (err) {
      setStatus(String(err));
    } finally {
      setOrphanBusy(false);
    }
  };

  const verifyModel = async (model: LocalModelRecord) => {
    if (!FEATURE_FLAGS.modelSha256Verify) return;
    setBusyId(model.id);
    try {
      const result = await verifyLocalModelIntegrity(model.path);
      setVerifyResult(result);
      setStatus(result.matched_expected === false
        ? `SHA-256 mismatch for ${model.name}`
        : `Verified ${model.name} · ${result.sha256.slice(0, 12)}…`);
    } catch (err) {
      setStatus(String(err));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="h-full overflow-y-auto p-8 space-y-8 bg-gradient-to-br from-surface-50 via-white to-primary-50/30 dark:from-surface-950 dark:via-surface-950 dark:to-primary-950/20">
      <section className="rounded-3xl border border-surface-200 dark:border-surface-800 bg-white/80 dark:bg-surface-900/80 backdrop-blur p-8 shadow-soft">
        <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-6">
          <div>
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-primary-100 dark:bg-primary-900/30 text-primary-700 dark:text-primary-300 text-sm font-semibold mb-4">
              <HardDrive className="w-4 h-4" /> Storage Manager
            </div>
            <h1 className="text-4xl font-black tracking-tight">Storage and local assets</h1>
            <p className="text-surface-600 dark:text-surface-400 mt-2 max-w-3xl">
              Review local model records, model sizes, chat counts, and disk status. This phase avoids dangerous file deletion; model removal is library-only unless you delete files manually.
            </p>
          </div>
          <button onClick={refreshModels} className="inline-flex items-center justify-center gap-2 rounded-2xl bg-primary-600 hover:bg-primary-700 text-white px-5 py-3 font-semibold shadow-lg shadow-primary-600/20">
            <RefreshCw className="w-4 h-4" /> Refresh
          </button>
        </div>
      </section>

      {status && (
        <div className="rounded-2xl border border-primary-200 dark:border-primary-900/60 bg-primary-50 dark:bg-primary-950/20 p-4 text-sm text-primary-800 dark:text-primary-200 flex items-center gap-3">
          <CheckCircle2 className="w-5 h-5" /> {status}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="rounded-3xl border border-surface-200 dark:border-surface-800 bg-white dark:bg-surface-900 p-5 shadow-soft">
          <p className="text-sm text-surface-500">Models in library</p>
          <p className="text-3xl font-black mt-1">{localModels.length}</p>
        </div>
        <div className="rounded-3xl border border-surface-200 dark:border-surface-800 bg-white dark:bg-surface-900 p-5 shadow-soft">
          <p className="text-sm text-surface-500">Model disk total</p>
          <p className="text-3xl font-black mt-1">{formatBytes(totalModelBytes)}</p>
        </div>
        <div className="rounded-3xl border border-surface-200 dark:border-surface-800 bg-white dark:bg-surface-900 p-5 shadow-soft">
          <p className="text-sm text-surface-500">Chats</p>
          <p className="text-3xl font-black mt-1">{conversations.length}</p>
        </div>
        <div className="rounded-3xl border border-surface-200 dark:border-surface-800 bg-white dark:bg-surface-900 p-5 shadow-soft">
          <p className="text-sm text-surface-500">Messages loaded</p>
          <p className="text-3xl font-black mt-1">{messageCount}</p>
        </div>
      </div>

      <section className="rounded-3xl border border-surface-200 dark:border-surface-800 bg-white dark:bg-surface-900 shadow-soft overflow-hidden">
        <div className="p-6 border-b border-surface-200 dark:border-surface-800 flex items-center justify-between gap-4">
          <div>
            <h2 className="text-2xl font-bold flex items-center gap-2"><Database className="w-6 h-6" /> Local model library</h2>
            <p className="text-sm text-surface-500 mt-1">Remove stale records safely without deleting the model file.</p>
          </div>
          <div className="text-sm text-surface-500">Free disk: {formatBytes(systemInfo?.storage.free_bytes)}</div>
        </div>

        {localModels.length === 0 ? (
          <div className="p-10 text-center text-surface-500">
            <FolderOpen className="w-10 h-10 mx-auto mb-3 opacity-60" />
            No GGUF models are registered yet. Go to Models to import or scan a folder.
          </div>
        ) : (
          <div className="divide-y divide-surface-200 dark:divide-surface-800">
            {localModels.map(model => (
              <div key={model.id} className="p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
                <div className="min-w-0">
                  <h3 className="font-bold truncate">{model.name}</h3>
                  <p className="text-xs text-surface-500 truncate mt-1">{model.path}</p>
                  <div className="flex flex-wrap gap-2 mt-2">
                    <span className="text-xs rounded-full bg-surface-100 dark:bg-surface-800 px-2 py-1">{formatBytes(model.size_bytes)}</span>
                    <span className="text-xs rounded-full bg-surface-100 dark:bg-surface-800 px-2 py-1">{model.quantization || 'Unknown quant'}</span>
                    <span className="text-xs rounded-full bg-surface-100 dark:bg-surface-800 px-2 py-1">{model.backend}</span>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                <button
                  disabled={busyId === model.id}
                  onClick={() => verifyModel(model)}
                  className="inline-flex items-center justify-center gap-2 rounded-xl border border-surface-200 dark:border-surface-700 px-4 py-2 text-sm font-semibold disabled:opacity-50"
                >
                  <CheckCircle2 className="w-4 h-4" /> Verify SHA-256
                </button>
                <button
                  disabled={busyId === model.id}
                  onClick={() => removeModelRecord(model)}
                  className="inline-flex items-center justify-center gap-2 rounded-xl border border-red-200 dark:border-red-900/60 text-red-700 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-950/30 px-4 py-2 text-sm font-semibold disabled:opacity-50"
                >
                  <Trash2 className="w-4 h-4" /> Remove record
                </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {FEATURE_FLAGS.orphanCleaner && (
        <section className="rounded-3xl border border-surface-200 dark:border-surface-800 bg-white dark:bg-surface-900 p-6 shadow-soft space-y-4">
          <h2 className="text-xl font-bold flex items-center gap-2"><Scan className="w-5 h-5" /> Orphan cleaner</h2>
          <p className="text-sm text-surface-500">Scan for stale partial downloads, orphan GGUF files, and old cache temp files.</p>
          <div className="flex flex-wrap gap-2">
            <button disabled={orphanBusy} onClick={() => void scanOrphans()} className="btn-secondary text-sm flex items-center gap-2">
              <Scan className="w-4 h-4" /> Scan (dry-run)
            </button>
            <button disabled={orphanBusy || orphans.length === 0} onClick={() => void confirmDeleteOrphans()} className="btn-secondary text-sm text-red-600 dark:text-red-400">
              Delete safe orphans
            </button>
            {FEATURE_FLAGS.batchDocumentProcessing && (
              <button disabled={orphanBusy} onClick={() => void runBatchProcess()} className="btn-secondary text-sm flex items-center gap-2">
                <FolderInput className="w-4 h-4" /> Batch process folder
              </button>
            )}
          </div>
          {orphans.length > 0 && (
            <div className="max-h-56 overflow-y-auto divide-y divide-surface-200 dark:divide-surface-800 rounded-xl border border-surface-200 dark:border-surface-800">
              {orphans.map(o => (
                <div key={o.path} className="p-3 text-xs flex justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-semibold truncate">{o.path}</p>
                    <p className="text-surface-500">{o.kind} · {formatBytes(o.size_bytes)}{o.safe_to_delete ? '' : ' · active model — skip'}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
          {verifyResult && (
            <p className="text-xs text-surface-500 break-all">Last verify: {verifyResult.sha256} ({formatBytes(verifyResult.size_bytes)})</p>
          )}
          {batchResults.length > 0 && (
            <div className="max-h-40 overflow-y-auto text-xs space-y-1">
              {batchResults.slice(0, 20).map(r => (
                <div key={r.path} className={r.ok ? 'text-surface-600' : 'text-red-500'}>{r.path}: {r.summary}</div>
              ))}
            </div>
          )}
        </section>
      )}

      <section className="rounded-3xl border border-amber-200 dark:border-amber-900/60 bg-amber-50 dark:bg-amber-950/20 p-5 flex gap-3 text-sm text-amber-800 dark:text-amber-200">
        <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5" />
        <div>
          <strong>Safe behavior:</strong> this screen does not delete GGUF files from disk. It only removes PocketMind Hybrid AI library records. File deletion should be added later with stronger confirmations and recycle-bin behavior.
        </div>
      </section>
    </div>
  );
}
