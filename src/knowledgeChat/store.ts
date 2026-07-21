import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { KcCollection, KcIndexProgress, KcRetrievalMode, KcSearchScope } from './types';
import { KC_DEFAULT_EMBEDDING_MODEL } from './types';

interface KnowledgeChatState {
  collections: KcCollection[];
  activeCollectionId: string | null;
  /** Persisted conversation id per collection+mode so KC history survives app restart. */
  conversationIdsByKey: Record<string, string>;
  embeddingModelPath: string;
  retrievalMode: KcRetrievalMode;
  searchScope: KcSearchScope;
  topK: number;
  indexProgress: KcIndexProgress | null;
  notice: string | null;
  error: string | null;
  setCollections: (collections: KcCollection[]) => void;
  setActiveCollectionId: (id: string | null) => void;
  setConversationIdForKey: (key: string, conversationId: string) => void;
  clearConversationIdForKey: (key: string) => void;
  upsertCollection: (collection: KcCollection) => void;
  removeCollection: (id: string) => void;
  setEmbeddingModelPath: (path: string) => void;
  setRetrievalMode: (mode: KcRetrievalMode) => void;
  setSearchScope: (scope: KcSearchScope) => void;
  setTopK: (value: number) => void;
  setIndexProgress: (progress: KcIndexProgress | null) => void;
  setNotice: (message: string | null) => void;
  setError: (message: string | null) => void;
}

export function kcConversationStorageKey(collectionId: string, serverRagMode: boolean): string {
  return `${collectionId}:${serverRagMode ? 'knowledge-server-rag' : 'knowledge'}`;
}

export const useKnowledgeChatStore = create<KnowledgeChatState>()(
  persist(
    (set) => ({
      collections: [],
      activeCollectionId: null,
      conversationIdsByKey: {},
      embeddingModelPath: KC_DEFAULT_EMBEDDING_MODEL,
      retrievalMode: 'hybrid_dense',
      searchScope: 'all',
      topK: 12,
      indexProgress: null,
      notice: null,
      error: null,
      setCollections: (collections) => set({ collections }),
      setActiveCollectionId: (id) => set({ activeCollectionId: id }),
      setConversationIdForKey: (key, conversationId) => set(state => ({
        conversationIdsByKey: { ...state.conversationIdsByKey, [key]: conversationId },
      })),
      clearConversationIdForKey: (key) => set(state => {
        const next = { ...state.conversationIdsByKey };
        delete next[key];
        return { conversationIdsByKey: next };
      }),
      upsertCollection: (collection) => set(state => ({
        collections: [
          collection,
          ...state.collections.filter(item => item.id !== collection.id),
        ],
      })),
      removeCollection: (id) => set(state => {
        const nextIds = { ...state.conversationIdsByKey };
        for (const key of Object.keys(nextIds)) {
          if (key.startsWith(`${id}:`)) delete nextIds[key];
        }
        return {
          collections: state.collections.filter(item => item.id !== id),
          activeCollectionId: state.activeCollectionId === id ? null : state.activeCollectionId,
          conversationIdsByKey: nextIds,
        };
      }),
      setEmbeddingModelPath: (path) => set({ embeddingModelPath: path }),
      setRetrievalMode: (mode) => set({ retrievalMode: mode }),
      setSearchScope: (scope) => set({ searchScope: scope }),
      setTopK: (value) => set({ topK: value }),
      setIndexProgress: (progress) => set({ indexProgress: progress }),
      setNotice: (message) => set({ notice: message }),
      setError: (message) => set({ error: message }),
    }),
    {
      name: 'nexus-knowledge-chat-storage',
      partialize: (state) => ({
        activeCollectionId: state.activeCollectionId,
        conversationIdsByKey: state.conversationIdsByKey,
        embeddingModelPath: state.embeddingModelPath,
        retrievalMode: state.retrievalMode,
        searchScope: state.searchScope,
        topK: state.topK,
      }),
    },
  ),
);
