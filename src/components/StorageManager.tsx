import { useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/tauri';
import { HardDrive, Trash2, RefreshCw, AlertTriangle, Database, FolderOpen, CheckCircle2 } from 'lucide-react';
import { useAppStore } from '../store';
import { LocalModelRecord } from '../types';

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

  const totalModelBytes = useMemo(() => localModels.reduce((sum, m) => sum + Math.max(0, m.size_bytes || 0), 0), [localModels]);
  const messageCount = useMemo(() => Object.values(messages).reduce((sum, list) => sum + list.length, 0), [messages]);

  const refreshModels = async () => {
    const models = await invoke<LocalModelRecord[]>('get_local_models');
    setLocalModels(models);
    setStatus('Model library refreshed.');
  };

  const removeModelRecord = async (model: LocalModelRecord) => {
    const confirmText = `Remove ${model.name} from the NexusAI library?\n\nThis removes the library record only. It does not delete the GGUF file from disk.`;
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
                <button
                  disabled={busyId === model.id}
                  onClick={() => removeModelRecord(model)}
                  className="inline-flex items-center justify-center gap-2 rounded-xl border border-red-200 dark:border-red-900/60 text-red-700 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-950/30 px-4 py-2 text-sm font-semibold disabled:opacity-50"
                >
                  <Trash2 className="w-4 h-4" /> Remove record
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="rounded-3xl border border-amber-200 dark:border-amber-900/60 bg-amber-50 dark:bg-amber-950/20 p-5 flex gap-3 text-sm text-amber-800 dark:text-amber-200">
        <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5" />
        <div>
          <strong>Safe behavior:</strong> this screen does not delete GGUF files from disk. It only removes NexusAI library records. File deletion should be added later with stronger confirmations and recycle-bin behavior.
        </div>
      </section>
    </div>
  );
}
