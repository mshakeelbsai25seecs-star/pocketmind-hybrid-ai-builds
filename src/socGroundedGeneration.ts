import { invoke } from '@tauri-apps/api/tauri';
import { listen } from '@tauri-apps/api/event';
import type { GenerationParams } from './types';
import type { KcCollection, KcRetrievalMode, KcSearchHit, KcSearchResult } from './knowledgeChat/types';
import {
  buildGroundedUserPrompt,
  buildRetrievedContextBlock,
  estimateKnowledgeContextCharBudget,
  KC_NOT_FOUND_MESSAGE,
  shouldSkipGeneration,
} from './knowledgeChat/prompts';
import { SOC_GENERATION_PARAMS, SOC_SYSTEM_PROMPT } from './socChatHandoff';
import {
  buildSocAutoKnowledgeContextBlock,
  buildSocRetrievalQuery,
  retrieveSocGroundedKnowledge,
  type SocGroundedRetrievalResult,
} from './socKnowledgeRetrieval';
import type { SocPromptKind, SocWorkspaceInput } from './socPromptTemplates';
import type { SocArtifactReportType } from './socReportTemplates';
import { buildSocGroundedReportUserPrompt, buildSocGroundedReportSystemPrompt } from './socReportTemplates';
import { useAppStore } from './store';
import { SOC_LOW_CONFIDENCE_BLOCKED_MESSAGE } from './productConfig';

type GenerationResponsePayload = {
  text?: string;
  finish_reason?: string;
};

export interface SocGroundedGenerationInput {
  collectionId: string;
  action: SocPromptKind;
  workspaceInput: SocWorkspaceInput;
  taskPrompt: string;
  embeddingModelPath: string;
  retrievalMode?: KcRetrievalMode;
  topK?: number;
  currentModel: string;
  defaultParams: GenerationParams;
  reportType?: SocArtifactReportType;
  onStatus?: (message: string | null) => void;
  onChunk?: (text: string) => void;
}

export interface SocGroundedGenerationResult {
  answer: string;
  retrieval: SocGroundedRetrievalResult;
  skippedGeneration: boolean;
}

export interface SocGroundedReportGenerationInput {
  collectionId: string;
  workspaceInput: SocWorkspaceInput;
  reportType: SocArtifactReportType;
  reportTitle: string;
  templateMarkdown: string;
  embeddingModelPath: string;
  retrievalMode?: KcRetrievalMode;
  topK?: number;
  currentModel: string;
  defaultParams: GenerationParams;
  onStatus?: (message: string | null) => void;
  onChunk?: (text: string) => void;
}

function productionBlocksGroundedGeneration(
  searchResult: KcSearchResult,
  query: string,
  hits?: KcSearchHit[],
): boolean {
  const product = useAppStore.getState().productConfig;
  if (!product?.block_low_confidence_generation) return false;
  if (shouldSkipGeneration(searchResult, query, hits)) return true;
  if (searchResult.confidence === 'low' && searchResult.confidence_score < product.min_confidence_score) {
    return true;
  }
  return false;
}

function mergeParams(base: GenerationParams): GenerationParams {
  return { ...base, ...SOC_GENERATION_PARAMS };
}

function modelBackend(modelPath: string): 'llama.cpp' | 'enterprise' | 'remote' {
  if (modelPath.startsWith('enterprise:')) return 'enterprise';
  if (modelPath.startsWith('remote:')) return 'remote';
  return 'llama.cpp';
}

async function streamGenerate(
  prompt: string,
  systemPrompt: string,
  modelPath: string,
  params: GenerationParams,
  onChunk?: (text: string) => void,
  onStatus?: (message: string | null) => void,
): Promise<string> {
  let streamingText = '';
  const unlistenChunk = await listen<GenerationResponsePayload>('generation-chunk', (event) => {
    const chunkText = event.payload?.text || '';
    if (!chunkText) return;
    streamingText = event.payload?.finish_reason ? chunkText : `${streamingText}${chunkText}`;
    onChunk?.(streamingText);
  });
  const unlistenStatus = await listen<{ message?: string }>('generation-status', (event) => {
    const message = event.payload?.message;
    if (typeof message === 'string' && message.trim()) onStatus?.(message);
  });

  try {
    await invoke('stream_generate', {
      request: {
        prompt,
        messages: [],
        system_prompt: systemPrompt,
        params,
        model_path: modelPath,
        backend: modelBackend(modelPath),
      },
    });
  } finally {
    unlistenChunk();
    unlistenStatus();
  }

  return streamingText.trim();
}

function socGroundedSystemPrompt(action: SocPromptKind): string {
  return [
    SOC_SYSTEM_PROMPT,
    'Use RETRIEVED SOURCES from the company knowledge index when they are present in the user message.',
    'Cite source file names and sections when company policy or SOP evidence supports your answer.',
    'If retrieved sources do not contain relevant evidence, say so explicitly and continue with incident-only reasoning.',
    action === 'triage'
      ? 'For triage, align severity and escalation guidance with company SOP snippets when available.'
      : '',
  ].filter(Boolean).join('\n');
}

