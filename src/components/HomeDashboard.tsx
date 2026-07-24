import { invoke } from '@tauri-apps/api/tauri';
import { Activity, Bot, CheckCircle, Cpu, Download, FileText, HardDrive, MessageSquare, ShieldCheck } from 'lucide-react';
import { useAppStore } from '../store';
import { Conversation, Message } from '../types';

function fmtBytes(bytes?: number | null) {
  if (!bytes || bytes <= 0) return 'Unknown';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i++; }
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

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

  const selectedModel = currentModel?.split(/[\\/]/).pop() || 'No model selected';
  const selectedCharacter = characters.find(c => c.id === activeCharacterId)?.name || 'Default assistant';

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
    { title: 'Fortinet Copilot', desc: 'Triage alerts, run validators, write reports, and search your company documents.', icon: ShieldCheck, action: 'Open SOC', view: 'soc' as const },
    { title: 'Knowledge Chat', desc: 'Index company folders and ask grounded questions.', icon: FileText, action: 'Open Knowledge Chat', view: 'knowledge-chat' as const },
    { title: 'Chat', desc: 'Local or online conversations.', icon: MessageSquare, action: 'Open Chat', view: 'chat' as const },
    { title: 'Models', desc: 'Import, scan, and select GGUF models.', icon: Download, action: 'Manage Models', view: 'models' as const },
  ];

  return (
    <div className="flex-1 overflow-y-auto p-4 sm:p-6">
      <div className="max-w-7xl mx-auto space-y-5">
        <section className="premium-card p-6 sm:p-7">
          <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-6">
            <div className="space-y-3">
              <h1 className="text-3xl sm:text-4xl font-black tracking-tight text-surface-950 dark:text-white">PocketMind Hybrid AI Desktop</h1>
              <p className="max-w-xl text-surface-600 dark:text-surface-300">
                Local AI for security analysts: Fortinet Copilot, Knowledge Chat, and on-device models.
              </p>
              <div className="flex flex-wrap gap-3">
                <button onClick={createChat} disabled={!currentModel} className="btn-primary disabled:opacity-50 disabled:cursor-not-allowed">New Chat</button>
                <button onClick={() => setActiveView('models')} className="btn-secondary">Select Model</button>
                <button onClick={() => setActiveView('enterprise-server')} className="btn-secondary">Org Server</button>
              </div>
              {!currentModel && <p className="text-sm text-amber-500">Select a model before chatting.</p>}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 min-w-[min(320px,100%)]">
              <Stat label="Active model" value={selectedModel} icon={HardDrive} />
              <Stat label="Local models" value={`${localModels.length}`} icon={Download} />
              <Stat label="Character" value={selectedCharacter} icon={Bot} />
              <Stat label="Memory free" value={fmtBytes(info?.memory.available_bytes)} icon={Activity} />
              <Stat label="CPU cores" value={info ? String(info.cpu.cores_logical) : 'Unknown'} icon={Cpu} />
            </div>
          </div>
        </section>

        <section className="grid md:grid-cols-2 xl:grid-cols-3 gap-4">
          {cards.map(card => (
            <button key={card.title} onClick={() => setActiveView(card.view)} className="group text-left premium-card p-5">
              <div className="h-10 w-10 rounded-xl bg-primary-100 dark:bg-primary-950/40 flex items-center justify-center mb-3">
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
              <li>Select it for chat.</li>
              <li>Ask your first question.</li>
            </ol>
          </div>
        </section>
      </div>
    </div>
  );
}

function Stat({ label, value, icon: Icon }: { label: string; value: string; icon: any }) {
  return (
    <div className="rounded-xl border border-surface-200 dark:border-surface-800 bg-surface-50 dark:bg-surface-900 p-4 min-w-0">
      <Icon className="w-4 h-4 text-primary-500 mb-2" />
      <p className="text-xs uppercase tracking-wider text-surface-500 font-semibold">{label}</p>
      <p className="font-bold truncate" title={value}>{value}</p>
    </div>
  );
}

function ChecklistItem({ done, text }: { done: boolean; text: string }) {
  return (
    <div className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm ${done ? 'border-green-200 dark:border-green-900 bg-green-50 dark:bg-green-950/20 text-green-800 dark:text-green-200' : 'border-surface-200 dark:border-surface-800 text-surface-500'}`}>
      <CheckCircle className={`w-4 h-4 shrink-0 ${done ? 'text-green-500' : 'text-surface-400'}`} />
      {text}
    </div>
  );
}
