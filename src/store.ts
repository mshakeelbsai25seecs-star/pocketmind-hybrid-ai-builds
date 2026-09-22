import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  Conversation, Message, Character, SystemInfo,
  ModelRecommendation, GenerationParams, ThemeMode, PerformanceMode, AppView, LocalModelRecord, SocKnowledgeResource, SocDataPackChecklistItem, SocDenseEmbeddingSettings
} from './types';
import { SOC_DATA_PACK_DEFAULT_CHECKLIST, mergeSocDataPackChecklist } from './socDataPackChecklist';
import { SOC_DEFAULT_DENSE_EMBEDDING_SETTINGS } from './socKnowledgeIndex';
import type { DeploymentConfig } from './deploymentConfig';
import type { ProductConfig } from './productConfig';
import type { PendingChatOptions } from './socChatHandoff';
import type { HistoryModeKey } from './conversationModes';
import { historyKeyForConversationMode } from './conversationModes';

interface AppState {
  sidebarOpen: boolean;
  activeConversationId: string | null;
  /** Last active conversation per history bucket (chat / knowledge / pocketcode / soc). */
  lastConversationIdByMode: Partial<Record<HistoryModeKey, string | null>>;
  activeCharacterId: string | null;
  activeView: AppView;
  theme: ThemeMode;
  accentColor: string;
  performanceMode: PerformanceMode;

  conversations: Conversation[];
  messages: Record<string, Message[]>;
  characters: Character[];
  localModels: LocalModelRecord[];
  systemInfo: SystemInfo | null;
  recommendations: ModelRecommendation[];
  currentModel: string | null;
  /** Last non-enterprise model for one-click swap from PocketCode org server strip. */
  lastLocalModel: string | null;
  /** Last enterprise:{id} model for one-click return to org server. */
  lastEnterpriseModel: string | null;
  setupCompleted: boolean;
  modelsDir: string;
  isGenerating: boolean;
  generationError: string | null;
  pendingChatPrompt: string | null;
  pendingChatOptions: PendingChatOptions | null;
  socKnowledgeResources: SocKnowledgeResource[];
  selectedSocKnowledgeResourceIds: string[];
  selectedSocKnowledgeChunkIds: string[];
  socDataPackChecklist: SocDataPackChecklistItem[];
  socDenseEmbeddingSettings: SocDenseEmbeddingSettings;
  socKnowledgeCollectionId: string | null;
  socKnowledgeCollectionRoot: string;
  socAutoRetrieveKnowledge: boolean;
  deploymentConfig: DeploymentConfig | null;
  productConfig: ProductConfig | null;
  workspaceEpoch: number;
  /** Bumped when user requests a blank PocketCode agent session. */
  pocketcodeNewSessionNonce: number;

  defaultParams: GenerationParams;

