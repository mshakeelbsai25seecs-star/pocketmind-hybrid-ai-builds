import { kcCreateCollection, kcGetCollection, kcHybridSearch, kcIndexCollection, kcListCollections, kcScanCollection } from './knowledgeChat/api';
import type { KcCollection, KcRetrievalMode, KcSearchFilters, KcSearchHit, KcSearchResult, KcSearchScope } from './knowledgeChat/types';
import { KC_DEFAULT_EMBEDDING_MODEL } from './knowledgeChat/types';
import {
  buildRetrievedContextBlock,
  filterHitsForContext,
  pickRetrievalMode,
} from './knowledgeChat/prompts';
import type { SocKnowledgeChunk } from './types';
import type { SocRagSearchResult, SocRetrievalMode } from './types';
import type { SocPromptKind, SocWorkspaceInput } from './socPromptTemplates';
import type { SocArtifactReportType } from './socReportTemplates';
import { buildSocRetrievedSnippetContext } from './socKnowledgeIndex';
import { SOC_COMPANY_INTAKE_ROOT } from './socCompanyDataIntake';

export const SOC_DEFAULT_KNOWLEDGE_ROOT = '';
export const SOC_DEFAULT_COLLECTION_NAME = 'Company SOC Data';

const ACTION_PREFERRED_DOC_TYPES: Partial<Record<SocPromptKind, string[]>> = {
  triage: ['markdown', 'document', 'structured'],
  investigation: ['markdown', 'document', 'log', 'tabular'],
  rule: ['structured', 'document'],
  parser: ['structured', 'log', 'document'],
  playbook: ['structured', 'document'],
  connector: ['structured', 'document'],
  knowledge: ['markdown', 'document'],
};

export function buildSocSearchFilters(action: SocPromptKind): KcSearchFilters {
  return {
    preferred_doc_types: ACTION_PREFERRED_DOC_TYPES[action],
    exclude_path_contains: ['node_modules', '.git', 'archive', '/tmp/'],
  };
}

// Map SOC actions to a hard partition scope. SOC knowledge collections are
// document-heavy, so we keep most actions at "both" to avoid missing
// cross-partition evidence and only narrow pure knowledge lookups to docs.
// `preferred_doc_types` still provides finer-grained soft boosting within scope.
const ACTION_SEARCH_SCOPE: Partial<Record<SocPromptKind, KcSearchScope>> = {
  knowledge: 'docs',
  triage: 'all',
  investigation: 'all',
  rule: 'all',
  parser: 'logs_data',
  playbook: 'runbooks',
  connector: 'all',
};

export function searchScopeForAction(action?: SocPromptKind): KcSearchScope {
  return (action && ACTION_SEARCH_SCOPE[action]) || 'all';
}

const ACTION_QUERY_FOCUS: Record<SocPromptKind, string> = {
  triage: 'incident triage severity escalation SLA response approval containment',
  investigation: 'investigation plan timeline enrichment evidence reconstruction',
  rule: 'detection rule correlation FortiSIEM threshold tuning',
  parser: 'parser field mapping log source recognizer FortiSIEM',
  playbook: 'FortiSOAR playbook workflow human approval containment response',
  connector: 'connector integration actions authentication inputs outputs',
  knowledge: 'company policy SOP procedure runbook',
};

const REPORT_QUERY_FOCUS: Record<SocArtifactReportType, string> = {
  triage_report: 'triage verdict severity escalation response approval',
  investigation_plan: 'investigation workflow timeline evidence gaps escalation',
  fortisiem_rule_draft: 'detection rule FortiSIEM correlation false positive',
  fortisiem_parser_draft: 'parser mapping log source field extraction FortiSIEM',
  fortisoar_playbook_draft: 'playbook workflow approval containment FortiSOAR',
  connector_spec: 'connector specification authentication actions integration',
  knowledge_context_summary: 'company policy SOP offline knowledge references',
  validator_report_summary: 'validation engineering checks parser playbook safety',
};

export interface SocGroundedRetrievalOptions {
  collectionId: string;
  query: string;
  embeddingModelPath?: string;
  retrievalMode?: KcRetrievalMode;
  topK?: number;
  charBudget?: number;
  action?: SocPromptKind;
  filters?: KcSearchFilters;
  searchScope?: KcSearchScope;
}

