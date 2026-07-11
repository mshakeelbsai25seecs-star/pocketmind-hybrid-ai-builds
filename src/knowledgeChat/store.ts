import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { KcCollection, KcIndexProgress, KcRetrievalMode, KcSearchScope } from './types';
import { KC_DEFAULT_EMBEDDING_MODEL } from './types';

interface KnowledgeChatState {
  collections: KcCollection[];
  activeCollectionId: string | null;
  embeddingModelPath: string;
  retrievalMode: KcRetrievalMode;
  searchScope: KcSearchScope;
  topK: number;
  indexProgress: KcIndexProgress | null;
  notice: string | null;
  error: string | null;
  setCollections: (collections: KcCollection[]) => void;
  setActiveCollectionId: (id: string | null) => void;
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

export const useKnowledgeChatStore = create<KnowledgeChatState>()(
  persist(
    (set) => ({
      collections: [],
      activeCollectionId: null,
      embeddingModelPath: KC_DEFAULT_EMBEDDING_MODEL,
      retrievalMode: 'hybrid_dense',
      searchScope: 'all',
      topK: 12,
      indexProgress: null,
      notice: null,
      error: null,
      setCollections: (collections) => set({ collections }),
      setActiveCollectionId: (id) => set({ activeCollectionId: id }),
      upsertCollection: (collection) => set(state => ({
        collections: [
          collection,
          ...state.collections.filter(item => item.id !== collection.id),
        ],
      })),
      removeCollection: (id) => set(state => ({
        collections: state.collections.filter(item => item.id !== id),
        activeCollectionId: state.activeCollectionId === id ? null : state.activeCollectionId,
      })),
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
        embeddingModelPath: state.embeddingModelPath,
        retrievalMode: state.retrievalMode,
        searchScope: state.searchScope,
        topK: state.topK,
      }),
    },
  ),
);