  setSidebarOpen: (open: boolean) => void;
  setActiveConversation: (id: string | null) => void;
  rememberConversationForMode: (mode: string | null | undefined, id: string | null) => void;
  requestNewPocketcodeSession: () => void;
  setActiveCharacter: (id: string | null) => void;
  setActiveView: (view: AppView) => void;
  setTheme: (theme: ThemeMode) => void;
  setAccentColor: (color: string) => void;
  setPerformanceMode: (mode: PerformanceMode) => void;
  setConversations: (conversations: Conversation[]) => void;
  setMessages: (convId: string, messages: Message[]) => void;
  addMessage: (convId: string, message: Message) => void;
  updateMessage: (convId: string, messageId: string, content: string) => void;
  replaceMessage: (convId: string, messageId: string, content: string) => void;
  removeConversationLocal: (convId: string) => void;
  renameConversationLocal: (convId: string, title: string) => void;
  setCharacters: (characters: Character[]) => void;
  setLocalModels: (models: LocalModelRecord[]) => void;
  setSystemInfo: (info: SystemInfo) => void;
  setRecommendations: (recs: ModelRecommendation[]) => void;
  setCurrentModel: (model: string | null) => void;
  setLastLocalModel: (model: string | null) => void;
  setLastEnterpriseModel: (model: string | null) => void;
  setSetupCompleted: (completed: boolean) => void;
  setModelsDir: (dir: string) => void;
  setIsGenerating: (generating: boolean) => void;
  setGenerationError: (error: string | null) => void;
  setPendingChatPrompt: (prompt: string | null, options?: PendingChatOptions | null) => void;
  addSocKnowledgeResource: (resource: SocKnowledgeResource) => void;
  updateSocKnowledgeResource: (id: string, updates: Partial<Omit<SocKnowledgeResource, 'id' | 'createdAt'>>) => void;
  removeSocKnowledgeResource: (id: string) => void;
  setSelectedSocKnowledgeResourceIds: (ids: string[]) => void;
  toggleSelectedSocKnowledgeResource: (id: string) => void;
  setSelectedSocKnowledgeChunkIds: (ids: string[]) => void;
  toggleSelectedSocKnowledgeChunk: (id: string) => void;
  clearSelectedSocKnowledgeChunks: () => void;
  setSocDataPackChecklistItemStatus: (id: string, status: SocDataPackChecklistItem['status']) => void;
  setSocDataPackChecklistItemNotes: (id: string, notes: string) => void;
  setSocDataPackChecklist: (items: SocDataPackChecklistItem[]) => void;
  resetSocDataPackChecklist: () => void;
  setSocDenseEmbeddingSettings: (settings: Partial<SocDenseEmbeddingSettings>) => void;
  resetSocDenseEmbeddingSettings: () => void;
  setSocKnowledgeCollectionId: (id: string | null) => void;
  setSocKnowledgeCollectionRoot: (root: string) => void;
  setSocAutoRetrieveKnowledge: (enabled: boolean) => void;
  setDeploymentConfig: (config: DeploymentConfig | null) => void;
  setProductConfig: (config: ProductConfig | null) => void;
  bumpWorkspaceEpoch: () => void;
  setDefaultParams: (params: Partial<GenerationParams>) => void;
  resetDefaultParams: () => void;
}

