import { useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/tauri';
import {
  Building2, CheckCircle2, Copy, ExternalLink, KeyRound, Loader2,
  Network, RefreshCw, ServerCog, ShieldCheck, Sparkles, Zap
} from 'lucide-react';
import { useAppStore } from '../store';
import { Conversation, EnterpriseEmbeddingProbe, EnterpriseModelInfo, EnterpriseServerConfig, EnterpriseServerTestResult } from '../types';
import { probeServerRag } from '../knowledgeChat/serverRag';

function humanError(err: unknown): string {
  if (!err) return 'Unknown error';
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.message;
  try { return JSON.stringify(err); } catch { return String(err); }
}

function normalizeModelName(id: string): string {
  return id
    .replace(/^.*\//, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase())
    .slice(0, 80);
}

export default function EnterpriseServer() {
  const store = useAppStore();
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [selectedModel, setSelectedModel] = useState('');
  const [apiKeySaved, setApiKeySaved] = useState(false);
  const [models, setModels] = useState<EnterpriseModelInfo[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [embeddingsEnabled, setEmbeddingsEnabled] = useState(false);
  const [codeEmbedModel, setCodeEmbedModel] = useState('');
  const [knowledgeEmbedModel, setKnowledgeEmbedModel] = useState('');
  const [embeddingsBaseUrl, setEmbeddingsBaseUrl] = useState('');
  const [embeddingProbes, setEmbeddingProbes] = useState<EnterpriseEmbeddingProbe[]>([]);
  const [serverRagEnabled, setServerRagEnabled] = useState(false);
  const [serverRagReachable, setServerRagReachable] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const config = await invoke<EnterpriseServerConfig>('get_enterprise_server_config');
        if (cancelled) return;
        setBaseUrl(config.base_url || '');
        setSelectedModel(config.selected_model || '');
        setApiKeySaved(config.api_key_saved);
        setEmbeddingsEnabled(Boolean(config.embeddings_enabled));
        setCodeEmbedModel(config.code_embedding_model || '');
        setKnowledgeEmbedModel(config.knowledge_embedding_model || '');
        setEmbeddingsBaseUrl(config.embeddings_base_url || '');
        setServerRagEnabled(Boolean(config.server_rag_enabled));
      } catch (err) {
        if (!cancelled) setError(humanError(err));
      }
    };
    load();
    return () => { cancelled = true; };
  }, []);

  const serverReady = useMemo(() => Boolean(baseUrl.trim() && selectedModel.trim()), [baseUrl, selectedModel]);

  const saveConfig = async (opts?: { selected?: string; serverRag?: boolean }) => {
    const config = await invoke<EnterpriseServerConfig>('save_enterprise_server_config', {
      baseUrl,
      apiKey: apiKey.trim() ? apiKey.trim() : null,
      selectedModel: opts?.selected ?? selectedModel,
      embeddingsEnabled,
      codeEmbeddingModel: codeEmbedModel.trim(),
      knowledgeEmbeddingModel: knowledgeEmbedModel.trim(),
      embeddingsBaseUrl: embeddingsBaseUrl.trim(),
      serverRagEnabled: opts?.serverRag ?? serverRagEnabled,
    });
    setBaseUrl(config.base_url);
    setSelectedModel(config.selected_model || opts?.selected || selectedModel);
    setApiKeySaved(config.api_key_saved);
    setEmbeddingsEnabled(Boolean(config.embeddings_enabled));
    setCodeEmbedModel(config.code_embedding_model || '');
    setKnowledgeEmbedModel(config.knowledge_embedding_model || '');
    setEmbeddingsBaseUrl(config.embeddings_base_url || '');
    setServerRagEnabled(Boolean(config.server_rag_enabled));
    if (apiKey.trim()) setApiKey('');
    return config;
  };

  const testConnection = async () => {
    setBusy(true);
    setError(null);
    setStatus('Connecting to the organization server...');
    try {
      const result = await invoke<EnterpriseServerTestResult>('test_enterprise_server_connection', {
        baseUrl,
        apiKey: apiKey.trim() ? apiKey.trim() : null,
        embeddingsBaseUrl: embeddingsBaseUrl.trim() ? embeddingsBaseUrl.trim() : null,
        codeEmbeddingModel: embeddingsEnabled && codeEmbedModel.trim() ? codeEmbedModel.trim() : null,
        knowledgeEmbeddingModel: embeddingsEnabled && knowledgeEmbedModel.trim() ? knowledgeEmbedModel.trim() : null,
      });
      setModels(result.models || []);
      setEmbeddingProbes(result.embedding_probes || []);
      setStatus(result.message);
      if (!selectedModel && result.models?.[0]?.id) setSelectedModel(result.models[0].id);

      const tokenForProbe = apiKey.trim()
        || (apiKeySaved ? await invoke<string>('get_enterprise_server_token').catch(() => '') : '');
      if (tokenForProbe) {
        const ragOk = await probeServerRag(baseUrl, tokenForProbe);
        setServerRagReachable(ragOk);
        if (ragOk && !serverRagEnabled) {
          setStatus(prev => `${prev || result.message} Knowledge API reachable — you can enable Server RAG.`);
        }
      } else {
        setServerRagReachable(null);
      }
    } catch (err) {
      setError(humanError(err));
      setStatus(null);
    } finally {
      setBusy(false);
    }
  };

  const refreshModels = async () => {
    setBusy(true);
    setError(null);
    setStatus('Loading models from the organization server...');
    try {
      const list = await invoke<EnterpriseModelInfo[]>('list_enterprise_server_models', {
        baseUrl: baseUrl.trim() ? baseUrl.trim() : null,
        apiKey: apiKey.trim() ? apiKey.trim() : null,
      });
      setModels(list);
      setStatus(`Loaded ${list.length} model(s) from the organization server.`);
      if (!selectedModel && list[0]?.id) setSelectedModel(list[0].id);
    } catch (err) {
      setError(humanError(err));
      setStatus(null);
    } finally {
      setBusy(false);
    }
  };

  const useModel = async (modelId?: string, dest: 'chat' | 'pocketcode' = 'chat') => {
    const id = (modelId || selectedModel).trim();
    if (!id) {
      setError('Choose a server model first.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await saveConfig({ selected: id });
      store.setCurrentModel(`enterprise:${id}`);

      const title = `Server: ${normalizeModelName(id)}`;
      if (dest === 'pocketcode') {
        store.setActiveView('code-workspace');
        setStatus(`${title} is active for PocketCode (org chat completions — not Knowledge Chat Server RAG).`);
      } else {
        const conversationId = await invoke<string>('create_conversation', {
          title: 'New Chat',
          characterId: store.activeCharacterId || null,
          modelId: `enterprise:${id}`,
          mode: 'organization-server',
        });
        store.setActiveConversation(conversationId);
        store.rememberConversationForMode('chat', conversationId);
        store.setMessages(conversationId, []);
        const convs = await invoke<Conversation[]>('get_conversations');
        store.setConversations(convs);
        store.setActiveView('chat');
        setStatus(`${title} is now active. A new server chat has been created.`);
      }
    } catch (err) {
      setError(humanError(err));
    } finally {
      setBusy(false);
    }
  };

  const clearToken = async () => {
    setBusy(true);
    setError(null);
    try {
      await invoke('clear_enterprise_server_key');
      setApiKey('');
      setApiKeySaved(false);
      setStatus('Organization server token removed from this device.');
    } catch (err) {
      setError(humanError(err));
    } finally {
      setBusy(false);
    }
  };

  const copyReport = async () => {
    const text = [
      'PocketMind Hybrid AI Organization Server Configuration',
      `Endpoint: ${baseUrl || '(not set)'}`,
      `Selected model: ${selectedModel || '(not set)'}`,
      `Token saved: ${apiKeySaved ? 'yes' : apiKey.trim() ? 'pending save' : 'no'}`,
      `Visible models: ${models.length}`,
      ...models.slice(0, 20).map(m => `- ${m.id}${m.owned_by ? ` (${m.owned_by})` : ''}`),
    ].join('\n');
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6">
      <div className="relative overflow-hidden rounded-[2rem] border border-white/70 dark:border-surface-800 bg-white/80 dark:bg-surface-950/75 shadow-2xl backdrop-blur-2xl p-6">
        <div className="absolute -right-20 -top-20 h-56 w-56 rounded-full bg-primary-300/30 blur-3xl" />
        <div className="absolute -left-16 bottom-0 h-52 w-52 rounded-full bg-primary-300/20 blur-3xl" />
        <div className="relative flex flex-col lg:flex-row lg:items-center lg:justify-between gap-6">
          <div className="space-y-3 max-w-3xl">
            <div className="inline-flex items-center gap-2 rounded-full border border-primary-200 bg-primary-50 px-3 py-1 text-xs font-bold text-primary-700 dark:border-primary-900/60 dark:bg-primary-950/40 dark:text-primary-200">
              <Building2 className="w-4 h-4" /> Organization Server Mode
            </div>
            <h1 className="text-3xl lg:text-4xl font-black tracking-tight gradient-text">Private AI for the whole company</h1>
            <p className="text-surface-600 dark:text-surface-300 leading-relaxed">
              Connect PocketMind Hybrid AI to a company-owned OpenAI-compatible inference server. Employees keep using the same Windows, macOS, and mobile clients while large models run on internal GPU servers with centralized access control.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-3 text-sm min-w-[18rem]">
            <div className="premium-card p-4">
              <Zap className="w-5 h-5 text-primary-500 mb-2" />
              <div className="font-bold">Large models</div>
              <div className="text-xs text-surface-500">32B / 70B / enterprise models on server hardware</div>
            </div>
            <div className="premium-card p-4">
              <ShieldCheck className="w-5 h-5 text-primary-500 mb-2" />
              <div className="font-bold">Private network</div>
              <div className="text-xs text-surface-500">Data can stay inside the company environment</div>
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        <div className="xl:col-span-2 premium-card p-6 space-y-5">
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 rounded-2xl bg-gradient-to-br from-primary-600 to-primary-400 flex items-center justify-center text-surface-950 shadow-lg">
              <ServerCog className="w-6 h-6" />
            </div>
            <div>
              <h2 className="text-xl font-black">Server connection</h2>
              <p className="text-sm text-surface-500">Use a vLLM, TGI, llama.cpp, or compatible private endpoint that exposes /v1/models and /v1/chat/completions.</p>
            </div>
          </div>

          <div className="space-y-4">
            <label className="block">
              <span className="text-sm font-bold text-surface-700 dark:text-surface-200">OpenAI-compatible server URL</span>
              <input
                value={baseUrl}
                onChange={e => setBaseUrl(e.target.value)}
                placeholder="http://192.168.1.50:8000/v1"
                className="input-field mt-2"
              />
              <span className="text-xs text-surface-500 mt-1 block">Use the internal LAN/VPN URL. If /v1 is missing, PocketMind Hybrid AI will add it automatically.</span>
            </label>

            <label className="block">
              <span className="text-sm font-bold text-surface-700 dark:text-surface-200">Organization access token</span>
              <div className="flex gap-2 mt-2">
                <input
                  value={apiKey}
                  onChange={e => setApiKey(e.target.value)}
                  type="password"
                  placeholder={apiKeySaved ? 'Token saved — enter a new token only if changing it' : 'Optional for trusted internal servers'}
                  className="input-field flex-1"
                />
                {apiKeySaved && (
                  <button onClick={clearToken} disabled={busy} className="btn-secondary whitespace-nowrap">Remove token</button>
                )}
              </div>
              <span className="text-xs text-surface-500 mt-1 block">The token is encrypted on this device. Leave it empty only if the server intentionally allows internal unauthenticated access.</span>
            </label>

            <div className="flex flex-wrap gap-3">
              <button onClick={testConnection} disabled={busy || !baseUrl.trim()} className="btn-primary">
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Network className="w-4 h-4" />}
                Test connection
              </button>
              <button onClick={refreshModels} disabled={busy || !baseUrl.trim()} className="btn-secondary">
                <RefreshCw className="w-4 h-4" /> Load models
              </button>
              <button onClick={() => saveConfig().then(() => setStatus('Organization server settings saved.')).catch(err => setError(humanError(err)))} disabled={busy || !baseUrl.trim()} className="btn-secondary">
                <KeyRound className="w-4 h-4" /> Save settings
              </button>
              <button onClick={copyReport} className="btn-secondary">
                <Copy className="w-4 h-4" /> {copied ? 'Copied' : 'Copy report'}
              </button>
            </div>

            <div className="rounded-2xl border border-surface-200 dark:border-surface-800 bg-surface-50/70 dark:bg-surface-900/50 p-4 space-y-3">
              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={serverRagEnabled}
                  onChange={async e => {
                    const next = e.target.checked;
                    setServerRagEnabled(next);
                    try {
                      await saveConfig({ serverRag: next });
                      setStatus(next
                        ? 'Server RAG enabled — Knowledge Chat will use the organization gateway.'
                        : 'Server RAG disabled — Knowledge Chat uses local indexing again.');
                    } catch (err) {
                      setServerRagEnabled(!next);
                      setError(humanError(err));
                    }
                  }}
                  className="h-4 w-4 rounded border-surface-300"
                />
                <span className="text-sm font-bold text-surface-700 dark:text-surface-200">
                  Server RAG (Knowledge Chat on org gateway)
                </span>
              </label>
              <p className="text-xs text-surface-500">
                Thin client mode: the desktop app sends questions and a Bearer token only.
                Collections, embeddings, rerank, and answers run on the Full Server RAG stack
                (<code className="mx-1">/v1/knowledge/*</code>). Leave off to keep local Knowledge Chat.
              </p>
              {serverRagReachable === true && (
                <div className="text-xs text-emerald-700 dark:text-emerald-300">Knowledge API reachable on this endpoint.</div>
              )}
              {serverRagReachable === false && (
                <div className="text-xs text-amber-700 dark:text-amber-300">
                  Knowledge API not detected — point Org Server URL at the gateway (port 8080) after setup.sh.
                </div>
              )}
            </div>

            <div className="rounded-2xl border border-surface-200 dark:border-surface-800 bg-surface-50/70 dark:bg-surface-900/50 p-4 space-y-3">
              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={embeddingsEnabled}
                  onChange={e => setEmbeddingsEnabled(e.target.checked)}
                  className="h-4 w-4 rounded border-surface-300"
                />
                <span className="text-sm font-bold text-surface-700 dark:text-surface-200">Use organization server for Knowledge Chat embeddings</span>
              </label>
              <p className="text-xs text-surface-500">
                When enabled, dense indexing and query embedding are offloaded to the organization server's
                <code className="mx-1">/v1/embeddings</code> endpoint. PocketMind Hybrid AI falls back to local embeddings automatically if the server is unreachable, so retrieval never silently degrades.
              </p>

              {embeddingsEnabled && (
                <div className="space-y-3">
                  <label className="block">
                    <span className="text-xs font-bold text-surface-600 dark:text-surface-300">Code embedding model id (Nomic)</span>
                    <input
                      value={codeEmbedModel}
                      onChange={e => setCodeEmbedModel(e.target.value)}
                      placeholder="nomic-embed-text-v1.5"
                      className="input-field mt-1"
                    />
                  </label>
                  <label className="block">
                    <span className="text-xs font-bold text-surface-600 dark:text-surface-300">Knowledge embedding model id (BGE-M3)</span>
                    <input
                      value={knowledgeEmbedModel}
                      onChange={e => setKnowledgeEmbedModel(e.target.value)}
                      placeholder="bge-m3"
                      className="input-field mt-1"
                    />
                  </label>
                  <label className="block">
                    <span className="text-xs font-bold text-surface-600 dark:text-surface-300">Embeddings base URL (optional)</span>
                    <input
                      value={embeddingsBaseUrl}
                      onChange={e => setEmbeddingsBaseUrl(e.target.value)}
                      placeholder="Leave empty to reuse the chat server URL"
                      className="input-field mt-1"
                    />
                    <span className="text-xs text-surface-500 mt-1 block">llama.cpp serves one model per process, so embed models often run on separate ports/URLs from chat.</span>
                  </label>

                  {embeddingProbes.length > 0 && (
                    <div className="space-y-1">
                      {embeddingProbes.map(probe => (
                        <div
                          key={probe.partition}
                          className={`flex items-start gap-2 rounded-xl px-3 py-2 text-xs ${probe.ok ? 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-200' : 'bg-red-50 text-red-800 dark:bg-red-950/30 dark:text-red-200'}`}
                        >
                          {probe.ok ? <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" /> : <Network className="w-4 h-4 mt-0.5 shrink-0" />}
                          <span><strong className="capitalize">{probe.partition}</strong>: {probe.message}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            {status && <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800 dark:border-emerald-900/50 dark:bg-emerald-950/30 dark:text-emerald-200">{status}</div>}
            {error && <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-200">{error}</div>}
          </div>
        </div>

        <div className="premium-card p-6 space-y-4">
          <h2 className="text-xl font-black flex items-center gap-2"><Sparkles className="w-5 h-5 text-primary-500" /> Deployment design</h2>
          <div className="space-y-3 text-sm text-surface-600 dark:text-surface-300">
            <p><strong>Client apps:</strong> Windows, macOS, and Android connect to one private endpoint.</p>
            <p><strong>Server:</strong> IT loads the model once on GPU hardware and controls access centrally.</p>
            <p><strong>Scaling:</strong> The server engine handles one GPU, multiple GPUs, or future server upgrades without changing the user app.</p>
          </div>
          <div className="rounded-2xl bg-surface-100/80 dark:bg-surface-900/80 p-4 text-xs text-surface-600 dark:text-surface-300">
            Recommended enterprise engines: vLLM for high-throughput multi-GPU serving, Hugging Face TGI for production transformer serving, and llama.cpp server for GGUF deployments.
          </div>
        </div>
      </div>

      <div className="premium-card p-6 space-y-4">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <h2 className="text-xl font-black">Available server models</h2>
            <p className="text-sm text-surface-500">Models returned by the private server. Selecting one creates a new Organization Server chat.</p>
          </div>
          {serverReady && <div className="text-xs font-bold px-3 py-1 rounded-full bg-primary-100 text-primary-700 dark:bg-primary-950/50 dark:text-primary-200">Ready: {selectedModel}</div>}
        </div>

        {models.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-surface-300 dark:border-surface-700 p-6 text-center text-surface-500">
            No server models loaded yet. Test the connection or load models from the configured endpoint.
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {models.map(model => {
              const active = selectedModel === model.id || store.currentModel === `enterprise:${model.id}`;
              return (
                <div key={model.id} className={`rounded-3xl border p-4 transition-all ${active ? 'border-primary-400 bg-primary-50/80 dark:bg-primary-950/30 shadow-lg' : 'border-white/70 dark:border-surface-800 bg-white/70 dark:bg-surface-950/50'}`}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="font-black truncate" title={model.id}>{normalizeModelName(model.id)}</h3>
                      <p className="text-xs text-surface-500 truncate" title={model.id}>{model.id}</p>
                      {model.owned_by && <p className="text-xs text-surface-400 mt-1">Owner: {model.owned_by}</p>}
                    </div>
                    {active && <CheckCircle2 className="w-5 h-5 text-primary-500 shrink-0" />}
                  </div>
                  <div className="mt-4 grid grid-cols-1 gap-2">
                    <button onClick={() => void useModel(model.id, 'chat')} disabled={busy} className="btn-primary w-full">
                      Use in Chat
                    </button>
                    <button onClick={() => void useModel(model.id, 'pocketcode')} disabled={busy} className="btn-secondary w-full">
                      Use in PocketCode
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {[
          ['1. Deploy server', 'Company IT deploys vLLM, TGI, or llama.cpp server on GPU hardware.'],
          ['2. Connect clients', 'Employees enter the private endpoint in PocketMind Hybrid AI and select the server model.'],
          ['3. Scale hardware', 'Add more GPUs or stronger servers behind the same endpoint without changing the client app.'],
        ].map(([title, body]) => (
          <div key={title} className="premium-card p-5">
            <h3 className="font-black mb-2">{title}</h3>
            <p className="text-sm text-surface-500 leading-relaxed">{body}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
