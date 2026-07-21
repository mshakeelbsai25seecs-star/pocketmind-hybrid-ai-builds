import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/tauri';
import {
  Activity, AlertTriangle, CheckCircle, Cpu, Gauge, Monitor,
  RefreshCcw, Rocket, ShieldCheck, Terminal, Zap, XCircle, BrainCircuit
} from 'lucide-react';
import { useAppStore } from '../store';
import { GpuRuntimeCheck, GpuRuntimeReport } from '../types';

function fmtBytes(bytes?: number | null) {
  if (!bytes || bytes <= 0) return 'Unknown';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i ? 1 : 0)} ${units[i]}`;
}

function fileName(path?: string | null) {
  if (!path) return 'No local model selected';
  return path.split(/[\\/]/).pop() || path;
}

export default function RuntimeManager() {
  const store = useAppStore();
  const [report, setReport] = useState<GpuRuntimeReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  const isRemote = store.currentModel?.startsWith('remote:') || false;
  const selectedModelPath = !isRemote ? store.currentModel : null;

  const run = async () => {
    setBusy(true);
    setMessage('');
    try {
      const next = await invoke<GpuRuntimeReport>('get_gpu_runtime_report', {
        selectedModelPath,
      });
      setReport(next);
    } catch (e) {
      setMessage(String(e));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => { run(); }, [store.currentModel]);

  const activeMode = useMemo(() => {
    const layers = store.defaultParams.gpu_layers;
    if (layers < 0) return 'Automatic optimizer';
    if (layers === 0) return 'CPU only';
    if (layers >= 999) return 'Maximum GPU offload';
    return `CPU + GPU split (${layers} layers)`;
  }, [store.defaultParams.gpu_layers]);


  const applyAutoOptimizer = () => {
    store.setDefaultParams({
      gpu_layers: -1,
      context_size: report?.auto_context_size || report?.recommended_context_size || 4096,
      batch_size: report?.auto_batch_size || report?.recommended_batch_size || 256,
      flash_attention: !!report?.supports_flash_attention,
    });
    setMessage('Applied Automatic Optimizer. PocketMind Hybrid AI will try full GPU offload first, then reduce GPU layers automatically, then fall back to CPU if needed.');
  };

  const applyCpuSafe = () => {
    store.setDefaultParams({ gpu_layers: 0, context_size: 2048, batch_size: 128, flash_attention: false });
    setMessage('Applied CPU-safe settings: GPU layers 0, context 2048, batch 128.');
  };

  const applyBalancedGpu = () => {
    const layers = Math.max(0, report?.auto_gpu_layers ?? report?.recommended_gpu_layers ?? 16);
    store.setDefaultParams({
      gpu_layers: layers,
      context_size: report?.auto_context_size || report?.recommended_context_size || 4096,
      batch_size: report?.auto_batch_size || report?.recommended_batch_size || 256,
      flash_attention: !!report?.supports_flash_attention,
    });
    setMessage(`Applied calculated CPU + GPU split: ${layers} GPU layers.`);
  };

  const applyMaxGpu = () => {
    store.setDefaultParams({
      gpu_layers: 999,
      context_size: 4096,
      batch_size: 256,
      flash_attention: !!report?.supports_flash_attention,
    });
    setMessage('Applied maximum GPU plan. The app will still fall back automatically if the engine cannot load the model.');
  };

  const copyReport = async () => {
    const text = [
      'PocketMind Hybrid AI GPU Runtime Report',
      `Runtime path: ${report?.llama_server_path || 'missing'}`,
      `Runtime found: ${report?.runtime_found}`,
      `GPU layers supported: ${report?.supports_gpu_layers}`,
      `GPU acceleration available: ${report?.gpu_acceleration_available}`,
      `CUDA hint: ${report?.supports_cuda_hint}`,
      `Vulkan hint: ${report?.supports_vulkan_hint}`,
      `Metal hint: ${report?.supports_metal_hint}`,
      `Flash attention: ${report?.supports_flash_attention}`,
      `nvidia-smi: ${report?.nvidia_smi_ok}`,
      `vulkaninfo: ${report?.vulkaninfo_ok}`,
      `Selected model: ${selectedModelPath || store.currentModel || 'none'}`,
      `Selected model size: ${fmtBytes(report?.selected_model_size_bytes)}`,
      `Automatic mode: ${report?.recommended_mode || 'unknown'}`,
      `Automatic strategy: ${report?.auto_strategy || 'unknown'}`,
      `Fit status: ${report?.fit_status || 'unknown'}`,
      `Auto GPU layers: ${report?.auto_gpu_layers ?? report?.recommended_gpu_layers ?? 'unknown'}`,
      `Auto context: ${report?.auto_context_size ?? report?.recommended_context_size ?? 'unknown'}`,
      `Auto batch: ${report?.auto_batch_size ?? report?.recommended_batch_size ?? 'unknown'}`,
      `Total VRAM estimate: ${fmtBytes(report?.estimated_total_vram_bytes)}`,
      `Available VRAM estimate: ${fmtBytes(report?.estimated_available_vram_bytes)}`,
      `Available RAM estimate: ${fmtBytes(report?.estimated_available_ram_bytes)}`,
      '',
      ...(report?.checks || []).map(c => `[${c.status.toUpperCase()}] ${c.label}: ${c.message}${c.detail ? ` (${c.detail})` : ''}`)
    ].join('\n');
    await navigator.clipboard.writeText(text);
    setMessage('Engine report copied.');
  };

  return (
    <div className="flex-1 overflow-y-auto p-4 sm:p-6">
      <div className="max-w-7xl mx-auto space-y-6">
        <div className="flex flex-col xl:flex-row xl:items-end xl:justify-between gap-4">
          <div>
            <div className="inline-flex items-center gap-2 rounded-full border border-primary-500/30 bg-primary-500/10 px-3 py-1 text-xs font-bold uppercase tracking-[0.18em] text-primary-600 dark:text-primary-300 mb-3">
              <Monitor className="w-4 h-4" /> Performance
            </div>
            <h1 className="text-3xl sm:text-4xl font-black tracking-tight">Runtime Manager</h1>
            <p className="text-surface-500 mt-2 max-w-3xl">
              Check that the local engine is installed and let PocketMind Hybrid AI pick a safe speed plan. It prefers GPU when available, then a GPU + CPU mix, then CPU-only if needed.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button onClick={run} disabled={busy} className="btn-primary flex items-center gap-2">
              <RefreshCcw className={`w-4 h-4 ${busy ? 'animate-spin' : ''}`} /> Scan engine
            </button>
            <button onClick={copyReport} className="btn-secondary flex items-center gap-2">
              <Terminal className="w-4 h-4" /> Copy report
            </button>
          </div>
        </div>

        {message && <div className="rounded-2xl border border-primary-400/30 bg-primary-50 dark:bg-primary-950/20 p-4 text-sm text-primary-700 dark:text-primary-300">{message}</div>}

        <div className="grid lg:grid-cols-4 gap-4">
          <Metric
            icon={BrainCircuit}
            label="Active mode"
            value={activeMode}
            ok={store.defaultParams.gpu_layers !== 0 && !!report?.gpu_acceleration_available}
          />
          <Metric icon={ShieldCheck} label="Engine" value={report?.runtime_found ? 'Found' : 'Missing'} ok={!!report?.runtime_found} />
          <Metric
            icon={Zap}
            label="GPU speed-up"
            value={report?.gpu_acceleration_available ? 'Ready' : report?.supports_gpu_layers ? 'CPU only' : 'Not available'}
            ok={!!report?.gpu_acceleration_available}
          />
          <Metric
            icon={Gauge}
            label="Auto plan"
            value={report?.recommended_mode || 'Scan needed'}
            ok={!!report?.gpu_acceleration_available && (report?.auto_gpu_layers ?? report?.recommended_gpu_layers ?? 0) !== 0}
          />
        </div>

        <div className="grid xl:grid-cols-[1.1fr_0.9fr] gap-6">
          <div className="glass-panel rounded-3xl p-5 sm:p-6 space-y-5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-2xl font-black">Automatic speed plan</h2>
                <p className="text-sm text-surface-500 mt-1">By default, PocketMind Hybrid AI uses the GPU when it can, a mixed plan when memory is tight, and CPU-only as a fallback. Manual profiles below are for testing.</p>
              </div>
              <span className="rounded-full bg-surface-100 dark:bg-surface-900 px-3 py-1 text-xs font-semibold text-surface-500">{fileName(store.currentModel)}</span>
            </div>

            <div className="grid md:grid-cols-2 xl:grid-cols-4 gap-4">
              <ProfileCard
                icon={BrainCircuit}
                title="Automatic"
                desc="Default. Uses the GPU when available, then eases off if memory is tight, then falls back to CPU."
                details={`${report?.auto_gpu_layers ?? report?.recommended_gpu_layers ?? -1} planned layers • ${report?.fit_status || 'Scan engine for fit status'}`}
                onClick={applyAutoOptimizer}
                button="Use Automatic"
                disabled={!report?.runtime_found}
              />
              <ProfileCard
                icon={Cpu}
                title="CPU Safe"
                desc="Most reliable. Use on CPU-only machines, unknown drivers, or first-run checks."
                details="GPU layers 0 • Context 2048 • Batch 128"
                onClick={applyCpuSafe}
                button="Use CPU Safe"
              />
              <ProfileCard
                icon={Zap}
                title="Balanced split"
                desc="Shares work between GPU and CPU when the model does not fit fully in GPU memory."
                details={`${report?.auto_gpu_layers ?? report?.recommended_gpu_layers ?? 16} GPU layers • Context ${report?.auto_context_size ?? report?.recommended_context_size ?? 4096}`}
                onClick={applyBalancedGpu}
                button="Use Balanced Split"
                disabled={!report?.gpu_acceleration_available}
              />
              <ProfileCard
                icon={Rocket}
                title="Maximum GPU"
                desc="Pushes as much as possible onto the GPU. The app still falls back safely if loading fails."
                details="GPU layers 999 • Context 4096 • Batch 256"
                onClick={applyMaxGpu}
                button="Use Max GPU"
                disabled={!report?.gpu_acceleration_available}
              />
            </div>

            {report?.warning && (
              <div className="rounded-2xl border border-amber-400/30 bg-amber-50 dark:bg-amber-950/20 p-4 flex gap-3 text-amber-800 dark:text-amber-200">
                <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5" />
                <p className="text-sm">{report.warning}</p>
              </div>
            )}

            <div className="rounded-2xl border border-primary-400/20 bg-primary-50/80 dark:bg-primary-950/20 p-4 text-sm">
              <p className="font-bold text-primary-700 dark:text-primary-300">Current plan</p>
              <p className="text-surface-600 dark:text-surface-300 mt-1">{report?.auto_strategy || 'Run Scan engine to calculate the automatic plan.'}</p>
              {report?.fit_status && <p className="text-xs text-surface-500 mt-2">Fit status: {report.fit_status}</p>}
            </div>

            <div className="grid md:grid-cols-2 gap-3 text-sm">
              <Info label="Engine path" value={report?.llama_server_path || 'Missing'} />
              <Info label="Selected local model" value={selectedModelPath || (isRemote ? 'Online model selected — GPU settings do not apply' : 'No local model selected')} />
              <Info label="Selected model size" value={fmtBytes(report?.selected_model_size_bytes)} />
              <Info label="NVIDIA driver" value={report?.nvidia_smi_ok ? 'Detected' : 'Not detected / not NVIDIA'} />
              <Info label="Vulkan check" value={report?.vulkaninfo_ok ? 'Available' : 'Not available'} />
              <Info
                label="GPU speed-up"
                value={report?.gpu_acceleration_available ? 'GPU libraries found' : 'Not available (CPU only)'}
              />
              <Info label="GPU support" value={`CUDA ${report?.supports_cuda_hint ? 'yes' : 'no'} • Vulkan ${report?.supports_vulkan_hint ? 'yes' : 'no'} • Metal ${report?.supports_metal_hint ? 'yes' : 'no'}`} />
              <Info label="macOS engines" value="Apple Silicon: macos-arm64-metal/cpu. Intel Mac: macos-x64-metal/cpu. Metal folders need libggml-metal for GPU." />
              <Info label="GPU memory estimate" value={`${fmtBytes(report?.estimated_available_vram_bytes)} available / ${fmtBytes(report?.estimated_total_vram_bytes)} total`} />
              <Info label="Available system RAM" value={fmtBytes(report?.estimated_available_ram_bytes)} />
            </div>
          </div>

          <div className="glass-panel rounded-3xl p-5 sm:p-6 space-y-4">
            <h2 className="text-2xl font-black">Detected GPUs</h2>
            {(report?.detected_gpus || []).length === 0 && (
              <div className="rounded-2xl border border-dashed border-surface-300 dark:border-surface-700 p-5 text-sm text-surface-500">
                No GPU was detected. CPU mode still works. With the right drivers and bundled engines, PocketMind Hybrid AI can use NVIDIA/AMD/Intel GPU support on Windows/Linux or Metal on Mac.
              </div>
            )}
            {!report?.gpu_acceleration_available && (report?.detected_gpus || []).length > 0 && (
              <div className="rounded-2xl border border-amber-400/30 bg-amber-50 dark:bg-amber-950/20 p-4 text-sm text-amber-800 dark:text-amber-200">
                A GPU was detected, but the bundled engines are CPU-only. Seeing a GPU is not enough — the matching GPU engine files must be installed.
              </div>
            )}
            {(report?.detected_gpus || []).map((gpu, i) => (
              <div key={`${gpu.name}-${i}`} className="rounded-2xl border border-surface-200 dark:border-surface-800 p-4 bg-surface-50 dark:bg-surface-950/60">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="font-bold">{gpu.vendor} {gpu.name}</p>
                    <p className="text-sm text-surface-500">{fmtBytes(gpu.vram_total_bytes)} VRAM • score {gpu.compute_score}</p>
                  </div>
                  <span className={`text-xs rounded-full px-2 py-1 font-bold ${gpu.is_metal_capable || gpu.is_cuda_capable || gpu.is_vulkan_capable ? 'bg-green-500/10 text-green-500' : 'bg-surface-200 dark:bg-surface-800 text-surface-500'}`}>
                    {gpu.is_metal_capable || gpu.is_cuda_capable || gpu.is_vulkan_capable ? 'Can speed up chat' : 'Display GPU only'}
                  </span>
                </div>
                <div className="mt-3 flex flex-wrap gap-2 text-xs">
                  {gpu.is_cuda_capable && <Badge>CUDA</Badge>}
                  {gpu.is_vulkan_capable && <Badge>Vulkan</Badge>}
                  {gpu.is_metal_capable && <Badge>Metal</Badge>}
                  {!gpu.is_cuda_capable && !gpu.is_vulkan_capable && !gpu.is_metal_capable && <Badge>Not used for chat speed-up</Badge>}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="glass-panel rounded-3xl overflow-hidden">
          <div className="p-5 border-b border-surface-200 dark:border-surface-800">
            <h2 className="text-xl font-black">Readiness checks</h2>
          </div>
          <div className="divide-y divide-surface-200 dark:divide-surface-800">
            {(report?.checks || []).map(check => <CheckLine key={check.id} check={check} />)}
            {!report && <div className="p-5 text-surface-500">Scan engine to see checks.</div>}
          </div>
        </div>

        <div className="rounded-3xl border border-surface-200 dark:border-surface-800 bg-surface-50 dark:bg-surface-950 p-5 text-sm text-surface-500">
          <p className="font-bold text-surface-800 dark:text-surface-100 mb-2">How engines are packaged</p>
          <p>
            One app build, with separate engine folders for CPU and GPU. Auto mode picks the fastest safe option on this machine (NVIDIA CUDA, Vulkan, Mac Metal, or CPU). If a model is too large, PocketMind Hybrid AI reports the issue instead of crashing.
          </p>
        </div>
      </div>
    </div>
  );
}

function Metric({ icon: Icon, label, value, ok }: { icon: any; label: string; value: string; ok: boolean }) {
  return (
    <div className="glass-panel rounded-2xl p-5 min-w-0">
      <Icon className={`w-5 h-5 mb-3 ${ok ? 'text-green-500' : 'text-amber-500'}`} />
      <p className="text-xs uppercase tracking-wider text-surface-500 font-semibold">{label}</p>
      <p className="font-bold text-lg truncate">{value}</p>
    </div>
  );
}

function ProfileCard({ icon: Icon, title, desc, details, onClick, button, disabled }: any) {
  return (
    <div className="rounded-2xl border border-surface-200 dark:border-surface-800 bg-surface-50 dark:bg-surface-950/60 p-4 flex flex-col gap-3">
      <Icon className="w-6 h-6 text-primary-500" />
      <div className="flex-1">
        <h3 className="font-black text-lg">{title}</h3>
        <p className="text-sm text-surface-500 mt-1">{desc}</p>
        <p className="text-xs text-surface-400 mt-3">{details}</p>
      </div>
      <button onClick={onClick} disabled={disabled} className="btn-secondary disabled:opacity-50 disabled:cursor-not-allowed w-full">{button}</button>
    </div>
  );
}

function CheckLine({ check }: { check: GpuRuntimeCheck }) {
  const Icon = check.status === 'pass' ? CheckCircle : check.status === 'fail' ? XCircle : check.status === 'warning' ? AlertTriangle : Activity;
  const color = check.status === 'pass' ? 'text-green-500' : check.status === 'fail' ? 'text-red-500' : check.status === 'warning' ? 'text-amber-500' : 'text-primary-500';
  return (
    <div className="p-4 flex items-start gap-3">
      <Icon className={`w-5 h-5 mt-0.5 ${color}`} />
      <div className="min-w-0">
        <p className="font-semibold">{check.label}</p>
        <p className="text-sm text-surface-500">{check.message}</p>
        {check.detail && <p className="text-xs text-surface-400 break-all mt-1 whitespace-pre-wrap">{check.detail}</p>}
      </div>
    </div>
  );
}

function Info({ label, value }: { label: string; value?: string | null }) {
  return <div className="rounded-xl bg-surface-100 dark:bg-surface-900 p-3 min-w-0"><p className="text-xs text-surface-500 mb-1">{label}</p><p className="font-medium break-all">{value || 'Unknown'}</p></div>;
}

function Badge({ children }: { children: ReactNode }) {
  return <span className="rounded-full bg-primary-500/10 text-primary-600 dark:text-primary-300 px-2 py-1 font-bold">{children}</span>;
}
