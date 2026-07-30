import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/tauri';
import { open } from '@tauri-apps/api/dialog';
import { ArrowRight, CheckCircle, Download, FolderSearch, HardDrive, Library, ShieldCheck, Sparkles, Wrench } from 'lucide-react';
import { useAppStore } from '../store';
import { LocalModelRecord, RuntimeDiagnostics } from '../types';
import SupportModelsPanel from './SupportModelsPanel';

export default function SetupWizard() {
  const store = useAppStore();
  const [step, setStep] = useState(0);
  const [diag, setDiag] = useState<RuntimeDiagnostics | null>(null);
  const [busy, setBusy] = useState(false);
  const steps = ['Welcome', 'Engine check', 'Models folder', 'First model', 'Support models', 'Ready'];

  const refresh = async () => {
    setBusy(true);
    try {
      const d = await invoke<RuntimeDiagnostics>('get_runtime_diagnostics', {
        selectedModelPath: store.currentModel || null,
        modelsDir: store.modelsDir,
      });
      setDiag(d);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => { refresh().catch(console.error); }, []);

  const chooseFolder = async () => {
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected === 'string') store.setModelsDir(selected);
  };

  const importModel = async () => {
    const selected = await open({ multiple: false, filters: [{ name: 'GGUF model', extensions: ['gguf'] }] });
    if (typeof selected !== 'string') return;
    const model = await invoke<LocalModelRecord>('import_local_model', { path: selected });
    store.setCurrentModel(model.path);
    const models = await invoke<LocalModelRecord[]>('get_local_models');
    store.setLocalModels(models);
    await refresh();
  };

  const finish = () => {
    store.setSetupCompleted(true);
    store.setActiveView('home');
  };

  const lastStep = steps.length - 1;

  return (
    <div className="flex-1 overflow-y-auto p-6 bg-[radial-gradient(circle_at_top_left,rgba(14,165,233,0.18),transparent_38%)]">
      <div className="max-w-4xl mx-auto space-y-6">
        <div className="glass-panel rounded-3xl p-7">
          <div className="flex items-center gap-3 mb-6">
            <div className="w-12 h-12 rounded-2xl bg-primary-500 text-white flex items-center justify-center"><Sparkles className="w-6 h-6" /></div>
            <div>
              <h1 className="text-3xl font-black">PocketMind Hybrid AI setup</h1>
              <p className="text-surface-500">Check the local engine, set your models folder, import a chat model, and optionally download embeddings / OCR.</p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2 mb-8">
            {steps.map((s, i) => <span key={s} className={`px-3 py-1 rounded-full text-xs font-semibold ${i <= step ? 'bg-primary-500 text-white' : 'bg-surface-100 dark:bg-surface-800 text-surface-500'}`}>{i + 1}. {s}</span>)}
          </div>

          {step === 0 && <Panel icon={Sparkles} title="Welcome to PocketMind Hybrid AI Desktop" desc="This wizard checks that the local engine is ready, confirms your models folder, helps you import the first chat model, and offers downloads for Knowledge Chat embeddings, reranker, and optional Unlimited-OCR. You can skip downloads and do them later in Settings." />}
          {step === 1 && <Panel icon={Wrench} title="Engine check" desc="PocketMind Hybrid AI needs its local engine files (llama-server) under bin/llama.cpp or next to the app.">
            <button onClick={refresh} className="btn-secondary mb-4" disabled={busy}>{busy ? 'Checking...' : 'Run check'}</button>
            <CheckRow ok={!!diag?.llama_server_found} label="Local engine found" detail={diag?.llama_server_path || diag?.llama_server_error || 'Not checked yet'} />
            <CheckRow ok={!!diag?.llama_server_help_ok} label="Local engine can start" detail={diag?.llama_server_help_ok ? 'Startup check succeeded.' : 'Copy the matching llama-server files from the same release package.'} />
          </Panel>}
          {step === 2 && <Panel icon={FolderSearch} title="Choose models folder" desc="This is where PocketMind Hybrid AI looks for chat models and where embeddings/rerankers will be downloaded.">
            <div className="grid md:grid-cols-[1fr_auto] gap-3">
              <input className="input-field" value={store.modelsDir} onChange={e => store.setModelsDir(e.target.value)} />
              <button onClick={chooseFolder} className="btn-secondary">Browse</button>
            </div>
          </Panel>}
          {step === 3 && <Panel icon={HardDrive} title="Import or download the first chat model" desc="Start with a small general chat model (for example Phi-3 Mini or Qwen). You can also open Models later to download from the catalog.">
            <div className="flex flex-wrap gap-2">
              <button onClick={importModel} className="btn-primary flex items-center gap-2"><Download className="w-4 h-4" /> Import GGUF</button>
              <button onClick={() => store.setActiveView('models')} className="btn-secondary flex items-center gap-2"><Download className="w-4 h-4" /> Open Models catalog</button>
            </div>
            <p className="text-sm text-surface-500 mt-3 break-all">Selected: {store.currentModel || 'None yet'}</p>
          </Panel>}
          {step === 4 && <Panel icon={Library} title="Knowledge Chat & OCR models (optional)" desc="Download embeddings, reranker, and optional Unlimited-OCR weights. Not required for basic chat. Large files download on demand — nothing is bundled in the installer.">
            <SupportModelsPanel compact />
            <p className="text-xs text-surface-500 mt-3">You can return anytime under Settings → Deployment (same download list) or Settings → Security (OCR details).</p>
          </Panel>}
          {step === 5 && <Panel icon={ShieldCheck} title="You are ready" desc="Setup is complete. Open Diagnostics if you want a health check, or finish and start using the app.">
            <div className="grid sm:grid-cols-2 gap-3">
              <button onClick={() => store.setActiveView('diagnostics')} className="btn-secondary">Open Diagnostics</button>
              <button onClick={finish} className="btn-primary">Finish setup</button>
            </div>
          </Panel>}

          <div className="flex items-center justify-between pt-8">
            <button onClick={() => store.setActiveView('home')} className="btn-secondary">Skip for now</button>
            <div className="flex gap-2">
              <button onClick={() => setStep(s => Math.max(0, s - 1))} disabled={step === 0} className="btn-secondary disabled:opacity-50">Back</button>
              {step < lastStep
                ? <button onClick={() => setStep(s => Math.min(lastStep, s + 1))} className="btn-primary flex items-center gap-2">Next <ArrowRight className="w-4 h-4" /></button>
                : <button onClick={finish} className="btn-primary">Finish</button>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Panel({ icon: Icon, title, desc, children }: { icon: any; title: string; desc: string; children?: React.ReactNode }) {
  return <div className="rounded-2xl border border-surface-200 dark:border-surface-800 p-5 bg-white/60 dark:bg-surface-900/50"><Icon className="w-7 h-7 text-primary-500 mb-3" /><h2 className="text-2xl font-bold mb-2">{title}</h2><p className="text-surface-500 mb-5">{desc}</p>{children}</div>;
}
function CheckRow({ ok, label, detail }: { ok: boolean; label: string; detail?: string }) {
  return <div className="flex items-start gap-3 rounded-xl bg-surface-100 dark:bg-surface-950 p-3 mb-2"><CheckCircle className={`w-5 h-5 mt-0.5 ${ok ? 'text-green-500' : 'text-amber-500'}`} /><div><p className="font-semibold">{label}</p><p className="text-sm text-surface-500 break-all">{detail}</p></div></div>;
}
