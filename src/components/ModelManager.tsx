import { useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/tauri';
import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/api/dialog';
import { Download, FolderSearch, HardDrive, Link as LinkIcon, RefreshCcw, Search, Trash2, CheckCircle, AlertTriangle, FlaskConical, Globe2, KeyRound, Crown, Zap, Tags, Power, Square } from 'lucide-react';
import { useAppStore } from '../store';
import { LocalModelRecord, OnlineChatModel, ModelCategoryId, Conversation } from '../types';
import { MODEL_CATEGORIES, OFFLINE_CHAT_CATALOG, ONLINE_CHAT_MODELS } from '../modelCatalog';
import { CHAT_API_PROVIDERS } from '../apiProviders';
import { validateApiKey, type ApiKeyValidation } from '../apiKeyValidation';
import { pathPlaceholder } from '../platformPaths';
import { answerModelLabel, remoteModelPath } from '../answerModel';
import { onOpenExternal } from '../openExternal';
import { filterChatSelectableLocalModels, isChatSelectableLocalModel } from '../localModels';

interface DownloadProgress {
  id: string;
  file_name: string;
  status: string;
  downloaded_bytes: number;
  total_bytes: number | null;
  speed_bytes_per_sec: number;
  retries: number;
  message: string;
  elapsed_secs: number;
}

type DownloadableModel = (typeof OFFLINE_CHAT_CATALOG)[number];

type ModelTab = 'offline' | 'online-free' | 'online-premium' | 'categories';

const CHAT_CATEGORIES = MODEL_CATEGORIES.filter(c => !c.id.startsWith('image-'));
const PRESETS: DownloadableModel[] = OFFLINE_CHAT_CATALOG;

function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || Number.isNaN(bytes)) return 'Unknown';
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx += 1;
  }
  return `${value.toFixed(idx === 0 ? 0 : 2)} ${units[idx]}`;
}

function formatSpeed(bytesPerSec: number): string {
  if (!bytesPerSec || bytesPerSec < 1) return '0 MB/s';
  return `${(bytesPerSec / 1024 / 1024).toFixed(2)} MB/s`;
}

