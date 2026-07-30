import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/tauri';
import { listen } from '@tauri-apps/api/event';
import { CheckCircle2, Download, ExternalLink, Loader2, StopCircle } from 'lucide-react';
import { useAppStore } from '../store';
import { joinPath } from '../platformPaths';
import {
  SUPPORT_MODEL_CATALOG,
  type SupportModelCatalogEntry,
  type SupportModelKind,
} from '../knowledgeChat/retrievalConfig';
import {
  downloadUnlimitedOcrModel,
  probeUnlimitedOcr,
  type UnlimitedOcrProbe,
} from '../ocrImageRagConfig';
import { onOpenExternal } from '../openExternal';
import type { LocalModelRecord } from '../types';

interface DownloadProgressEvent {
  id?: string;
  file_name?: string;
  status?: string;
  downloaded_bytes?: number;
  total_bytes?: number | null;
  speed_bytes_per_sec?: number;
  message?: string;
  elapsed_secs?: number;
}

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    return await invoke<boolean>('path_exists', { path });
  } catch {
    // Fallback: try reading via get_local_models / filesystem check through download skip
    try {
      const models = await invoke<LocalModelRecord[]>('get_local_models');
      return models.some(m => m.path.replace(/\//g, '\\').toLowerCase() === path.replace(/\//g, '\\').toLowerCase());
    } catch {
      return false;
    }
  }
}

export default function SupportModelsPanel({ compact = false }: { compact?: boolean }) {
  const modelsDir = useAppStore(s => s.modelsDir);
  const deploymentConfig = useAppStore(s => s.deploymentConfig);
  const setDeploymentConfig = useAppStore(s => s.setDeploymentConfig);
  const [present, setPresent] = useState<Partial<Record<SupportModelKind, boolean>>>({});
  const [uoProbe, setUoProbe] = useState<UnlimitedOcrProbe | null>(null);
  const [busyId, setBusyId] = useState<SupportModelKind | null>(null);
  const [progress, setProgress] = useState<DownloadProgressEvent | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const baseModelsDir = (modelsDir || deploymentConfig?.modelsDir || '').trim();

  const destFor = (entry: SupportModelCatalogEntry): string => {
    if (entry.downloadMode === 'hf_snapshot') {
      return uoProbe?.model_dir || '(app data)/models/ocr/unlimited-ocr';
    }
    return joinPath(baseModelsDir, entry.destSubdir, entry.fileName);
  };

  const refreshPresence = async () => {
    const next: Partial<Record<SupportModelKind, boolean>> = {};
    for (const entry of SUPPORT_MODEL_CATALOG) {
      if (entry.downloadMode === 'hf_snapshot') {
        try {
          const p = await probeUnlimitedOcr();
          setUoProbe(p);
          next[entry.id] = Boolean(p.model_ready);
        } catch {
          next[entry.id] = false;
        }
        continue;
      }
      if (!baseModelsDir) {
        next[entry.id] = false;
        continue;
      }
      next[entry.id] = await pathExists(joinPath(baseModelsDir, entry.destSubdir, entry.fileName));
    }
    setPresent(next);
  };

  useEffect(() => {
    void refreshPresence();
  }, [baseModelsDir]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<DownloadProgressEvent>('model-download-progress', event => {
      setProgress(event.payload);
    }).then(fn => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, []);

  const stopDownload = async () => {
    try {
      await invoke('cancel_model_download');
      setMsg('Download stopped.');
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
      setProgress(null);
    }
  };

  const downloadEntry = async (entry: SupportModelCatalogEntry) => {
    setErr(null);
    setMsg(null);
    setBusyId(entry.id);
    setProgress(null);
    try {
      if (entry.downloadMode === 'hf_snapshot') {
        setMsg('Downloading Unlimited-OCR weights from Hugging Face (this can take a while)…');
        const probe = await downloadUnlimitedOcrModel();
        setUoProbe(probe);
        setPresent(prev => ({ ...prev, unlimited_ocr: probe.model_ready }));
        setMsg(probe.available
          ? 'Unlimited-OCR ready (CUDA + weights).'
          : `Weights saved to ${probe.model_dir}. CUDA/torch still required for use.`);
        return;
      }

      if (!baseModelsDir) {
        setErr('Set a models folder first (Setup step or Settings → Deployment).');
        return;
      }

      const destDir = joinPath(baseModelsDir, entry.destSubdir);
      await invoke('begin_model_download_job', {
        destDir,
        files: [entry.fileName],
      });
      setMsg(`Downloading ${entry.fileName}…`);
      const record = await invoke<LocalModelRecord>('download_model', {
        url: entry.url,
        destDir,
        name: entry.fileName,
      });

      // Wire deployment paths when relevant.
      if (deploymentConfig) {
        const next = { ...deploymentConfig };
        if (entry.id === 'code_embedding') {
          next.embeddingModelPath = record.path;
        } else if (entry.id === 'reranker') {
          next.rerankerModelPath = record.path;
        }
        setDeploymentConfig(next);
      }

      setPresent(prev => ({ ...prev, [entry.id]: true }));
      setMsg(`Downloaded ${entry.title} → ${record.path}`);
      await refreshPresence();
    } catch (e) {
      const text = e instanceof Error ? e.message : String(e);
      if (/stopped by user|partial files were deleted/i.test(text)) {
        setMsg('Download stopped. Partial files were removed.');
      } else {
        setErr(text);
      }
    } finally {
      setBusyId(null);
      setProgress(null);
    }
  };

  const pct = (() => {
    const done = progress?.downloaded_bytes ?? 0;
    const total = progress?.total_bytes ?? 0;
    if (!total || total <= 0) return null;
    return Math.min(100, Math.round((done / total) * 100));
  })();

  return (
    <div className={compact ? 'space-y-3' : 'space-y-4'}>
      {!compact && (
        <p className="text-sm text-surface-500">
          These files are not in the installer. PocketMind downloads them into your models folder (or OCR cache) when you click Download.
          Chat models stay under <span className="font-medium">Models</span>.
        </p>
      )}
      {!baseModelsDir && (
        <p className="text-sm text-amber-700 dark:text-amber-300">
          Models folder is not set yet — set it in Setup or Settings → Deployment before downloading embeddings/reranker.
        </p>
      )}

      <div className="space-y-3">
        {SUPPORT_MODEL_CATALOG.map(entry => {
          const ready = Boolean(present[entry.id]);
          const busy = busyId === entry.id;
          return (
            <div
              key={entry.id}
              className="rounded-xl border border-surface-200 dark:border-surface-700 p-3 sm:p-4 space-y-2"
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-semibold text-sm flex items-center gap-2">
                    {entry.title}
                    {ready ? (
                      <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-600 dark:text-emerald-300">
                        <CheckCircle2 className="w-3.5 h-3.5" /> Ready
                      </span>
                    ) : (
                      <span className="text-xs text-surface-400">Not downloaded</span>
                    )}
                  </p>
                  <p className="text-xs text-surface-500 mt-1">{entry.description}</p>
                  <p className="text-[11px] text-surface-400 mt-1">
                    {entry.sizeLabel} · {entry.requiredFor}
                  </p>
                  <p className="text-[11px] text-surface-400 break-all mt-0.5">{destFor(entry)}</p>
                </div>
                <div className="flex flex-wrap gap-2 shrink-0">
                  <button
                    type="button"
                    className="btn-secondary text-xs flex items-center gap-1"
                    onClick={onOpenExternal(entry.repoPage)}
                    title="Open Hugging Face page"
                  >
                    <ExternalLink className="w-3.5 h-3.5" /> Link
                  </button>
                  <button
                    type="button"
                    className="btn-primary text-xs flex items-center gap-1"
                    disabled={!!busyId || (entry.downloadMode === 'gguf' && !baseModelsDir)}
                    onClick={() => void downloadEntry(entry)}
                  >
                    {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
                    {ready ? 'Re-download' : 'Download'}
                  </button>
                </div>
              </div>
              {busy && progress && (
                <div className="text-xs text-surface-500 space-y-1">
                  <div className="flex justify-between gap-2">
                    <span>{progress.file_name || entry.fileName}</span>
                    <span>
                      {formatBytes(progress.downloaded_bytes || 0)}
                      {progress.total_bytes ? ` / ${formatBytes(progress.total_bytes)}` : ''}
                      {pct != null ? ` (${pct}%)` : ''}
                    </span>
                  </div>
                  <div className="h-1.5 rounded-full bg-surface-200 dark:bg-surface-800 overflow-hidden">
                    <div
                      className="h-full bg-primary-500 transition-all"
                      style={{ width: `${pct ?? (progress.status === 'starting' ? 5 : 35)}%` }}
                    />
                  </div>
                  <p>{progress.message || progress.status || 'Downloading…'}</p>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {busyId && busyId !== 'unlimited_ocr' && (
        <button type="button" className="btn-secondary text-xs flex items-center gap-1" onClick={() => void stopDownload()}>
          <StopCircle className="w-3.5 h-3.5" /> Stop download
        </button>
      )}

      {msg && <p className="text-sm text-emerald-600 dark:text-emerald-300">{msg}</p>}
      {err && <p className="text-sm text-red-600 dark:text-red-300">{err}</p>}
    </div>
  );
}
