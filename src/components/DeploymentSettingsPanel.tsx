import { useEffect, useState, type ReactNode } from 'react';
import { open } from '@tauri-apps/api/dialog';
import { CheckCircle2, Download, FolderOpen, Loader2, Save, Server, Settings2 } from 'lucide-react';
import { useAppStore } from '../store';
import { useKnowledgeChatStore } from '../knowledgeChat/store';
import {
  applyDeploymentToAppState,
  ensureDeploymentDirectories,
  loadDeploymentConfigMapped,
  saveDeploymentConfigMapped,
  SERVER_INFERENCE_PRESET,
  WORKSTATION_INFERENCE_PRESET,
  type DeploymentConfig,
} from '../deploymentConfig';
import SupportModelsPanel from './SupportModelsPanel';

function fieldLabel(label: string, children: React.ReactNode) {
  return (
    <label className="block">
      <span className="block text-sm font-medium mb-2">{label}</span>
      {children}
    </label>
  );
}

export default function DeploymentSettingsPanel() {
  const store = useAppStore();
  const kcStore = useKnowledgeChatStore();
  const [form, setForm] = useState<DeploymentConfig | null>(store.deploymentConfig);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (store.deploymentConfig && !form) {
      setForm(store.deploymentConfig);
    }
  }, [store.deploymentConfig, form]);

  const update = <K extends keyof DeploymentConfig>(key: K, value: DeploymentConfig[K]) => {
    setForm(prev => prev ? { ...prev, [key]: value } : prev);
  };

  const reload = async () => {
    setBusy(true);
    setError(null);
    try {
      const config = await loadDeploymentConfigMapped();
      setForm(config);
      setNotice('Reloaded deployment settings from server configuration store.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const applyPreset = (preset: Partial<DeploymentConfig>) => {
    setForm(prev => prev ? { ...prev, ...preset } : prev);
  };

  const pickFolder = async (key: keyof DeploymentConfig) => {
    const selected = await open({ directory: true, multiple: false });
    if (!selected || typeof selected !== 'string' || !form) return;
    update(key, selected as DeploymentConfig[typeof key]);
  };

  const save = async () => {
    if (!form) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const saved = await saveDeploymentConfigMapped(form);
      await ensureDeploymentDirectories();
      applyDeploymentToAppState(saved, {
        setModelsDir: store.setModelsDir,
        setSocKnowledgeCollectionRoot: store.setSocKnowledgeCollectionRoot,
        setDefaultParams: store.setDefaultParams,
        setSocDenseEmbeddingSettings: store.setSocDenseEmbeddingSettings,
        setKnowledgeEmbeddingPath: kcStore.setEmbeddingModelPath,
        setKnowledgeTopK: kcStore.setTopK,
      });
      store.setDeploymentConfig(saved);
      setForm(saved);
      setNotice('Deployment settings saved. Folder structure verified on this server.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (!form) {
    return (
      <div className="glass-panel rounded-xl p-6 text-sm text-surface-500">
        Loading deployment configuration…
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="glass-panel rounded-xl p-6 space-y-4">
        <h3 className="font-semibold flex items-center gap-2">
          <Server className="w-5 h-5 text-primary-500" />
          Server deployment mode
        </h3>
        <p className="text-sm text-surface-500">
          Configure where models, company data, exports, and indexes live on this server. These paths replace hardcoded drive letters and are enforced for SOC scans, exports, and OCR.
        </p>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => applyPreset(SERVER_INFERENCE_PRESET)} className="btn-secondary text-sm">Apply server performance preset</button>
          <button type="button" onClick={() => applyPreset(WORKSTATION_INFERENCE_PRESET)} className="btn-secondary text-sm">Apply workstation preset</button>
        </div>
        <div className="grid sm:grid-cols-2 gap-4">
          {fieldLabel('Deployment mode',
            <select value={form.deploymentMode} onChange={e => update('deploymentMode', e.target.value as DeploymentConfig['deploymentMode'])} className="input-field">
              <option value="server">Server (higher context / throughput)</option>
              <option value="workstation">Workstation (balanced)</option>
            </select>
          )}
          {fieldLabel('Data root',
            <div className="flex gap-2">
              <input value={form.dataRoot} onChange={e => update('dataRoot', e.target.value)} className="input-field font-mono text-xs" />
              <button type="button" onClick={() => void pickFolder('dataRoot')} className="btn-secondary px-3"><FolderOpen className="w-4 h-4" /></button>
            </div>
          )}
        </div>
      </div>

      <div className="glass-panel rounded-xl p-6 space-y-4">
        <h3 className="font-semibold flex items-center gap-2"><Settings2 className="w-5 h-5 text-primary-500" />Data locations</h3>
        <div className="grid gap-4">
          {[
            ['modelsDir', 'Models directory', 'GGUF chat models'],
            ['embeddingModelPath', 'Code embedding model (GGUF)', 'Qwen3-Embedding-8B for Knowledge Chat code partition (last-token pooling)'],
            ['rerankerModelPath', 'Reranker model (GGUF)', 'Qwen3-Reranker-4B GGUF under models/rerankers (llama.cpp RANK; not ONNX)'],
            ['socDataRoot', 'Company SOC data root', 'Grounded SOC knowledge collection root'],
            ['exportDir', 'Export directory', 'SOC reports and validator exports'],
            ['denseIndexPath', 'Dense index file', 'Legacy SOC dense index JSON path'],
          ].map(([key, label, hint]) => (
            <div key={key}>
              {fieldLabel(label,
                <div className="flex gap-2">
                  <input
                    value={form[key as keyof DeploymentConfig] as string}
                    onChange={e => update(key as keyof DeploymentConfig, e.target.value as DeploymentConfig[keyof DeploymentConfig])}
                    className="input-field font-mono text-xs"
                  />
                  {key.endsWith('Dir') || key === 'socDataRoot' ? (
                    <button type="button" onClick={() => void pickFolder(key as keyof DeploymentConfig)} className="btn-secondary px-3"><FolderOpen className="w-4 h-4" /></button>
                  ) : null}
                </div>
              )}
              <p className="text-xs text-surface-500 mt-1">{hint}</p>
            </div>
          ))}
          {fieldLabel('Intake subfolder (under company data root)',
            <input value={form.socIntakeSubdir} onChange={e => update('socIntakeSubdir', e.target.value)} className="input-field font-mono text-xs" placeholder="intake" />
          )}
        </div>
      </div>

      <div className="glass-panel rounded-xl p-6 space-y-4">
        <h3 className="font-semibold flex items-center gap-2">
          <Download className="w-5 h-5 text-primary-500" />
          Download embeddings, reranker &amp; OCR
        </h3>
        <p className="text-sm text-surface-500">
          On-demand downloads with Hugging Face links. The app writes files under your models folder (or OCR cache). Not included in the Windows installer.
        </p>
        <SupportModelsPanel />
      </div>

      <div className="glass-panel rounded-xl p-6 space-y-4">
        <h3 className="font-semibold">Inference & retrieval limits</h3>
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {[
            ['contextSize', 'Context window (tokens)', 1024, 32768],
            ['maxTokens', 'Max response length (tokens)', 128, 4096],
            ['gpuLayers', 'GPU layers (-1 = auto)', -1, 999],
            ['batchSize', 'Batch size', 32, 1024],
            ['threads', 'CPU threads (0 = auto)', 0, 64],
            ['retrievalTopK', 'Retrieval top-K', 3, 20],
            ['embedContextSize', 'Embedding context', 512, 8192],
            ['maxSnippetChars', 'Max snippet chars in prompts', 400, 3000],
          ].map(([key, label, min, max]) => (
            fieldLabel(String(label),
              <input
                type="number"
                value={form[key as keyof DeploymentConfig] as number}
                min={min as number}
                max={max as number}
                onChange={e => update(key as keyof DeploymentConfig, Number(e.target.value) as DeploymentConfig[keyof DeploymentConfig])}
                className="input-field"
              />
            )
          ))}
          {fieldLabel('Temperature',
            <input type="number" step="0.05" min={0} max={1.5} value={form.temperature} onChange={e => update('temperature', Number(e.target.value))} className="input-field" />
          )}
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => void save()} disabled={busy} className="btn-primary flex items-center gap-2">
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          Save deployment settings
        </button>
        <button type="button" onClick={() => void reload()} disabled={busy} className="btn-secondary">Reload</button>
      </div>

      {notice && (
        <div className="rounded-xl border border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/30 p-4 text-sm text-emerald-800 dark:text-emerald-200 flex items-start gap-2">
          <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" /> {notice}
        </div>
      )}
      {error && (
        <div className="rounded-xl border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/30 p-4 text-sm text-red-700 dark:text-red-300">{error}</div>
      )}
    </div>
  );
}
