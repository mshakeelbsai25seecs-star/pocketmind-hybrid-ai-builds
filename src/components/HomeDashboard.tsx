import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/tauri';
import { listen } from '@tauri-apps/api/event';
import { Activity, Bot, CheckCircle, Code2, Cpu, Download, FileText, HardDrive, MessageSquare, ShieldCheck } from 'lucide-react';
import { useAppStore } from '../store';
import { Conversation, LocalModelRecord, Message, SystemInfo } from '../types';
import RefreshButton from './RefreshButton';
import { filterChatSelectableLocalModels } from '../localModels';
import { formatInvokeError } from '../lib/formatInvokeError';
import { chooseWritableDataRoot, needsWritableDataRoot, probeStorageAccess } from '../storageAccess';

function fmtBytes(bytes?: number | null) {
  if (!bytes || bytes <= 0) return 'Unknown';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i++; }
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

type CudaInstallProgress = {
  backend?: string;
  phase?: string;
  message?: string;
  percent?: number | null;
  file?: string | null;
  downloaded?: number | null;
  total?: number | null;
};

export default function HomeDashboard() {
  const info = useAppStore(s => s.systemInfo);
  const currentModel = useAppStore(s => s.currentModel);
  const activeCharacterId = useAppStore(s => s.activeCharacterId);
  const characters = useAppStore(s => s.characters);
  const localModels = useAppStore(s => s.localModels);
  const setupCompleted = useAppStore(s => s.setupCompleted);
  const setActiveConversation = useAppStore(s => s.setActiveConversation);
  const setMessages = useAppStore(s => s.setMessages);
  const setConversations = useAppStore(s => s.setConversations);
  const setActiveView = useAppStore(s => s.setActiveView);
  const setSystemInfo = useAppStore(s => s.setSystemInfo);
  const setLocalModels = useAppStore(s => s.setLocalModels);
  const setCharacters = useAppStore(s => s.setCharacters);
  const [refreshBusy, setRefreshBusy] = useState(false);
  const [cudaBusy, setCudaBusy] = useState(false);
  const [cudaMsg, setCudaMsg] = useState<string | null>(null);
  const [cudaProgress, setCudaProgress] = useState<CudaInstallProgress | null>(null);
  const [cudaNeedsPath, setCudaNeedsPath] = useState(false);
  const [dataRootHint, setDataRootHint] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void probeStorageAccess()
      .then(probe => {
        if (cancelled) return;
        if (!probe.writable) {
          setDataRootHint(probe.message);
          setCudaNeedsPath(true);
        } else {
          setDataRootHint(`Runtimes/models write to: ${probe.dataRoot}`);
        }
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<CudaInstallProgress>('llama-runtime-install-progress', event => {
      const payload = event.payload;
      if (payload?.backend && payload.backend !== 'cuda') return;
      setCudaProgress(payload);
      if (payload?.message) setCudaMsg(payload.message);
    }).then(fn => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, []);

  const refreshDashboard = async () => {
    setRefreshBusy(true);
    try {
      const [nextInfo, models, chars] = await Promise.all([
        invoke<SystemInfo>('get_system_info'),
        invoke<LocalModelRecord[]>('get_local_models'),
        invoke<typeof characters>('get_characters'),
      ]);
      setSystemInfo(nextInfo);
      setLocalModels(filterChatSelectableLocalModels(models));
      setCharacters(chars);
    } finally {
      setRefreshBusy(false);
    }
  };

  const chooseDataFolder = async () => {
    try {
      const saved = await chooseWritableDataRoot({
        title: 'Choose writable folder for models and CUDA runtimes',
        defaultPath: dataRootHint?.includes(':\\') ? undefined : 'D:\\PocketMind',
      });
      if (!saved) return;
      setCudaNeedsPath(false);
      setDataRootHint(`Runtimes/models write to: ${saved.dataRoot}`);
      setCudaMsg(`Data folder set to ${saved.dataRoot}. You can retry CUDA download.`);
    } catch (err) {
      setCudaMsg(formatInvokeError(err));
    }
  };

  const installCudaRuntime = async () => {
    setCudaBusy(true);
    setCudaNeedsPath(false);
    setCudaProgress({ phase: 'start', message: 'Preparing CUDA download…', percent: 1 });
    setCudaMsg('Downloading NVIDIA CUDA llama.cpp runtime…');
    try {
      const result = await invoke<{ message: string; server_path?: string }>('install_llama_runtime_backend', {
        backend: 'cuda',
      });
      setCudaMsg(result.message + (result.server_path ? ` → ${result.server_path}` : ''));
      setCudaProgress({ phase: 'complete', message: result.message, percent: 100 });
      useAppStore.getState().setDefaultParams({
        gpu_layers: -1,
      });
      await refreshDashboard();
    } catch (err) {
      const text = formatInvokeError(err);
      setCudaMsg(text);
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

  const selectedModel = currentModel?.split(/[\\/]/).pop() || 'No model selected';
  const selectedCharacter = characters.find(c => c.id === activeCharacterId)?.name || 'Default assistant';
  const cudaPercent = typeof cudaProgress?.percent === 'number' ? Math.max(0, Math.min(100, cudaProgress.percent)) : null;
  const cudaBytesLabel =
    cudaProgress?.downloaded != null && cudaProgress?.total != null && cudaProgress.total > 0
      ? `${fmtBytes(cudaProgress.downloaded)} / ${fmtBytes(cudaProgress.total)}`
      : null;

  const createChat = async () => {
    const id = await invoke<string>('create_conversation', {
      title: 'New Chat',
      characterId: activeCharacterId || null,
      modelId: currentModel || null,
      mode: 'chat'
    });
    setActiveConversation(id);
    setMessages(id, [] as Message[]);
    const convs = await invoke<Conversation[]>('get_conversations');
    setConversations(convs);
    setActiveView('chat');
  };

  const cards = [
    { title: 'PocketCode', desc: 'Open a project folder and run the coding agent: search, edit, terminal, checkpoints, and plans — without cluttering your repo.', icon: Code2, action: 'Open PocketCode', view: 'code-workspace' as const },
    { title: 'SOC', desc: 'Alert queue, investigation, Fortinet engineering tools, and company knowledge.', icon: ShieldCheck, action: 'Open SOC', view: 'soc' as const },
    { title: 'Image Studio', desc: 'Generate, compare, and export images.', icon: FileText, action: 'Open Image Studio', view: 'image-studio' as const },
    { title: 'Chat', desc: 'Local or online conversations.', icon: MessageSquare, action: 'Open Chat', view: 'chat' as const },
    { title: 'Models', desc: 'Import, scan, and select GGUF models.', icon: Download, action: 'Manage Models', view: 'models' as const },
  ];

  return (
    <div className="flex-1 overflow-y-auto p-4 sm:p-6">
      <div className="max-w-7xl mx-auto space-y-5">
        <section className="premium-card p-6 sm:p-7">
          <div className="flex flex-col xl:flex-row xl:items-start xl:justify-between gap-6">
            <div className="space-y-3 flex-1 min-w-0 xl:min-w-[22rem]">
              <h1 className="app-brand-name text-3xl sm:text-4xl font-black tracking-tight text-primary-400 dark:text-primary-300">PocketMind Hybrid AI Desktop</h1>
              <p className="max-w-2xl text-surface-600 dark:text-surface-300">
                Local AI for security analysts and developers: Fortinet Copilot, PocketCode, Image Studio, and on-device models.
              </p>
              <div className="flex flex-wrap gap-3">
                <button onClick={createChat} disabled={!currentModel} className="btn-primary disabled:opacity-50 disabled:cursor-not-allowed">New Chat</button>
                <button onClick={() => setActiveView('models')} className="btn-secondary">Select Model</button>
                <button onClick={() => setActiveView('enterprise-server')} className="btn-secondary">Org Server</button>
                <button
                  type="button"
                  onClick={() => void installCudaRuntime()}
                  disabled={cudaBusy}
                  className="btn-secondary inline-flex items-center gap-2"
                  title="Optional post-install CUDA llama.cpp download (Store packages stay CPU-only)"
                >
                  <Download className="w-4 h-4" />
                  {cudaBusy ? 'Installing CUDA…' : 'Install CUDA runtime'}
                </button>
                {cudaNeedsPath && (
                  <button
                    type="button"
                    onClick={() => void chooseDataFolder()}
                    className="btn-secondary inline-flex items-center gap-2"
                    title="Lab PCs often block C: writes — pick a writable drive folder"
                  >
                    <HardDrive className="w-4 h-4" />
                    Choose data folder…
                  </button>
                )}
              </div>
              {dataRootHint && (
                <p className={`text-xs ${cudaNeedsPath ? 'text-amber-400' : 'text-surface-500'}`}>{dataRootHint}</p>
              )}
              {!currentModel && <p className="text-sm text-amber-500">Select a model before chatting.</p>}
            </div>
            <div className="flex flex-col gap-3 w-full xl:w-[min(28rem,100%)] shrink-0">
              <RefreshButton
                title="Refresh"
                onClick={refreshDashboard}
                busy={refreshBusy}
                className="self-end"
              />
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Stat label="Active model" value={selectedModel} icon={HardDrive} />
              <Stat label="Local models" value={`${localModels.length}`} icon={Download} />
              <Stat label="Character" value={selectedCharacter} icon={Bot} />
              <Stat label="Memory free" value={fmtBytes(info?.memory.available_bytes)} icon={Activity} />
              <Stat label="CPU" value={info?.cpu ? `${info.cpu.cores_physical} cores / ${info.cpu.cores_logical} threads` : 'Unknown'} icon={Cpu} />
              </div>
            </div>
          </div>
          {(cudaBusy || cudaProgress || cudaMsg) && (
            <div className="mt-5 rounded-sm border border-primary-500/30 bg-primary-950/20 p-3 space-y-2">
              <div className="flex items-start justify-between gap-3 text-xs text-primary-200">
                <span className="font-medium break-words min-w-0 flex-1">{cudaMsg || 'Preparing CUDA download…'}</span>
                {cudaPercent != null && <span className="tabular-nums shrink-0 pt-0.5">{cudaPercent}%</span>}
              </div>
              <div className="h-2 rounded-sm bg-surface-800 overflow-hidden">
                <div
                  className={`h-full bg-primary-500 transition-[width] duration-300 ${cudaBusy && cudaPercent == null ? 'animate-pulse w-1/3' : ''}`}
                  style={{ width: cudaPercent != null ? `${cudaPercent}%` : cudaBusy ? undefined : '0%' }}
                />
              </div>
              <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-surface-400">
                {cudaProgress?.phase && <span>Phase: {cudaProgress.phase}</span>}
                {cudaProgress?.file && <span className="break-all" title={cudaProgress.file}>{cudaProgress.file}</span>}
                {cudaBytesLabel && <span className="tabular-nums">{cudaBytesLabel}</span>}
              </div>
              {cudaNeedsPath && (
                <button type="button" onClick={() => void chooseDataFolder()} className="btn-secondary text-xs px-3 py-1.5">
                  Choose writable data folder…
                </button>
              )}
            </div>
          )}
        </section>

        <section className="grid md:grid-cols-2 xl:grid-cols-3 gap-4">
          {cards.map(card => (
            <button key={card.title} onClick={() => setActiveView(card.view)} className="group text-left premium-card p-5">
              <div className="h-10 w-10 rounded-sm bg-primary-100 dark:bg-primary-950/40 flex items-center justify-center mb-3">
                <card.icon className="w-5 h-5 text-primary-600 dark:text-primary-300" />
              </div>
              <h3 className="font-bold text-lg mb-1">{card.title}</h3>
              <p className="text-sm text-surface-500 leading-relaxed mb-3">{card.desc}</p>
              <span className="text-sm font-semibold text-primary-500">{card.action} →</span>
            </button>
          ))}
        </section>

        <section className="grid lg:grid-cols-3 gap-4">
          <div className="premium-card p-5 lg:col-span-2">
            <h2 className="font-bold text-lg mb-3 flex items-center gap-2"><ShieldCheck className="w-5 h-5 text-green-500" /> Readiness</h2>
            <div className="grid sm:grid-cols-2 gap-3">
              <ChecklistItem done={!!currentModel} text="Chat model selected" />
              <ChecklistItem done={localModels.length > 0} text="Local model available" />
              <ChecklistItem done={!!info} text="Hardware scan complete" />
              <ChecklistItem done={setupCompleted} text="Setup complete" />
            </div>
          </div>
          <div className="premium-card p-5">
            <h2 className="font-bold text-lg mb-3 flex items-center gap-2"><FileText className="w-5 h-5 text-primary-500" /> Quick start</h2>
            <ol className="space-y-2 text-sm text-surface-600 dark:text-surface-300 list-decimal pl-5">
              <li>Import or download a GGUF model.</li>
              <li>Select it for chat or PocketCode.</li>
              <li>Open PocketCode on a folder, or start a chat.</li>
            </ol>
          </div>
        </section>
      </div>
    </div>
  );
}

function Stat({ label, value, icon: Icon }: { label: string; value: string; icon: any }) {
  return (
    <div className="rounded-sm border border-surface-200 dark:border-surface-800 bg-surface-50 dark:bg-surface-900 p-4 min-w-0">
      <Icon className="w-4 h-4 text-primary-500 mb-2" />
      <p className="text-xs uppercase tracking-wider text-surface-500 font-semibold">{label}</p>
      <p className="font-bold truncate" title={value}>{value}</p>
    </div>
  );
}

function ChecklistItem({ done, text }: { done: boolean; text: string }) {
  return (
    <div className={`flex items-center gap-2 rounded-sm border px-3 py-2 text-sm ${done ? 'border-green-200 dark:border-green-900 bg-green-50 dark:bg-green-950/20 text-green-800 dark:text-green-200' : 'border-surface-200 dark:border-surface-800 text-surface-500'}`}>
      <CheckCircle className={`w-4 h-4 shrink-0 ${done ? 'text-green-500' : 'text-surface-400'}`} />
      {text}
    </div>
  );
}
