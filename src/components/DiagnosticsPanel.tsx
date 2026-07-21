import { useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/tauri';
import { AlertTriangle, CheckCircle, ClipboardCopy, Cpu, HardDrive, RefreshCcw, ShieldAlert, ShieldCheck, Terminal, Wrench, XCircle } from 'lucide-react';
import { useAppStore } from '../store';
import { RuntimeDiagnostics } from '../types';

function fmtBytes(bytes?: number | null) {
  if (!bytes || bytes <= 0) return 'Unknown';
  const units = ['B','KB','MB','GB','TB']; let v = bytes; let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i ? 1 : 0)} ${units[i]}`;
}

export default function DiagnosticsPanel() {
  const store = useAppStore();
  const [diag, setDiag] = useState<RuntimeDiagnostics | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  const run = async () => {
    setBusy(true); setMessage('');
    try {
      const d = await invoke<RuntimeDiagnostics>('get_runtime_diagnostics', { selectedModelPath: store.currentModel || null, modelsDir: store.modelsDir });
      setDiag(d);
    } catch (e) {
      setMessage(String(e));
    } finally { setBusy(false); }
  };

  useEffect(() => { run(); }, []);

  const report = useMemo(() => {
    if (!diag) return '';
    return [
      'PocketMind Hybrid AI Diagnostics Report',
      `App version: ${diag.app_version}`,
      `Current dir: ${diag.current_dir}`,
      `Executable dir: ${diag.executable_dir}`,
      `llama-server found: ${diag.llama_server_found}`,
      `Runtime path: ${diag.llama_server_path || 'missing'}`,
      `llama-server help OK: ${diag.llama_server_help_ok}`,
      `Selected model: ${diag.selected_model_path || 'none'}`,
      `Selected model exists: ${diag.selected_model_exists}`,
      `Selected model size: ${fmtBytes(diag.selected_model_size_bytes)}`,
      `Models folder exists: ${diag.models_dir_exists}`,
      `CPU: ${diag.cpu_brand || 'unknown'}`,
      `Memory available: ${fmtBytes(diag.memory_available_bytes)} / ${fmtBytes(diag.memory_total_bytes)}`,
      `GPUs: ${diag.gpu_summary.join(', ') || 'none detected'}`,
      '',
      ...diag.checks.map(c => `[${c.status.toUpperCase()}] ${c.label}: ${c.message}${c.detail ? ` (${c.detail})` : ''}`)
    ].join('\n');
  }, [diag]);

  const copyReport = async () => {
    await navigator.clipboard.writeText(report || 'No diagnostics report available yet.');
    setMessage('Diagnostics report copied to clipboard.');
  };

  const killEngine = async () => {
    setBusy(true);
    try {
      await invoke('kill_llama_servers');
      setMessage('Stopped running local engine processes. Run checks again before starting a new generation.');
      await run();
    } catch (e) { setMessage(String(e)); }
    finally { setBusy(false); }
  };

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="max-w-6xl mx-auto space-y-6">
        <div className="flex flex-col lg:flex-row lg:items-end lg:justify-between gap-4">
          <div>
            <h1 className="text-3xl font-black flex items-center gap-2"><Wrench className="w-7 h-7 text-primary-500" /> Diagnostics & Recovery</h1>
            <p className="text-surface-500 mt-1">Run these checks before sharing a build or when a tester reports a runtime, model, GPU, or file issue.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button onClick={run} className="btn-primary flex items-center gap-2" disabled={busy}><RefreshCcw className={`w-4 h-4 ${busy ? 'animate-spin' : ''}`} /> Run checks</button>
            <button onClick={killEngine} className="btn-secondary flex items-center gap-2"><Terminal className="w-4 h-4" /> Stop Local Engine</button>
            <button onClick={copyReport} className="btn-secondary flex items-center gap-2"><ClipboardCopy className="w-4 h-4" /> Copy report</button>
          </div>
        </div>

        {message && <div className="rounded-xl border border-primary-400/30 bg-primary-50 dark:bg-primary-950/20 p-3 text-sm text-primary-700 dark:text-primary-300">{message}</div>}

        <div className="grid md:grid-cols-2 xl:grid-cols-4 gap-4">
          <Metric icon={HardDrive} label="llama-server" value={diag?.llama_server_found ? 'Found' : 'Missing'} ok={!!diag?.llama_server_found} />
          <Metric icon={ShieldCheck} label="Runtime health" value={diag?.llama_server_help_ok ? 'OK' : 'Check required'} ok={!!diag?.llama_server_help_ok} />
          <Metric icon={Cpu} label="Memory available" value={fmtBytes(diag?.memory_available_bytes)} ok={(diag?.memory_available_bytes || 0) > 4_000_000_000} />
          <Metric icon={HardDrive} label="Selected model" value={diag?.selected_model_exists ? 'Valid' : 'Not ready'} ok={!!diag?.selected_model_exists} />
        </div>

        <div className="glass-panel rounded-2xl overflow-hidden">
          <div className="p-5 border-b border-surface-200 dark:border-surface-800"><h2 className="font-bold text-xl">Checks</h2></div>
          <div className="divide-y divide-surface-200 dark:divide-surface-800">
            {(diag?.checks || []).map(check => <CheckLine key={check.id} check={check} />)}
            {!diag && <div className="p-5 text-surface-500">Run diagnostics to see checks.</div>}
          </div>
        </div>

        <div className="glass-panel rounded-2xl p-5">
          <h2 className="font-bold text-xl mb-3">System details</h2>
          <div className="grid md:grid-cols-2 gap-3 text-sm">
            <Info label="Current dir" value={diag?.current_dir} />
            <Info label="Executable dir" value={diag?.executable_dir} />
            <Info label="Runtime path" value={diag?.llama_server_path || diag?.llama_server_error} />
            <Info label="Selected model" value={diag?.selected_model_path} />
            <Info label="Model size" value={fmtBytes(diag?.selected_model_size_bytes)} />
            <Info label="CPU" value={diag?.cpu_brand} />
            <Info label="GPUs" value={diag?.gpu_summary.join(' | ')} />
            <Info label="Free disk" value={fmtBytes(diag?.free_disk_bytes)} />
          </div>
        </div>
      </div>
    </div>
  );
}

function Metric({ icon: Icon, label, value, ok }: { icon: any; label: string; value: string; ok: boolean }) {
  return <div className="glass-panel rounded-2xl p-5"><Icon className={`w-5 h-5 mb-3 ${ok ? 'text-green-500' : 'text-amber-500'}`} /><p className="text-xs uppercase tracking-wider text-surface-500 font-semibold">{label}</p><p className="font-bold text-lg truncate">{value}</p></div>;
}
function CheckLine({ check }: { check: any }) {
  const Icon = check.status === 'pass' ? CheckCircle : check.status === 'fail' ? XCircle : check.status === 'warning' ? AlertTriangle : ShieldAlert;
  const color = check.status === 'pass' ? 'text-green-500' : check.status === 'fail' ? 'text-red-500' : check.status === 'warning' ? 'text-amber-500' : 'text-primary-500';
  return <div className="p-4 flex items-start gap-3"><Icon className={`w-5 h-5 mt-0.5 ${color}`} /><div><p className="font-semibold">{check.label}</p><p className="text-sm text-surface-500">{check.message}</p>{check.detail && <p className="text-xs text-surface-400 break-all mt-1">{check.detail}</p>}</div></div>;
}
function Info({ label, value }: { label: string; value?: string | null }) {
  return <div className="rounded-xl bg-surface-100 dark:bg-surface-900 p-3"><p className="text-xs text-surface-500 mb-1">{label}</p><p className="font-medium break-all">{value || 'Unknown'}</p></div>;
}
