import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/tauri';
import { listen } from '@tauri-apps/api/event';
import { Cpu, CheckCircle2, Download, Monitor, Zap } from 'lucide-react';
import { useAppStore } from '../store';
import { formatInvokeError } from '../lib/formatInvokeError';
import { chooseWritableDataRoot, needsWritableDataRoot } from '../storageAccess';
import type { GpuRuntimeReport, RuntimeDiagnostics, SystemInfo } from '../types';

type CudaInstallProgress = {
  backend?: string;
  phase?: string;
  message?: string;
  percent?: number | null;
  file?: string | null;
  downloaded?: number | null;
  total?: number | null;
};

function fmtBytes(bytes?: number | null) {
  if (!bytes || bytes <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(i ? 1 : 0)} ${units[i]}`;
}

function ReadyPill({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className={`inline-flex items-center gap-1 text-[11px] font-semibold ${ok ? 'text-primary-400' : 'text-amber-300'}`}>
      <CheckCircle2 className="w-3.5 h-3.5" />
      {ok ? label : 'Not detected'}
    </span>
  );
}

export default function HardwareRuntimeManager() {
  const store = useAppStore();
  const [report, setReport] = useState<GpuRuntimeReport | null>(null);
  const [diag, setDiag] = useState<RuntimeDiagnostics | null>(null);
  const [busy, setBusy] = useState(false);
  const [cudaBusy, setCudaBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [cudaProgress, setCudaProgress] = useState<CudaInstallProgress | null>(null);
  const [cudaNeedsPath, setCudaNeedsPath] = useState(false);

  const isRemote = store.currentModel?.startsWith('remote:') || store.currentModel?.startsWith('enterprise:') || false;
  const selectedModelPath = !isRemote ? store.currentModel : null;

  const refresh = async () => {
    setBusy(true);
    try {
      const [info, next, d] = await Promise.all([
        invoke<SystemInfo>('get_system_info'),
        invoke<GpuRuntimeReport>('get_gpu_runtime_report', { selectedModelPath }),
        invoke<RuntimeDiagnostics>('get_runtime_diagnostics', {
          selectedModelPath: store.currentModel || null,
          modelsDir: store.modelsDir,
        }),
      ]);
      store.setSystemInfo(info);
      setReport(next);
      setDiag(d);
    } catch (err) {
      setMessage(formatInvokeError(err));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, [store.currentModel]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<CudaInstallProgress>('llama-runtime-install-progress', event => {
      const payload = event.payload;
      if (payload?.backend && payload.backend !== 'cuda') return;
      setCudaProgress(payload);
      if (payload?.message) setMessage(payload.message);
    }).then(fn => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, []);

  const info = store.systemInfo;
  const ramGb = info ? Math.round(info.memory.total_bytes / 1_073_741_824) : null;
  const gpu = info?.gpus?.[0];
  const vramGb = gpu?.vram_total_bytes ? Math.round(gpu.vram_total_bytes / 1_073_741_824) : 0;

  const cudaOk = Boolean(
    report?.cuda_runtime_found
    || report?.supports_cuda_hint
    || gpu?.is_cuda_capable
    || /nvidia|geforce|rtx |gtx /i.test(gpu?.name || ''),
  );
  const vulkanOk = Boolean(report?.supports_vulkan_hint || gpu?.is_vulkan_capable);
  const cpuOk = true;

  const mode = store.defaultParams.gpu_layers;
  const automatic = mode < 0;
  const cpuSafe = mode === 0;

  const applyAutomatic = () => {
    store.setDefaultParams({
      gpu_layers: -1,
      context_size: report?.auto_context_size || report?.recommended_context_size || 4096,
      batch_size: report?.auto_batch_size || report?.recommended_batch_size || 256,
      flash_attention: !!report?.supports_flash_attention,
    });
    const plan = report?.recommended_mode || 'Automatic';
    const layers = report?.auto_gpu_layers ?? report?.recommended_gpu_layers ?? -1;
    if (cudaOk) {
      setMessage(
        `Automatic Optimizer on: prefers CUDA when available (plan: ${plan}, layers ${layers}). `
        + (report?.cuda_runtime_found ? 'CUDA runtime folder found.' : 'Install CUDA runtime if chat stays on CPU.'),
      );
    } else {
      setMessage(`Automatic Optimizer on: ${plan} (no CUDA runtime/GPU detected yet — CPU fallback until CUDA is installed).`);
    }
  };

  const applyCpuSafe = () => {
    store.setDefaultParams({ gpu_layers: 0, context_size: 2048, batch_size: 128, flash_attention: false });
    setMessage('CPU Safe selected: GPU layers 0, context 2048.');
  };

  const selectCpu = () => applyCpuSafe();
  const selectCuda = () => {
    store.setDefaultParams({
      gpu_layers: report?.auto_gpu_layers ?? 999,
      context_size: report?.auto_context_size || 4096,
      batch_size: report?.auto_batch_size || 256,
      flash_attention: !!report?.supports_flash_attention,
    });
    setMessage(cudaOk ? 'CUDA runtime selected for GPU offload.' : 'No CUDA GPU was detected. Settings applied anyway; inference will fall back to CPU.');
  };
  const selectVulkan = () => {
    store.setDefaultParams({
      gpu_layers: report?.auto_gpu_layers ?? 32,
      context_size: report?.recommended_context_size || 4096,
      batch_size: report?.recommended_batch_size || 256,
    });
    setMessage(vulkanOk ? 'Vulkan runtime preferred for GPU acceleration.' : 'Vulkan was not detected on this machine.');
  };

  const installCudaRuntime = async () => {
    setCudaBusy(true);
    setCudaNeedsPath(false);
    setCudaProgress({ phase: 'start', message: 'Preparing CUDA download…', percent: 1 });
    setMessage('Downloading NVIDIA CUDA llama.cpp runtime (large download, often 500+ MB)…');
    try {
      const result = await invoke<{
        ok: boolean;
        message: string;
        install_dir: string;
        server_path?: string;
      }>('install_llama_runtime_backend', { backend: 'cuda' });
      setMessage(result.message + (result.server_path ? ` → ${result.server_path}` : ''));
      setCudaProgress({ phase: 'complete', message: result.message, percent: 100 });
      selectCuda();
      await refresh();
    } catch (err) {
      const text = formatInvokeError(err);
      setMessage(text);
      setCudaNeedsPath(needsWritableDataRoot(err));
      setCudaProgress(prev => ({
        phase: 'error',
        message: text,
        percent: prev?.percent ?? null,
      }));
    } finally {
      setCudaBusy(false);
    }
  };

  const chooseDataFolder = async () => {
    try {
      const saved = await chooseWritableDataRoot({
        title: 'Choose writable folder for CUDA runtimes and models',
      });
      if (!saved) return;
      setCudaNeedsPath(false);
      setMessage(`Data folder set to ${saved.dataRoot}. Retry CUDA download.`);
    } catch (err) {
      setMessage(formatInvokeError(err));
    }
  };

  const llamaReady = Boolean(diag?.llama_server_found || report?.runtime_found);
  const checks = useMemo(() => ([
    { label: 'Backend', ok: llamaReady },
    { label: 'CPU', ok: true },
    { label: 'Memory', ok: (info?.memory.available_bytes || 0) > 512 * 1024 * 1024 },
    { label: 'Model Loading', ok: !store.currentModel || Boolean(diag?.selected_model_exists) || isRemote },
    { label: 'Inference', ok: llamaReady || isRemote },
  ]), [diag, info, llamaReady, store.currentModel, isRemote]);

  return (
    <div className="flex-1 overflow-y-auto p-6 bg-black text-surface-50">
      <div className="max-w-5xl mx-auto space-y-5">
        <div>
          <h1 className="text-2xl font-bold">Hardware &amp; Runtime Manager</h1>
          <p className="text-sm text-surface-400 mt-1">
            PocketMind Hybrid AI automatically selects the best available runtime for your hardware.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <RuntimeCard
            title="CPU"
            icon={<Cpu className="w-7 h-7 text-primary-400" />}
            body="Optimized for broad compatibility. Always available."
            available={cpuOk}
            selected={cpuSafe}
            actionLabel={cpuSafe ? 'Selected (CPU Safe)' : 'Use CPU'}
            onAction={selectCpu}
          />
          <RuntimeCard
            title="NVIDIA CUDA"
            icon={<span className="text-primary-400 font-black text-lg">NVIDIA</span>}
            body="High performance acceleration on NVIDIA GPUs. Store builds ship CPU-only — download CUDA here after install."
            available={cudaOk}
            selected={!cpuSafe && cudaOk && !automatic}
            actionLabel={cudaOk ? (automatic ? 'Ready to Use' : 'Use CUDA') : 'Not detected'}
            onAction={selectCuda}
          />
          <RuntimeCard
            title="Vulkan"
            icon={<Zap className="w-7 h-7 text-primary-400" />}
            body="Cross-platform GPU acceleration with Vulkan."
            available={vulkanOk}
            selected={false}
            actionLabel={vulkanOk ? 'Ready to Use' : 'Not detected'}
            onAction={selectVulkan}
          />
        </div>

        <div className="rounded-sm border border-primary-500/40 bg-[#0c0c0c] p-4 space-y-3">
          <h2 className="font-semibold flex items-center gap-2">
            <Download className="w-4 h-4 text-primary-400" /> Download CUDA runtime (optional)
          </h2>
          <p className="text-xs text-surface-400 leading-relaxed">
            Microsoft Store packages stay CPU-only (policy 10.2.4.2). After install, download the official ggml-org CUDA
            llama.cpp folder into your PocketMind data directory so GPU offload works. Requires an NVIDIA GPU + driver.
            Large download (~500 MB+).
          </p>
          <button
            type="button"
            className="btn-primary text-sm inline-flex items-center gap-2"
            disabled={cudaBusy || busy}
            onClick={() => void installCudaRuntime()}
          >
            <Download className="w-4 h-4" />
            {cudaBusy ? 'Downloading CUDA…' : 'Download / install CUDA llama.cpp'}
          </button>
          {cudaNeedsPath && (
            <button
              type="button"
              className="btn-secondary text-sm inline-flex items-center gap-2 ml-2"
              onClick={() => void chooseDataFolder()}
            >
              <Monitor className="w-4 h-4" />
              Choose writable data folder…
            </button>
          )}
          {(cudaBusy || cudaProgress || message) && (
            <div className={`space-y-2 rounded-sm border p-3 ${
              cudaProgress?.phase === 'stalled' || cudaProgress?.phase === 'retrying'
                ? 'border-amber-500/40 bg-amber-950/20'
                : 'border-transparent'
            }`}>
              <div className={`flex items-start justify-between gap-3 text-xs ${
                cudaProgress?.phase === 'stalled' || cudaProgress?.phase === 'retrying'
                  ? 'text-amber-200'
                  : 'text-primary-200'
              }`}>
                <span className="font-medium break-words min-w-0 flex-1">{cudaProgress?.message || message || 'Preparing…'}</span>
                {typeof cudaProgress?.percent === 'number' && (
                  <span className="tabular-nums shrink-0">{cudaProgress.percent}%</span>
                )}
              </div>
              <div className="h-2 rounded-sm bg-surface-800 overflow-hidden">
                <div
                  className={`h-full transition-[width] duration-300 ${
                    cudaProgress?.phase === 'stalled' || cudaProgress?.phase === 'retrying' ? 'bg-amber-500' : 'bg-primary-500'
                  } ${cudaBusy && cudaProgress?.percent == null ? 'animate-pulse w-1/3' : ''}`}
                  style={{
                    width:
                      typeof cudaProgress?.percent === 'number'
                        ? `${Math.max(0, Math.min(100, cudaProgress.percent))}%`
                        : cudaBusy
                          ? undefined
                          : '0%',
                  }}
                />
              </div>
              <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-surface-500">
                {cudaProgress?.phase && <span>Phase: {cudaProgress.phase}</span>}
                {cudaProgress?.file && (
                  <span className="break-all" title={cudaProgress.file}>{cudaProgress.file}</span>
                )}
                {cudaProgress?.downloaded != null && cudaProgress?.total != null && cudaProgress.total > 0 && (
                  <span className="tabular-nums">
                    {fmtBytes(cudaProgress.downloaded)} / {fmtBytes(cudaProgress.total)}
                  </span>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className="rounded-sm border border-white/10 bg-[#0c0c0c] p-4">
            <div className="flex items-center gap-2 mb-3">
              <Monitor className="w-4 h-4 text-primary-400" />
              <h2 className="font-semibold">Hardware Summary</h2>
            </div>
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between"><dt className="text-surface-400">RAM</dt><dd>{ramGb != null ? `${ramGb} GB` : fmtBytes(info?.memory.total_bytes)}</dd></div>
              <div className="flex justify-between"><dt className="text-surface-400">GPU</dt><dd>{gpu ? `${fmtBytes(gpu.vram_total_bytes)} VRAM` : 'No discrete GPU'}</dd></div>
            </dl>
            <p className="text-xs text-surface-500 mt-3">
              {gpu ? `${gpu.name}` : 'CPU-only machine.'} {vramGb >= 8 || (ramGb || 0) >= 16
                ? 'Your system meets the requirements for supported runtimes.'
                : 'Low VRAM/RAM: prefer CPU Safe and smaller GGUFs.'}
            </p>
          </div>

          <div className="rounded-sm border border-white/10 bg-[#0c0c0c] p-4 space-y-3">
            <h2 className="font-semibold flex items-center gap-2">
              <Zap className="w-4 h-4 text-primary-400" /> Runtime Selection
            </h2>
            <label className="flex items-start gap-2 cursor-pointer">
              <input type="radio" checked={automatic} onChange={applyAutomatic} className="mt-1" />
              <span>
                <span className="block text-sm font-medium">Automatic Optimizer (Recommended)</span>
                <span className="text-xs text-surface-500">PocketMind Hybrid AI will automatically choose the best runtime for each model and task.</span>
              </span>
            </label>
            <label className="flex items-start gap-2 cursor-pointer">
              <input type="radio" checked={cpuSafe} onChange={applyCpuSafe} className="mt-1" />
              <span>
                <span className="block text-sm font-medium">CPU Safe (Maximum Compatibility)</span>
                <span className="text-xs text-surface-500">Use CPU runtime for maximum compatibility across all models.</span>
              </span>
            </label>
          </div>
        </div>

        <div className="rounded-sm border border-white/10 bg-[#0c0c0c] p-4">
          <h2 className="font-semibold mb-3">Local Runtime (llama.cpp)</h2>
          <div className="flex flex-wrap gap-4">
            {checks.map(c => (
              <div key={c.label} className="min-w-[6.5rem]">
                <ReadyPill ok={c.ok} label="Ready" />
                <p className="text-xs text-surface-400 mt-1">{c.label}</p>
              </div>
            ))}
          </div>
          <p className="text-xs text-surface-500 mt-3">
            {llamaReady
              ? 'All systems are operational. Your local runtime is ready.'
              : 'llama-server was not found. Install a CPU/CUDA/Vulkan runtime from Models or Diagnostics → Repair tooling.'}
          </p>
          {diag?.llama_server_path && (
            <p className="text-[11px] font-mono text-surface-500 mt-1 break-all">{diag.llama_server_path}</p>
          )}
          <div className="mt-3 rounded-sm border border-white/10 bg-black/40 p-3 space-y-1 text-xs">
            <p className="font-semibold text-surface-200">Offload status</p>
            <p className="text-surface-400">
              Mode: {automatic ? 'Automatic Optimizer' : cpuSafe ? 'CPU Safe' : `Manual GPU layers (${mode})`}
            </p>
            <p className="text-surface-400">
              Plan: {report?.recommended_mode || '—'}
              {typeof report?.auto_gpu_layers === 'number' ? ` · planned layers ${report.auto_gpu_layers}` : ''}
            </p>
            <p className="text-surface-400">
              CUDA runtime: {report?.cuda_runtime_found ? 'found' : 'not found'}
              {report?.gpu_acceleration_available ? ' · GPU libs available' : ' · GPU libs missing'}
            </p>
            {report?.active_backend && (
              <p className="text-primary-300 break-all">
                Last load: {report.active_backend}
                {typeof report.active_gpu_layers === 'number' ? ` · ngl ${report.active_gpu_layers}` : ''}
                {report.active_launch_label ? ` · ${report.active_launch_label}` : ''}
              </p>
            )}
            {report?.active_runtime_path && (
              <p className="font-mono text-[11px] text-surface-500 break-all">{report.active_runtime_path}</p>
            )}
            {report?.warning && <p className="text-amber-300">{report.warning}</p>}
          </div>
          <button type="button" className="btn-secondary mt-3 text-sm" disabled={busy} onClick={() => void refresh()}>
            {busy ? 'Scanning…' : 'Rescan hardware'}
          </button>
          {message && <p className="text-sm text-primary-300 mt-2">{message}</p>}
        </div>
      </div>
    </div>
  );
}

function RuntimeCard({
  title,
  icon,
  body,
  available,
  selected,
  actionLabel,
  onAction,
}: {
  title: string;
  icon: ReactNode;
  body: string;
  available: boolean;
  selected: boolean;
  actionLabel: string;
  onAction: () => void;
}) {
  return (
    <div className={`rounded-sm border p-4 bg-[#0c0c0c] ${selected ? 'border-primary-500' : 'border-white/10'}`}>
      <div className="flex items-start justify-between gap-2">
        {icon}
        <ReadyPill ok={available} label="Available" />
      </div>
      <h3 className="font-semibold mt-3">{title}</h3>
      <p className="text-xs text-surface-400 mt-1 min-h-[2.5rem]">{body}</p>
      <button
        type="button"
        onClick={onAction}
        className={`mt-3 w-full h-9 rounded-lg text-sm font-semibold border ${
          selected ? 'border-primary-500 text-primary-300' : 'border-white/10 text-surface-200 hover:bg-white/5'
        }`}
      >
        {actionLabel}
      </button>
    </div>
  );
}