export async function retrieveForSocTask(
  collectionId: string,
  action: SocPromptKind,
  workspaceInput: SocWorkspaceInput,
  options: {
    embeddingModelPath: string;
    retrievalMode?: KcRetrievalMode;
    topK?: number;
    reportType?: SocArtifactReportType;
    defaultParams: GenerationParams;
  },
): Promise<SocGroundedRetrievalResult> {
  const query = buildSocRetrievalQuery(action, workspaceInput, options.reportType);
  const params = mergeParams(options.defaultParams);
  const charBudget = estimateKnowledgeContextCharBudget(
    params.context_size,
    params.max_tokens,
    socGroundedSystemPrompt(action),
    query,
  );
  return retrieveSocGroundedKnowledge({
    collectionId,
    query,
    embeddingModelPath: options.embeddingModelPath,
    retrievalMode: options.retrievalMode,
    topK: options.topK,
    charBudget,
    action,
  });
}

export async function generateSocGroundedAnswer(
  input: SocGroundedGenerationInput,
): Promise<SocGroundedGenerationResult> {
  input.onStatus?.('Retrieving company knowledge…');
  const retrieval = await retrieveForSocTask(input.collectionId, input.action, input.workspaceInput, {
    embeddingModelPath: input.embeddingModelPath,
    retrievalMode: input.retrievalMode,
    topK: input.topK,
    reportType: input.reportType,
    defaultParams: input.defaultParams,
  });

  const query = buildSocRetrievalQuery(input.action, input.workspaceInput, input.reportType);
  if (productionBlocksGroundedGeneration(retrieval.searchResult, query, retrieval.contextHits)) {
    input.onStatus?.('Waiting: not enough matching documents in your index.');
    return { answer: SOC_LOW_CONFIDENCE_BLOCKED_MESSAGE, retrieval, skippedGeneration: true };
  }
  if (shouldSkipGeneration(retrieval.searchResult, query, retrieval.contextHits)) {
    const fallback = [
      input.taskPrompt,
      '',
      buildSocAutoKnowledgeContextBlock(retrieval),
      '',
      'Note: Indexed company folder did not return strong evidence for this task. Answer from incident context only and list evidence gaps.',
    ].join('\n');
    input.onStatus?.('Generating answer from incident context (limited folder evidence)…');
    const answer = await streamGenerate(
      fallback,
      socGroundedSystemPrompt(input.action),
      input.currentModel,
      mergeParams(input.defaultParams),
      input.onChunk,
      input.onStatus,
    );
    return { answer, retrieval, skippedGeneration: true };
  }

  const groundedPrompt = buildGroundedUserPrompt(
    input.taskPrompt,
    retrieval.contextBlock,
  );

  input.onStatus?.('Generating grounded SOC answer…');
  const answer = await streamGenerate(
    groundedPrompt,
    socGroundedSystemPrompt(input.action),
    input.currentModel,
    mergeParams(input.defaultParams),
    input.onChunk,
    input.onStatus,
  );

  return { answer, retrieval, skippedGeneration: false };
}

export async function generateSocGroundedReport(
  input: SocGroundedReportGenerationInput,
): Promise<SocGroundedGenerationResult> {
  input.onStatus?.('Retrieving company knowledge for report…');
  const retrieval = await retrieveForSocTask(input.collectionId, 'knowledge', input.workspaceInput, {
    embeddingModelPath: input.embeddingModelPath,
    retrievalMode: input.retrievalMode,
    topK: input.topK,
    reportType: input.reportType,
    defaultParams: input.defaultParams,
  });

  const query = buildSocRetrievalQuery('knowledge', input.workspaceInput, input.reportType);
  if (productionBlocksGroundedGeneration(retrieval.searchResult, query, retrieval.contextHits)) {
    input.onStatus?.('Waiting: not enough matching documents in your index.');
    return { answer: SOC_LOW_CONFIDENCE_BLOCKED_MESSAGE, retrieval, skippedGeneration: true };
  }

  const systemPrompt = buildSocGroundedReportSystemPrompt(input.reportType);
  const params = mergeParams(input.defaultParams);

  if (shouldSkipGeneration(retrieval.searchResult, query, retrieval.contextHits)) {
    const prompt = [
      buildSocGroundedReportUserPrompt({
        reportTitle: input.reportTitle,
        reportType: input.reportType,
        templateMarkdown: input.templateMarkdown,
        workspaceInput: input.workspaceInput,
        contextBlock: buildSocAutoKnowledgeContextBlock(
          retrieval,
          'No strong indexed evidence was retrieved. Produce a cautious draft from incident context and clearly mark assumptions.',
        ),
      }),
    ].join('\n');
    input.onStatus?.('Generating report draft (limited folder evidence)…');
    const answer = await streamGenerate(prompt, systemPrompt, input.currentModel, params, input.onChunk, input.onStatus);
    return { answer, retrieval, skippedGeneration: true };
  }

  const prompt = buildSocGroundedReportUserPrompt({
    reportTitle: input.reportTitle,
    reportType: input.reportType,
    templateMarkdown: input.templateMarkdown,
    workspaceInput: input.workspaceInput,
    contextBlock: retrieval.contextBlock,
  });

  input.onStatus?.('Generating grounded SOC report…');
  const answer = await streamGenerate(prompt, systemPrompt, input.currentModel, params, input.onChunk, input.onStatus);
  return { answer, retrieval, skippedGeneration: false };
}

export function formatSocRetrievalSummary(
  collection: KcCollection,
  searchResult: KcSearchResult,
  hits: KcSearchHit[],
): string {
  if (!hits.length) return KC_NOT_FOUND_MESSAGE;
  return buildRetrievedContextBlock(hits, collection.name, collection.root_path, searchResult);
}
