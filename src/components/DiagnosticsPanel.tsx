import { useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/tauri';
import { AlertTriangle, CheckCircle, ClipboardCopy, Cpu, HardDrive, RefreshCcw, ShieldAlert, ShieldCheck, Terminal, Wrench, XCircle, Hammer } from 'lucide-react';
import { useAppStore } from '../store';
import { RuntimeDiagnostics } from '../types';
import { cwListRunners } from '../api/codeWorkspace';
import { getToolingStatus, repairTooling } from '../api/powerFeatures';
import type { RunnersStatus, ToolingStatus } from '../codeWorkspace/types';

function fmtBytes(bytes?: number | null) {
  if (!bytes || bytes <= 0) return 'Unknown';
  const units = ['B','KB','MB','GB','TB']; let v = bytes; let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i ? 1 : 0)} ${units[i]}`;
}

const BUNDLED_TOOL_IDS = new Set(['python', 'node', 'rg', 'ripgrep', 'javascript']);

const HOST_INSTALL_COMMANDS: Record<string, string> = {
  python: 'Install Python 3 from https://www.python.org/downloads/ (or use Repair bundled tooling in Diagnostics).',
  node: 'Install Node.js from https://nodejs.org/ (or use Repair bundled tooling in Diagnostics).',
  javascript: 'Install Node.js from https://nodejs.org/ (or use Repair bundled tooling in Diagnostics).',
  rg: 'Install ripgrep: cargo install ripgrep  # Windows: choco install ripgrep  macOS: brew install ripgrep',
  ripgrep: 'Install ripgrep: cargo install ripgrep  # Windows: choco install ripgrep  macOS: brew install ripgrep',
  cargo: 'curl --proto "=https" --tlsv1.2 -sSf https://sh.rustup.rs | sh',
  npm: 'Install Node.js from https://nodejs.org/ (includes npm).',
  npx: 'Install Node.js from https://nodejs.org/ (includes npx).',
  yarn: 'npm install -g yarn',
  pnpm: 'npm install -g pnpm',
  bun: 'curl -fsSL https://bun.sh/install | bash',
  deno: 'curl -fsSL https://deno.land/install.sh | sh',
  go: 'Install Go from https://go.dev/dl/',
  java: 'Install a JDK (Temurin/OpenJDK) and ensure javac/java are on PATH.',
  dotnet: 'Install .NET SDK from https://dotnet.microsoft.com/download',
  pip: 'python -m ensurepip --upgrade  # then: python -m pip install --upgrade pip',
  pytest: 'python -m pip install pytest',
  make: 'Install build tools for your OS (Xcode CLT, build-essential, or Visual Studio Build Tools).',
  cmake: 'Install CMake from https://cmake.org/download/',
  gcc: 'Install GCC/clang build tools for your OS.',
  flutter: 'Install Flutter SDK from https://docs.flutter.dev/get-started/install',
  git: 'Install Git from https://git-scm.com/downloads',
};

function hostInstallCommand(runnerId: string): string {
  return HOST_INSTALL_COMMANDS[runnerId]
    || `Install ${runnerId} and ensure it is on PATH for PocketCode runners.`;
}

function bundledToolLabel(tool: 'rg' | 'python' | 'node'): string {
  if (tool === 'rg') return 'Ripgrep';
  if (tool === 'python') return 'Python';
  return 'Node';
}

export default function DiagnosticsPanel() {
  const store = useAppStore();
  const [diag, setDiag] = useState<RuntimeDiagnostics | null>(null);
  const [tooling, setTooling] = useState<ToolingStatus | null>(null);
  const [runners, setRunners] = useState<RunnersStatus | null>(null);
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

  useEffect(() => { run(); void loadTooling(); }, []);

  const loadTooling = async () => {
    try {
      setTooling(await getToolingStatus());
    } catch {
      setTooling(null);
    }
    try {
      setRunners(await cwListRunners());
    } catch {
      setRunners(null);
    }
  };

  const rescanRunners = async () => {
    setBusy(true);
    setMessage('Re-scanning allowlisted runners…');
    try {
      setRunners(await cwListRunners());
      setMessage('Runner scan complete.');
    } catch (e) {
      setMessage(String(e));
    } finally {
      setBusy(false);
    }
  };

  const repairBundledTooling = async () => {
    setBusy(true);
    setMessage('Repairing bundled tooling…');
    try {
      const status = await repairTooling();
      setTooling(status);
      setRunners(await cwListRunners());
      setMessage(status.message);
    } catch (e) {
      setMessage(String(e));
    } finally {
      setBusy(false);
    }
  };

  const copyInstallCommand = async (runnerId: string) => {
    const cmd = hostInstallCommand(runnerId);
    await navigator.clipboard.writeText(cmd);
    setMessage(`Copied install notes for ${runnerId}.`);
  };

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

  const runTokPerSec = async () => {
    if (!store.currentModel) {
      setMessage('Select a model in Models first, then run the tok/s test.');
      return;
    }
    setBusy(true);
    setMessage('Running tok/s benchmark…');
    const started = performance.now();
    try {
      const isRemote = store.currentModel.startsWith('remote:') || store.currentModel.startsWith('enterprise:');
      const chunk = await invoke<{ text: string; tokens_generated: number; tokens_per_sec: number }>('generate_response', {
        request: {
          prompt: 'Count from 1 to 20 in words, then stop.',
          system_prompt: null,
          params: {
            ...store.defaultParams,
            max_tokens: 64,
            temperature: 0.2,
          },
          model_path: store.currentModel,
          backend: isRemote ? (store.currentModel.startsWith('enterprise:') ? 'enterprise' : 'remote') : 'local',
          messages: [{ role: 'user', content: 'Count from 1 to 20 in words, then stop.' }],
        },
      });
      const elapsed = (performance.now() - started) / 1000;
      const reported = chunk.tokens_per_sec || 0;
      const approx = chunk.tokens_generated > 0 && elapsed > 0
        ? chunk.tokens_generated / elapsed
        : (chunk.text?.length || 0) / 4 / Math.max(elapsed, 0.001);
      setMessage(
        reported > 0
          ? `≈ ${reported.toFixed(1)} tok/s (engine) · ${approx.toFixed(1)} tok/s wall · ${chunk.tokens_generated || 0} tokens in ${elapsed.toFixed(1)}s`
          : `≈ ${approx.toFixed(1)} tok/s wall · ${chunk.tokens_generated || Math.round((chunk.text?.length || 0) / 4)} tokens in ${elapsed.toFixed(1)}s`
      );
    } catch (e) {
      setMessage(String(e));
    } finally {
      setBusy(false);
    }
  };

  const bundledTools: Array<{ id: 'rg' | 'python' | 'node'; ok: boolean; path: string | null }> = tooling
    ? [
        { id: 'rg', ok: tooling.rg_ok, path: tooling.rg_path },
        { id: 'python', ok: tooling.python_ok, path: tooling.python_path },
        { id: 'node', ok: tooling.node_ok, path: tooling.node_path },
      ]
    : [];

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
            <button onClick={runTokPerSec} className="btn-secondary flex items-center gap-2" disabled={busy}><Cpu className="w-4 h-4" /> Run tok/s test</button>
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

        <div className="glass-panel rounded-2xl p-5 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="font-bold text-xl flex items-center gap-2"><Hammer className="w-5 h-5 text-primary-500" /> PocketCode tooling</h2>
            <div className="flex gap-2">
              <button onClick={() => void loadTooling()} className="btn-secondary text-sm" disabled={busy}>Refresh</button>
              <button onClick={() => void rescanRunners()} className="btn-secondary text-sm" disabled={busy}>Re-scan runners</button>
              <button onClick={() => void repairBundledTooling()} className="btn-primary text-sm" disabled={busy}>Repair all bundled</button>
            </div>
          </div>
          {tooling ? (
            <div className="grid md:grid-cols-3 gap-3 text-sm">
              {bundledTools.map(tool => (
                <div
                  key={tool.id}
                  className={`rounded-xl p-3 border ${tool.ok ? 'border-emerald-300/40 bg-emerald-50/50 dark:bg-emerald-950/20' : 'border-surface-300/60 bg-surface-100/80 dark:bg-surface-900/60 opacity-80'}`}
                >
                  <p className="text-xs text-surface-500 mb-1">{bundledToolLabel(tool.id)}</p>
                  <p className="font-medium break-all text-sm">{tool.ok ? tool.path : 'Missing'}</p>
                  {!tool.ok && (
                    <button
                      type="button"
                      onClick={() => void repairBundledTooling()}
                      disabled={busy}
                      className="btn-secondary text-xs mt-2 w-full"
                      title="Copy bundled python/node/rg from app resources into runtime-data/tooling"
                    >
                      Install / Repair
                    </button>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-surface-500">Tooling status unavailable. Run Repair tooling after `scripts/fetch-tooling`.</p>
          )}
          {tooling?.message && <p className="text-xs text-surface-500">{tooling.message}</p>}
          <div className="text-xs text-surface-500 space-y-0.5 pt-1">
            <p>
              PocketCode backend:{' '}
              {store.currentModel?.startsWith('enterprise:')
                ? 'org server (chat completions)'
                : store.currentModel?.startsWith('remote:')
                  ? 'online'
                  : store.currentModel
                    ? 'local'
                    : 'none'}
            </p>
            {store.generationError && (
              <p className="text-amber-700 dark:text-amber-300">Last generation error: {store.generationError}</p>
            )}
          </div>
          {runners && (
            <div className="space-y-2 pt-2 border-t border-surface-200 dark:border-surface-800">
              <p className="text-sm font-semibold">Allowlisted runners</p>
              <p className="text-xs text-surface-500">{runners.message}</p>
              <div className="max-h-48 overflow-y-auto grid sm:grid-cols-2 gap-2 text-xs">
                {runners.runners.map(r => {
                  const bundled = BUNDLED_TOOL_IDS.has(r.id);
                  return (
                    <div
                      key={r.id}
                      className={`rounded-lg px-2 py-1.5 flex items-center justify-between gap-2 ${r.available ? 'text-primary-700 dark:text-primary-300' : 'text-surface-400 bg-surface-100/70 dark:bg-surface-900/50'}`}
                      title={r.binary || r.note}
                    >
                      <span className="truncate font-mono">
                        {r.available ? '✓' : '·'} {r.id}
                        <span className="text-surface-500"> ({r.kind})</span>
                      </span>
                      {!r.available && !bundled && (
                        <button
                          type="button"
                          className="btn-secondary text-[10px] py-0.5 px-1.5 shrink-0"
                          onClick={() => void copyInstallCommand(r.id)}
                          title="Copy host install command"
                        >
                          Copy install
                        </button>
                      )}
                      {!r.available && bundled && (
                        <button
                          type="button"
                          className="btn-secondary text-[10px] py-0.5 px-1.5 shrink-0"
                          onClick={() => void repairBundledTooling()}
                          disabled={busy}
                          title="Install bundled tooling via tooling_repair"
                        >
                          Install / Repair
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
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
