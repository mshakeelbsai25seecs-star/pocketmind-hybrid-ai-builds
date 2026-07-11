import { useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/tauri';
import { listen } from '@tauri-apps/api/event';
import { BookOpenCheck, Loader2, Send, StopCircle } from 'lucide-react';
import { useAppStore } from '../../store';
import { GenerationParams, Message } from '../../types';
import {
  kcHybridSearch,
  kcPrepareSearchQuery,
  kcBuildFileCatalog,
  kcLoadSelectedFiles,
  humanError,
} from '../../knowledgeChat/api';
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
} from '../../knowledgeChat/prompts';
import { buildCodebaseExplorerContext } from '../../knowledgeChat/codebaseExplorer';
import {
  buildBundledGroundedPrompt,
  buildBundledLlmContext,
  buildDemoGroundedPrompt,
  bundleHitsForLlm,
} from '../../knowledgeChat/contextBundler';
import {
  boostSelectedPathsFromQuery,
  buildFileSelectionPrompt,
  KC_FILE_SELECT_SYSTEM_PROMPT,
  mergeSelectedPaths,
  parseSelectedFilePaths,
  pathsFromRetrievalHits,
  pinPathsFromDemoSearch,
  shouldSkipCatalogFilePick,
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
import { groundingCheck, isNotFoundAnswer, isSubstantiveDraft } from '../../knowledgeChat/groundingCheck';
import {
  resolveBestExtractiveAnswer,
  shouldPreferExtractiveOverLlm,
  shouldSkipLlmForExtractive,
} from '../../knowledgeChat/extractivePrefer';
import { runtimeLimitsForConfig } from '../../knowledgeChat/deploymentProfile';
import { expandVagueQueryWithLlm } from '../../knowledgeChat/queryRewrite';
import { useKnowledgeChatStore } from '../../knowledgeChat/store';
import { SOC_LOW_CONFIDENCE_BLOCKED_MESSAGE, saveProductConfig, type KcKnowledgeChatMode } from '../../productConfig';
import MessageSources, { type SourceSummary } from './MessageSources';
import type { KcAnswerMode, KcRetrievalConfidence, KcSearchHit, KcSearchResult, KcSearchScope } from '../../knowledgeChat/types';
import { KC_RETRIEVAL_MODE_LABELS } from '../../knowledgeChat/types';

const KC_SEARCH_SCOPE_OPTIONS: KcSearchScope[] = [
  'all', 'code', 'documentation', 'runbooks', 'logs_data', 'general', 'docs', 'both',
];

const KC_SEARCH_SCOPE_LABELS: Record<KcSearchScope, string> = {
  all: 'All partitions',
  code: 'Code only',
  documentation: 'Documentation only',
  runbooks: 'Runbooks only',
  logs_data: 'Logs & data only',
  general: 'General documents only',
  docs: 'All documents (legacy)',
  both: 'All partitions (legacy)',
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
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const generationRef = useRef(0);

  const { currentModel, defaultParams, productConfig, setProductConfig } = useAppStore();
  const {
    collections,
    activeCollectionId,
    embeddingModelPath,
    retrievalMode,
    searchScope,
    topK,
    setRetrievalMode,
    setSearchScope,
    setTopK,
  } = useKnowledgeChatStore();

  const activeCollection = useMemo(
    () => collections.find(item => item.id === activeCollectionId) || null,
    [collections, activeCollectionId],
  );

  const chatReady = Boolean(activeCollection?.status === 'ready' && currentModel);
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
      if (!chatReady) {
        setConversationId(null);
        return;
      }
      setConversationLoading(true);
      setLastHits([]);
      setLastSearch(null);
      setError(null);
      try {
        const id = await invoke<string>('create_conversation', {
          title: `Knowledge Chat: ${activeCollection?.name || 'Collection'}`,
          characterId: null,
          modelId: currentModel,
          mode: 'knowledge',
        });
        if (cancelled) return;
        setConversationId(id);
        setMessages([]);
      } catch (err) {
        if (!cancelled) setError(humanError(err));
      } finally {
        if (!cancelled) setConversationLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [activeCollection?.id, activeCollection?.name, chatReady, currentModel]);

  const stopGeneration = async () => {
    generationRef.current += 1;
    try {
      await invoke('stop_generation');
    } finally {
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

    try {
      await invoke('stream_generate', {
        request: {
          prompt,
          messages: [],
          system_prompt: systemPrompt,
          params: generationParams,
          model_path: currentModel,
          backend: currentModel!.startsWith('enterprise:')
            ? 'enterprise'
            : currentModel!.startsWith('remote:')
              ? 'remote'
              : 'llama.cpp',
        },
      });
    } finally {
      unlistenChunk();
      unlistenStatus();
    }

    return streamingText.trim();
  };

  const sendMessage = async () => {
    const question = input.trim();
    if (!question || !conversationId || !currentModel || !activeCollection || !chatReady || isGenerating) return;

    const generationId = ++generationRef.current;
    const activeConversationId = conversationId;
    const isStale = () => generationRef.current !== generationId || activeConversationId !== conversationId;

    setError(null);
    setNotice(null);
    setInput('');
    setLastHits([]);
    setLastSearch(null);
    setIsGenerating(true);
    setGenerationStatus('Retrieving relevant indexed snippets...');
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
      content: 'Searching indexed folder...',
      metadata: null,
    });
    setMessages(prev => [...prev, createLocalMessage(assistantMsgId, conversationId, 'assistant', 'Searching indexed folder...')]);

    try {
      const rewrite = await kcPrepareSearchQuery(question);
      let searchQuery = question;
      if (productConfig?.enable_llm_query_expand && rewrite.vague && currentModel) {
        searchQuery = await expandVagueQueryWithLlm(question, rewrite, currentModel, defaultParams);
        if (searchQuery !== rewrite.retrieval_query) {
          setNotice('LLM expanded vague query for retrieval.');
        }
      } else if (rewrite.vague && rewrite.expansions.length > 0) {
        setNotice(`Expanded shorthand query for retrieval (${rewrite.expansions.slice(0, 3).join(', ')}).`);
      }

      const denseAvailable = activeCollection.dense_status === 'ready' && activeCollection.dense_chunk_count > 0;
      const mode = pickRetrievalMode(denseAvailable, retrievalMode);

      let searchResult = await kcHybridSearch({
        collection_id: activeCollection.id,
        query: searchQuery,
        mode,
        top_k: topK,
        search_scope: searchScope,
      });
      if (isStale()) return;

      const appendSearchNotices = (result: KcSearchResult) => {
        if (result.dense_pair_rerank_used) {
          setNotice(prev => prev || 'Applied local dense pair reranking to top candidates.');
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
        setNotice(`Retrieval used ${KC_RETRIEVAL_MODE_LABELS[searchResult.mode] || searchResult.mode} for this answer.`);
      }

      let contextHits = filterHitsForContext(searchResult.hits, question);
      let bundledHits = bundleHitsForLlm(contextHits);
      let citationHitsForAnswer = buildCitationHits(bundledHits.length ? bundledHits : contextHits);
      setLastHits(contextHits);
      setLastSearch(searchResult);

      let grounded = searchResult.grounded_context;
      const evidenceMode = productConfig?.knowledge_chat_evidence_mode ?? 'concise';
      let answerRoute = resolveAnswerRoute(searchResult, question, contextHits, productConfig);
      let extractivePreview = resolveBestExtractiveAnswer(
        question,
        contextHits,
        searchResult.symbol_entities,
        searchResult.grounded_context?.sources,
      );
      let structuredAnswer = resolveStructuredAnswer(searchResult);
      let correctiveRetrievalUsed = false;

      const applySearchState = (next: KcSearchResult) => {
        searchResult = next;
        contextHits = filterHitsForContext(next.hits, question);
        bundledHits = bundleHitsForLlm(contextHits);
        citationHitsForAnswer = buildCitationHits(bundledHits.length ? bundledHits : contextHits);
        setLastHits(contextHits);
        setLastSearch(next);
        grounded = next.grounded_context;
        answerRoute = resolveAnswerRoute(next, question, contextHits, productConfig);
        extractivePreview = resolveBestExtractiveAnswer(
          question,
          contextHits,
          next.symbol_entities,
          next.grounded_context?.sources,
        );
        structuredAnswer = resolveStructuredAnswer(next);
      };

      /** Cap at one extra retrieval. Skip when extractive/structured already won. */
      const runCorrectiveRetrieval = async (): Promise<boolean> => {
        if (correctiveRetrievalUsed) return false;
        if (shouldSkipCorrectiveRetrieval(!!structuredAnswer, !!extractivePreview)) return false;
        correctiveRetrievalUsed = true;
        setNotice(prev => {
          return prev?.includes('Corrective retrieval')
            ? prev
            : prev
              ? `${prev} ${CORRECTIVE_RETRIEVAL_NOTICE}`
              : CORRECTIVE_RETRIEVAL_NOTICE;
        });
        setGenerationStatus('Corrective retrieval: tightening query...');
        const tightened = tightenSearchQuery(question, rewrite);
        const second = await kcHybridSearch({
          collection_id: activeCollection.id,
          query: tightened,
          mode,
          top_k: topK,
          search_scope: searchScope,
        });
        if (isStale()) return true;
        appendSearchNotices(second);
        if (shouldPreferCorrectiveResult(second, searchResult)) {
          applySearchState(second);
        } else {
          // Still adopt second-pass extractive/evidence if the first pass had none.
          const secondHits = filterHitsForContext(second.hits, question);
          const secondExtractive = resolveBestExtractiveAnswer(
            question,
            secondHits,
            second.symbol_entities,
            second.grounded_context?.sources,
          );
          if (secondExtractive || resolveStructuredAnswer(second)) {
            applySearchState(second);
          }
        }
        return true;
      };

      // CRAG-lite: one corrective re-search when confidence is low/none (not when extractive wins).
      if (
        !shouldSkipCorrectiveRetrieval(!!structuredAnswer, !!extractivePreview)
        && needsCorrectiveRetrieval(searchResult)
      ) {
        await runCorrectiveRetrieval();
        if (isStale()) return;
      }

      const formatAnswer = (text: string, skipQualityGate = false, demoMode = false) => formatKnowledgeAnswer(
        text,
        citationHitsForAnswer,
        {
          question,
          notFoundFallback: KC_NOT_FOUND_MESSAGE,
          skipQualityGate,
          demoMode,
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

      const publishAnswer = async (text: string, hitsForMeta: KcSearchHit[] = contextHits, citations = citationHitsForAnswer) => {
        const metadata = buildAssistantMetadata(
          searchResult,
          hitsForMeta,
          citations,
          question,
          true,
          snapshotTiming(),
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
        // Accuracy-first: never ask Phi-3 to paraphrase a known symbol body.
        if (shouldSkipLlmForExtractive(question, extractivePreview)) {
          return { text: formatAnswer(extractivePreview!, true) };
        }
        if (!shouldUseLlmSynthesis(searchResult, contextHits, productConfig, question)) {
          const fallback = resolveAnswerFallback(searchResult, question, contextHits);
          if (fallback) return { text: formatAnswer(fallback, true) };
        }

        const demoActive = searchResult.demo_cheatsheet_active === true;
        const demoPinnedPaths = pinPathsFromDemoSearch(searchResult.demo_pinned_paths);
        const systemPrompt = systemPromptForQuestion(question, searchResult.answer_mode, demoActive);

        const retrievalPool = bundledHits.length ? bundledHits : contextHits;
        let contextBlock = '';
        let attachedSources = grounded?.sources ?? [];

        const searchContextReady = !!grounded?.context_block?.trim()
          && (grounded.sources?.length ?? 0) > 0
          && !/ATTACHED SOURCE FILES:\s*none/i.test(grounded.context_block);

        if (searchContextReady) {
          contextBlock = grounded!.context_block;
          attachedSources = grounded!.sources;
          setGenerationStatus(demoActive
            ? 'Using cheatsheet-guided evidence from search...'
            : 'Using indexed evidence from search...');
        } else {
          setGenerationStatus('Reading indexed folder catalog...');
          const catalog = await kcBuildFileCatalog(activeCollection.id);
          if (isStale()) return { text: '' };

          let selectedPaths = mergeSelectedPaths(
            demoPinnedPaths,
            pathsFromRetrievalHits(retrievalPool, catalog),
            boostSelectedPathsFromQuery(question, catalog, retrievalPool),
          );

          if (!selectedPaths.length && !shouldSkipCatalogFilePick(demoPinnedPaths)) {
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
        const extractiveFromAttached = resolveBestExtractiveAnswer(
          question,
          contextHits,
          searchResult.symbol_entities,
          attachedSources,
        );
        if (shouldSkipLlmForExtractive(question, extractiveFromAttached)) {
          extractivePreview = extractiveFromAttached;
          return { text: formatAnswer(extractiveFromAttached!, true) };
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
        if (isStale()) return { text: '' };

        const groundedPrompt = demoActive && searchResult.demo_cheatsheet_block?.trim()
          ? buildDemoGroundedPrompt(question, searchResult.demo_cheatsheet_block, contextBlock)
          : buildBundledGroundedPrompt(question, contextBlock);

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

        let finalText = formatAnswer(draftAnswer || KC_NOT_FOUND_MESSAGE, true, demoActive);
        const groundedOk = groundingCheck(finalText, contextHits, question, 0.35, attachedSources);
        const bestExtractive = extractiveFromAttached
          || extractivePreview
          || resolveBestExtractiveAnswer(
            question,
            contextHits,
            searchResult.symbol_entities,
            attachedSources,
          );

        if (shouldPreferExtractiveOverLlm(question, bestExtractive, finalText, groundedOk)) {
          finalText = formatAnswer(bestExtractive!, true);
        } else if (isNotFoundAnswer(finalText) || !groundedOk) {
          // Post-gen CRAG-lite: one corrective re-search if not already used; prefer extractive/evidence.
          // Never keep an ungrounded LLM draft — that is the main hallucination path on small models.
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
      if (isStale() || !result || !result.text.trim()) return;
      await publishAnswer(
        result.text,
        result.hitsForMeta ?? contextHits,
        result.withCitations === false ? [] : citationHitsForAnswer,
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
          <h2 className="text-xl font-black text-surface-950 dark:text-white">Ask Your Indexed Folder</h2>
        </div>
        <div className="flex flex-col sm:flex-row gap-2">
          <label className="sr-only" htmlFor="kc-mode">Knowledge Chat mode</label>
          <select
            id="kc-mode"
            value={knowledgeChatMode}
            onChange={e => void setKnowledgeChatMode(e.target.value as KcKnowledgeChatMode)}
            className="input-field text-sm"
            aria-label="Knowledge Chat mode"
            title="Folder Q&A uses cheatsheet-guided retrieval; Codebase Explorer adds a repo map and symbol-first code retrieval."
          >
            <option value="folder_qa">Folder Q&amp;A</option>
            <option value="codebase_explorer">Codebase Explorer</option>
          </select>
          <label className="sr-only" htmlFor="kc-search-scope">Search scope</label>
          <select id="kc-search-scope" value={searchScope} onChange={e => setSearchScope(e.target.value as KcSearchScope)} className="input-field text-sm" aria-label="Search scope">
            {KC_SEARCH_SCOPE_OPTIONS.map(value => (
              <option key={value} value={value}>{KC_SEARCH_SCOPE_LABELS[value]}</option>
            ))}
          </select>
          <label className="sr-only" htmlFor="kc-retrieval-mode">Retrieval mode</label>
          <select id="kc-retrieval-mode" value={retrievalMode} onChange={e => setRetrievalMode(e.target.value as typeof retrievalMode)} className="input-field text-sm" aria-label="Retrieval mode">
            {Object.entries(KC_RETRIEVAL_MODE_LABELS).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
          <label className="sr-only" htmlFor="kc-top-k">Number of sources</label>
          <select id="kc-top-k" value={topK} onChange={e => setTopK(Number(e.target.value))} className="input-field text-sm" aria-label="Number of sources">
            {[6, 8, 10, 12].map(value => <option key={value} value={value}>Top {value} sources</option>)}
          </select>
        </div>
      </div>

      {conversationLoading && (
        <div className="mb-4 rounded-2xl border border-sky-200/70 dark:border-sky-900 bg-sky-50/85 dark:bg-sky-950/20 px-4 py-3 text-sm text-sky-800 dark:text-sky-200 flex items-center gap-2">
          <Loader2 className="w-4 h-4 animate-spin" /> Starting chat session…
        </div>
      )}

      {!chatReady && (
        <div className="rounded-2xl border border-amber-200/70 dark:border-amber-900 bg-amber-50/85 dark:bg-amber-950/20 px-4 py-3 text-sm text-amber-800 dark:text-amber-200 mb-4">
          Select a ready collection and a local model before chatting. Build the index in the panel above first.
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
            <BookOpenCheck className="w-8 h-8 mx-auto mb-3 text-sky-500" />
            Ask anything about the indexed folder.
          </div>
        )}
        {messages.map(message => {
          const meta = parseMessageMetadata(message.metadata);
          return (
          <div key={message.id} className={`rounded-2xl px-4 py-3 ${message.role === 'user'
            ? 'bg-sky-50/90 dark:bg-sky-950/25 border border-sky-200/70 dark:border-sky-900 ml-8'
            : 'bg-white/85 dark:bg-surface-900/60 border border-white/70 dark:border-surface-800 mr-8'}`}>
            <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-surface-500 mb-1">{message.role === 'user' ? 'You' : 'Answer'}</p>
            {message.role === 'assistant' ? (
              <>
                <KnowledgeMarkdown
                  content={message.content}
                  citationHits={meta?.citationHits || []}
                  question={meta?.question || ''}
                />
                {typeof meta?.latency_ms === 'number' && meta.latency_ms >= 0 && (
                  <p className="mt-2 text-[10px] text-surface-500 dark:text-surface-400">
                    Answered in {formatLatencyMs(meta.latency_ms)}
                    {typeof meta.retrieval_ms === 'number' && typeof meta.answer_ms === 'number'
                      ? ` (retrieve ${formatLatencyMs(meta.retrieval_ms)} · answer ${formatLatencyMs(meta.answer_ms)})`
                      : ''}
                  </p>
                )}
                {meta?.context_sources && meta.context_sources.length > 0 && (
                  <MessageSources
                    summaries={meta.context_sources}
                    confidence={meta.confidence}
                    answerMode={meta.answer_mode}
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
        <p className="mt-3 text-xs text-sky-700 dark:text-sky-300 flex items-center gap-2">
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> {generationStatus}
        </p>
      )}
      {notice && <p className="mt-3 text-xs text-sky-700 dark:text-sky-300">{notice}</p>}
      {error && <p className="mt-3 text-xs text-amber-700 dark:text-amber-300" role="alert">{error}</p>}

      <div className="mt-4 flex flex-col sm:flex-row gap-2">
        <textarea
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={3}
          className="input-field flex-1 resize-none"
          aria-label="Ask about indexed folder"
          placeholder={chatReady ? 'Ask a question about the indexed folder...' : 'Build a ready collection first...'}
          disabled={!chatReady || isGenerating || conversationLoading}
        />
        <div className="flex sm:flex-col gap-2">
          <button type="button" onClick={sendMessage} disabled={!chatReady || isGenerating || conversationLoading || !input.trim()} className="btn-primary flex items-center justify-center gap-2">
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