export const SAFE_DEFAULT_PARAMS: GenerationParams = {
  // Production default: automatic hardware optimizer. PocketMind Hybrid AI tries full GPU offload first
  // when a compatible runtime/GPU exists, then partial CPU+GPU split, then CPU fallback.
  temperature: 0.45,
  top_k: 40,
  top_p: 0.82,
  repetition_penalty: 1.18,
  max_tokens: 512,
  context_size: 4096,
  gpu_layers: -1,
  batch_size: 128,
  threads: 0,
  flash_attention: false,
};

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      sidebarOpen: true,
      activeConversationId: null,
      lastConversationIdByMode: {},
      activeCharacterId: null,
      activeView: 'home',
      theme: 'system',
      accentColor: '#4ade80',
      performanceMode: 'balanced',
      conversations: [],
      messages: {},
      characters: [],
      localModels: [],
      systemInfo: null,
      recommendations: [],
      currentModel: null,
      lastLocalModel: null,
      lastEnterpriseModel: null,
      setupCompleted: false,
      modelsDir: '',
      isGenerating: false,
      generationError: null,
      pendingChatPrompt: null,
      pendingChatOptions: null,
      socKnowledgeResources: [],
      selectedSocKnowledgeResourceIds: [],
      selectedSocKnowledgeChunkIds: [],
      socDataPackChecklist: SOC_DATA_PACK_DEFAULT_CHECKLIST,
      socDenseEmbeddingSettings: SOC_DEFAULT_DENSE_EMBEDDING_SETTINGS,
      socKnowledgeCollectionId: null,
      socKnowledgeCollectionRoot: '',
      socAutoRetrieveKnowledge: true,
      deploymentConfig: null,
      productConfig: null,
      workspaceEpoch: 0,
      pocketcodeNewSessionNonce: 0,

      defaultParams: SAFE_DEFAULT_PARAMS,

      setSidebarOpen: (open) => set({ sidebarOpen: open }),
      setActiveConversation: (id) => set((state) => {
        const conv = id ? state.conversations.find(c => c.id === id) : null;
        const key = conv ? historyKeyForConversationMode(conv.mode) : null;
        return {
          activeConversationId: id,
          generationError: null,
          lastConversationIdByMode: key
            ? { ...state.lastConversationIdByMode, [key]: id }
            : state.lastConversationIdByMode,
        };
      }),
      rememberConversationForMode: (mode, id) => set((state) => {
        const key = historyKeyForConversationMode(mode);
        return {
          lastConversationIdByMode: { ...state.lastConversationIdByMode, [key]: id },
        };
      }),
      requestNewPocketcodeSession: () => set((state) => ({
        lastConversationIdByMode: { ...state.lastConversationIdByMode, pocketcode: null },
        activeConversationId: state.activeView === 'code-workspace' ? null : state.activeConversationId,
        pocketcodeNewSessionNonce: state.pocketcodeNewSessionNonce + 1,
      })),
      setActiveCharacter: (id) => set({ activeCharacterId: id }),
      setActiveView: (view) => set({ activeView: view }),
      setTheme: (theme) => set({ theme }),
      setAccentColor: (color) => set({ accentColor: color }),
      setPerformanceMode: (mode) => set({ performanceMode: mode }),
      setConversations: (conversations) => set({ conversations }),
      setMessages: (convId, messages) => set((state) => ({
        messages: { ...state.messages, [convId]: messages }
      })),
      addMessage: (convId, message) => set((state) => ({
        messages: {
          ...state.messages,
          [convId]: [...(state.messages[convId] || []), message]
        }
      })),
      updateMessage: (convId, messageId, content) => set((state) => ({
        messages: {
          ...state.messages,
          [convId]: state.messages[convId]?.map(m =>
            m.id === messageId ? { ...m, content: m.content + content } : m
          ) || []
        }
      })),
      replaceMessage: (convId, messageId, content) => set((state) => ({
        messages: {
          ...state.messages,
          [convId]: state.messages[convId]?.map(m =>
            m.id === messageId ? { ...m, content } : m
          ) || []
        }
      })),
      removeConversationLocal: (convId) => set((state) => {
        const nextMessages = { ...state.messages };
        delete nextMessages[convId];
        const nextConversations = state.conversations.filter(c => c.id !== convId);
        return {
          messages: nextMessages,
          conversations: nextConversations,
          activeConversationId: state.activeConversationId === convId ? null : state.activeConversationId,
        };
      }),
      renameConversationLocal: (convId, title) => set((state) => ({
        conversations: state.conversations.map(c =>
          c.id === convId ? { ...c, title, updated_at: Math.floor(Date.now() / 1000) } : c
        ),
      })),
      setCharacters: (characters) => set({ characters }),
      setLocalModels: (models) => set({ localModels: models }),
      setSystemInfo: (info) => set({ systemInfo: info }),
      setRecommendations: (recs) => set({ recommendations: recs }),
      setCurrentModel: (model) => set((state) => {
        const patch: Partial<AppState> = { currentModel: model };
        if (model?.startsWith('enterprise:')) {
          patch.lastEnterpriseModel = model;
        } else if (model) {
          patch.lastLocalModel = model;
        }
        return { ...state, ...patch };
      }),
      setLastLocalModel: (model) => set({ lastLocalModel: model }),
      setLastEnterpriseModel: (model) => set({ lastEnterpriseModel: model }),
      setSetupCompleted: (completed) => set({ setupCompleted: completed }),
      setModelsDir: (dir) => set({ modelsDir: dir }),
      setIsGenerating: (generating) => set({ isGenerating: generating }),
      setGenerationError: (error) => set({ generationError: error }),
      setPendingChatPrompt: (prompt, options = null) => set({
        pendingChatPrompt: prompt,
        pendingChatOptions: prompt ? (options || null) : null,
      }),
      addSocKnowledgeResource: (resource) => set((state) => ({
        socKnowledgeResources: [...state.socKnowledgeResources, resource],
      })),
      updateSocKnowledgeResource: (id, updates) => set((state) => ({
        socKnowledgeResources: state.socKnowledgeResources.map(resource =>
          resource.id === id ? { ...resource, ...updates, updatedAt: Math.floor(Date.now() / 1000) } : resource
        ),
      })),
      removeSocKnowledgeResource: (id) => set((state) => ({
        socKnowledgeResources: state.socKnowledgeResources.filter(resource => resource.id !== id),
        selectedSocKnowledgeResourceIds: state.selectedSocKnowledgeResourceIds.filter(resourceId => resourceId !== id),
        selectedSocKnowledgeChunkIds: state.selectedSocKnowledgeChunkIds.filter(chunkId => !chunkId.startsWith(`${id}::`)),
      })),
      setSelectedSocKnowledgeResourceIds: (ids) => set({ selectedSocKnowledgeResourceIds: Array.from(new Set(ids)) }),
      toggleSelectedSocKnowledgeResource: (id) => set((state) => ({
        selectedSocKnowledgeResourceIds: state.selectedSocKnowledgeResourceIds.includes(id)
          ? state.selectedSocKnowledgeResourceIds.filter(resourceId => resourceId !== id)
          : [...state.selectedSocKnowledgeResourceIds, id],
      })),
      setSelectedSocKnowledgeChunkIds: (ids) => set({ selectedSocKnowledgeChunkIds: Array.from(new Set(ids)) }),
      toggleSelectedSocKnowledgeChunk: (id) => set((state) => ({
        selectedSocKnowledgeChunkIds: state.selectedSocKnowledgeChunkIds.includes(id)
          ? state.selectedSocKnowledgeChunkIds.filter(chunkId => chunkId !== id)
          : [...state.selectedSocKnowledgeChunkIds, id],
      })),
      clearSelectedSocKnowledgeChunks: () => set({ selectedSocKnowledgeChunkIds: [] }),
      setSocDataPackChecklistItemStatus: (id, status) => set((state) => ({
        socDataPackChecklist: mergeSocDataPackChecklist(state.socDataPackChecklist).map(item =>
          item.id === id ? { ...item, status, updatedAt: Math.floor(Date.now() / 1000) } : item
        ),
      })),
      setSocDataPackChecklistItemNotes: (id, notes) => set((state) => ({
        socDataPackChecklist: mergeSocDataPackChecklist(state.socDataPackChecklist).map(item =>
          item.id === id ? { ...item, notes, updatedAt: Math.floor(Date.now() / 1000) } : item
        ),
      })),
      setSocDataPackChecklist: (items) => set({ socDataPackChecklist: mergeSocDataPackChecklist(items) }),
      resetSocDataPackChecklist: () => set({ socDataPackChecklist: SOC_DATA_PACK_DEFAULT_CHECKLIST }),
      setSocDenseEmbeddingSettings: (settings) => set((state) => ({
        socDenseEmbeddingSettings: {
          ...SOC_DEFAULT_DENSE_EMBEDDING_SETTINGS,
          ...state.socDenseEmbeddingSettings,
          ...settings,
        },
      })),
      resetSocDenseEmbeddingSettings: () => set({ socDenseEmbeddingSettings: SOC_DEFAULT_DENSE_EMBEDDING_SETTINGS }),
      setSocKnowledgeCollectionId: (id) => set({ socKnowledgeCollectionId: id }),
      setSocKnowledgeCollectionRoot: (root) => set({ socKnowledgeCollectionRoot: root.trim() }),
      setSocAutoRetrieveKnowledge: (enabled) => set({ socAutoRetrieveKnowledge: enabled }),
      setDeploymentConfig: (config) => set({ deploymentConfig: config }),
      setProductConfig: (config) => set({ productConfig: config }),
      bumpWorkspaceEpoch: () => set((state) => ({ workspaceEpoch: state.workspaceEpoch + 1 })),
      setDefaultParams: (params) => set((state) => ({
        defaultParams: { ...state.defaultParams, ...params }
      })),
      resetDefaultParams: () => set({ defaultParams: SAFE_DEFAULT_PARAMS }),
    }),
    {
      name: 'nexus-ai-storage',
      partialize: (state) => ({
        theme: state.theme,
        accentColor: state.accentColor,
        performanceMode: state.performanceMode,
        defaultParams: state.defaultParams,
        activeConversationId: state.activeConversationId,
        lastConversationIdByMode: state.lastConversationIdByMode,
        activeCharacterId: state.activeCharacterId,
        currentModel: state.currentModel,
        lastLocalModel: state.lastLocalModel,
        lastEnterpriseModel: state.lastEnterpriseModel,
        setupCompleted: state.setupCompleted,
        modelsDir: state.modelsDir,
        socKnowledgeResources: state.socKnowledgeResources.map(resource => ({
          ...resource,
          indexedChunks: (resource.indexedChunks || []).map(({ lexicalVector, denseVector, ...chunk }) => chunk),
        })),
        selectedSocKnowledgeResourceIds: state.selectedSocKnowledgeResourceIds,
        selectedSocKnowledgeChunkIds: state.selectedSocKnowledgeChunkIds,
        socDataPackChecklist: mergeSocDataPackChecklist(state.socDataPackChecklist),
        socDenseEmbeddingSettings: {
          ...SOC_DEFAULT_DENSE_EMBEDDING_SETTINGS,
          ...state.socDenseEmbeddingSettings,
        },
        socKnowledgeCollectionId: state.socKnowledgeCollectionId,
        socKnowledgeCollectionRoot: state.socKnowledgeCollectionRoot,
        socAutoRetrieveKnowledge: state.socAutoRetrieveKnowledge,
      }),
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        // Clear stale local GGUF selection if the file vanished (async check after rehydrate).
        const selected = state.currentModel;
        if (selected && !selected.startsWith('remote:') && !selected.startsWith('enterprise:')) {
          void import('@tauri-apps/api/tauri').then(({ invoke }) => {
            invoke<boolean>('path_exists', { path: selected })
              .then(ok => {
                if (!ok) {
                  useAppStore.getState().setCurrentModel(null);
                }
              })
              .catch(() => { /* ignore */ });
          });
        }
        if (!state.socDenseEmbeddingSettings?.modelPath?.trim()) {
          state.socDenseEmbeddingSettings = {
            ...SOC_DEFAULT_DENSE_EMBEDDING_SETTINGS,
            ...state.socDenseEmbeddingSettings,
            modelPath: SOC_DEFAULT_DENSE_EMBEDDING_SETTINGS.modelPath,
            providerMode: state.socDenseEmbeddingSettings?.providerMode === 'disabled'
              ? 'disabled'
              : 'local_dense',
          };
        }
        const denseOnChunks = state.socKnowledgeResources.reduce(
          (sum, resource) => sum + (resource.indexedChunks || []).filter(chunk => Array.isArray(chunk.denseVector) && chunk.denseVector.length > 0).length,
          0,
        );
        if (denseOnChunks === 0 && state.socDenseEmbeddingSettings?.status === 'ready') {
          state.socDenseEmbeddingSettings = {
            ...state.socDenseEmbeddingSettings,
            status: 'not_configured',
            vectorizedChunkCount: 0,
            vectorDimension: undefined,
          };
        } else if (denseOnChunks > 0) {
          state.socDenseEmbeddingSettings = {
            ...state.socDenseEmbeddingSettings,
            status: 'ready',
            vectorizedChunkCount: denseOnChunks,
          };
        }
      },
    }
  )
);

/** Browser verify hook (`?verify=1`) — not used in production UI. */
if (typeof window !== 'undefined') {
  try {
    if (new URLSearchParams(window.location.search).has('verify')) {
      (window as unknown as { __PM_STORE__?: typeof useAppStore }).__PM_STORE__ = useAppStore;
    }
  } catch {
    /* ignore */
  }
}