function quantFamilyKey(name: string): string {
  return name
    .replace(/\.gguf$/i, '')
    .replace(/[._-]?(q[0-9](_k_[msl])?|Q[0-9](_K_[MSL])?)/g, '')
    .replace(/[._-]+$/g, '')
    .toLowerCase();
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return 'Unknown';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function fileNameFromUrl(url: string): string {
  try {
    const clean = url.split('?')[0];
    const last = clean.substring(clean.lastIndexOf('/') + 1);
    return decodeURIComponent(last || 'model.gguf');
  } catch {
    return 'model.gguf';
  }
}

export default function ModelManager() {
  const [search, setSearch] = useState('');
  const statusRef = useRef<HTMLDivElement | null>(null);
  const [directUrl, setDirectUrl] = useState('');
  const [status, setStatus] = useState<string>('');
  const [error, setError] = useState<string>('');
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [stoppingDownload, setStoppingDownload] = useState(false);
  const [healthBusy, setHealthBusy] = useState(false);
  const [healthResult, setHealthResult] = useState<string>('');
  const [unloadBusy, setUnloadBusy] = useState(false);
  const [activeTab, setActiveTab] = useState<ModelTab>('offline');
  const [categoryFilter, setCategoryFilter] = useState<ModelCategoryId | 'all'>('all');
  const [configuredProviders, setConfiguredProviders] = useState<string[]>([]);
  const [apiKeyInputs, setApiKeyInputs] = useState<Record<string, string>>({});
  const [keyValidating, setKeyValidating] = useState<Record<string, boolean>>({});
  const [keyValidation, setKeyValidation] = useState<Record<string, ApiKeyValidation | null>>({});
  const {
    localModels,
    setLocalModels,
    setCurrentModel,
    currentModel,
    modelsDir,
    setModelsDir,
    defaultParams,
    activeCharacterId,
    setActiveConversation,
    setMessages,
    setConversations,
    setActiveView,
    deploymentConfig,
  } = useAppStore();

  const filtered = useMemo(
    () => PRESETS.filter(m => {
      const q = search.toLowerCase().trim();
      const matchesSearch = !q || [m.name, m.params, m.quant, m.recommendedUse, ...m.categories].join(' ').toLowerCase().includes(q);
      const matchesCategory = categoryFilter === 'all' || m.categories.includes(categoryFilter);
      return matchesSearch && matchesCategory;
    }),
    [search, categoryFilter]
  );

  const onlineFreeModels = useMemo(() => ONLINE_CHAT_MODELS.filter(m => m.tier === 'free' && (categoryFilter === 'all' || m.categories.includes(categoryFilter))), [categoryFilter]);
  const onlinePremiumModels = useMemo(() => ONLINE_CHAT_MODELS.filter(m => m.tier === 'premium' && (categoryFilter === 'all' || m.categories.includes(categoryFilter))), [categoryFilter]);
  const visionOnlineCount = useMemo(() => ONLINE_CHAT_MODELS.filter(m => m.categories.includes('vision')).length, []);

  const quantFamilies = useMemo(() => {
    const map = new Map<string, LocalModelRecord[]>();
    for (const model of localModels) {
      const key = quantFamilyKey(model.name || model.path);
      const list = map.get(key) || [];
      list.push(model);
      map.set(key, list);
    }
    return Array.from(map.entries())
      .filter(([, siblings]) => siblings.length > 1)
      .map(([family, siblings]) => ({ family, siblings }));
  }, [localModels]);

  const catalogQuantGroups = useMemo(() => {
    const byId = new Map<string, DownloadableModel>();
    for (const model of OFFLINE_CHAT_CATALOG) {
      const prev = byId.get(model.id);
      // Prefer the entry that has a download URL when catalog IDs collide.
      if (!prev || (!prev.url && model.url)) byId.set(model.id, model);
    }
    const map = new Map<string, DownloadableModel[]>();
    for (const model of byId.values()) {
      const key = quantFamilyKey(model.name);
      const list = map.get(key) || [];
      list.push(model);
      map.set(key, list);
    }
    return Array.from(map.entries())
      .filter(([, siblings]) => siblings.some(s => /Q[458]/i.test(s.quant)))
      .slice(0, 8)
      .map(([family, siblings]) => ({ family, siblings }));
  }, []);

  const refreshModels = async () => {
    const models = await invoke<LocalModelRecord[]>('get_local_models');
    setLocalModels(filterChatSelectableLocalModels(models));
  };

  const refreshProviders = async () => {
    try {
      const providers = await invoke<string[]>('get_api_key_providers');
      setConfiguredProviders(providers);
    } catch {
      setConfiguredProviders([]);
    }
  };

  useEffect(() => {
    refreshModels().catch(err => setError(String(err)));
    refreshProviders();
    const unlisten = listen<DownloadProgress>('model-download-progress', event => {
      setProgress(event.payload);
      setStatus(event.payload.message || event.payload.status);
    });
    return () => {
      unlisten.then(fn => fn()).catch(() => undefined);
    };
  }, []);


  const announce = (message: string, isError = false) => {
    if (isError) {
      setError(message);
    } else {
      setError('');
      setStatus(message);
    }
    setTimeout(() => statusRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 50);
  };

  const hasMeaningfulMessages = (items: Array<{ role?: string; content?: string }> | undefined): boolean => {
    return (items || []).some(m => {
      const role = String(m.role || '').toLowerCase();
      const content = String(m.content || '').trim();
      return (role === 'user' || role === 'assistant') && Boolean(content) && content !== 'Thinking...';
    });
  };

  const removeEmptyActiveChatBeforeModelSwitch = async () => {
    const state = useAppStore.getState();
    const activeId = state.activeConversationId;
    if (!activeId) return;

    const localMessages = state.messages[activeId];
    let hasMessages = hasMeaningfulMessages(localMessages);

    // If the message list is not loaded in memory yet, check the database before deciding.
    if (!Array.isArray(localMessages)) {
      try {
        const savedMessages = await invoke<Array<{ role?: string; content?: string }>>('get_messages', { conversationId: activeId });
        hasMessages = hasMeaningfulMessages(savedMessages);
      } catch {
        // If the DB check fails, do not delete anything. Safety first.
        return;
      }
    }

    if (hasMessages) return;

    try {
      await invoke('delete_conversation', { id: activeId });
    } catch {
      // Local cleanup still runs so an empty draft does not stay visible in the sidebar.
    }
    state.removeConversationLocal(activeId);
  };

  /** Set the shared answer model for Chat and Knowledge Chat without leaving Models. */
  const activateAnswerModel = (modelPath: string, modelName: string) => {
    const previousModel = useAppStore.getState().currentModel;
    setCurrentModel(modelPath);
    if (previousModel === modelPath) {
      announce(`${modelName} is already the active model for Chat and Knowledge Chat.`);
      return;
    }
    announce(`${modelName} is now the active model for Chat and Knowledge Chat.`);
  };

  const startFreshChatForModel = async (modelPath: string, modelName: string) => {
    try {
      // If the previous model switch created an empty draft chat and the user never typed,
      // remove that draft before creating the next one. This prevents sidebar clutter.
      await removeEmptyActiveChatBeforeModelSwitch();
      setCurrentModel(modelPath);

      // Model changes should never continue inside an unrelated older conversation.
      // Start one fresh chat for the selected model, but do not keep unused empty drafts.
      const id = await invoke<string>('create_conversation', {
        title: 'New Chat',
        characterId: activeCharacterId || null,
        modelId: modelPath,
        mode: 'chat'
      });
      setActiveConversation(id);
      setMessages(id, []);
      const convs = await invoke<Conversation[]>('get_conversations');
      setConversations(convs);
      setActiveView('chat');
      announce(`Started a new chat with ${modelName}.`);
    } catch (err) {
      // Keep the model selection if chat creation fails so the user can still create a chat manually.
      setCurrentModel(modelPath);
      announce(`Model selected, but PocketMind Hybrid AI could not create a fresh chat automatically: ${String(err)}`, true);
    }
  };

  const selectLocalAnswerModel = async (model: LocalModelRecord) => {
    if (!isChatSelectableLocalModel(model)) {
      announce('Select the primary GGUF (*-00001-of-*.gguf), not a secondary shard or mmproj.', true);
      return;
    }
    try {
      const exists = await invoke<boolean>('path_exists', { path: model.path });
      if (!exists) {
        announce('That GGUF file is missing on disk. Scan/Import again after placing the file.', true);
        await refreshModels();
        return;
      }
    } catch {
      /* path_exists optional */
    }
    activateAnswerModel(model.path, model.name);
  };

  const chooseFolder = async () => {
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected === 'string') setModelsDir(selected);
  };

  const scanFolder = async () => {
    setError('');
    announce('Scanning selected folder for .gguf models...');
    try {
      const models = await invoke<LocalModelRecord[]>('scan_model_folder', { folderPath: modelsDir });
      const selectable = filterChatSelectableLocalModels(models);
      setLocalModels(selectable);
      announce(`Scan complete. ${selectable.length} selectable local model(s) in the library (extra shards / mmproj hidden).`);
    } catch (err) {
      announce(String(err), true);
    }
  };

  const importModel = async () => {
    setError('');
    try {
      const selected = await open({ multiple: false, filters: [{ name: 'GGUF model', extensions: ['gguf'] }] });
      if (typeof selected !== 'string') return;
      const model = await invoke<LocalModelRecord>('import_local_model', { path: selected });
      await refreshModels();
      await startFreshChatForModel(model.path, model.name);
      announce(`Imported ${model.name}. A fresh chat has been created for this model.`);
    } catch (err) {
      announce(String(err), true);
    }
  };

  /** Copy a projector next to the GGUF so offline vision / VL pairing works. */
  const linkMmprojBeside = async (model: LocalModelRecord) => {
    setError('');
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: 'mmproj GGUF', extensions: ['gguf'] }],
        title: 'Select mmproj projector for this model',
      });
      if (typeof selected !== 'string') return;
      const dest = await invoke<string>('link_mmproj_beside_model', {
        modelPath: model.path,
        mmprojPath: selected,
      });
      announce(`Linked mmproj beside ${model.name}: ${dest}`);
      await refreshModels();
    } catch (err) {
      announce(String(err), true);
    }
  };

  const startDownload = async (model: DownloadableModel | null) => {
    const url = model?.url || directUrl.trim();
    if (!url) {
      announce(model ? `${model.name} is a catalog entry. This catalog entry does not include a direct GGUF URL. Paste a direct .gguf link or choose a downloadable entry.` : 'Paste a direct .gguf URL first. Hugging Face links usually contain /resolve/main/ and end with .gguf.', true);
      return;
    }
    setError('');
    const shardCount = model?.shardUrls?.length ?? 0;
    announce(
      model?.mmprojUrl
        ? shardCount > 0
          ? `Starting multi-shard GGUF download (${1 + shardCount} parts), then mmproj for offline vision…`
          : 'Starting GGUF download, then mmproj for offline vision…'
        : 'Starting download. Progress will stay visible in the status panel below.',
    );
    setProgress({
      id: model?.id || 'direct',
      file_name: fileNameFromUrl(url),
      status: 'starting',
      downloaded_bytes: 0,
      total_bytes: null,
      speed_bytes_per_sec: 0,
      retries: 0,
      message: 'Connecting...',
      elapsed_secs: 0,
    });
    setDownloadingId(model?.id || 'direct');

    // Always keep the Hugging Face basename (includes quant + mmproj markers).
    // Renaming to a friendly catalog title breaks mmproj auto-pairing.
    const mmprojBase = fileNameFromUrl(url)
      .replace(/\.gguf$/i, '')
      .replace(/-split-\d+-of-\d+$/i, '')
      .replace(/-\d{5}-of-\d{5}$/i, '');
    const mmprojLeaf = model?.mmprojUrl ? fileNameFromUrl(model.mmprojUrl) : '';
    const mmprojName = model?.mmprojUrl
      ? (/^mmproj[-_.]?(f16|bf16|f32|q8_0)?\.gguf$/i.test(mmprojLeaf)
        ? `mmproj-${mmprojBase}-f16.gguf`
        : mmprojLeaf)
      : null;

    const jobFiles = [
      fileNameFromUrl(url),
      ...(model?.shardUrls || []).map(fileNameFromUrl),
      ...(mmprojName ? [mmprojName] : []),
    ];

    try {
      await invoke('begin_model_download_job', { destDir: modelsDir, files: jobFiles });
      const record = await invoke<LocalModelRecord>('download_model', {
        url,
        destDir: modelsDir,
        name: null,
      });
      if (model?.shardUrls?.length) {
        for (let i = 0; i < model.shardUrls.length; i++) {
          announce(`Downloading shard ${i + 2} of ${1 + model.shardUrls.length}…`);
          await invoke<LocalModelRecord>('download_model', {
            url: model.shardUrls[i],
            destDir: modelsDir,
            name: null,
          });
        }
      }
      if (model?.mmprojUrl) {
        announce('GGUF ready. Downloading mmproj projector for vision…');
        await invoke<LocalModelRecord>('download_model', {
          url: model.mmprojUrl,
          destDir: modelsDir,
          name: mmprojName,
        });
      }
      await refreshModels();
      await startFreshChatForModel(record.path, record.name);
      announce(
        model?.visionCapable || model?.mmprojUrl
          ? `Download complete (vision-ready if mmproj is beside the GGUF). Select the primary shard (${record.name}) in PocketCode.`
          : `Download complete. A fresh chat has been created for ${record.name}.`,
      );
    } catch (err) {
      const msg = String(err);
      if (/stopped by user|partial files were deleted/i.test(msg)) {
        setProgress(null);
        announce('Download stopped. All files for this download were removed from disk.');
      } else {
        announce(msg, true);
      }
    } finally {
      setDownloadingId(null);
      setStoppingDownload(false);
    }
  };

  const stopDownload = async () => {
    if (!downloadingId || stoppingDownload) return;
    setStoppingDownload(true);
    announce('Stopping download and clearing files…');
    try {
      const msg = await invoke<string>('cancel_model_download');
      announce(msg || 'Download stopped. Files cleared.');
      setProgress(null);
    } catch (err) {
      announce(String(err), true);
      setStoppingDownload(false);
    }
  };

  const unloadCurrentModel = async () => {
    const isRemote = !!currentModel && (currentModel.startsWith('remote:') || currentModel.startsWith('enterprise:'));
    if (isRemote) {
      setCurrentModel(null);
      announce('Online/server model deselected. Nothing was loaded in local memory.');
      return;
    }
    setUnloadBusy(true);
    setError('');
    try {
      // Keep Knowledge Chat embed/rerank warm — releasing them forces a multi-minute
      // cold start on the next question with no quality benefit.
      const result = await invoke<{ chat_unloaded: boolean; knowledge_engines_released: boolean; message: string }>(
        'unload_chat_model',
        { releaseKnowledgeEngines: false },
      );
      announce(result.message || 'Model unloaded from memory.');
    } catch (err) {
      announce(String(err), true);
    } finally {
      setUnloadBusy(false);
    }
  };

  const testCurrentModel = async () => {
    if (!currentModel) {
      announce('Select a model first, then run the health test.', true);
      return;
    }
    setHealthBusy(true);
    setHealthResult('Starting model health test...');
    setError('');
    try {
      const started = performance.now();
      const result = await invoke<{ text: string; tokens_generated?: number; tokens_per_sec?: number }>('generate_response', {
        request: {
          prompt: 'Say hello in one sentence.',
          messages: [{ role: 'user', content: 'Say hello in one sentence.' }],
          system_prompt: 'You are PocketMind Hybrid AI. Reply with exactly one short friendly sentence.',
          params: { ...defaultParams, max_tokens: 96, temperature: 0.35, top_p: 0.8, repetition_penalty: 1.2 },
          model_path: currentModel,
          backend: currentModel.startsWith('remote:') ? 'remote' : 'llama.cpp'
        }
      });
      const elapsed = ((performance.now() - started) / 1000).toFixed(1);
      const text = result.text?.trim() || '[empty response]';
      const suspicious = /(workflow engine|model card|what is gemma|\b(\w+)\s+\1\s+\1\b)/i.test(text);
      setHealthResult(`${suspicious ? 'Warning' : 'Passed'} in ${elapsed}s: ${text}`);
      announce(suspicious ? 'The model responded, but the output looks unreliable. Try a general instruct model and keep creativity low for validation.' : 'Model health test passed. You can open Chat.', suspicious);
    } catch (err) {
      const msg = String(err);
      setHealthResult(`Failed: ${msg}`);
      announce(msg, true);
    } finally {
      setHealthBusy(false);
    }
  };


  const testProviderKey = async (provider: string) => {
    setKeyValidating(prev => ({ ...prev, [provider]: true }));
    try {
      const result = await validateApiKey(provider, apiKeyInputs[provider]);
      setKeyValidation(prev => ({ ...prev, [provider]: result }));
      announce(result.message, !result.ok);
      return result;
    } catch (err) {
      const fail: ApiKeyValidation = { ok: false, provider, message: String(err) };
      setKeyValidation(prev => ({ ...prev, [provider]: fail }));
      announce(String(err), true);
      return fail;
    } finally {
      setKeyValidating(prev => ({ ...prev, [provider]: false }));
    }
  };

  const saveProviderKey = async (provider: string) => {
    const key = (apiKeyInputs[provider] || '').trim();
    if (!key) {
      announce(`Paste an API key for ${provider} first.`, true);
      return;
    }
    setKeyValidating(prev => ({ ...prev, [provider]: true }));
    try {
      const result = await validateApiKey(provider, key);
      setKeyValidation(prev => ({ ...prev, [provider]: result }));
      if (!result.ok) {
        announce(result.message, true);
        return;
      }
      await invoke('store_api_key', { provider, key });
      setApiKeyInputs(prev => ({ ...prev, [provider]: '' }));
      await refreshProviders();
      announce(`${provider}: ${result.message} Saved locally (encrypted).`);
    } catch (err) {
      announce(String(err), true);
    } finally {
      setKeyValidating(prev => ({ ...prev, [provider]: false }));
    }
  };

  const ensureOnlineKey = (model: OnlineChatModel): boolean => {
    if (model.requiresApiKey && !configuredProviders.includes(model.provider)) {
      announce(`Add your ${model.providerName} API key before using ${model.name}.`, true);
      setActiveTab(model.tier === 'free' ? 'online-free' : 'online-premium');
      return false;
    }
    return true;
  };

  const useOnlineAnswerModel = (model: OnlineChatModel) => {
    if (!ensureOnlineKey(model)) return;
    activateAnswerModel(remoteModelPath(model), `${model.name} through ${model.providerName}`);
  };

  const openChatWithOnlineModel = async (model: OnlineChatModel) => {
    if (!ensureOnlineKey(model)) return;
    await startFreshChatForModel(remoteModelPath(model), `${model.name} through ${model.providerName}`);
  };

  const handleDelete = async (id: string) => {
    setError('');
    try {
      await invoke('delete_local_model', { id });
      await refreshModels();
      announce('Removed model from the local library. The physical GGUF file was not deleted.');
    } catch (err) {
      announce(String(err), true);
    }
  };

  const percent = progress?.total_bytes ? Math.min(100, (progress.downloaded_bytes / progress.total_bytes) * 100) : 0;
  const remaining = progress?.total_bytes ? Math.max(0, progress.total_bytes - progress.downloaded_bytes) : null;
  const eta = progress && remaining != null && progress.speed_bytes_per_sec > 0 ? remaining / progress.speed_bytes_per_sec : 0;

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="max-w-6xl mx-auto space-y-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold mb-1">Model Manager</h1>
            <p className="text-surface-500">Manage local GGUF models and online providers. The active answer model is shared by Chat and Knowledge Chat so you can compare offline vs large online models on the same pipeline.</p>
          </div>
          <button onClick={refreshModels} className="btn-secondary flex items-center gap-2">
            <RefreshCcw className="w-4 h-4" /> Refresh
          </button>
        </div>

        <div className="glass-panel rounded-xl p-4 space-y-4 border border-surface-200 dark:border-surface-800">
          <div className="flex flex-wrap gap-2">
            {[
              { id: 'offline', label: 'Offline GGUF', icon: HardDrive },
              { id: 'online-free', label: 'Online Free / Free Tier', icon: Zap },
              { id: 'online-premium', label: 'Online Premium', icon: Crown },
              { id: 'categories', label: 'Categories', icon: Tags },
            ].map(tab => (
              <button key={tab.id} onClick={() => setActiveTab(tab.id as ModelTab)} className={`px-4 py-2 rounded-xl text-sm font-semibold flex items-center gap-2 transition-all ${activeTab === tab.id ? 'bg-primary-600 text-white shadow-lg shadow-primary-500/20' : 'bg-surface-100 dark:bg-surface-800 hover:bg-surface-200 dark:hover:bg-surface-700 text-surface-600 dark:text-surface-300'}`}>
                <tab.icon className="w-4 h-4" /> {tab.label}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap gap-2">
            <button onClick={() => setCategoryFilter('all')} className={`px-3 py-1.5 rounded-lg text-xs font-medium ${categoryFilter === 'all' ? 'bg-primary-100 dark:bg-primary-900/40 text-primary-700 dark:text-primary-300' : 'bg-surface-100 dark:bg-surface-800 text-surface-500'}`}>All categories</button>
            {CHAT_CATEGORIES.map(cat => (
              <button key={cat.id} onClick={() => setCategoryFilter(cat.id)} className={`px-3 py-1.5 rounded-lg text-xs font-medium ${categoryFilter === cat.id ? 'bg-primary-100 dark:bg-primary-900/40 text-primary-700 dark:text-primary-300' : 'bg-surface-100 dark:bg-surface-800 hover:bg-surface-200 dark:hover:bg-surface-700 text-surface-500'}`}>{cat.icon} {cat.label}</button>
            ))}
          </div>
        </div>

        <div ref={statusRef} className="glass-panel rounded-xl p-5 border border-surface-200 dark:border-surface-800">
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
            <div>
              <p className="text-sm uppercase tracking-wider text-surface-500 font-semibold">Active answer model</p>
              <p className="font-semibold text-lg break-all">{answerModelLabel(currentModel, localModels)}</p>
              <p className="text-sm text-surface-500 mt-1">{currentModel ? currentModel : 'Choose a local GGUF or an online model below. The same selection drives Chat and Knowledge Chat.'}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button onClick={unloadCurrentModel} disabled={unloadBusy} className="btn-secondary disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2" title="Free RAM/VRAM by unloading the local chat model and Knowledge Chat search engines">
                <Power className="w-4 h-4" /> {unloadBusy ? 'Unloading...' : 'Unload from memory'}
              </button>
              <button onClick={testCurrentModel} disabled={!currentModel || healthBusy} className="btn-secondary disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"><FlaskConical className="w-4 h-4" /> {healthBusy ? 'Checking...' : 'Run Health Check'}</button>
              <button onClick={() => useAppStore.getState().setActiveView('knowledge-chat')} disabled={!currentModel} className="btn-secondary disabled:opacity-50 disabled:cursor-not-allowed">Open Knowledge Chat</button>
              <button onClick={() => useAppStore.getState().setActiveView('chat')} disabled={!currentModel} className="btn-primary disabled:opacity-50 disabled:cursor-not-allowed">Open Chat</button>
            </div>
          </div>
        </div>

        {healthResult && (
          <div className="glass-panel rounded-xl p-4 border border-surface-200 dark:border-surface-800 text-sm">
            <p className="font-semibold mb-1">Latest Model Health Check</p>
            <p className="text-surface-500 whitespace-pre-wrap">{healthResult}</p>
          </div>
        )}

        {(status || error || progress) && (
          <div className={`glass-panel rounded-xl p-5 border ${error ? 'border-red-500/50' : 'border-primary-500/30'}`}>
            <div className="flex items-start gap-3">
              {error ? <AlertTriangle className="w-5 h-5 text-red-500 mt-0.5" /> : <CheckCircle className="w-5 h-5 text-primary-500 mt-0.5" />}
              <div className="flex-1 space-y-3">
                <p className={`font-medium ${error ? 'text-red-500' : ''}`}>{error || status}</p>
                {progress && (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between gap-3">
                      <span className="truncate text-sm text-surface-500">{progress.file_name}</span>
                      <div className="flex items-center gap-2 shrink-0">
                        <span className="text-sm font-semibold">{percent.toFixed(1)}%</span>
                        {downloadingId && (
                          <button
                            type="button"
                            onClick={stopDownload}
                            disabled={stoppingDownload}
                            className="btn-secondary flex items-center gap-1.5 text-red-600 dark:text-red-400 border-red-300/50 disabled:opacity-50"
                            title="Stop download and delete all partial/completed files for this job"
                          >
                            <Square className="w-3.5 h-3.5 fill-current" />
                            {stoppingDownload ? 'Stopping…' : 'Stop & clear'}
                          </button>
                        )}
                      </div>
                    </div>
                    <div className="rounded-xl border border-primary-300/40 bg-primary-50/80 dark:bg-primary-950/30 px-4 py-3 flex items-end justify-between gap-3">
                      <div>
                        <p className="text-[11px] uppercase tracking-[0.16em] text-surface-500 font-bold">Download speed</p>
                        <p className="text-3xl font-black tabular-nums text-primary-700 dark:text-primary-300">
                          {formatSpeed(progress.speed_bytes_per_sec)}
                        </p>
                      </div>
                      <div className="text-right text-sm text-surface-500">
                        <p>ETA {formatTime(eta)}</p>
                        <p>{formatBytes(progress.downloaded_bytes)} / {formatBytes(progress.total_bytes)}</p>
                      </div>
                    </div>
                    <div className="h-3 bg-surface-200 dark:bg-surface-800 rounded-full overflow-hidden">
                      <div className="h-full bg-primary-500 transition-all duration-300" style={{ width: `${percent}%` }} />
                    </div>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                      <InfoTile label="Remaining" value={formatBytes(remaining)} />
                      <InfoTile label="Elapsed" value={formatTime(progress.elapsed_secs)} />
                      <InfoTile label="Retries" value={String(progress.retries)} />
                      <InfoTile label="Status" value={progress.status} />
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}


        <div className="glass-panel rounded-xl p-5 border border-primary-300/30 bg-primary-50/70 dark:bg-primary-950/20 space-y-3">
          <h2 className="font-semibold flex items-center gap-2"><Zap className="w-5 h-5 text-primary-500" /> Automatic optimization and quantization</h2>
          <p className="text-sm text-surface-600 dark:text-surface-300">PocketMind Hybrid AI keeps both small and enterprise-scale models in the catalog. For local GGUF models, the Runtime optimizer decides the launch plan automatically: full GPU offload first, calculated CPU + GPU split second, and CPU fallback last.</p>
          <div className="grid md:grid-cols-4 gap-3 text-xs">
            <InfoTile label="Q4_K_M" value="Best size/quality balance" />
            <InfoTile label="Q5_K_M / Q6_K" value="Higher quality, heavier" />
            <InfoTile label="Q8 / FP16" value="Very large hardware only" />
            <InfoTile label="GPU layers -1" value="Automatic optimizer" />
          </div>
          <p className="text-xs text-surface-500">Large 70B / 72B / 405B / GLM-5.2 and other frontier entries stay listed for organizations with qualified RAM/VRAM or hosted APIs. Offline rows without a direct URL are import targets (paste a .gguf link or import a file). If a device cannot load a local weight, PocketMind explains the fit issue instead of removing the option or crashing.</p>
        </div>

        <div className="glass-panel rounded-xl p-5 space-y-4">
          <h2 className="font-semibold flex items-center gap-2"><HardDrive className="w-5 h-5 text-primary-500" /> Local model folder</h2>
          <div className="grid grid-cols-1 md:grid-cols-[1fr_auto_auto] gap-3">
            <input value={modelsDir} onChange={e => setModelsDir(e.target.value)} className="input-field" placeholder={pathPlaceholder(deploymentConfig, 'models')} />
            <button onClick={chooseFolder} className="btn-secondary flex items-center gap-2"><FolderSearch className="w-4 h-4" /> Browse</button>
            <button onClick={scanFolder} className="btn-secondary flex items-center gap-2"><Search className="w-4 h-4" /> Scan Folder</button>
          </div>
          <div className="flex flex-wrap gap-2">
            <button onClick={importModel} className="btn-primary flex items-center gap-2"><HardDrive className="w-4 h-4" /> Import .gguf</button>
            <p className="text-xs text-surface-500 mt-2">Importing the same file again will reuse the existing library entry instead of creating duplicates.</p>
          </div>
        </div>

        <div className="glass-panel rounded-xl p-5 space-y-4">
          <h2 className="font-semibold flex items-center gap-2"><LinkIcon className="w-5 h-5 text-primary-500" /> Download by direct GGUF URL</h2>
          <p className="text-sm text-surface-500">Use a direct file URL, usually a Hugging Face link containing <code>/resolve/main/</code> and ending in <code>.gguf</code>.</p>
          <div className="grid grid-cols-1 md:grid-cols-[1fr_auto] gap-3">
            <input value={directUrl} onChange={e => setDirectUrl(e.target.value)} className="input-field" placeholder="https://huggingface.co/.../resolve/main/model.gguf?download=true" />
            <button onClick={() => startDownload(null)} disabled={!!downloadingId} className="btn-primary flex items-center gap-2 disabled:opacity-50">
              <Download className="w-4 h-4" /> Download
            </button>
          </div>
        </div>

        {(activeTab === 'online-free' || activeTab === 'online-premium') && (
          <div className="glass-panel rounded-xl overflow-hidden">
            <div className="p-4 border-b border-surface-200 dark:border-surface-800">
              <h2 className="font-semibold flex items-center gap-2"><Globe2 className="w-5 h-5 text-primary-500" /> {activeTab === 'online-free' ? 'Online Free / Free Tier Chat Models' : 'Online Premium Chat Models'}</h2>
              <p className="text-sm text-surface-500">
                Bring your own API key (OpenAI, Anthropic, DeepSeek, Mistral, Gemini, OpenRouter, Groq, Cerebras, Together). Keys stay on this device.
                Select a model after saving. Vision-capable models ({visionOnlineCount}) can understand screenshots and PDF pages in Chat and PocketCode.
              </p>
              <div className="flex flex-wrap gap-2 mt-3">
                <button
                  type="button"
                  onClick={() => setCategoryFilter(categoryFilter === 'vision' ? 'all' : 'vision')}
                  className={`text-xs px-2.5 py-1 rounded-full font-semibold ${categoryFilter === 'vision' ? 'bg-sky-600 text-white' : 'bg-sky-100 text-sky-800 dark:bg-sky-950/40 dark:text-sky-200'}`}
                >
                  Vision models
                </button>
                {categoryFilter !== 'all' && categoryFilter !== 'vision' && (
                  <button type="button" onClick={() => setCategoryFilter('all')} className="text-xs text-surface-500 underline">Clear filter</button>
                )}
              </div>
            </div>
            <div className="p-4 grid lg:grid-cols-[320px_1fr] gap-4">
              <div className="rounded-xl border border-surface-200 dark:border-surface-800 p-4 bg-surface-50 dark:bg-surface-950/40 space-y-4 max-h-[40rem] overflow-y-auto">
                <div>
                  <p className="font-semibold flex items-center gap-2"><KeyRound className="w-4 h-4 text-primary-500" /> API Keys</p>
                  <p className="text-xs text-surface-500 mt-1">
                    All providers listed. Configured: {configuredProviders.length ? configuredProviders.join(', ') : 'none yet'}.
                    Select a model from that provider after saving.
                  </p>
                </div>
                {CHAT_API_PROVIDERS.map(provider => (
                  <div key={provider.id} className="space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium">{provider.name}</span>
                      <span className={`text-[10px] px-2 py-0.5 rounded-full ${configuredProviders.includes(provider.id) ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300' : 'bg-surface-200 dark:bg-surface-800 text-surface-500'}`}>{configuredProviders.includes(provider.id) ? 'Saved' : 'Needed'}</span>
                    </div>
                    <input
                      type="password"
                      value={apiKeyInputs[provider.id] || ''}
                      onChange={e => {
                        setApiKeyInputs(prev => ({ ...prev, [provider.id]: e.target.value }));
                        setKeyValidation(prev => ({ ...prev, [provider.id]: null }));
                      }}
                      placeholder={`${provider.name} API key`}
                      className="input-field text-sm"
                    />
                    <div className="flex gap-2">
                      <button
                        type="button"
                        disabled={!!keyValidating[provider.id]}
                        onClick={() => void testProviderKey(provider.id)}
                        className="btn-secondary text-xs disabled:opacity-50"
                        title="Test pasted key, or the saved key if empty"
                      >
                        {keyValidating[provider.id] ? 'Testing…' : 'Test'}
                      </button>
                      <button
                        type="button"
                        disabled={!!keyValidating[provider.id]}
                        onClick={() => void saveProviderKey(provider.id)}
                        className="btn-secondary text-xs flex-1 disabled:opacity-50"
                      >
                        Save key
                      </button>
                      <button type="button" onClick={onOpenExternal(provider.url)} className="btn-secondary text-xs">Get key</button>
                    </div>
                    {keyValidation[provider.id] && (
                      <p className={`text-[11px] ${keyValidation[provider.id]!.ok ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                        {keyValidation[provider.id]!.message}
                      </p>
                    )}
                  </div>
                ))}
              </div>
              <div className="grid md:grid-cols-2 gap-4">
                {(activeTab === 'online-free' ? onlineFreeModels : onlinePremiumModels).map(model => (
                  <div key={model.id} className="rounded-xl border border-surface-200 dark:border-surface-800 p-4 bg-white/60 dark:bg-surface-950/40 hover:border-primary-400/50 transition-colors">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="font-semibold flex items-center gap-2">
                          {model.name}
                          {model.categories.includes('vision') && (
                            <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded-md bg-sky-100 text-sky-800 dark:bg-sky-950/50 dark:text-sky-200">Vision</span>
                          )}
                        </p>
                        <p className="text-xs text-surface-500">{model.providerName} • {model.modelId}</p>
                      </div>
                      <span className={`text-[10px] uppercase tracking-wide px-2 py-1 rounded-full ${model.tier === 'free' ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300' : 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300'}`}>{model.tier}</span>
                    </div>
                    <p className="text-sm text-surface-600 dark:text-surface-400 mt-3">{model.recommendedUse}</p>
                    <div className="flex flex-wrap gap-1.5 mt-3">
                      {model.categories.map(cat => (
                        <span
                          key={cat}
                          className={`text-[10px] px-2 py-1 rounded-full ${cat === 'vision' ? 'bg-sky-100 dark:bg-sky-950/40 text-sky-700 dark:text-sky-300' : 'bg-surface-100 dark:bg-surface-800 text-surface-500'}`}
                        >
                          {cat}
                        </span>
                      ))}
                    </div>
                    <div className="grid grid-cols-2 gap-2 text-xs mt-4">
                      <InfoTile label="Speed" value={model.speed} />
                      <InfoTile label="Quality" value={model.quality} />
                    </div>
                    <div className="grid grid-cols-2 gap-2 mt-4">
                      <button
                        onClick={() => useOnlineAnswerModel(model)}
                        className={`w-full px-3 py-2 rounded-lg text-sm font-medium ${currentModel === remoteModelPath(model) ? 'bg-green-600 text-white' : 'bg-primary-600 hover:bg-primary-500 text-white'}`}
                      >
                        {currentModel === remoteModelPath(model) ? 'Selected' : 'Use'}
                      </button>
                      <button onClick={() => void openChatWithOnlineModel(model)} className="btn-secondary w-full text-sm">
                        Open Chat
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {activeTab === 'categories' && (
          <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-4">
            {CHAT_CATEGORIES.map(cat => (
              <div key={cat.id} className="glass-panel rounded-xl p-5 border border-surface-200 dark:border-surface-800">
                <div className="text-2xl mb-2">{cat.icon}</div>
                <h3 className="font-semibold">{cat.label}</h3>
                <p className="text-sm text-surface-500 mt-1">{cat.description}</p>
                <p className="text-xs text-surface-400 mt-3">Offline: {OFFLINE_CHAT_CATALOG.filter(m => m.categories.includes(cat.id)).length} • Online: {ONLINE_CHAT_MODELS.filter(m => m.categories.includes(cat.id)).length}</p>
              </div>
            ))}
          </div>
        )}

        <div className="glass-panel rounded-xl p-5 border border-surface-200 dark:border-surface-800 space-y-4">
          <div>
            <h2 className="font-semibold">Quantization switch</h2>
            <p className="text-sm text-surface-500">
              Pick among available GGUF quants for the same model family (Q4 / Q5 / Q8). This does not re-encode a single file.
            </p>
          </div>
          {quantFamilies.length > 0 ? (
            <div className="space-y-3">
              {quantFamilies.map(group => (
                <div key={group.family} className="rounded-xl border border-surface-200 dark:border-surface-800 p-3">
                  <p className="text-sm font-semibold mb-2">{group.family}</p>
                  <div className="flex flex-wrap gap-2">
                    {group.siblings.map(sibling => (
                      <button
                        key={sibling.id}
                        onClick={() => void selectLocalAnswerModel(sibling)}
                        className={`px-3 py-1.5 rounded-lg text-xs font-semibold ${
                          currentModel === sibling.path
                            ? 'bg-green-600 text-white'
                            : 'bg-surface-100 dark:bg-surface-800 hover:bg-primary-100 dark:hover:bg-primary-950/40'
                        }`}
                      >
                        {(sibling.quantization || 'GGUF')} · Use
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-surface-500">
              Import or download more than one quant of the same base model to switch here. Catalog downloads below offer Q4 / Q5 / Q8 when URLs are known.
            </p>
          )}
          <div className="grid md:grid-cols-2 gap-3">
            {catalogQuantGroups.map(group => (
              <div key={group.family} className="rounded-xl border border-surface-200 dark:border-surface-800 p-3 space-y-2">
                <p className="text-sm font-semibold">{group.siblings[0]?.name || group.family}</p>
                <div className="flex flex-wrap gap-2">
                  {group.siblings.map(item => (
                    <button
                      key={item.id}
                      onClick={() => void startDownload(item)}
                      className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-primary-600 hover:bg-primary-500 text-white"
                      disabled={!!downloadingId || !item.url}
                      title={item.url ? `${item.name} (${item.size})` : 'No direct URL available'}
                    >
                      Download {item.quant}{item.params ? ` · ${item.params}` : ''}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="glass-panel rounded-xl overflow-hidden">
          <div className="p-4 border-b border-surface-200 dark:border-surface-800 flex items-center justify-between gap-3">
            <div>
              <h2 className="font-semibold">Local Model Library</h2>
              <p className="text-sm text-surface-500">
                Import or scan .gguf files on this PC, then click <span className="font-medium">Use in Chat</span>.
                For multi-part models, select the <code className="text-xs">*-00001-of-*.gguf</code> file only (other shards stay in the same folder).
                Text chat does not need mmproj. For offline image/PDF vision, put a matching <code className="text-xs">*mmproj*.gguf</code> in the same folder (or use Link mmproj).
              </p>
            </div>
            <button type="button" onClick={() => void refreshModels()} className="btn-secondary text-xs shrink-0">Refresh</button>
          </div>
          {localModels.length === 0 ? (
            <div className="p-6 text-center text-surface-500">No local models yet. Import a .gguf file or scan your model folder.</div>
          ) : (
            <table className="w-full">
              <thead className="bg-surface-50 dark:bg-surface-900 border-b border-surface-200 dark:border-surface-800">
                <tr>
                  <th className="text-left px-4 py-3 text-sm font-medium text-surface-500">Name</th>
                  <th className="text-left px-4 py-3 text-sm font-medium text-surface-500">Quant</th>
                  <th className="text-left px-4 py-3 text-sm font-medium text-surface-500">Size</th>
                  <th className="text-left px-4 py-3 text-sm font-medium text-surface-500">Path</th>
                  <th className="text-right px-4 py-3 text-sm font-medium text-surface-500">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-200 dark:divide-surface-800">
                {localModels.map(model => (
                  <tr key={model.id} className="hover:bg-surface-50 dark:hover:bg-surface-900/50 transition-colors">
                    <td className="px-4 py-4 font-medium">{model.name}</td>
                    <td className="px-4 py-4 text-sm">{model.quantization || 'Unknown'}</td>
                    <td className="px-4 py-4 text-sm">{formatBytes(model.size_bytes)}</td>
                    <td className="px-4 py-4 text-xs text-surface-500 max-w-sm truncate" title={model.path}>{model.path}</td>
                    <td className="px-4 py-4 text-right space-x-2">
                      <button onClick={() => void selectLocalAnswerModel(model)} className={`px-3 py-1.5 rounded-lg text-sm ${currentModel === model.path ? 'bg-green-600 text-white' : 'bg-primary-600 hover:bg-primary-500 text-white'}`}>{currentModel === model.path ? 'Selected' : 'Use in Chat'}</button>
                      <button onClick={() => void startFreshChatForModel(model.path, model.name)} className="px-3 py-1.5 rounded-lg text-sm btn-secondary">Open Chat</button>
                      <button onClick={() => void linkMmprojBeside(model)} className="px-3 py-1.5 rounded-lg text-sm btn-secondary" title="Copy an mmproj projector into this model folder for offline vision">Link mmproj</button>
                      <button onClick={() => handleDelete(model.id)} className="p-2 rounded-lg hover:bg-red-100 dark:hover:bg-red-900/30 text-red-600 transition-colors"><Trash2 className="w-4 h-4" /></button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="glass-panel rounded-xl overflow-hidden">
          <div className="p-4 border-b border-surface-200 dark:border-surface-800">
            <h2 className="font-semibold">Recommended Downloads</h2>
            <p className="text-sm text-surface-500">
              Frontier: Kimi K3 (online until weights drop), GLM-5.2, DeepSeek V4 Pro/Flash, Qwen3 Coder 480B, Llama 4 Maverick, DeepSeek V3, MiniMax M3, Qwen3.5 397B, Kimi K2.6.
              Filter Vision / Large. Offline shards often need 160–500GB+ RAM. Tiny models are smoke tests only.
            </p>
          </div>
          <div className="relative flex-1 p-4">
            <Search className="absolute left-7 top-1/2 -translate-y-1/2 w-4 h-4 text-surface-400" />
            <input type="text" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search recommended models..." className="input-field pl-10" />
          </div>
          <table className="w-full">
            <thead className="bg-surface-50 dark:bg-surface-900 border-y border-surface-200 dark:border-surface-800">
              <tr>
                <th className="text-left px-4 py-3 text-sm font-medium text-surface-500">Model</th>
                <th className="text-left px-4 py-3 text-sm font-medium text-surface-500">Quant</th>
                <th className="text-left px-4 py-3 text-sm font-medium text-surface-500">Size</th>
                <th className="text-left px-4 py-3 text-sm font-medium text-surface-500">RAM</th>
                <th className="text-left px-4 py-3 text-sm font-medium text-surface-500">Speed</th>
                <th className="text-right px-4 py-3 text-sm font-medium text-surface-500">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-surface-200 dark:divide-surface-800">
              {filtered.map(model => (
                <tr key={model.id} className="hover:bg-surface-50 dark:hover:bg-surface-900/50 transition-colors">
                  <td className="px-4 py-4">
                    <p className="font-medium flex items-center gap-2">
                      {model.name}
                      {(model.visionCapable || model.categories.includes('vision')) && (
                        <span className="text-[10px] uppercase px-1.5 py-0.5 rounded bg-sky-100 text-sky-800 dark:bg-sky-950/40 dark:text-sky-200">Vision</span>
                      )}
                      {parseFloat((model.params.match(/(\d+(?:\.\d+)?)/) || [])[1] || '0') >= 100 && (
                        <span className="text-[10px] uppercase px-1.5 py-0.5 rounded bg-amber-100 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">100B+</span>
                      )}
                      {(model.shardUrls?.length ?? 0) > 0 && (
                        <span className="text-[10px] uppercase px-1.5 py-0.5 rounded bg-violet-100 text-violet-900 dark:bg-violet-950/40 dark:text-violet-200">
                          {1 + (model.shardUrls?.length ?? 0)} shards
                        </span>
                      )}
                    </p>
                    <p className="text-xs text-surface-500">{model.params} parameters • {model.recommendedUse}</p>
                  </td>
                  <td className="px-4 py-4"><span className="px-2 py-1 rounded-md bg-surface-100 dark:bg-surface-800 text-xs font-medium">{model.quant}</span></td>
                  <td className="px-4 py-4 text-sm">{model.size}</td>
                  <td className="px-4 py-4 text-sm">{model.ram}</td>
                  <td className="px-4 py-4 text-sm"><div>{model.speed}</div><div className="text-xs text-surface-500">{model.quality}</div></td>
                  <td className="px-4 py-4 text-right">
                    <button onClick={() => startDownload(model)} disabled={!!downloadingId || !model.url} className="p-2 rounded-lg hover:bg-surface-100 dark:hover:bg-surface-800 text-primary-600 dark:text-primary-400 transition-colors disabled:opacity-40 disabled:cursor-not-allowed" title={model.url ? 'Download with progress details' : 'No direct URL available. Paste a direct GGUF URL above.'}>
                      <Download className={`w-4 h-4 ${downloadingId === model.id ? 'animate-pulse' : ''}`} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function InfoTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-surface-100 dark:bg-surface-900 p-3">
      <p className="text-xs text-surface-500 mb-1">{label}</p>
      <p className="font-semibold truncate" title={value}>{value}</p>
    </div>
  );
}
