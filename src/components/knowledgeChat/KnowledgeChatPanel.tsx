import { useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/tauri';
import { listen } from '@tauri-apps/api/event';
import { BookOpenCheck, Loader2, Send, StopCircle } from 'lucide-react';
import { useAppStore } from '../../store';
import { Conversation, GenerationParams, Message } from '../../types';
import { ONLINE_CHAT_MODELS } from '../../modelCatalog';
import {
  answerModelKind,
  answerModelLabel,
  backendForModelPath,
  isOnlineRemotePath,
  remoteModelPath,
} from '../../answerModel';
import {
  kcHybridSearch,
  kcPrepareSearchQuery,
  kcBuildFileCatalog,
  kcLoadSelectedFiles,
  humanError,
} from '../../knowledgeChat/api';
import {
  loadServerRagCredentials,
  serverRagChat,
  type ServerRagCredentials,
} from '../../knowledgeChat/serverRag';
import {
  KC_GENERATION_DEFAULTS,
  KC_NOT_FOUND_MESSAGE,
  buildCitationHits,
  confidenceBadgeClass,
  pickRetrievalMode,
  sourceSummaryFromHits,
  systemPromptForQuestion,
  codebaseExplorerSystemPrompt,
  filterHitsForContext,
  formatSourceCitation,
  formatSourceSnippetPreview,
  buildVerificationPrompt,
  parseVerificationVerdict,
  KC_VERIFY_PROMPT,
} from '../../knowledgeChat/prompts';
import { buildCodebaseExplorerContext } from '../../knowledgeChat/codebaseExplorer';
import {
  buildBundledGroundedPrompt,
  buildBundledLlmContext,
  bundleHitsForLlm,
} from '../../knowledgeChat/contextBundler';
import {
  boostSelectedPathsFromQuery,
  buildFileSelectionPrompt,
  KC_FILE_SELECT_SYSTEM_PROMPT,
  mergeSelectedPaths,
  parseSelectedFilePaths,
  pathsFromRetrievalHits,
} from '../../knowledgeChat/fileSelection';
import {
  mergeAnswerWithEvidence,
  resolveEvidenceAnswer,
  resolveStructuredAnswer,
} from '../../knowledgeChat/evidenceAnswer';
import {
  resolveAnswerFallback,
  resolveAnswerRoute,
  shouldUseLlmSynthesis,
} from '../../knowledgeChat/answerRouting';
import { runAnswerPipeline, type AnswerContext, type AnswerResult } from '../../knowledgeChat/answerPipeline';
import {
  CORRECTIVE_RETRIEVAL_NOTICE,
  needsCorrectiveRetrieval,
  shouldPreferCorrectiveResult,
  shouldSkipCorrectiveRetrieval,
  tightenSearchQuery,
} from '../../knowledgeChat/correctiveRetrieval';
import {
  groundingCheck,
  isEmptyModelResponse,
  isNotFoundAnswer,
  isSubstantiveDraft,
} from '../../knowledgeChat/groundingCheck';
import {
  resolveBestExtractiveAnswer,
  shouldPreferExtractiveOverLlm,
  shouldSkipLlmForExtractive,
} from '../../knowledgeChat/extractivePrefer';
import { runtimeLimitsForConfig } from '../../knowledgeChat/deploymentProfile';
import { expandVagueQueryWithLlm } from '../../knowledgeChat/queryRewrite';
import {
  classifyAnswerIntent,
  classifyRulesAnswerIntent,
  classifyRulesSearchIntent,
  classifySearchIntent,
  vetoSearchIntent,
} from '../../knowledgeChat/intentClassify';
import { decideRetrievalSufficiency } from '../../knowledgeChat/retrievalDecision';
import {
  kcConversationStorageKey,
  useKnowledgeChatStore,
} from '../../knowledgeChat/store';
import { SOC_LOW_CONFIDENCE_BLOCKED_MESSAGE, saveProductConfig, type KcKnowledgeChatMode } from '../../productConfig';
import MessageSources, { type SourceSummary } from './MessageSources';
import type { KcAnswerMode, KcPipelineTrace, KcRetrievalConfidence, KcSearchHit, KcSearchResult, KcSearchScope } from '../../knowledgeChat/types';
import { effectiveAnswerIntent, KC_RETRIEVAL_MODE_LABELS } from '../../knowledgeChat/types';
import { mergeAnswerStagesIntoTrace, mergeIntentStagesIntoTrace, stageStatusLabel } from '../../knowledgeChat/pipelineTrace';

const KC_SEARCH_SCOPE_OPTIONS: KcSearchScope[] = [
  'all', 'code', 'documentation', 'runbooks', 'logs_data', 'general', 'docs', 'both',
];

const KC_SEARCH_SCOPE_LABELS: Record<KcSearchScope, string> = {
  all: 'All files',
  code: 'Code only',
  documentation: 'Documentation only',
  runbooks: 'Runbooks only',
  logs_data: 'Logs & data only',
  general: 'General documents only',
  docs: 'All documents',
  both: 'All files',
};

function partitionsSearchedLabel(partitions?: string[]): string {
  if (!partitions || partitions.length === 0) return '';
  const labels: Record<string, string> = {
    code: 'code',
    documentation: 'documentation',
    runbooks: 'runbooks',
    logs_data: 'logs & data',
    general: 'general',
    knowledge: 'general',
  };
  return partitions.map(part => labels[part] ?? part).join(' + ');
}
import { formatKnowledgeAnswer, retrievalStatusLabel, unescapeLlmLiterals } from '../../knowledgeChat/formatAnswer';
import type { CitationHit } from '../../knowledgeChat/formatAnswer';
import KnowledgeMarkdown from './KnowledgeMarkdown';

type GenerationResponsePayload = {
  text: string;
  finish_reason?: string | null;
};

function appendStreamChunk(current: string, chunk: string): string {
  if (!chunk) return current;
  if (!current) return chunk;
  if (chunk.startsWith(current)) return chunk;
  if (current.endsWith(chunk)) return current;
  return current + chunk;
}

function sourceInterpretation(
  hit: KcSearchResult['hits'][number],
  evidenceSummary?: string | null,
): string | undefined {
  const { entity_name, entity_kind, source_type } = hit.chunk;
  const isModulePreamble = entity_name === 'module_preamble';

  // For real code entities, describe them precisely from index metadata
  // (e.g. "Defines the function `handleSend`.") rather than a generic summary.
  if (source_type === 'code_entity' && entity_name && !isModulePreamble) {
    const kind = (entity_kind || 'symbol').toLowerCase();
    return `Defines the ${kind} \`${entity_name}\`.`;
  }

  const summary = evidenceSummary?.trim();
  if (!summary) return undefined;
  // Never surface module-preamble / import-block artifacts as an interpretation.
  if (isModulePreamble || /module_preamble/i.test(summary)) return undefined;
  if (/^This module `/i.test(summary)) return undefined;
  return summary;
}

type AnswerTiming = {
  latency_ms: number;
  retrieval_ms?: number;
  answer_ms?: number;
  answered_at_ms: number;
};

function formatLatencyMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1000;
  if (seconds < 10) return `${seconds.toFixed(1)} s`;
  return `${Math.round(seconds)} s`;
}

/** Keep pipeline IO previews short so they do not re-print the full answer. */
function truncatePipelineIo(text: string, maxChars = 140): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= maxChars) return flat;
  return `${flat.slice(0, maxChars - 1).trimEnd()}…`;
}

function parseMessageMetadata(metadata?: string | null): {
  citationHits?: CitationHit[];
  question?: string;
  formatted?: boolean;
  confidence?: KcRetrievalConfidence;
  answer_mode?: KcAnswerMode;
  context_sources?: SourceSummary[];
  latency_ms?: number;
  retrieval_ms?: number;
  answer_ms?: number;
  answered_at_ms?: number;
  pipeline_trace?: KcPipelineTrace;
} | null {
  if (!metadata) return null;
  try {
    return JSON.parse(metadata) as {
      citationHits?: CitationHit[];
      question?: string;
      formatted?: boolean;
      confidence?: KcRetrievalConfidence;
      answer_mode?: KcAnswerMode;
      context_sources?: SourceSummary[];
      latency_ms?: number;
      retrieval_ms?: number;
      answer_ms?: number;
      answered_at_ms?: number;
      pipeline_trace?: KcPipelineTrace;
    };
  } catch {
    return null;
  }
}

function buildAssistantMetadata(
  searchResult: KcSearchResult,
  contextHits: KcSearchResult['hits'],
  citationHits: CitationHit[],
  question: string,
  formatted = true,
  timing?: AnswerTiming | null,
  pipelineTrace?: KcPipelineTrace | null,
) {
  const evidenceItems = searchResult.grounded_context?.evidence_items ?? [];
  const evidenceByFile = new Map(evidenceItems.map(item => [item.file_name, item]));

  return JSON.stringify({
    sources: sourceSummaryFromHits(contextHits),
    context_sources: contextHits.map(hit => {
      const evidence = evidenceByFile.get(hit.chunk.file_name);
      return {
        file_name: hit.chunk.file_name,
        file_path: hit.chunk.file_path,
        rank: hit.rank,
        title: formatSourceCitation(hit).split(' · ').slice(1).join(' · '),
        snippet: formatSourceSnippetPreview(
          hit.chunk.context_text?.trim() || hit.chunk.text,
          900,
        ),
        source_confidence: hit.chunk.source_confidence ?? evidence?.source_confidence,
        interpretation: sourceInterpretation(hit, evidence?.plain_summary),
        line_start: hit.chunk.line_start ?? evidence?.line_start,
        line_end: hit.chunk.line_end ?? evidence?.line_end,
      };
    }),
    retrieval_mode: searchResult.mode,
    hit_count: contextHits.length,
    confidence: searchResult.confidence,
    confidence_score: searchResult.confidence_score,
    answer_mode: searchResult.answer_mode,
    sub_queries: searchResult.sub_queries,
    citationHits,
    question,
    formatted,
    ...(timing
      ? {
          latency_ms: timing.latency_ms,
          retrieval_ms: timing.retrieval_ms,
          answer_ms: timing.answer_ms,
          answered_at_ms: timing.answered_at_ms,
        }
      : {}),
    ...(pipelineTrace ? { pipeline_trace: pipelineTrace } : {}),
  });
}

function createLocalMessage(
  id: string,
  conversationId: string,
  role: 'user' | 'assistant',
  content: string,
  metadata?: string | null,
): Message {
  return {
    id,
    conversation_id: conversationId,
    role,
    content,
    metadata: metadata ?? undefined,
    created_at: Math.floor(Date.now() / 1000),
  };
}

export default function KnowledgeChatPanel() {
  const [input, setInput] = useState('');
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [generationStatus, setGenerationStatus] = useState<string | null>(null);
  const [lastHits, setLastHits] = useState<KcSearchResult['hits']>([]);
  const [lastSearch, setLastSearch] = useState<KcSearchResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [conversationLoading, setConversationLoading] = useState(false);
  const [serverRagCreds, setServerRagCreds] = useState<ServerRagCredentials | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const generationRef = useRef(0);
  const sendInFlightRef = useRef(false);

  const {
    currentModel,
    defaultParams,
    productConfig,
    setProductConfig,
    localModels,
    setCurrentModel,
    setActiveView,
    setConversations,
    setMessages: setStoreMessages,
    setActiveConversation,
    activeConversationId: appActiveConversationId,
    conversations: appConversations,
  } = useAppStore();
  const {
    collections,
    activeCollectionId,
    embeddingModelPath,
    retrievalMode,
    searchScope,
    topK,
    setConversationIdForKey,
    setRetrievalMode,
    setSearchScope,
    setTopK,
  } = useKnowledgeChatStore();
  const [configuredProviders, setConfiguredProviders] = useState<string[]>([]);

  const activeCollection = useMemo(
    () => collections.find(item => item.id === activeCollectionId) || null,
    [collections, activeCollectionId],
  );

  const serverRagMode = Boolean(serverRagCreds);
  const chatReady = serverRagMode
    ? Boolean(activeCollection?.status === 'ready')
    : Boolean(activeCollection?.status === 'ready' && currentModel);
  const modelKind = answerModelKind(currentModel);
  const modelLabel = answerModelLabel(currentModel, localModels);

  useEffect(() => {
    let cancelled = false;
    loadServerRagCredentials()
      .then(creds => {
        if (!cancelled) setServerRagCreds(creds);
      })
      .catch(() => {
        if (!cancelled) setServerRagCreds(null);
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    invoke<string[]>('get_api_key_providers')
      .then(providers => {
        if (!cancelled) setConfiguredProviders(providers || []);
      })
      .catch(() => {
        if (!cancelled) setConfiguredProviders([]);
      });
    return () => { cancelled = true; };
  }, [currentModel]);

  const onlineModelOptions = useMemo(() => {
    return ONLINE_CHAT_MODELS.map(model => ({
      model,
      path: remoteModelPath(model),
      ready: !model.requiresApiKey || configuredProviders.includes(model.provider),
    }));
  }, [configuredProviders]);

  const onAnswerModelChange = (value: string) => {
    if (!value) {
      setCurrentModel(null);
      return;
    }
    if (value.startsWith('remote:')) {
      const option = onlineModelOptions.find(item => item.path === value);
      if (option && !option.ready) {
        setError(`Add your ${option.model.providerName} API key in Models before using ${option.model.name}.`);
        setActiveView('models');
        return;
      }
    }
    setCurrentModel(value);
    setError(null);
  };
  const knowledgeChatMode: KcKnowledgeChatMode = productConfig?.knowledge_chat_mode === 'codebase_explorer'
    ? 'codebase_explorer'
    : 'folder_qa';
  const explorerMode = knowledgeChatMode === 'codebase_explorer';

  const setKnowledgeChatMode = async (mode: KcKnowledgeChatMode) => {
    if (!productConfig || mode === productConfig.knowledge_chat_mode) return;
    const next = { ...productConfig, knowledge_chat_mode: mode };
    setProductConfig(next);
    try {
      await saveProductConfig(next);
    } catch (err) {
      setError(humanError(err));
    }
  };

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'auto' });
  }, [messages.length, isGenerating]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!chatReady || !activeCollection?.id) {
        setConversationId(null);
        return;
      }
      setConversationLoading(true);
      setLastHits([]);
      setLastSearch(null);
      setError(null);
      const mode = serverRagMode ? 'knowledge-server-rag' : 'knowledge';
      const storageKey = kcConversationStorageKey(activeCollection.id, serverRagMode);
      const title = `Knowledge Chat: ${activeCollection.name || 'Collection'}`;
      // Read persisted map at call time (zustand persist may hydrate after first render).
      const storedId = useKnowledgeChatStore.getState().conversationIdsByKey[storageKey] || null;

      const loadMessages = async (id: string): Promise<Message[] | null> => {
        try {
          return await invoke<Message[]>('get_messages', { conversationId: id });
        } catch {
          return null;
        }
      };

      try {
        // #region agent log
        fetch('http://127.0.0.1:7414/ingest/28bf2132-0f52-40ef-96b9-4e681c1d7653',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'7d5a77'},body:JSON.stringify({sessionId:'7d5a77',runId:'kc-persist-post',hypothesisId:'A',location:'KnowledgeChatPanel.tsx:conversation-init',message:'kc_conversation_init_restore_or_create',data:{chatReady,collectionId:activeCollection.id,collectionName:activeCollection.name,serverRagMode,storedId,appActiveConversationId,mode},timestamp:Date.now()})}).catch(()=>{});
        // #endregion

        let resolvedId: string | null = null;
        let resolvedMessages: Message[] = [];
        let restoreSource: 'stored' | 'app-active' | 'db-title' | 'created' = 'created';

        if (storedId) {
          const msgs = await loadMessages(storedId);
          if (msgs) {
            resolvedId = storedId;
            resolvedMessages = msgs;
            restoreSource = 'stored';
          }
        }

        if (!resolvedId && appActiveConversationId) {
          const activeConv = (useAppStore.getState().conversations.find(c => c.id === appActiveConversationId)
            || appConversations.find(c => c.id === appActiveConversationId));
          if (activeConv && activeConv.mode === mode) {
            const msgs = await loadMessages(appActiveConversationId);
            if (msgs) {
              resolvedId = appActiveConversationId;
              resolvedMessages = msgs;
              restoreSource = 'app-active';
            }
          }
        }

        if (!resolvedId) {
          const convs = await invoke<Conversation[]>('get_conversations');
          const matches = convs.filter(c =>
            c.mode === mode
            && (c.title === title || c.title.startsWith(`Knowledge Chat: ${activeCollection.name}`)),
          );
          // Prefer a thread that already has messages (older empty drafts may sort newer).
          for (const match of matches) {
            const msgs = await loadMessages(match.id);
            if (msgs && msgs.length > 0) {
              resolvedId = match.id;
              resolvedMessages = msgs;
              restoreSource = 'db-title';
              break;
            }
          }
          if (!resolvedId && matches[0]) {
            const msgs = await loadMessages(matches[0].id);
            if (msgs) {
              resolvedId = matches[0].id;
              resolvedMessages = msgs;
              restoreSource = 'db-title';
            }
          }
        }

        if (!resolvedId) {
          resolvedId = await invoke<string>('create_conversation', {
            title,
            characterId: null,
            modelId: serverRagMode ? 'enterprise:server-rag' : currentModel,
            mode,
          });
          resolvedMessages = [];
          restoreSource = 'created';
        }

        if (cancelled || !resolvedId) return;

        setConversationIdForKey(storageKey, resolvedId);
        setConversationId(resolvedId);
        setMessages(resolvedMessages);
        setStoreMessages(resolvedId, resolvedMessages);
        setActiveConversation(resolvedId);
        try {
          const convs = await invoke<Conversation[]>('get_conversations');
          if (!cancelled) setConversations(convs);
        } catch {
          // Sidebar refresh is best-effort.
        }

        // #region agent log
        fetch('http://127.0.0.1:7414/ingest/28bf2132-0f52-40ef-96b9-4e681c1d7653',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'7d5a77'},body:JSON.stringify({sessionId:'7d5a77',runId:'kc-persist-post',hypothesisId:'A',location:'KnowledgeChatPanel.tsx:conversation-resolved',message:'kc_conversation_resolved',data:{conversationId:resolvedId,restoreSource,messageCount:resolvedMessages.length,storageKey},timestamp:Date.now()})}).catch(()=>{});
        // #endregion
      } catch (err) {
        if (!cancelled) setError(humanError(err));
      } finally {
        if (!cancelled) setConversationLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // Intentionally omit currentModel: changing answer model must not wipe the thread.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- restore map + collection/mode only
  }, [activeCollection?.id, activeCollection?.name, chatReady, serverRagMode]);

  const stopGeneration = async () => {
    generationRef.current += 1;
    try {
      await invoke('stop_generation');
    } finally {
      sendInFlightRef.current = false;
      setIsGenerating(false);
      setGenerationStatus(null);
    }
  };

  const streamGenerate = async (
    prompt: string,
    systemPrompt: string,
    onChunk: (text: string) => void,
    onStatus?: (message: string | null) => void,
    isStale?: () => boolean,
    paramOverrides?: Partial<GenerationParams>,
  ): Promise<string> => {
    let streamingText = '';
    const limits = runtimeLimitsForConfig(productConfig);
    const generationParams: GenerationParams = {
      ...defaultParams,
      ...KC_GENERATION_DEFAULTS,
      context_size: limits.contextSize,
      max_tokens: limits.maxTokens,
      ...paramOverrides,
    };
    const unlistenChunk = await listen<GenerationResponsePayload>('generation-chunk', (event) => {
      const chunkText = event.payload?.text || '';
      if (!chunkText || isStale?.()) return;
      streamingText = event.payload?.finish_reason
        ? chunkText
        : appendStreamChunk(streamingText, chunkText);
      onChunk(streamingText);
    });
    const unlistenStatus = await listen<any>('generation-status', (event) => {
      const message = event.payload?.message;
      if (typeof message === 'string' && message.trim()) onStatus?.(message);
    });

    const backend = backendForModelPath(currentModel!);
    // #region agent log
    fetch('http://127.0.0.1:7414/ingest/28bf2132-0f52-40ef-96b9-4e681c1d7653', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '7d5a77' },
      body: JSON.stringify({
        sessionId: '7d5a77',
        runId: 'online-kc-1',
        hypothesisId: 'H3',
        location: 'KnowledgeChatPanel.tsx:streamGenerate',
        message: 'stream_generate_invoke',
        data: {
          modelPath: currentModel,
          backend,
          promptChars: prompt.length,
          maxTokens: generationParams.max_tokens,
        },
        timestamp: Date.now(),
      }),
    }).catch(() => undefined);
    // #endregion
    try {
      await invoke('stream_generate', {
        request: {
          prompt,
          messages: [],
          system_prompt: systemPrompt,
          params: generationParams,
          model_path: currentModel,
          backend,
        },
      });
    } finally {
      unlistenChunk();
      unlistenStatus();
    }

    // #region agent log
    fetch('http://127.0.0.1:7414/ingest/28bf2132-0f52-40ef-96b9-4e681c1d7653', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '7d5a77' },
      body: JSON.stringify({
        sessionId: '7d5a77',
        runId: 'online-kc-1',
        hypothesisId: 'H3',
        location: 'KnowledgeChatPanel.tsx:streamGenerate',
        message: 'stream_generate_done',
        data: {
          modelPath: currentModel,
          backend,
          replyChars: streamingText.trim().length,
          replyPreview: streamingText.trim().slice(0, 160),
        },
        timestamp: Date.now(),
      }),
    }).catch(() => undefined);
    // #endregion
    return streamingText.trim();
  };

  const sendMessage = async () => {
    const question = input.trim();
    if (!question || !conversationId || !activeCollection || !chatReady) return;
    if (!serverRagMode && !currentModel) return;
    if (sendInFlightRef.current || isGenerating) return;

    const generationId = ++generationRef.current;
    const activeConversationId = conversationId;
    const isStale = () => generationRef.current !== generationId || activeConversationId !== conversationId;

    sendInFlightRef.current = true;
    setError(null);
    setNotice(null);
    setInput('');
    setLastHits([]);
    setLastSearch(null);
    setIsGenerating(true);
    setGenerationStatus(serverRagMode
      ? 'Asking the organization server...'
      : 'Finding relevant sections...');
    const answerStartedAt = performance.now();
    let retrievalMs: number | undefined;

    const snapshotTiming = (): AnswerTiming => {
      const latency_ms = Math.max(0, Math.round(performance.now() - answerStartedAt));
      const retrieval_ms = retrievalMs != null ? Math.round(retrievalMs) : undefined;
      const answer_ms = retrieval_ms != null
        ? Math.max(0, latency_ms - retrieval_ms)
        : undefined;
      return {
        latency_ms,
        retrieval_ms,
        answer_ms,
        answered_at_ms: Date.now(),
      };
    };

    const userMsgId = await invoke<string>('add_message', {
      conversationId,
      role: 'user',
      content: question,
      metadata: null,
    });
    const userMsg = createLocalMessage(userMsgId, conversationId, 'user', question);
    setMessages(prev => [...prev, userMsg]);

    const assistantMsgId = await invoke<string>('add_message', {
      conversationId,
      role: 'assistant',
      content: serverRagMode ? 'Asking the organization server...' : 'Searching this folder...',
      metadata: null,
    });
    // #region agent log
    fetch('http://127.0.0.1:7414/ingest/28bf2132-0f52-40ef-96b9-4e681c1d7653',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'7d5a77'},body:JSON.stringify({sessionId:'7d5a77',runId:'kc-persist-post',hypothesisId:'B',location:'KnowledgeChatPanel.tsx:messages-persisted',message:'kc_messages_written_to_db',data:{conversationId,userMsgId,assistantMsgId,questionLen:question.length},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
    setMessages(prev => [...prev, createLocalMessage(
      assistantMsgId,
      conversationId,
      'assistant',
      serverRagMode ? 'Asking the organization server...' : 'Searching this folder...',
    )]);

    try {
      // Server RAG thin client: skip local hybrid_search / embed; gateway returns answer+sources.
      if (serverRagCreds && serverRagMode) {
        const result = await serverRagChat(serverRagCreds, activeCollection.id, question);
        if (isStale()) return;
        retrievalMs = performance.now() - answerStartedAt;
        const sources: SourceSummary[] = (result.sources || []).map((src, idx) => ({
          rank: idx + 1,
          file_name: src.file_name,
          file_path: src.relative_path,
          title: src.title,
          snippet: src.snippet,
          source_confidence: src.score,
        }));
        setNotice('Answered from your organization server.');
        const metadata = JSON.stringify({
          mode: 'server_rag',
          collection_id: result.collection_id,
          sources,
          timing: snapshotTiming(),
        });
        await invoke('update_message', { id: assistantMsgId, content: result.answer, metadata });
        setMessages(prev => prev.map(item => item.id === assistantMsgId
          ? { ...item, content: result.answer, metadata }
          : item));
        setLastHits([]);
        return;
      }

      const rewrite = await kcPrepareSearchQuery(question);
      let searchQuery = question;
      if (productConfig?.enable_llm_query_expand && rewrite.vague && currentModel) {
        searchQuery = await expandVagueQueryWithLlm(question, rewrite, currentModel, defaultParams);
        if (searchQuery !== rewrite.retrieval_query) {
          setNotice('Clarified your question before searching.');
        }
      } else if (rewrite.vague && rewrite.expansions.length > 0) {
        setNotice('Expanded a short question to improve search.');
      }

      const denseAvailable = activeCollection.dense_status === 'ready' && activeCollection.dense_chunk_count > 0;
      const mode = pickRetrievalMode(denseAvailable, retrievalMode);

      // High-precision vetoes (error codes / env vars) keep the specialist path.
      // Everything else uses LLM orchestration: the model interprets the question
      // and may request one refined retrieval instead of brittle intent routing.
      const precisionVeto = vetoSearchIntent(question);
      const preferLlmOrchestration = Boolean(currentModel) && !serverRagMode && !precisionVeto;

      // Stage A — only run LLM intent when specialists still own the path.
      const searchIntentResult = preferLlmOrchestration
        ? { intent: 'general' as const, source: 'rules' as const }
        : currentModel
          ? await classifySearchIntent(question, currentModel, defaultParams)
          : { intent: classifyRulesSearchIntent(question), source: 'rules' as const };
      if (isStale()) return;

      let searchResult = await kcHybridSearch({
        collection_id: activeCollection.id,
        query: searchQuery,
        mode,
        top_k: topK,
        search_scope: searchScope,
        intent_override: precisionVeto || searchIntentResult.intent,
      });
      // #region agent log
      fetch('http://127.0.0.1:7414/ingest/28bf2132-0f52-40ef-96b9-4e681c1d7653',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'7d5a77'},body:JSON.stringify({sessionId:'7d5a77',runId:'llm-orch-1',hypothesisId:'O1',location:'KnowledgeChatPanel.tsx:search',message:'fe_hybrid_search_result',data:{collectionId:activeCollection.id,modeRequested:mode,modeActual:searchResult.mode,hitCount:searchResult.hits?.length??0,denseAvailable,searchIntent:precisionVeto||searchIntentResult.intent,preferLlmOrchestration,precisionVeto,degradationCount:searchResult.degradation_reasons?.length??0,degradationSample:(searchResult.degradation_reasons||[]).slice(0,3),confidence:searchResult.confidence,autoFilters:!!searchResult.auto_filters_applied},timestamp:Date.now()})}).catch(()=>{});
      // #endregion
      if (isStale()) return;

      // Stage B — skipped under orchestration (LLM decides meaning from evidence).
      const answerIntentResult = preferLlmOrchestration
        ? { intent: 'general' as const, source: 'rules' as const }
        : currentModel
          ? await classifyAnswerIntent(question, searchResult.hits.slice(0, 8), currentModel, defaultParams)
          : { intent: classifyRulesAnswerIntent(question, searchResult.hits), source: 'rules' as const };
      if (isStale()) return;

      searchResult = {
        ...searchResult,
        detected_intent: searchResult.detected_intent || searchIntentResult.intent,
        answer_intent: answerIntentResult.intent,
        intent_source: answerIntentResult.source,
        pipeline_trace: mergeIntentStagesIntoTrace(searchResult.pipeline_trace, {
          question,
          searchIntent: precisionVeto || searchIntentResult.intent,
          searchSource: preferLlmOrchestration ? 'rules' : searchIntentResult.source,
          answerIntent: answerIntentResult.intent,
          answerSource: answerIntentResult.source,
        }),
      };

      const appendSearchNotices = (result: KcSearchResult) => {
        if (result.dense_pair_rerank_used) {
          setNotice(prev => prev || 'Refined the top matches for a better answer.');
        }
        if (result.llama_rerank_used) {
          setNotice(prev => {
            const msg = 'Applied Qwen3 / llama.cpp RANK reranking to top candidates.';
            return prev?.includes('RANK') ? prev : prev ? `${prev} ${msg}` : msg;
          });
        } else if (result.onnx_reranker_used) {
          setNotice(prev => {
            const msg = 'Applied ONNX cross-encoder reranking to top candidates.';
            return prev?.includes('cross-encoder') ? prev : prev ? `${prev} ${msg}` : msg;
          });
        }
        if (result.adjacent_expand_applied) {
          setNotice(prev => {
            const msg = 'Included neighboring sections from the same file for fuller context.';
            return prev?.includes('neighboring sections') ? prev : prev ? `${prev} ${msg}` : msg;
          });
        }
        if (result.parent_merge_applied) {
          setNotice(prev => {
            const msg = 'Merged sibling chunks into parent context.';
            return prev?.includes('parent context') ? prev : prev ? `${prev} ${msg}` : msg;
          });
        }
        if (result.auto_filters_applied) {
          const f = result.auto_filters_applied;
          const bits: string[] = [];
          if (f.file_name_contains?.length) bits.push(`file=${f.file_name_contains.join(',')}`);
          if (f.doc_types?.length) bits.push(`type=${f.doc_types.join(',')}`);
          if (f.path_contains?.length) bits.push(`path=${f.path_contains.join(',')}`);
          if (bits.length) {
            setNotice(prev => {
              const msg = `Auto-scoped search (${bits.join('; ')}).`;
              return prev?.includes('Auto-scoped') ? prev : prev ? `${prev} ${msg}` : msg;
            });
          }
        }
      };

      retrievalMs = performance.now() - answerStartedAt;
      appendSearchNotices(searchResult);

      if (
        searchResult.intent_match
        && searchResult.hits.length === 0
        && productConfig?.allow_intent_short_circuit
      ) {
        const hint = searchResult.intent_match.source_hint
          ? ` Refer to your indexed ${searchResult.intent_match.source_hint} for authoritative steps.`
          : '';
        const finalText = `${searchResult.intent_match.answer}${hint}`;
        const metadata = buildAssistantMetadata(searchResult, [], [], question, true, snapshotTiming());
        if (isStale()) return;
        await invoke('update_message', { id: assistantMsgId, content: finalText, metadata });
        setMessages(prev => prev.map(item => item.id === assistantMsgId
          ? { ...item, content: finalText, metadata }
          : item));
        return;
      }

      if (searchResult.degradation_reasons?.length) {
        setNotice(searchResult.degradation_reasons.join(' '));
      } else if (searchResult.mode !== mode && (mode === 'hybrid_dense' || mode === 'dense_vector')) {
        setNotice(`Using ${KC_RETRIEVAL_MODE_LABELS[searchResult.mode] || 'available'} search.`);
      }

      let contextHits = filterHitsForContext(searchResult.hits, question);
      let bundledHits = bundleHitsForLlm(contextHits);
      let citationHitsForAnswer = buildCitationHits(bundledHits.length ? bundledHits : contextHits);
      setLastHits(contextHits);
      setLastSearch(searchResult);

      let grounded = searchResult.grounded_context;
      const evidenceMode = productConfig?.knowledge_chat_evidence_mode ?? 'concise';
      const preferOnlineLlm = isOnlineRemotePath(currentModel);
      const llmOwnsAnswer = preferLlmOrchestration || preferOnlineLlm;
      let answerRoute = resolveAnswerRoute(searchResult, question, contextHits, productConfig);
      const answerIntent = () => effectiveAnswerIntent(searchResult);
      let extractivePreview = answerIntent() === 'explain_symbol'
        ? resolveBestExtractiveAnswer(
          question,
          contextHits,
          searchResult.symbol_entities,
          searchResult.grounded_context?.sources,
        )
        : null;
      let structuredAnswer = resolveStructuredAnswer(searchResult, question);
      // LLM orchestration / online models: do not short-circuit to inventory/extractive.
      if (llmOwnsAnswer && answerRoute !== 'not_found') {
        answerRoute = 'llm';
        extractivePreview = null;
        structuredAnswer = null;
      }
      let correctiveRetrievalUsed = false;
      // #region agent log
      fetch('http://127.0.0.1:7414/ingest/28bf2132-0f52-40ef-96b9-4e681c1d7653', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '7d5a77' },
        body: JSON.stringify({
          sessionId: '7d5a77',
          runId: 'llm-orch-1',
          hypothesisId: 'O1',
          location: 'KnowledgeChatPanel.tsx:route',
          message: 'answer_route_resolved',
          data: {
            currentModel,
            preferOnlineLlm,
            preferLlmOrchestration,
            llmOwnsAnswer,
            answerRoute,
            answerIntent: answerIntent(),
            searchIntent: searchResult.detected_intent || searchResult.answer_intent || null,
            hitCount: contextHits.length,
            hasExtractive: !!extractivePreview,
            hasStructured: !!structuredAnswer,
            serverRagMode,
            questionPreview: question.slice(0, 120),
          },
          timestamp: Date.now(),
        }),
      }).catch(() => undefined);
      // #endregion

      const applySearchState = (next: KcSearchResult) => {
        // Preserve Stage A/B intent fields across corrective re-search.
        searchResult = {
          ...next,
          answer_intent: next.answer_intent || searchResult.answer_intent,
          intent_source: next.intent_source || searchResult.intent_source,
          detected_intent: next.detected_intent || searchResult.detected_intent,
          pipeline_trace: next.pipeline_trace || searchResult.pipeline_trace,
        };
        contextHits = filterHitsForContext(searchResult.hits, question);
        bundledHits = bundleHitsForLlm(contextHits);
        citationHitsForAnswer = buildCitationHits(bundledHits.length ? bundledHits : contextHits);
        setLastHits(contextHits);
        setLastSearch(searchResult);
        grounded = searchResult.grounded_context;
        answerRoute = resolveAnswerRoute(searchResult, question, contextHits, productConfig);
        extractivePreview = answerIntent() === 'explain_symbol'
          ? resolveBestExtractiveAnswer(
            question,
            contextHits,
            searchResult.symbol_entities,
            searchResult.grounded_context?.sources,
          )
          : null;
        structuredAnswer = resolveStructuredAnswer(searchResult, question);
        // Corrective re-search must not re-arm extractive/structured short-circuits
        // when LLM orchestration / online synthesis owns the answer.
        if (llmOwnsAnswer && answerRoute !== 'not_found') {
          answerRoute = 'llm';
          extractivePreview = null;
          structuredAnswer = null;
        }
      };

      /** Cap at one extra retrieval. Optional LLM-refined query override. */
      const runCorrectiveRetrieval = async (queryOverride?: string | null): Promise<boolean> => {
        if (correctiveRetrievalUsed) return false;
        if (shouldSkipCorrectiveRetrieval(!!structuredAnswer, !!extractivePreview, preferLlmOrchestration)) {
          return false;
        }
        correctiveRetrievalUsed = true;
        setNotice(prev => {
          return prev?.includes('Refined the search')
            ? prev
            : prev
              ? `${prev} ${CORRECTIVE_RETRIEVAL_NOTICE}`
              : CORRECTIVE_RETRIEVAL_NOTICE;
        });
        setGenerationStatus(queryOverride?.trim() ? 'Searching again with a better query…' : 'Refining search…');
        const tightened = (queryOverride || '').trim() || tightenSearchQuery(question, rewrite);
        const second = await kcHybridSearch({
          collection_id: activeCollection.id,
          query: tightened,
          mode,
          top_k: topK,
          search_scope: searchScope,
          intent_override: preferLlmOrchestration ? 'general' : (precisionVeto || searchIntentResult.intent),
        });
        if (isStale()) return true;
        appendSearchNotices(second);
        if (shouldPreferCorrectiveResult(second, searchResult) || preferLlmOrchestration) {
          applySearchState(second);
        } else {
          // Still adopt second-pass extractive/evidence if the first pass had none.
          const secondHits = filterHitsForContext(second.hits, question);
          const secondExtractive = answerIntent() === 'explain_symbol'
            ? resolveBestExtractiveAnswer(
              question,
              secondHits,
              second.symbol_entities,
              second.grounded_context?.sources,
            )
            : null;
          if (secondExtractive || resolveStructuredAnswer(second, question)) {
            applySearchState(second);
          }
        }
        return true;
      };

      // LLM-driven re-retrieve: model decides if evidence is enough (bounded to 1).
      if (preferLlmOrchestration && currentModel && !correctiveRetrievalUsed) {
        setGenerationStatus('Checking whether search results are enough…');
        const decision = await decideRetrievalSufficiency(
          question,
          contextHits,
          currentModel,
          defaultParams,
          searchResult.confidence,
        );
        // #region agent log
        fetch('http://127.0.0.1:7414/ingest/28bf2132-0f52-40ef-96b9-4e681c1d7653',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'7d5a77'},body:JSON.stringify({sessionId:'7d5a77',runId:'llm-orch-1',hypothesisId:'O2',location:'KnowledgeChatPanel.tsx:retrievalDecision',message:'llm_retrieval_decision',data:{action:decision.action,queryPreview:decision.action==='need_retrieval'?decision.query.slice(0,120):null,hitCount:contextHits.length,confidence:searchResult.confidence},timestamp:Date.now()})}).catch(()=>{});
        // #endregion
        if (isStale()) return;
        if (decision.action === 'need_retrieval') {
          await runCorrectiveRetrieval(decision.query);
          if (isStale()) return;
        }
      }

      // Heuristic CRAG-lite backup when the controller did not spend the re-retrieve budget.
      if (
        !correctiveRetrievalUsed
        && !shouldSkipCorrectiveRetrieval(!!structuredAnswer, !!extractivePreview, preferLlmOrchestration)
        && needsCorrectiveRetrieval(searchResult)
      ) {
        await runCorrectiveRetrieval();
        if (isStale()) return;
      }

      const formatAnswer = (text: string, skipQualityGate = false) => formatKnowledgeAnswer(
        text,
        citationHitsForAnswer,
        {
          question,
          notFoundFallback: KC_NOT_FOUND_MESSAGE,
          skipQualityGate,
          preferredCitation: searchResult.structured_answer
            ? {
              file_name: searchResult.structured_answer.source_file,
              sectionLabel: searchResult.structured_answer.line_start
                ? `L${searchResult.structured_answer.line_start}${searchResult.structured_answer.line_end && searchResult.structured_answer.line_end > searchResult.structured_answer.line_start ? `–L${searchResult.structured_answer.line_end}` : ''}`
                : searchResult.structured_answer.source_file,
              line_start: searchResult.structured_answer.line_start ?? undefined,
              line_end: searchResult.structured_answer.line_end ?? undefined,
            }
            : undefined,
        },
      );

      const publishAnswer = async (
        text: string,
        hitsForMeta: KcSearchHit[] = contextHits,
        citations = citationHitsForAnswer,
        extras?: {
          winningStageId?: string | null;
          extractiveUsed?: boolean;
          structuredUsed?: boolean;
          llmUsed?: boolean;
        },
      ) => {
        const pipelineTrace = mergeAnswerStagesIntoTrace(searchResult.pipeline_trace, {
          correctiveUsed: correctiveRetrievalUsed,
          winningStageId: extras?.winningStageId,
          extractiveUsed: !!extras?.extractiveUsed || !!extractivePreview,
          structuredUsed: !!extras?.structuredUsed || !!structuredAnswer,
          llmUsed: !!extras?.llmUsed || extras?.winningStageId === 'llm-synthesis',
          question,
          extractivePreview,
          structuredAnswer,
          finalAnswerPreview: text.slice(0, 1200),
        });
        const metadata = buildAssistantMetadata(
          searchResult,
          hitsForMeta,
          citations,
          question,
          true,
          snapshotTiming(),
          pipelineTrace,
        );
        if (isStale()) return;
        await invoke('update_message', { id: assistantMsgId, content: text, metadata });
        setMessages(prev => prev.map(item => item.id === assistantMsgId
          ? { ...item, content: text, metadata }
          : item));
      };

      const resolveExplorer = async (): Promise<string | null> => {
        try {
          const explorer = await buildCodebaseExplorerContext({
            collectionId: activeCollection.id,
            question,
            streamGenerate,
            setStatus: setGenerationStatus,
            isStale,
            enableAgentLoop: true,
          });
          if (isStale() || !explorer.prompt.trim()) return null;

          const explorerSystem = codebaseExplorerSystemPrompt(question);
          setGenerationStatus('Generating codebase answer...');
          const unlistenExplorerError = await listen<string>('generation-error', (event) => {
            setError(humanError(event.payload));
          });
          let explorerDraft = '';
          try {
            explorerDraft = await streamGenerate(
              explorer.prompt,
              explorerSystem,
              (text) => {
                setMessages(prev => prev.map(item => item.id === assistantMsgId
                  ? { ...item, content: unescapeLlmLiterals(text) }
                  : item));
              },
              setGenerationStatus,
              isStale,
            );
          } finally {
            unlistenExplorerError();
          }
          if (isStale()) return null;

          let explorerText = formatAnswer(explorerDraft || KC_NOT_FOUND_MESSAGE, true);
          if (isNotFoundAnswer(explorerText) && explorerDraft && isSubstantiveDraft(explorerDraft)) {
            explorerText = formatAnswer(explorerDraft, true);
          }
          if ((isNotFoundAnswer(explorerText) || !/##\s+Evidence/i.test(explorerText)) && extractivePreview) {
            explorerText = formatAnswer(extractivePreview, true);
          }
          return explorerText;
        } catch (err) {
          setNotice(`Codebase Explorer fell back to standard retrieval: ${humanError(err)}`);
          return null;
        }
      };

      const resolveEvidence = (): string | null => {
        const evidenceText = resolveAnswerFallback(searchResult, question, contextHits);
        return evidenceText ? formatAnswer(evidenceText, true) : null;
      };

      const resolveNotFound = (): AnswerResult => {
        const fallback = resolveAnswerFallback(searchResult, question, contextHits);
        const text = fallback
          ? formatAnswer(fallback, true)
          : (grounded?.blocked_reason?.trim() || KC_NOT_FOUND_MESSAGE);
        return { text, hitsForMeta: contextHits, withCitations: !!fallback };
      };

      const resolveLlm = async (): Promise<AnswerResult> => {
        // Accuracy-first for local small models: never paraphrase a known symbol body.
        // Online models are kept on the synthesis path so pipeline quality can be tested.
        if (!llmOwnsAnswer && shouldSkipLlmForExtractive(question, extractivePreview)) {
          return { text: formatAnswer(extractivePreview!, true) };
        }
        if (!llmOwnsAnswer && !shouldUseLlmSynthesis(searchResult, contextHits, productConfig, question)) {
          const fallback = resolveAnswerFallback(searchResult, question, contextHits);
          if (fallback) return { text: formatAnswer(fallback, true) };
        }

        const systemPrompt = systemPromptForQuestion(question, searchResult.answer_mode);

        const retrievalPool = bundledHits.length ? bundledHits : contextHits;
        let contextBlock = '';
        let attachedSources = grounded?.sources ?? [];

        const searchContextReady = !!grounded?.context_block?.trim()
          && (grounded.sources?.length ?? 0) > 0
          && !/ATTACHED SOURCE FILES:\s*none/i.test(grounded.context_block);

        if (searchContextReady) {
          contextBlock = grounded!.context_block;
          attachedSources = grounded!.sources;
          setGenerationStatus('Using matching sections from search…');
        } else {
          setGenerationStatus('Reading folder contents…');
          const catalog = await kcBuildFileCatalog(activeCollection.id);
          if (isStale()) return { text: '' };

          let selectedPaths = mergeSelectedPaths(
            pathsFromRetrievalHits(retrievalPool, catalog),
            boostSelectedPathsFromQuery(question, catalog, retrievalPool),
          );

          if (!selectedPaths.length) {
            setGenerationStatus('Selecting relevant files...');
            const selectionPrompt = buildFileSelectionPrompt(question, catalog, retrievalPool);
            const selectionRaw = await streamGenerate(
              selectionPrompt,
              KC_FILE_SELECT_SYSTEM_PROMPT,
              () => undefined,
              setGenerationStatus,
              isStale,
              { max_tokens: 320, temperature: 0.05 },
            );
            if (isStale()) return { text: '' };
            selectedPaths = mergeSelectedPaths(
              selectedPaths,
              parseSelectedFilePaths(selectionRaw, catalog),
            );
          }

          if (selectedPaths.length) {
            setGenerationStatus('Loading selected files...');
            const loaded = await kcLoadSelectedFiles(activeCollection.id, selectedPaths);
            if (loaded.context_block.trim() && loaded.sources.length) {
              contextBlock = loaded.context_block;
              attachedSources = loaded.sources;
            }
          }
        }

        // After files are attached, rebuild extractive — this is the handleSend path:
        // exact function body present, but Tree-sitter/chunk extractive missed earlier.
        // Only for explain_symbol — list/locate/imports use structured specialists instead.
        let extractiveFromAttached: string | null = null;
        if (effectiveAnswerIntent(searchResult) === 'explain_symbol') {
          extractiveFromAttached = resolveBestExtractiveAnswer(
            question,
            contextHits,
            searchResult.symbol_entities,
            attachedSources,
          );
          if (!llmOwnsAnswer && shouldSkipLlmForExtractive(question, extractiveFromAttached)) {
            extractivePreview = extractiveFromAttached;
            return { text: formatAnswer(extractiveFromAttached!, true) };
          }
        }

        if (!contextBlock.trim()) {
          contextBlock = buildBundledLlmContext(
            retrievalPool,
            grounded,
            activeCollection.name,
            question,
          );
          if (!attachedSources.length && grounded?.sources?.length) {
            attachedSources = grounded.sources;
          }
        }

        // Optional Online Image RAG (collection + global gates enforced in Rust).
        if (activeCollection.id && contextHits.length > 0 && question.trim()) {
          try {
            const vision = await invoke<{
              evidence?: Array<{ page_label: string; description: string }>;
              warning?: string | null;
            }>('kc_image_rag_enrich', {
              collectionId: activeCollection.id,
              question: question.slice(0, 2000),
              hits: contextHits.slice(0, 8),
            });
            if (vision?.warning) {
              const warn = String(vision.warning);
              setNotice(prev => (prev ? `${prev} ${warn}` : warn));
            }
            if (Array.isArray(vision?.evidence) && vision.evidence.length) {
              const usable = vision.evidence.filter(
                e => e && typeof e.description === 'string' && e.description.trim(),
              );
              const visionBlock = usable
                .map(e => `${e.page_label || 'Page image'}\n${e.description}`)
                .join('\n\n---\n\n');
              if (visionBlock.trim()) {
                contextBlock = `${contextBlock}\n\n---\n\nPage image notes (optional online look):\n${visionBlock}`;
                // Include vision text in grounding corpus so valid visual answers are not discarded.
                attachedSources = [
                  ...attachedSources,
                  ...usable.map(e => ({
                    file_name: e.page_label || 'Page image',
                    source_confidence: 0.55,
                    text: e.description,
                    source_type: 'online_vision',
                  })),
                ];
              }
            }
          } catch {
            // Soft-fail: continue offline-only.
          }
        }

        if (isStale()) return { text: '' };

        const groundedPrompt = buildBundledGroundedPrompt(question, contextBlock);

        setGenerationStatus('Generating grounded answer...');

        let draftAnswer = '';
        const unlistenError = await listen<string>('generation-error', (event) => {
          setError(humanError(event.payload));
        });

        try {
          draftAnswer = await streamGenerate(
            groundedPrompt,
            systemPrompt,
            (text) => {
              setMessages(prev => prev.map(item => item.id === assistantMsgId
                ? { ...item, content: unescapeLlmLiterals(text) }
                : item));
            },
            setGenerationStatus,
            isStale,
          );
        } finally {
          unlistenError();
        }
        if (isStale()) return { text: '' };

        if (isEmptyModelResponse(draftAnswer || '')) {
          const extractive = extractiveFromAttached
            || extractivePreview
            || resolveBestExtractiveAnswer(
              question,
              contextHits,
              searchResult.symbol_entities,
              attachedSources,
            );
          if (extractive) {
            return { text: formatAnswer(extractive, true), hitsForMeta: contextHits, withCitations: true };
          }
          const fallback = resolveAnswerFallback(searchResult, question, contextHits, attachedSources);
          return {
            text: formatAnswer(fallback || KC_NOT_FOUND_MESSAGE, true),
            hitsForMeta: contextHits,
            withCitations: !!fallback,
          };
        }

        let finalText = formatAnswer(draftAnswer || KC_NOT_FOUND_MESSAGE, true);
        const groundedOk = groundingCheck(finalText, contextHits, question, 0.35, attachedSources);

        // Pass-2 citation verifier (optional; default on via ocr/product settings).
        let verifyOk = true;
        let verifyVerdict: 'valid' | 'invalid' | 'unknown' | 'skipped' | 'error' = 'skipped';
        try {
          const ocrCfg = await invoke<{ verify_llm_answer?: boolean }>('get_ocr_image_rag_config');
          if (ocrCfg?.verify_llm_answer !== false && groundedOk && !isNotFoundAnswer(finalText)) {
            setGenerationStatus('Verifying citations...');
            const verifyPrompt = buildVerificationPrompt(question, contextBlock, finalText);
            const verdictRaw = await streamGenerate(
              verifyPrompt,
              KC_VERIFY_PROMPT,
              () => {},
              setGenerationStatus,
              isStale,
            );
            const verdict = parseVerificationVerdict(verdictRaw || '');
            verifyVerdict = verdict;
            // Specialist local path: only explicit VALID is trusted.
            // LLM orchestration / online: keep grounded drafts unless INVALID.
            verifyOk = llmOwnsAnswer ? verdict !== 'invalid' : verdict === 'valid';
          }
        } catch {
          verifyVerdict = 'error';
          // Verifier unavailable: fail-closed for specialists; keep grounded orchestration drafts.
          verifyOk = llmOwnsAnswer ? groundedOk : false;
        }
        const answerTrusted = groundedOk && verifyOk;
        const bestExtractive = extractiveFromAttached
          || extractivePreview
          || resolveBestExtractiveAnswer(
            question,
            contextHits,
            searchResult.symbol_entities,
            attachedSources,
          );

        // #region agent log
        fetch('http://127.0.0.1:7414/ingest/28bf2132-0f52-40ef-96b9-4e681c1d7653', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '7d5a77' },
          body: JSON.stringify({
            sessionId: '7d5a77',
            runId: 'online-kc-1',
            hypothesisId: 'H2',
            location: 'KnowledgeChatPanel.tsx:postLlm',
            message: 'llm_draft_trust_gate',
            data: {
              preferOnlineLlm,
              groundedOk,
              verifyOk,
              verifyVerdict,
              answerTrusted,
              draftChars: finalText.length,
              hasExtractiveFallback: !!bestExtractive,
            },
            timestamp: Date.now(),
          }),
        }).catch(() => undefined);
        // #endregion

        if (!llmOwnsAnswer && shouldPreferExtractiveOverLlm(question, bestExtractive, finalText, answerTrusted)) {
          finalText = formatAnswer(bestExtractive!, true);
        } else if (isNotFoundAnswer(finalText) || !answerTrusted) {
          // Post-gen CRAG-lite / verify failure: prefer extractive/evidence over untrusted LLM draft.
          const didCorrect = await runCorrectiveRetrieval();
          if (didCorrect && !isStale()) {
            const extractive = resolveBestExtractiveAnswer(
              question,
              contextHits,
              searchResult.symbol_entities,
              searchResult.grounded_context?.sources,
            );
            if (extractive) {
              finalText = formatAnswer(extractive, true);
            } else {
              const correctedFallback = resolveAnswerFallback(
                searchResult,
                question,
                contextHits,
                attachedSources,
              );
              if (correctedFallback) {
                finalText = formatAnswer(correctedFallback, true);
              } else {
                finalText = formatAnswer(KC_NOT_FOUND_MESSAGE, true);
              }
            }
          } else {
            const fallback = resolveAnswerFallback(searchResult, question, contextHits, attachedSources);
            if (fallback) {
              finalText = formatAnswer(fallback, true);
            } else {
              const extractive = resolveBestExtractiveAnswer(
                question,
                contextHits,
                searchResult.symbol_entities,
                attachedSources,
              );
              if (extractive) {
                finalText = formatAnswer(extractive, true);
              } else {
                finalText = formatAnswer(KC_NOT_FOUND_MESSAGE, true);
              }
            }
          }
        }

        finalText = mergeAnswerWithEvidence(finalText, searchResult, evidenceMode);
        return { text: finalText };
      };

      const answerContext: AnswerContext = {
        question,
        searchResult,
        contextHits,
        productConfig,
        explorerMode,
        answerRoute,
        preferOnlineLlm,
        preferLlmOrchestration,
        structuredAnswer,
        extractivePreview,
        isStale,
        formatAnswer,
        resolveExplorer,
        resolveEvidence,
        resolveNotFound,
        resolveLlm,
      };

      const result = await runAnswerPipeline(answerContext);
      // #region agent log
      fetch('http://127.0.0.1:7414/ingest/28bf2132-0f52-40ef-96b9-4e681c1d7653', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '7d5a77' },
        body: JSON.stringify({
          sessionId: '7d5a77',
          runId: 'llm-orch-1',
          hypothesisId: 'O1',
          location: 'KnowledgeChatPanel.tsx:pipelineResult',
          message: 'answer_pipeline_winner',
          data: {
            currentModel,
            preferOnlineLlm,
            preferLlmOrchestration,
            winningStageId: result?.stageId || null,
            answerChars: result?.text?.trim().length || 0,
            answerPreview: (result?.text || '').trim().slice(0, 160),
            looksLikeSymbolInventory: /^\s*`[^`]+`\s+defines these (functions|symbols):/i.test(result?.text || ''),
          },
          timestamp: Date.now(),
        }),
      }).catch(() => undefined);
      // #endregion
      if (isStale() || !result || !result.text.trim()) return;
      await publishAnswer(
        result.text,
        result.hitsForMeta ?? contextHits,
        result.withCitations === false ? [] : citationHitsForAnswer,
        {
          winningStageId: result.stageId,
          extractiveUsed: result.stageId === 'extractive-code-symbol' || !!extractivePreview,
          structuredUsed: result.stageId === 'structured' || !!structuredAnswer,
          llmUsed: result.stageId === 'llm-synthesis',
        },
      );
    } catch (err) {
      const msg = humanError(err);
      setError(msg);
      await invoke('update_message', {
        id: assistantMsgId,
        content: `**Grounded chat failed:** ${msg}`,
        metadata: null,
      }).catch(() => undefined);
      setMessages(prev => prev.map(item => item.id === assistantMsgId
        ? { ...item, content: `**Grounded chat failed:** ${msg}` }
        : item));
    } finally {
      sendInFlightRef.current = false;
      setIsGenerating(false);
      setGenerationStatus(null);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void sendMessage();
    }
  };

  return (
    <section className="panel-shell p-4 sm:p-6 flex flex-col min-h-[20rem] relative z-10">
      <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4 mb-4">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-surface-500">Knowledge Chat</p>
          <h2 className="text-xl font-black text-surface-950 dark:text-white">Ask about this folder</h2>
        </div>
        <div className="flex flex-col sm:flex-row flex-wrap gap-2">
          {!serverRagMode && (
            <>
              <label className="sr-only" htmlFor="kc-answer-model">Answer model</label>
              <select
                id="kc-answer-model"
                value={currentModel || ''}
                onChange={e => onAnswerModelChange(e.target.value)}
                className="input-field text-sm min-w-[14rem] max-w-[22rem]"
                aria-label="Answer model for Knowledge Chat"
                title="Local or online model used to write answers. Retrieval still runs on your indexed folder."
              >
                <option value="">Select answer model…</option>
                {localModels.length > 0 && (
                  <optgroup label="Offline (local GGUF)">
                    {localModels.map(model => (
                      <option key={model.id} value={model.path}>{model.name}</option>
                    ))}
                  </optgroup>
                )}
                <optgroup label="Online free / free tier">
                  {onlineModelOptions.filter(item => item.model.tier === 'free').map(item => (
                    <option key={item.path} value={item.path} disabled={!item.ready}>
                      {item.model.name} ({item.model.providerName}){item.ready ? '' : ' — add API key'}
                    </option>
                  ))}
                </optgroup>
                <optgroup label="Online premium">
                  {onlineModelOptions.filter(item => item.model.tier === 'premium').map(item => (
                    <option key={item.path} value={item.path} disabled={!item.ready}>
                      {item.model.name} ({item.model.providerName}){item.ready ? '' : ' — add API key'}
                    </option>
                  ))}
                </optgroup>
              </select>
            </>
          )}
          <label className="sr-only" htmlFor="kc-mode">Knowledge Chat mode</label>
          <select
            id="kc-mode"
            value={knowledgeChatMode}
            onChange={e => void setKnowledgeChatMode(e.target.value as KcKnowledgeChatMode)}
            className="input-field text-sm"
            aria-label="Knowledge Chat mode"
            title="Folder Q&A answers from your documents. Code explorer focuses on code structure and symbols."
          >
            <option value="folder_qa">Folder Q&amp;A</option>
            <option value="codebase_explorer">Code explorer</option>
          </select>
          <label className="sr-only" htmlFor="kc-search-scope">Search scope</label>
          <select id="kc-search-scope" value={searchScope} onChange={e => setSearchScope(e.target.value as KcSearchScope)} className="input-field text-sm" aria-label="Search scope">
            {KC_SEARCH_SCOPE_OPTIONS.map(value => (
              <option key={value} value={value}>{KC_SEARCH_SCOPE_LABELS[value]}</option>
            ))}
          </select>
          <label className="sr-only" htmlFor="kc-retrieval-mode">Search style</label>
          <select id="kc-retrieval-mode" value={retrievalMode} onChange={e => setRetrievalMode(e.target.value as typeof retrievalMode)} className="input-field text-sm" aria-label="Search style">
            {Object.entries(KC_RETRIEVAL_MODE_LABELS).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
          <label className="sr-only" htmlFor="kc-top-k">Number of sources</label>
          <select id="kc-top-k" value={topK} onChange={e => setTopK(Number(e.target.value))} className="input-field text-sm" aria-label="Number of sources">
            {[6, 8, 10, 12].map(value => <option key={value} value={value}>Up to {value} sources</option>)}
          </select>
        </div>
      </div>

      {conversationLoading && (
        <div className="mb-4 rounded-2xl border border-primary-200/70 dark:border-primary-900 bg-primary-50/85 dark:bg-primary-950/20 px-4 py-3 text-sm text-primary-800 dark:text-primary-200 flex items-center gap-2">
          <Loader2 className="w-4 h-4 animate-spin" /> Starting chat session…
        </div>
      )}

      {!chatReady && (
        <div className="rounded-2xl border border-amber-200/70 dark:border-amber-900 bg-amber-50/85 dark:bg-amber-950/20 px-4 py-3 text-sm text-amber-800 dark:text-amber-200 mb-4">
          {serverRagMode
            ? 'Select a ready collection from your organization server.'
            : 'Select a ready collection and an answer model (offline or online). Scan and build the index above, or pick a model in Models.'}
        </div>
      )}

      {!serverRagMode && chatReady && currentModel && (
        <div className="mb-4 rounded-2xl border border-white/70 dark:border-surface-800 bg-white/70 dark:bg-surface-900/45 px-4 py-3 text-sm text-surface-700 dark:text-surface-200">
          Answering with <span className="font-semibold">{modelLabel}</span>
          {' · '}
          {modelKind === 'online'
            ? 'Online API (good for testing how a large model behaves on this pipeline)'
            : modelKind === 'local'
              ? 'Local offline model'
              : 'Selected model'}
          . Folder search stays on this device.
        </div>
      )}

      {serverRagMode && chatReady && (
        <div className="mb-4 rounded-2xl border border-primary-200/70 dark:border-primary-900 bg-primary-50/85 dark:bg-primary-950/20 px-4 py-3 text-sm text-primary-800 dark:text-primary-200">
          Organization server mode — questions go to your company gateway. Local folder search is skipped.
        </div>
      )}

      {lastSearch && !isGenerating && (
        <div className="mb-4 rounded-2xl border border-white/70 dark:border-surface-800 bg-white/70 dark:bg-surface-900/45 px-4 py-3 text-xs">
          <span className={confidenceBadgeClass(lastSearch.confidence)}>
            {retrievalStatusLabel(lastSearch.confidence, lastSearch.answer_mode)}
          </span>
          {partitionsSearchedLabel(lastSearch.partitions_searched) && (
            <span className="ml-2 text-surface-500">
              Searched: {partitionsSearchedLabel(lastSearch.partitions_searched)}
            </span>
          )}
        </div>
      )}

      <div className="flex-1 overflow-y-auto rounded-2xl border border-white/70 dark:border-surface-800 bg-surface-50/85 dark:bg-surface-950/55 p-4 space-y-4 min-h-[18rem]" aria-live="polite">
        {messages.length === 0 && !conversationLoading && (
          <div className="text-center text-sm text-surface-500 py-10">
            <BookOpenCheck className="w-8 h-8 mx-auto mb-3 text-primary-500" />
            Ask about files in this folder.
          </div>
        )}
        {messages.map(message => {
          const meta = parseMessageMetadata(message.metadata);
          return (
          <div key={message.id} className={`rounded-2xl px-4 py-3 ${message.role === 'user'
            ? 'bg-primary-50/90 dark:bg-primary-950/25 border border-primary-200/70 dark:border-primary-900 ml-8'
            : 'bg-white/85 dark:bg-surface-900/60 border border-white/70 dark:border-surface-800 mr-8'}`}>
            <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-surface-500 mb-1">{message.role === 'user' ? 'You' : 'Answer'}</p>
            {message.role === 'assistant' ? (
              <>
                <KnowledgeMarkdown
                  content={message.content}
                  citationHits={meta?.citationHits || []}
                  question={meta?.question || ''}
                  alreadyFormatted={meta?.formatted === true}
                />
                {typeof meta?.latency_ms === 'number' && meta.latency_ms >= 0 && (
                  <p className="mt-2 text-[10px] text-surface-500 dark:text-surface-400">
                    Answered in {formatLatencyMs(meta.latency_ms)}
                    {typeof meta.retrieval_ms === 'number' && typeof meta.answer_ms === 'number'
                      ? ` (search ${formatLatencyMs(meta.retrieval_ms)} · answer ${formatLatencyMs(meta.answer_ms)})`
                      : ''}
                  </p>
                )}
                {meta?.pipeline_trace && meta.pipeline_trace.stages?.length > 0 && (
                  <details className="mt-2 rounded-xl border border-white/60 dark:border-surface-800 bg-surface-50/70 dark:bg-surface-950/40 px-3 py-2">
                    <summary className="cursor-pointer text-[10px] font-bold uppercase tracking-[0.12em] text-surface-500">
                      Advanced: how this answer was built
                      {meta.pipeline_trace.primary_culprit_stage
                        ? ` · focus: ${meta.pipeline_trace.primary_culprit_stage}`
                        : ''}
                    </summary>
                    {meta.pipeline_trace.diagnosis_summary && (
                      <p className="mt-2 text-[11px] text-surface-600 dark:text-surface-300">
                        {meta.pipeline_trace.diagnosis_summary}
                      </p>
                    )}
                    {!!meta.pipeline_trace.diagnosis_actions?.length && (
                      <ul className="mt-1 list-disc pl-4 text-[11px] text-surface-500">
                        {meta.pipeline_trace.diagnosis_actions.map(action => (
                          <li key={action}>{action}</li>
                        ))}
                      </ul>
                    )}
                    <ul className="mt-2 space-y-2">
                      {meta.pipeline_trace.stages.map(stage => (
                        <li key={stage.id} className="text-[11px] text-surface-700 dark:text-surface-200 border-t border-white/50 dark:border-surface-800 pt-2 first:border-0 first:pt-0">
                          <div>
                            <span className="font-semibold">{stage.id}</span>
                            {' · '}
                            <span>{stageStatusLabel(stage.status)}</span>
                            {typeof stage.duration_ms === 'number' ? ` · ${stage.duration_ms} ms` : ''}
                            {stage.detail ? ` — ${stage.detail}` : ''}
                          </div>
                          {stage.input ? (
                            <pre className="mt-1 whitespace-pre-wrap break-words rounded-lg bg-white/60 dark:bg-surface-900/60 px-2 py-1 text-[10px] text-surface-600 dark:text-surface-300">
                              <span className="font-bold text-surface-500">IN: </span>{truncatePipelineIo(stage.input)}
                            </pre>
                          ) : null}
                          {stage.output ? (
                            <pre className="mt-1 whitespace-pre-wrap break-words rounded-lg bg-white/60 dark:bg-surface-900/60 px-2 py-1 text-[10px] text-surface-600 dark:text-surface-300">
                              <span className="font-bold text-surface-500">OUT: </span>{truncatePipelineIo(stage.output)}
                            </pre>
                          ) : null}
                          {stage.remediation ? (
                            <span className="block text-amber-700 dark:text-amber-300 pl-0.5 mt-1">Fix: {stage.remediation}</span>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
                {meta?.context_sources && meta.context_sources.length > 0 && (
                  <MessageSources
                    summaries={meta.context_sources}
                    compact
                    title="Sources used"
                  />
                )}
              </>
            ) : (
              <div className="text-sm whitespace-pre-wrap leading-6 text-surface-800 dark:text-surface-100">{message.content}</div>
            )}
          </div>
          );
        })}
        <div ref={messagesEndRef} />
      </div>

      {lastHits.length > 0 && isGenerating && (
        <MessageSources hits={lastHits} title="Retrieving sources…" compact />
      )}

      {generationStatus && (
        <p className="mt-3 text-xs text-primary-700 dark:text-primary-300 flex items-center gap-2">
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> {generationStatus}
        </p>
      )}
      {notice && <p className="mt-3 text-xs text-primary-700 dark:text-primary-300">{notice}</p>}
      {error && <p className="mt-3 text-xs text-amber-700 dark:text-amber-300" role="alert">{error}</p>}

      <div className="mt-4 flex flex-col sm:flex-row gap-2">
        <textarea
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={3}
          className="input-field flex-1 resize-none"
          aria-label="Ask about files in this folder"
          placeholder={chatReady ? 'Ask about files in this folder…' : 'Build a ready collection first…'}
          disabled={!chatReady || isGenerating || conversationLoading}
        />
        <div className="flex sm:flex-col gap-2">
          <button type="button" onClick={() => void sendMessage()} disabled={!chatReady || isGenerating || conversationLoading || !input.trim()} className="btn-primary flex items-center justify-center gap-2">
            {isGenerating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            Ask
          </button>
          {isGenerating && (
            <button type="button" onClick={stopGeneration} className="btn-secondary flex items-center justify-center gap-2">
              <StopCircle className="w-4 h-4" /> Stop
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
