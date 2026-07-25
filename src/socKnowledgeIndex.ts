import type {
  AttachmentContext,
  SocKnowledgeChunk,
  SocDenseEmbeddingSettings,
  SocKnowledgeResource,
  SocRagHealthStats,
  SocRagSearchResult,
  SocRetrievalMode,
} from './types';

export const SOC_INDEXABLE_EXTENSIONS = ['txt', 'log', 'md', 'markdown', 'csv', 'json', 'xml', 'yaml', 'yml', 'html', 'htm', 'pdf'];
export const SOC_MAX_INDEX_CHARS_PER_FILE = 60000;
export const SOC_MAX_INDEX_CHUNKS_PER_RESOURCE = 36;
export const SOC_MAX_SNIPPET_CHARS_PER_PROMPT = 1400;
export const SOC_MAX_SNIPPETS_IN_PROMPT = 10;
export const SOC_RAG_VECTOR_DIMENSIONS = 96;
export const SOC_RAG_EMBEDDING_KIND = 'lexical_hash_v1';
export const SOC_DENSE_EMBEDDING_INTERFACE_VERSION = 'dense_provider_interface_v1';

export const SOC_RAG_RETRIEVAL_MODE_LABELS: Record<SocRetrievalMode, string> = {
  keyword: 'Keyword',
  hybrid_lexical: 'Hybrid lexical RAG',
  dense_vector: 'Dense vector RAG',
  hybrid_dense: 'Hybrid dense RAG',
};

export const SOC_DEFAULT_EMBEDDING_MODEL_PATH = '';
export const SOC_DENSE_INDEX_PATH = '';
export const SOC_DENSE_EMBED_CONTEXT_SIZE = 2048;
export const SOC_DENSE_EMBED_BATCH_SIZE = 512;

export const SOC_DEFAULT_DENSE_EMBEDDING_SETTINGS: SocDenseEmbeddingSettings = {
  providerMode: 'local_dense',
  modelPath: SOC_DEFAULT_EMBEDDING_MODEL_PATH,
  providerName: 'Local llama.cpp embeddings (nomic-embed-text-v1.5)',
  status: 'not_configured',
  vectorizedChunkCount: 0,
  failedChunkCount: 0,
};

export const SOC_DENSE_PROVIDER_MODE_LABELS: Record<SocDenseEmbeddingSettings['providerMode'], string> = {
  disabled: 'Disabled',
  hybrid_lexical_only: 'Hybrid lexical only',
  local_dense: 'Local dense embeddings',
};

export const SOC_DENSE_PROVIDER_STATUS_LABELS: Record<SocDenseEmbeddingSettings['status'], string> = {
  not_configured: 'Not configured',
  ready: 'Ready',
  indexing: 'Indexing',
  failed: 'Failed',
};

const SOC_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'when', 'then', 'than', 'are', 'was', 'were', 'will', 'would', 'should',
  'can', 'could', 'has', 'have', 'had', 'not', 'you', 'your', 'our', 'their', 'there', 'here', 'about', 'after', 'before', 'within',
  'using', 'used', 'use', 'guide', 'page', 'section', 'table', 'content', 'html', 'http', 'https', 'com', 'www',
]);

export function normalizeSocPath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (typeof navigator !== 'undefined' && !/win/i.test(navigator.platform || '')) {
    return trimmed.replace(/\\/g, '/');
  }
  return trimmed.replace(/\//g, '\\');
}

/**
 * @deprecated Use `isPathUnderDeploymentRoots` from `deploymentConfig.ts`.
 * Compatibility shim — always returns true for non-empty paths.
 */
export function isDDriveSocPath(value: string): boolean {
  return value.trim().length > 0;
}

export function socFileExtension(value: string): string {
  const normalized = normalizeSocPath(value).split(/[\\/]/).pop() || '';
  const parts = normalized.split('.');
  return parts.length > 1 ? (parts.pop() || '').toLowerCase() : '';
}

export function isSocIndexableTextPath(value: string): boolean {
  return SOC_INDEXABLE_EXTENSIONS.includes(socFileExtension(value));
}