export interface SocGroundedRetrievalResult {
  collection: KcCollection;
  searchResult: KcSearchResult;
  contextHits: KcSearchHit[];
  contextBlock: string;
  socChunks: SocKnowledgeChunk[];
  retrievalModeUsed: KcRetrievalMode;
  notice?: string;
}

function normalizeRootPath(value: string): string {
  return value.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

function compactField(value: string, max = 240): string {
  const cleaned = value.replace(/\s+/g, ' ').trim();
  if (!cleaned) return '';
  return cleaned.length > max ? `${cleaned.slice(0, max)}…` : cleaned;
}

export function buildSocRetrievalQuery(
  action: SocPromptKind,
  input: SocWorkspaceInput,
  reportType?: SocArtifactReportType,
): string {
  const parts = [
    ACTION_QUERY_FOCUS[action],
    reportType ? REPORT_QUERY_FOCUS[reportType] : '',
    compactField(input.alertSummary, 320),
    compactField(input.notes, 180),
    compactField(input.severity, 40),
    compactField(input.asset, 80),
    compactField(input.username, 80),
    compactField(input.sourceIp, 40),
    compactField(input.destinationIp, 40),
  ].filter(Boolean);
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

export function kcHitToSocChunk(hit: KcSearchHit): SocKnowledgeChunk {
  const chunk = hit.chunk;
  return {
    id: `kc::${chunk.id}`,
    resourceId: chunk.file_id,
    resourceTitle: chunk.file_name,
    category: 'Internal SOC SOP',
    product: 'Internal',
    filePath: chunk.file_path,
    index: chunk.chunk_index,
    title: chunk.title || chunk.file_name,
    startChar: chunk.start_char,
    endChar: chunk.end_char,
    text: hit.relevant_snippet?.trim() || chunk.text,
  };
}

export function kcHitsToSocChunks(hits: KcSearchHit[]): SocKnowledgeChunk[] {
  return hits.map(kcHitToSocChunk);
}

export async function findSocKnowledgeCollection(
  rootPath: string,
  preferredId?: string | null,
): Promise<KcCollection | null> {
  const collections = await kcListCollections();
  if (preferredId) {
    const byId = collections.find(item => item.id === preferredId);
    if (byId) return byId;
  }
  const normalizedRoot = normalizeRootPath(rootPath);
  return collections.find(item => normalizeRootPath(item.root_path) === normalizedRoot) || null;
}

export async function ensureSocKnowledgeCollection(
  rootPath: string,
  options?: {
    name?: string;
    preferredId?: string | null;
    embeddingModelPath?: string;
  },
): Promise<KcCollection> {
  const existing = await findSocKnowledgeCollection(rootPath, options?.preferredId);
  if (existing) return existing;

  return kcCreateCollection({
    name: options?.name || SOC_DEFAULT_COLLECTION_NAME,
    root_path: rootPath,
    embedding_model_path: options?.embeddingModelPath || KC_DEFAULT_EMBEDDING_MODEL,
  });
}

export async function indexSocKnowledgeCollection(
  collectionId: string,
  options?: {
    rebuild?: boolean;
    buildDense?: boolean;
    embeddingModelPath?: string;
  },
): Promise<KcCollection> {
  await kcScanCollection(collectionId);
  await kcIndexCollection(collectionId, {
    rebuild: options?.rebuild ?? false,
    build_dense: options?.buildDense ?? true,
    incremental: !(options?.rebuild ?? false),
    embedding_model_path: options?.embeddingModelPath,
  });
  return kcGetCollection(collectionId);
}

export async function retrieveSocGroundedKnowledge(
  options: SocGroundedRetrievalOptions,
): Promise<SocGroundedRetrievalResult> {
  const collection = await kcGetCollection(options.collectionId);
  const query = options.query.trim();
  if (!query) {
    throw new Error('Retrieval query is empty.');
  }
  if (collection.status !== 'ready' || collection.chunk_count <= 0) {
    throw new Error(
      `Company knowledge collection is not ready (${collection.status}, ${collection.chunk_count} chunks). Scan and index the folder first.`,
    );
  }


  const preferredMode = options.retrievalMode || 'hybrid_dense';
  const denseAvailable = collection.dense_status === 'ready' && collection.dense_chunk_count > 0;
  const retrievalModeUsed = pickRetrievalMode(denseAvailable, preferredMode);

  const searchResult = await kcHybridSearch({
    collection_id: collection.id,
    query,
    mode: retrievalModeUsed,
    top_k: options.topK ?? 8,
    filters: options.filters ?? (options.action ? buildSocSearchFilters(options.action) : undefined),
    search_scope: options.searchScope ?? searchScopeForAction(options.action),
  });

  let notice: string | undefined;

  if (searchResult.mode !== retrievalModeUsed && (preferredMode === 'hybrid_dense' || preferredMode === 'dense_vector')) {
    notice = notice || `Retrieval used ${searchResult.mode} for this task.`;
  }

  const contextHits = filterHitsForContext(searchResult.hits, query);
  const contextBlock = buildRetrievedContextBlock(
    contextHits,
    collection.name,
    collection.root_path,
    searchResult,
    options.charBudget,
    query,
  );

  return {
    collection,
    searchResult,
    contextHits,
    contextBlock,
    socChunks: kcHitsToSocChunks(contextHits),
    retrievalModeUsed: searchResult.mode,
    notice,
  };
}

export function buildSocAutoKnowledgeContextBlock(
  retrieval: SocGroundedRetrievalResult | null,
  fallbackNotice?: string,
): string {
  if (!retrieval) {
    return fallbackNotice
      ? `AUTO-RETRIEVED COMPANY KNOWLEDGE:\n${fallbackNotice}`
      : '';
  }

  const header = [
    'AUTO-RETRIEVED COMPANY KNOWLEDGE (Knowledge Chat index):',
    `Collection: ${retrieval.collection.name}`,
    `Root path: ${retrieval.collection.root_path}`,
    `Retrieval mode: ${retrieval.retrievalModeUsed}`,
    `Confidence: ${retrieval.searchResult.confidence} (${retrieval.searchResult.confidence_score.toFixed(2)})`,
    `Evidence mode: ${retrieval.searchResult.answer_mode}`,
    retrieval.notice ? `Note: ${retrieval.notice}` : '',
  ].filter(Boolean).join('\n');

  return [header, '', retrieval.contextBlock].join('\n');
}

export function mergeSocKnowledgeChunks(
  autoChunks: SocKnowledgeChunk[],
  manualChunks: SocKnowledgeChunk[],
): SocKnowledgeChunk[] {
  const seen = new Set<string>();
  const merged: SocKnowledgeChunk[] = [];
  for (const chunk of [...autoChunks, ...manualChunks]) {
    const key = `${chunk.filePath}::${chunk.index}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(chunk);
  }
  return merged.slice(0, 10);
}

export function buildManualKnowledgeSnippetBlock(chunks: SocKnowledgeChunk[]): string {
  if (!chunks.length) return '';
  return [
    'MANUALLY SELECTED RETRIEVAL SNIPPETS:',
    buildSocRetrievedSnippetContext(chunks),
  ].join('\n');
}

export function defaultSocKnowledgeRoot(): string {
  return SOC_DEFAULT_KNOWLEDGE_ROOT;
}

export function kcHitToSocRagSearchResult(hit: KcSearchHit, mode: KcRetrievalMode): SocRagSearchResult {
  const socMode: SocRetrievalMode = mode === 'hybrid_dense'
    ? 'hybrid_dense'
    : mode === 'dense_vector'
      ? 'dense_vector'
      : mode === 'keyword'
        ? 'keyword'
        : 'hybrid_lexical';
  return {
    chunk: kcHitToSocChunk(hit),
    retrievalMode: socMode,
    keywordScore: hit.keyword_score,
    similarityScore: hit.lexical_score,
    denseSimilarityScore: hit.dense_score,
    combinedScore: hit.fused_score,
  };
}

export function kcHitsToSocRagResults(hits: KcSearchHit[], mode: KcRetrievalMode): SocRagSearchResult[] {
  return hits.map(hit => kcHitToSocRagSearchResult(hit, mode));
}

export function defaultCompanyIntakeRoot(): string {
  return SOC_COMPANY_INTAKE_ROOT;
}
