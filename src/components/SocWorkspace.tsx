import { useMemo, useState, type ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/tauri';
import {
  Check, ClipboardCopy, Copy, Search, Send
} from 'lucide-react';
import { useAppStore } from '../store';
import { Conversation } from '../types';
import SocKnowledgeBase from './SocKnowledgeBase';
import SocKnowledgeCollection from './SocKnowledgeCollection';
import SocRetrievedSources from './SocRetrievedSources';
import SocValidators from './SocValidators';
import SocReports from './SocReports';
import SocDashboard from './SocDashboard';
import SocExamplesPanel from './SocExamplesPanel';
import { logAuditEvent } from '../auditLog';
import SocDataPackIntake from './SocDataPackIntake';
import { useSocGroundedKnowledge } from '../hooks/useSocGroundedKnowledge';
import {
  buildSocPrompt,
  SOC_PROMPT_ACTIONS,
  SocPromptKind,
  SocWorkspaceInput,
} from '../socPromptTemplates';
import { buildSocAutoKnowledgeContextBlock } from '../socKnowledgeRetrieval';
import { buildSocRetrievedSnippetContext } from '../socKnowledgeIndex';
import type { SocDemoSample } from '../socDemoSamples';
import { SOC_SYSTEM_PROMPT } from '../socChatHandoff';

const emptyInput: SocWorkspaceInput = {
  alertSummary: '',
  rawLogs: '',
  sourceIp: '',
  destinationIp: '',
  username: '',
  asset: '',
  severity: '',
  notes: '',
};

function fieldLabel(label: string, children: ReactNode) {
  return (
    <label className="block">
      <span className="text-xs font-bold uppercase tracking-[0.16em] text-surface-500 dark:text-surface-400">{label}</span>
      {children}
    </label>
  );
}


function compactTextForLocalPrompt(value: string, max = 900): string {
  const cleaned = value.replace(/\s+/g, ' ').trim();
  return cleaned.length > max ? `${cleaned.slice(0, max)}...` : cleaned;
}

function defaultTitleForAction(kind: SocPromptKind): string {
  const action = SOC_PROMPT_ACTIONS.find(item => item.id === kind);
  return action ? `SOC ${action.shortLabel}` : 'SOC Workspace';
}

export default function SocWorkspace() {
  const [input, setInput] = useState<SocWorkspaceInput>(emptyInput);
  const [activeAction, setActiveAction] = useState<SocPromptKind>('triage');
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const store = useAppStore();
  const {
    activeConversationId,
    activeCharacterId,
    currentModel,
    selectedSocKnowledgeResourceIds,
    setPendingChatPrompt,
    setActiveView,
    setSidebarOpen,
    setActiveConversation,
    setMessages,
    setConversations,
  } = store;

  const grounded = useSocGroundedKnowledge({
    action: activeAction,
    workspaceInput: input,
  });

  const prompt = useMemo(
    () => buildSocPrompt(activeAction, input, grounded.knowledgeContext),
    [activeAction, input, grounded.knowledgeContext],
  );

  const activeActionMeta = SOC_PROMPT_ACTIONS.find(item => item.id === activeAction) ?? {
    id: 'triage' as const,
    label: 'Triage Alert',
    shortLabel: 'Triage',
    description: 'Classify the alert, summarize evidence, estimate severity, and recommend safe next steps.',
  };

  const update = (key: keyof SocWorkspaceInput, value: string) => {
    setInput(prev => ({ ...prev, [key]: value }));
  };

  const copyPrompt = async () => {
    await navigator.clipboard.writeText(prompt);
    setCopied(true);
    setNotice('Structured SOC prompt copied with auto-retrieved company knowledge when available.');
    window.setTimeout(() => setCopied(false), 1800);
  };

  const openInChat = async () => {
    if (!currentModel) {
      setNotice('Select a model in Models before sending to Chat.');
      return;
    }

    setBusy(true);
    setNotice(null);
    try {
      let conversationId = activeConversationId;
      if (!conversationId) {
        conversationId = await invoke<string>('create_conversation', {
          title: defaultTitleForAction(activeAction),
          characterId: activeCharacterId || null,
          modelId: currentModel || null,
          mode: 'soc'
        });
        setActiveConversation(conversationId);
        setMessages(conversationId, []);
      }

      const convs = await invoke<Conversation[]>('get_conversations');
      setConversations(convs);

      const autoBlock = buildSocAutoKnowledgeContextBlock(grounded.retrieval, grounded.error || undefined);
      const safePrompt = prompt.length > 9000
        ? [
          'You are PocketMind Hybrid AI Fortinet SOC Copilot.',
          'The original SOC prompt/context was large, so this compact summary is used to stay within local model context limits.',
          'Use Copy Prompt or local exports for the full artifact. Do not claim live FortiSIEM/FortiSOAR integration.',
          '',
          `SOC task: ${activeActionMeta.label}`,
          `Alert summary: ${compactTextForLocalPrompt(input.alertSummary || 'not provided', 1000)}`,
          `Raw evidence/logs summary: ${compactTextForLocalPrompt(input.rawLogs || 'not provided', 1200)}`,
          `Entities: source=${input.sourceIp || 'n/a'}, destination=${input.destinationIp || 'n/a'}, user=${input.username || 'n/a'}, asset=${input.asset || 'n/a'}, severity=${input.severity || 'n/a'}`,
          `Notes: ${compactTextForLocalPrompt(input.notes || 'not provided', 700)}`,
          autoBlock,
          grounded.mergedChunks.length
            ? ['', 'TOP RETRIEVED SNIPPETS (compact):', buildSocRetrievedSnippetContext(grounded.mergedChunks.slice(0, 5))].join('\n')
            : `Selected metadata references: ${selectedSocKnowledgeResourceIds.length}`,
          '',
          'Task: Produce concise analyst guidance grounded in company SOP snippets when present. List evidence gaps and human approval points.',
          'OUTPUT FORMAT: Follow the standard numbered SOC sections for this task type when possible.',
        ].join('\n')
        : prompt;

      setPendingChatPrompt(safePrompt, { soc: true, autoSend: true });
      setActiveView('chat');
      setSidebarOpen(false);
      void logAuditEvent({
        eventType: `soc.${activeAction}`,
        category: 'soc',
        summary: `SOC ${activeActionMeta.label} sent to Chat`,
        detail: `retrieved_snippets=${grounded.contextHits.length}`,
      });
      if (prompt.length > 9000) {
        setNotice('Compact SOC summary loaded into Chat because the full prompt was large. Use Copy Prompt for the full local context.');
      } else if (grounded.contextHits.length) {
        setNotice(`Sent to Chat with ${grounded.contextHits.length} auto-retrieved company knowledge snippet(s).`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err || 'Unknown error');
      setNotice(`Could not open SOC prompt in chat: ${message}`);
    } finally {
      setBusy(false);
    }
  };

  const resetForm = () => {
    setInput(emptyInput);
    setNotice('SOC workspace fields cleared.');
  };

  const applyExample = (sample: SocDemoSample) => {
    setInput(sample.input);
    setActiveAction(sample.recommendedAction);
    setNotice(`Loaded example: ${sample.title}.`);
  };

  return (
    <div className="flex-1 overflow-y-auto p-4 sm:p-6 lg:p-8 space-y-6">
      <div className="panel-shell p-4 sm:p-5 space-y-2">
        <h1 className="text-2xl font-black text-surface-950 dark:text-white">Fortinet Copilot</h1>
        <p className="text-sm text-surface-600 dark:text-surface-300 max-w-3xl">
          Index your company folder, enter alert details below, pick an action, then send to Chat or generate a report.
          Company policies are pulled in automatically when indexed.
        </p>
      </div>

      <div id="soc-knowledge-collection" className="scroll-mt-6">
        <SocKnowledgeCollection />
      </div>

      <div id="soc-dashboard" className="scroll-mt-6">
        <SocDashboard />
      </div>

      <div id="soc-data-pack-intake" className="scroll-mt-6">
        <SocDataPackIntake />
      </div>

      <div id="soc-examples" className="scroll-mt-6">
        <SocExamplesPanel onApplySample={applyExample} />
      </div>

      <div id="soc-workspace" className="scroll-mt-6 grid xl:grid-cols-[minmax(0,1.05fr)_minmax(22rem,0.95fr)] gap-6">
        <section className="panel-shell p-4 sm:p-6 space-y-5">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div>
              <p className="text-xs font-bold uppercase tracking-[0.18em] text-surface-500">Alert details</p>
              <h2 className="text-xl font-black text-surface-950 dark:text-white">Incident input</h2>
            </div>
            <button type="button" onClick={resetForm} className="btn-secondary text-sm">Clear fields</button>
          </div>

          <div className="grid sm:grid-cols-2 gap-4">
            {fieldLabel('Alert summary',
              <textarea value={input.alertSummary} onChange={e => update('alertSummary', e.target.value)} rows={4} className="input-field mt-1 min-h-[7rem]" placeholder="Example: Multiple failed VPN logins followed by successful login from new geo..." />
            )}
            {fieldLabel('Raw logs / evidence',
              <textarea value={input.rawLogs} onChange={e => update('rawLogs', e.target.value)} rows={4} className="input-field mt-1 min-h-[7rem] font-mono text-xs" placeholder="Paste FortiSIEM alert details, FortiGate logs, EDR notes, raw sample logs, parser samples, or exported incident notes..." />
            )}
          </div>

          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {fieldLabel('Source IP',
              <input value={input.sourceIp} onChange={e => update('sourceIp', e.target.value)} className="input-field mt-1" placeholder="10.0.0.25" />
            )}
            {fieldLabel('Destination IP',
              <input value={input.destinationIp} onChange={e => update('destinationIp', e.target.value)} className="input-field mt-1" placeholder="172.16.1.10" />
            )}
            {fieldLabel('Username',
              <input value={input.username} onChange={e => update('username', e.target.value)} className="input-field mt-1" placeholder="user@company.local" />
            )}
            {fieldLabel('Asset / device',
              <input value={input.asset} onChange={e => update('asset', e.target.value)} className="input-field mt-1" placeholder="VPN gateway, FortiGate, endpoint, server..." />
            )}
            {fieldLabel('Severity',
              <select value={input.severity} onChange={e => update('severity', e.target.value)} className="input-field mt-1">
                <option value="">Not set</option>
                <option value="Informational">Informational</option>
                <option value="Low">Low</option>
                <option value="Medium">Medium</option>
                <option value="High">High</option>
                <option value="Critical">Critical</option>
              </select>
            )}
            {fieldLabel('Rule / playbook / parser notes',
              <input value={input.notes} onChange={e => update('notes', e.target.value)} className="input-field mt-1" placeholder="Detection goal, parser issue, connector requirement..." />
            )}
          </div>

          {grounded.hasAutoRetrieval && (
            <SocRetrievedSources
              hits={grounded.contextHits}
              loading={grounded.loading}
              error={grounded.error}
              notice={grounded.notice}
              query={grounded.query}
              onRefresh={() => void grounded.refresh()}
              compact
            />
          )}
        </section>

        <section className="panel-shell p-4 sm:p-6 space-y-5">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.18em] text-surface-500">Next step</p>
            <h2 className="text-xl font-black text-surface-950 dark:text-white">What do you want to do?</h2>
          </div>

          <div className="grid sm:grid-cols-2 gap-2">
            {SOC_PROMPT_ACTIONS.map(action => (
              <button
                key={action.id}
                type="button"
                onClick={() => setActiveAction(action.id)}
                className={`text-left rounded-2xl border p-3 transition-all ${activeAction === action.id
                  ? 'border-primary-300 dark:border-primary-700 bg-primary-50/90 dark:bg-primary-950/30 shadow-lg shadow-primary-500/10'
                  : 'border-white/70 dark:border-surface-800 bg-white/60 dark:bg-surface-900/50 hover:bg-primary-50/70 dark:hover:bg-surface-900'}`}
              >
                <span className="block text-sm font-black text-surface-950 dark:text-white">{action.label}</span>
              </button>
            ))}
          </div>

          <div className="rounded-2xl border border-white/70 dark:border-surface-800 bg-surface-50/85 dark:bg-surface-950/65 overflow-hidden">
            <div className="px-4 py-3 border-b border-white/70 dark:border-surface-800 flex items-center justify-between gap-2">
              <div>
                <p className="text-xs font-bold uppercase tracking-[0.16em] text-surface-500">Prepared prompt</p>
                <p className="text-sm font-bold text-surface-900 dark:text-white">{activeActionMeta.label}</p>
                <p className="mt-1 text-xs font-semibold text-primary-700 dark:text-primary-300">
                  {grounded.contextHits.length} auto-retrieved snippet{grounded.contextHits.length === 1 ? '' : 's'}
                  {grounded.selectedManualChunks.length > 0 ? ` + ${grounded.selectedManualChunks.length} manual` : ''}
                </p>
              </div>
              <Search className="w-5 h-5 text-surface-400" />
            </div>
            <textarea
              value={prompt}
              readOnly
              rows={14}
              className="w-full bg-transparent p-4 text-xs leading-5 font-mono text-surface-700 dark:text-surface-200 resize-none focus:outline-none"
            />
          </div>

          {notice && (
            <div className="rounded-2xl border border-primary-200/70 dark:border-primary-800/60 bg-primary-50/90 dark:bg-primary-950/25 px-4 py-3 text-sm text-primary-700 dark:text-primary-300">
              {notice}
            </div>
          )}

          <div className="flex flex-col sm:flex-row gap-3">
            <button type="button" onClick={copyPrompt} className="btn-secondary flex-1 flex items-center justify-center gap-2">
              {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
              {copied ? 'Copied' : 'Copy Prompt'}
            </button>
            <button type="button" onClick={openInChat} disabled={busy} className="btn-primary flex-1 flex items-center justify-center gap-2">
              {busy ? <ClipboardCopy className="w-4 h-4 animate-pulse" /> : <Send className="w-4 h-4" />}
              Send to Chat
            </button>
          </div>
        </section>
      </div>

      <div id="soc-knowledge-base" className="scroll-mt-6">
        <SocKnowledgeBase />
      </div>

      <div id="soc-validators" className="scroll-mt-6">
        <SocValidators />
      </div>

      <div id="soc-reports" className="scroll-mt-6">
        <SocReports workspaceInput={input} generatedPrompt={prompt} />
      </div>
    </div>
  );
}
