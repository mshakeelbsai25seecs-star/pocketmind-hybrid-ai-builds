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
    setMessage('Applied Automatic Optimizer. NexusAI will try full GPU offload first, then reduce GPU layers automatically, then fall back to CPU if needed.');
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
    setMessage('Applied maximum GPU offload. The backend will still fall back automatically if the selected runtime cannot load the model.');
  };

  const copyReport = async () => {
    const text = [
      'NexusAI GPU Runtime Report',
      `Runtime path: ${report?.llama_server_path || 'missing'}`,
      `Runtime found: ${report?.runtime_found}`,
      `GPU layers supported: ${report?.supports_gpu_layers}`,
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
    setMessage('GPU runtime report copied.');
  };

  return (
    <div className="flex-1 overflow-y-auto p-4 sm:p-6">
      <div className="max-w-7xl mx-auto space-y-6">
        <div className="flex flex-col xl:flex-row xl:items-end xl:justify-between gap-4">
          <div>
            <div className="inline-flex items-center gap-2 rounded-full border border-primary-500/30 bg-primary-500/10 px-3 py-1 text-xs font-bold uppercase tracking-[0.18em] text-primary-600 dark:text-primary-300 mb-3">
              <Monitor className="w-4 h-4" /> Runtime Control
            </div>
            <h1 className="text-3xl sm:text-4xl font-black tracking-tight">Universal Runtime Manager</h1>
            <p className="text-surface-500 mt-2 max-w-3xl">
              Verify bundled llama.cpp runtimes and let NexusAI choose the safest high-performance launch plan automatically. On Windows it can use CPU, CUDA, or Vulkan runtimes; on macOS it can use CPU or Metal runtimes. The optimizer prioritizes full GPU offload, then CPU + GPU split, then CPU fallback if the selected model or drivers cannot support GPU loading.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button onClick={run} disabled={busy} className="btn-primary flex items-center gap-2">
              <RefreshCcw className={`w-4 h-4 ${busy ? 'animate-spin' : ''}`} /> Scan runtime
            </button>
            <button onClick={copyReport} className="btn-secondary flex items-center gap-2">
              <Terminal className="w-4 h-4" /> Copy report
            </button>
          </div>
        </div>

        {message && <div className="rounded-2xl border border-primary-400/30 bg-primary-50 dark:bg-primary-950/20 p-4 text-sm text-primary-700 dark:text-primary-300">{message}</div>}

        <div className="grid lg:grid-cols-4 gap-4">
          <Metric icon={BrainCircuit} label="Active mode" value={activeMode} ok={store.defaultParams.gpu_layers !== 0} />
          <Metric icon={ShieldCheck} label="Runtime" value={report?.runtime_found ? 'Found' : 'Missing'} ok={!!report?.runtime_found} />
          <Metric icon={Zap} label="GPU flags" value={report?.supports_gpu_layers ? 'Available' : 'Not confirmed'} ok={!!report?.supports_gpu_layers} />
          <Metric icon={Gauge} label="Auto plan" value={report?.recommended_mode || 'Scan needed'} ok={(report?.auto_gpu_layers ?? report?.recommended_gpu_layers ?? 0) !== 0} />
        </div>

        <div className="grid xl:grid-cols-[1.1fr_0.9fr] gap-6">
          <div className="glass-panel rounded-3xl p-5 sm:p-6 space-y-5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-2xl font-black">Automatic launch strategy</h2>
                <p className="text-sm text-surface-500 mt-1">NexusAI now defaults to an automatic optimizer: full GPU offload first, calculated CPU + GPU split second, and CPU fallback last. Manual profiles remain available for validation and troubleshooting.</p>
              </div>
              <span className="rounded-full bg-surface-100 dark:bg-surface-900 px-3 py-1 text-xs font-semibold text-surface-500">{fileName(store.currentModel)}</span>
            </div>

            <div className="grid md:grid-cols-2 xl:grid-cols-4 gap-4">
              <ProfileCard
                icon={BrainCircuit}
                title="Automatic Optimizer"
                desc="Default setting. Uses GPU when available, then reduces GPU layers, then falls back to CPU if needed."
                details={`${report?.auto_gpu_layers ?? report?.recommended_gpu_layers ?? -1} planned layers • ${report?.fit_status || 'Scan runtime for fit status'}`}
                onClick={applyAutoOptimizer}
                button="Use Automatic Optimizer"
                disabled={!report?.runtime_found}
              />
              <ProfileCard
                icon={Cpu}
                title="CPU Safe"
                desc="Most reliable. Use this for CPU-only devices, unknown drivers, or first-run validation."
                details="GPU layers 0 • Context 2048 • Batch 128"
                onClick={applyCpuSafe}
                button="Use CPU Safe"
              />
              <ProfileCard
                icon={Zap}
                title="Calculated Split"
                desc="Uses the automatic fit calculation directly when full GPU memory is not enough. Good for large models on mixed CPU+GPU systems."
                details={`${report?.auto_gpu_layers ?? report?.recommended_gpu_layers ?? 16} GPU layers • Context ${report?.auto_context_size ?? report?.recommended_context_size ?? 4096}`}
                onClick={applyBalancedGpu}
                button="Use Calculated Split"
                disabled={!report?.supports_gpu_layers}
              />
              <ProfileCard
                icon={Rocket}
                title="Force Maximum GPU"
                desc="For qualified hardware and enterprise workstations. Attempts maximum offload while backend fallback still protects the app if loading fails."
                details="GPU layers 999 • Context 4096 • Batch 256"
                onClick={applyMaxGpu}
                button="Use Max GPU"
                disabled={!report?.supports_gpu_layers}
              />
            </div>

            {report?.warning && (
              <div className="rounded-2xl border border-amber-400/30 bg-amber-50 dark:bg-amber-950/20 p-4 flex gap-3 text-amber-800 dark:text-amber-200">
                <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5" />
                <p className="text-sm">{report.warning}</p>
              </div>
            )}

            <div className="rounded-2xl border border-primary-400/20 bg-primary-50/80 dark:bg-primary-950/20 p-4 text-sm">
              <p className="font-bold text-primary-700 dark:text-primary-300">Automatic strategy</p>
              <p className="text-surface-600 dark:text-surface-300 mt-1">{report?.auto_strategy || 'Run Scan runtime to calculate the automatic launch plan.'}</p>
              {report?.fit_status && <p className="text-xs text-surface-500 mt-2">Fit status: {report.fit_status}</p>}
            </div>

            <div className="grid md:grid-cols-2 gap-3 text-sm">
              <Info label="llama-server path" value={report?.llama_server_path || 'Missing'} />
              <Info label="Selected local model" value={selectedModelPath || (isRemote ? 'Online model selected — GPU settings do not apply' : 'No local model selected')} />
              <Info label="Selected model size" value={fmtBytes(report?.selected_model_size_bytes)} />
              <Info label="NVIDIA driver" value={report?.nvidia_smi_ok ? 'nvidia-smi works' : 'Not detected / not NVIDIA'} />
              <Info label="Vulkan diagnostics" value={report?.vulkaninfo_ok ? 'vulkaninfo works' : 'vulkaninfo unavailable'} />
              <Info label="Backend hints" value={`CUDA ${report?.supports_cuda_hint ? 'yes' : 'unknown'} • Vulkan ${report?.supports_vulkan_hint ? 'yes' : 'unknown'} • Metal ${report?.supports_metal_hint ? 'yes' : 'unknown'}`} />
              <Info label="macOS runtime layout" value="Use macos-arm64-metal/cpu for Apple Silicon and macos-x64-metal/cpu for Intel Macs. Legacy macos-metal/cpu folders still work." />
              <Info label="Combined VRAM estimate" value={`${fmtBytes(report?.estimated_available_vram_bytes)} available / ${fmtBytes(report?.estimated_total_vram_bytes)} total`} />
              <Info label="Available system RAM" value={fmtBytes(report?.estimated_available_ram_bytes)} />
            </div>
          </div>

          <div className="glass-panel rounded-3xl p-5 sm:p-6 space-y-4">
            <h2 className="text-2xl font-black">Detected GPUs</h2>
            {(report?.detected_gpus || []).length === 0 && (
              <div className="rounded-2xl border border-dashed border-surface-300 dark:border-surface-700 p-5 text-sm text-surface-500">
                No GPU was detected by the current scanner. CPU mode remains fully supported. If a supported GPU is available and the correct drivers/runtimes are bundled, NexusAI can use CUDA/Vulkan on Windows/Linux or the matching Metal runtime on macOS.
              </div>
            )}
            {(report?.detected_gpus || []).map((gpu, i) => (
              <div key={`${gpu.name}-${i}`} className="rounded-2xl border border-surface-200 dark:border-surface-800 p-4 bg-surface-50 dark:bg-surface-950/60">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="font-bold">{gpu.vendor} {gpu.name}</p>
                    <p className="text-sm text-surface-500">{fmtBytes(gpu.vram_total_bytes)} VRAM • score {gpu.compute_score}</p>
                  </div>
                  <span className="text-xs rounded-full bg-green-500/10 text-green-500 px-2 py-1 font-bold">Detected</span>
                </div>
                <div className="mt-3 flex flex-wrap gap-2 text-xs">
                  {gpu.is_cuda_capable && <Badge>CUDA capable</Badge>}
                  {gpu.is_vulkan_capable && <Badge>Vulkan capable</Badge>}
                  {gpu.is_metal_capable && <Badge>Metal capable</Badge>}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="glass-panel rounded-3xl overflow-hidden">
          <div className="p-5 border-b border-surface-200 dark:border-surface-800">
            <h2 className="text-xl font-black">GPU readiness checks</h2>
          </div>
          <div className="divide-y divide-surface-200 dark:divide-surface-800">
            {(report?.checks || []).map(check => <CheckLine key={check.id} check={check} />)}
            {!report && <div className="p-5 text-surface-500">Scan runtime to see checks.</div>}
          </div>
        </div>

        <div className="rounded-3xl border border-surface-200 dark:border-surface-800 bg-surface-50 dark:bg-surface-950 p-5 text-sm text-surface-500">
          <p className="font-bold text-surface-800 dark:text-surface-100 mb-2">Universal runtime packaging</p>
          <p>
            NexusAI uses one application build with separate runtime folders. Auto mode prioritizes the fastest safe launch path available on the current machine: CUDA for NVIDIA on Windows/Linux, Vulkan where available, Metal on macOS, then CPU fallback. Large models remain available for organizations with qualified hardware; if a machine cannot load them, NexusAI reports the fit issue instead of removing the model or crashing.
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