export function compactSocNumber(value?: number): string {
  if (!value || value <= 0) return '0';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 100) / 10}k`;
  return String(value);
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#x2F;/gi, '/');
}

export function cleanSocTextForIndexing(text: string): string {
  return decodeHtmlEntities(text || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<head[\s\S]*?<\/head>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<header[\s\S]*?<\/header>/gi, ' ')
    .replace(/<(meta|link|svg|path|button|input|noscript)[\s\S]*?>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\b(class|style|href|src|rel|type|data-[a-z0-9-]+)="[^"]*"/gi, ' ')
    .replace(/\b(class|style|href|src|rel|type|data-[a-z0-9-]+)='[^']*'/gi, ' ')
    .replace(/\{[\s\S]{0,120}?\}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function tokenizeSocText(text: string): string[] {
  return cleanSocTextForIndexing(text)
    .toLowerCase()
    .split(/[^a-z0-9_.:-]+/)
    .map(term => term.trim())
    .filter(term => term.length > 1 && term.length < 48 && !SOC_STOPWORDS.has(term));
}

function hashTerm(term: string): number {
  let hash = 2166136261;
  for (let i = 0; i < term.length; i += 1) {
    hash ^= term.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash >>> 0);
}

export function buildSocLexicalVector(text: string, dimensions = SOC_RAG_VECTOR_DIMENSIONS): number[] {
  const vector = new Array(dimensions).fill(0) as number[];
  const tokens = tokenizeSocText(text);
  if (!tokens.length) return vector;

  const counts = tokens.reduce<Record<string, number>>((acc, token) => {
    acc[token] = (acc[token] || 0) + 1;
    return acc;
  }, {});

  Object.entries(counts).forEach(([term, count]) => {
    const index = hashTerm(term) % dimensions;
    const weight = 1 + Math.log(count);
    vector[index] += weight;
  });

  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return magnitude > 0 ? vector.map(value => Number((value / magnitude).toFixed(6))) : vector;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (!a.length || !b.length) return 0;
  const max = Math.min(a.length, b.length);
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < max; i += 1) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  if (magA <= 0 || magB <= 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

function topTermsForText(text: string, limit = 8): string[] {
  const counts = tokenizeSocText(text).reduce<Record<string, number>>((acc, term) => {
    acc[term] = (acc[term] || 0) + 1;
    return acc;
  }, {});

  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([term]) => term);
}

function trimForPrompt(text: string, limit = SOC_MAX_SNIPPET_CHARS_PER_PROMPT): string {
  const cleaned = cleanSocTextForIndexing(text);
  if (cleaned.length <= limit) return cleaned;
  return `${cleaned.slice(0, limit)}\n[...snippet trimmed for prompt safety...]`;
}

export function attachmentToSocChunks(resource: SocKnowledgeResource, attachment: AttachmentContext): SocKnowledgeChunk[] {
  const attachmentChunks = attachment.chunks && attachment.chunks.length
    ? attachment.chunks
    : [{ index: 0, title: 'Extracted text preview', start_char: 0, end_char: attachment.text?.length || 0, text: attachment.text || '' }];

  return attachmentChunks.slice(0, SOC_MAX_INDEX_CHUNKS_PER_RESOURCE).map(chunk => {
    const cleanText = cleanSocTextForIndexing(chunk.text || '');
    const lexicalVector = buildSocLexicalVector(cleanText);
    const tokens = tokenizeSocText(cleanText);
    return {
      id: `${resource.id}::chunk-${chunk.index}`,
      resourceId: resource.id,
      resourceTitle: resource.title,
      category: resource.category,
      product: resource.product,
      version: resource.version,
      tags: resource.tags,
      filePath: resource.filePath,
      index: chunk.index,
      title: chunk.title || `Section ${chunk.index + 1}`,
      startChar: chunk.start_char,
      endChar: chunk.end_char,
      text: cleanText,
      wordCount: tokens.length,
      uniqueTermCount: new Set(tokens).size,
      topTerms: topTermsForText(cleanText),
      lexicalVector,
      vectorDimensions: SOC_RAG_VECTOR_DIMENSIONS,
      embeddingKind: SOC_RAG_EMBEDDING_KIND,
      vectorizedAt: Math.floor(Date.now() / 1000),
    };
  });
}

export function flattenSocChunks(resources: SocKnowledgeResource[]): SocKnowledgeChunk[] {
  return resources.flatMap(resource => resource.indexedChunks || []);
}

export function scoreSocChunkKeyword(chunk: SocKnowledgeChunk, query: string): number {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return 0;
  const terms = normalizedQuery.split(/\s+/).filter(term => term.length > 1).slice(0, 12);
  if (!terms.length) return 0;

  const title = `${chunk.resourceTitle} ${chunk.title}`.toLowerCase();
  const metadata = `${chunk.category} ${chunk.product} ${chunk.version || ''} ${(chunk.tags || []).join(' ')} ${chunk.filePath}`.toLowerCase();
  const text = cleanSocTextForIndexing(chunk.text).toLowerCase();
  let score = 0;

  for (const term of terms) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const wordPattern = new RegExp(`\\b${escaped}\\b`, 'gi');
    if (title.includes(term)) score += 8;
    if (metadata.includes(term)) score += 4;
    const matches = (text.match(wordPattern) || []).length;
    score += Math.min(matches, 8);
  }

  if (text.includes(normalizedQuery)) score += 12;
  return score;
}

export function isSocDenseProviderReady(settings?: SocDenseEmbeddingSettings): boolean {
  return Boolean(settings && settings.providerMode === 'local_dense' && settings.status === 'ready' && (settings.vectorizedChunkCount || 0) > 0 && (settings.vectorDimension || 0) > 0);
}

export function getSocDenseProviderStatusText(settings?: SocDenseEmbeddingSettings): string {
  const effective = settings || SOC_DEFAULT_DENSE_EMBEDDING_SETTINGS;
  if (effective.providerMode === 'disabled') return 'Dense vector retrieval is disabled. Keyword and hybrid lexical RAG remain available.';
  if (effective.providerMode === 'hybrid_lexical_only') return 'Hybrid lexical RAG is active. Dense vector retrieval requires a configured local embedding provider.';
  if (effective.status === 'ready') return `Dense vector retrieval is ready using ${effective.providerName || 'local embedding provider'}.`;
  if (effective.status === 'failed') return `Dense embedding provider is not ready: ${effective.error || 'check local model/provider settings.'}`;
  return 'Local dense embedding provider settings are saved, but no embedding runtime is connected yet.';
}

export function searchSocRagChunks(
  resources: SocKnowledgeResource[],
  query: string,
  mode: SocRetrievalMode = 'hybrid_lexical',
  limit = 8,
  denseSettings?: SocDenseEmbeddingSettings,
  queryDenseVector?: number[],
): SocRagSearchResult[] {
  const q = query.trim();
  if (!q) return [];

  const denseReady = isSocDenseProviderReady(denseSettings);
  const denseQueryReady = denseReady && Array.isArray(queryDenseVector) && queryDenseVector.length > 0;
  if ((mode === 'dense_vector' || mode === 'hybrid_dense') && !denseQueryReady) {
    return searchSocRagChunks(resources, query, 'hybrid_lexical', limit, denseSettings);
  }

  const effectiveMode: SocRetrievalMode = mode;
  const queryVector = buildSocLexicalVector(q);
  const queryTerms = new Set(tokenizeSocText(q));

  return flattenSocChunks(resources)
    .map(chunk => {
      const keywordScore = scoreSocChunkKeyword(chunk, q);
      const chunkVector = chunk.lexicalVector?.length ? chunk.lexicalVector : buildSocLexicalVector(chunk.text);
      const similarityScore = cosineSimilarity(queryVector, chunkVector) * 100;
      // Dense vector scores are only used when real local dense vectors exist
      // and the current query has been embedded through the local provider.
      const denseSimilarityScore = denseQueryReady && chunk.denseVector?.length
        ? cosineSimilarity(queryDenseVector || [], chunk.denseVector) * 100
        : 0;
      const topTermBoost = (chunk.topTerms || []).filter(term => queryTerms.has(term)).length * 3;
      const normalizedKeyword = Math.min(keywordScore, 50) / 50 * 60;
      const normalizedSimilarity = Math.min(similarityScore, 100) / 100 * 40;
      const normalizedDense = Math.min(denseSimilarityScore, 100) / 100 * 55;
      const combinedScore = effectiveMode === 'keyword'
        ? keywordScore
        : effectiveMode === 'dense_vector'
          ? denseSimilarityScore
          : effectiveMode === 'hybrid_dense'
            ? normalizedKeyword + normalizedSimilarity + normalizedDense + topTermBoost
            : normalizedKeyword + normalizedSimilarity + topTermBoost;
      return {
        chunk,
        retrievalMode: effectiveMode,
        keywordScore: Number(keywordScore.toFixed(2)),
        similarityScore: Number(similarityScore.toFixed(2)),
        denseSimilarityScore: Number(denseSimilarityScore.toFixed(2)),
        combinedScore: Number(combinedScore.toFixed(2)),
      };
    })
    .filter(item => {
      if (effectiveMode === 'dense_vector') return (item.denseSimilarityScore || 0) > 0;
      if (effectiveMode === 'hybrid_dense') return item.combinedScore > 0 || (item.denseSimilarityScore || 0) > 0;
      return item.combinedScore > 0 || item.keywordScore > 0 || item.similarityScore > 0;
    })
    .sort((a, b) => b.combinedScore - a.combinedScore || b.keywordScore - a.keywordScore || a.chunk.resourceTitle.localeCompare(b.chunk.resourceTitle))
    .slice(0, limit);
}

export function searchSocKnowledgeChunks(resources: SocKnowledgeResource[], query: string, limit = 8): SocKnowledgeChunk[] {
  return searchSocRagChunks(resources, query, 'keyword', limit).map(item => item.chunk);
}

export function socChunkToPromptBlock(chunk: SocKnowledgeChunk, ordinal: number): string {
  return [
    `Retrieved snippet ${ordinal}: ${chunk.resourceTitle} — ${chunk.title}`,
    `Source citation: [${chunk.resourceTitle} / ${chunk.title}]`,
    `Category: ${chunk.category}`,
    `Product: ${chunk.product}`,
    `Version: ${chunk.version || 'not specified'}`,
    `File path: ${chunk.filePath}`,
    `Chunk ID: ${chunk.id}`,
    `Character range: ${chunk.startChar}-${chunk.endChar}`,
    `Lexical stats: ${chunk.wordCount || 0} terms, ${chunk.uniqueTermCount || 0} unique terms, ${chunk.embeddingKind || 'not vectorized'}`,
    'Text:',
    trimForPrompt(chunk.text),
  ].join('\n');
}

export function buildSocRetrievedSnippetContext(chunks: SocKnowledgeChunk[]): string {
  if (!chunks.length) return '';
  return chunks.slice(0, SOC_MAX_SNIPPETS_IN_PROMPT).map((chunk, index) => socChunkToPromptBlock(chunk, index + 1)).join('\n\n---\n\n');
}

export function buildSocRagRetrievedSnippetContext(results: SocRagSearchResult[]): string {
  if (!results.length) return '';
  return results.slice(0, SOC_MAX_SNIPPETS_IN_PROMPT).map((result, index) => [
    `RAG result ${index + 1}: ${result.chunk.resourceTitle} — ${result.chunk.title}`,
    `Retrieval mode: ${SOC_RAG_RETRIEVAL_MODE_LABELS[result.retrievalMode]}`,
    `Combined score: ${result.combinedScore}`,
    `Keyword score: ${result.keywordScore}`,
    `Lexical similarity score: ${result.similarityScore}`,
    `Dense similarity score: ${result.denseSimilarityScore || 0}`,
    `Dense provider: ${result.chunk.denseEmbeddingProvider || 'not used'}`,
    `Chunk ID: ${result.chunk.id}`,
    `Source: ${result.chunk.filePath}`,
    'Snippet:',
    trimForPrompt(result.chunk.text),
  ].join('\n')).join('\n\n---\n\n');
}

export function getSocRagHealthStats(resources: SocKnowledgeResource[], denseSettings?: SocDenseEmbeddingSettings): SocRagHealthStats {
  const chunks = flattenSocChunks(resources);
  const keywordIndexedChunks = chunks.length;
  const vectorizedChunks = chunks.filter(chunk => Array.isArray(chunk.lexicalVector) && chunk.lexicalVector.length > 0).length;
  const denseVectorChunks = chunks.filter(chunk => Array.isArray(chunk.denseVector) && chunk.denseVector.length > 0).length;
  const denseAvailable = isSocDenseProviderReady({ ...(denseSettings || SOC_DEFAULT_DENSE_EMBEDDING_SETTINGS), vectorizedChunkCount: denseVectorChunks });
  const staleChunks = chunks.filter(chunk => !chunk.embeddingKind || chunk.embeddingKind !== SOC_RAG_EMBEDDING_KIND).length;
  const failedChunks = resources
    .filter(resource => resource.indexStatus === 'error')
    .reduce((sum, resource) => sum + Math.max(resource.indexedChunkCount || 0, 1), 0);
  const effectiveDenseSettings = denseSettings || SOC_DEFAULT_DENSE_EMBEDDING_SETTINGS;

  return {
    totalChunks: chunks.length,
    keywordIndexedChunks,
    vectorizedChunks,
    denseVectorChunks,
    staleChunks,
    failedChunks: failedChunks + (effectiveDenseSettings.failedChunkCount || 0),
    retrievalModes: denseAvailable ? ['keyword', 'hybrid_lexical', 'dense_vector', 'hybrid_dense'] : ['keyword', 'hybrid_lexical'],
    embeddingStatus: getSocDenseProviderStatusText(effectiveDenseSettings),
    embeddingKind: SOC_RAG_EMBEDDING_KIND,
    denseAvailable,
    denseProviderStatus: effectiveDenseSettings.status,
    denseProviderMode: effectiveDenseSettings.providerMode,
    denseVectorDimension: effectiveDenseSettings.vectorDimension,
    denseProviderName: effectiveDenseSettings.providerName,
    nextRecommendedAction: denseAvailable
      ? 'Dense retrieval is available. Rebuild when resources change.'
      : denseVectorChunks > 0
        ? 'Click Build Dense Index (All Indexed) to finish the remaining chunks.'
        : effectiveDenseSettings.runtimePath || effectiveDenseSettings.modelFormat
          ? 'Click Build Dense Index (All Indexed) to generate dense vectors.'
          : 'Validate the embedding provider, then click Build Dense Index (All Indexed).',
  };
}

function breakdown(values: string[]): Array<{ label: string; count: number }> {
  return Object.entries(values.reduce<Record<string, number>>((acc, value) => {
    const key = value || 'not specified';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {})).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([label, count]) => ({ label, count }));
}

export function buildSocRagIndexSummaryMarkdown(resources: SocKnowledgeResource[], denseSettings?: SocDenseEmbeddingSettings): string {
  const stats = getSocRagHealthStats(resources, denseSettings);
  const chunks = flattenSocChunks(resources);
  const productBreakdown = breakdown(chunks.map(chunk => chunk.product));
  const versionBreakdown = breakdown(chunks.map(chunk => chunk.version || 'not specified'));
  const categoryBreakdown = breakdown(chunks.map(chunk => chunk.category));

  const formatBreakdown = (title: string, items: Array<{ label: string; count: number }>) => [
    `## ${title}`,
    ...(items.length ? items.map(item => `- ${item.label}: ${item.count}`) : ['- No indexed chunks yet.']),
  ].join('\n');

  return [
    '# Knowledge index summary',
    '',
    `Generated: ${new Date().toLocaleString()}`,
    '',
    '## Retrieval Mode',
    `- Modes available: ${stats.retrievalModes.map(mode => SOC_RAG_RETRIEVAL_MODE_LABELS[mode]).join(', ')}`,
    `- Dense vector retrieval: ${stats.denseAvailable ? 'Ready' : 'Not configured'}`,
    `- Dense provider mode: ${SOC_DENSE_PROVIDER_MODE_LABELS[stats.denseProviderMode]}`,
    `- Dense provider status: ${SOC_DENSE_PROVIDER_STATUS_LABELS[stats.denseProviderStatus]}`,
    `- Dense provider name: ${stats.denseProviderName || 'not configured'}`,
    `- Dense model path: ${denseSettings?.modelPath || 'not configured'}`,
    `- Dense runtime path: ${denseSettings?.runtimePath || 'not detected'}`,
    `- Dense model format: ${denseSettings?.modelFormat || 'not detected'}`,
    `- Dense vector dimension: ${stats.denseVectorDimension || 'not available'}`,
    '- Cloud retrieval/API calls: not used',
    '- Embedding status: ' + stats.embeddingStatus,
    '',
    '## Index Health',
    `- Total indexed chunks: ${stats.totalChunks}`,
    `- Keyword-indexed chunks: ${stats.keywordIndexedChunks}`,
    `- Hybrid lexical vectorized chunks: ${stats.vectorizedChunks}`,
    `- Dense-vector chunks: ${stats.denseVectorChunks}`,
    `- Stale / legacy chunks: ${stats.staleChunks}`,
    `- Failed resource indicators: ${stats.failedChunks}`,
    `- Lexical vector dimensions: ${SOC_RAG_VECTOR_DIMENSIONS}`,
    `- Embedding kind: ${stats.embeddingKind}`,
    '',
    formatBreakdown('Product Breakdown', productBreakdown),
    '',
    formatBreakdown('Version Breakdown', versionBreakdown),
    '',
    formatBreakdown('Category Breakdown', categoryBreakdown),
    '',
    '## Current Limitations',
    '- This patch adds a dense-provider-ready architecture and configuration surface.',
    '- Dense semantic retrieval is only active when a real local embedding provider generates dense vectors.',
    '- If dense provider status is not Ready, the app remains in Keyword / Hybrid lexical RAG mode.',
    '- Source documents remain local and unchanged; snippets are cleaned only for indexing/search display.',
    '',
    '## Next Recommendations',
    '- Rebuild the RAG index after bulk-importing new FortiSIEM/FortiSOAR/SOC data.',
    '- Connect a local dense embedding runtime/model when available, then rebuild dense vectors for selected resources.',
    '- Use compact or full Chat handoff intentionally depending on review depth needed.',
  ].join('\n');
}
