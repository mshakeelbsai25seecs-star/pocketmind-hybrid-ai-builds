import type { ProductConfig } from '../productConfig';
import type { AnswerRoute } from './answerRouting';
import { isWeakGrounding } from './answerRouting';
import { isCodeSymbolQuestion } from './prompts';
import type { KcSearchHit, KcSearchResult } from './types';

/**
 * Modular answer pipeline.
 *
 * Stage 1 (retrieval) already ran before this point: hybrid lexical + dense search,
 * RRF fusion, dense-pair rerank and ONNX rerank produced `searchResult`. This module
 * owns Stage 2 (answer assembly): a declarative, ordered registry that decides which
 * strategy produces the reply. The panel supplies effectful resolvers (streaming,
 * file loading, publishing) as callbacks so all ordering and gating live in one place
 * instead of an inline `if` chain in `KnowledgeChatPanel`.
 */

export interface AnswerResult {
  /** Final answer text to publish (already passed through `formatAnswer`). */
  text: string;
  /** Hits used to build assistant metadata. Defaults to `contextHits`. */
  hitsForMeta?: KcSearchHit[];
  /** Whether to attach citation hits. Defaults to true. */
  withCitations?: boolean;
}

export interface AnswerContext {
  question: string;
  searchResult: KcSearchResult;
  contextHits: KcSearchHit[];
  productConfig: ProductConfig | null | undefined;
  explorerMode: boolean;
  answerRoute: AnswerRoute;
  /** Pre-rendered deterministic answers (null when not applicable). */
  structuredAnswer: string | null;
  extractivePreview: string | null;
  isStale: () => boolean;
  /** Apply the shared quality gate / citation formatting to a raw answer string. */
  formatAnswer: (text: string, skipQualityGate?: boolean, demoMode?: boolean) => string;
  /** Run the Codebase Explorer flow; returns formatted text, or null to fall through. */
  resolveExplorer: () => Promise<string | null>;
  /** Resolve a deterministic evidence answer; returns formatted text, or null. */
  resolveEvidence: () => string | null;
  /** Resolve the not-found answer (or a deterministic fallback). */
  resolveNotFound: () => AnswerResult;
  /** Terminal LLM synthesis flow; always returns a publishable result. */
  resolveLlm: () => Promise<AnswerResult>;
}

export interface AnswerStage {
  id: string;
  canHandle(ctx: AnswerContext): boolean;
  execute(ctx: AnswerContext): Promise<AnswerResult | null>;
}

/**
 * Cross-file / flow questions that warrant the Codebase Explorer LLM rather than a
 * single-symbol extractive answer (e.g. "how does a message get from ChatView to the
 * backend?", "where is hybrid search used?").
 */
export function isMultiFileQuestion(question: string): boolean {
  const q = question.toLowerCase();
  return (
    /\bfrom\b[\s\S]*\bto\b/.test(q)
    || /\b(flow|pipeline|call chain|end[- ]to[- ]end|across|between)\b/.test(q)
    || /\bwhere\b[\s\S]*\b(used|called|defined|referenced)\b/.test(q)
    || /\bhow (?:do|does|are)\b[\s\S]*\b(connect|interact|communicate|wire|integrate)/.test(q)
  );
}

const stages: AnswerStage[] = [
  {
    id: 'structured',
    canHandle: ctx => ctx.answerRoute === 'structured' && !!ctx.structuredAnswer,
    execute: async ctx => ({ text: ctx.formatAnswer(ctx.structuredAnswer!, true) }),
  },
  {
    id: 'extractive-code-symbol',
    // Always prefer a ready extractive/symbol answer over Phi-3 synthesis.
    canHandle: ctx => !!ctx.extractivePreview,
    execute: async ctx => ({ text: ctx.formatAnswer(ctx.extractivePreview!, true) }),
  },
  {
    id: 'codebase-explorer',
    // Reserve the Explorer LLM for cross-file questions where no extractive answer
    // exists. Single-symbol questions are served by the extractive stage above.
    canHandle: ctx =>
      ctx.explorerMode
      && !ctx.extractivePreview
      && (isMultiFileQuestion(ctx.question) || !isCodeSymbolQuestion(ctx.question)),
    execute: async ctx => {
      const text = await ctx.resolveExplorer();
      return text ? { text } : null;
    },
  },
  {
    id: 'evidence',
    canHandle: ctx => ctx.answerRoute === 'evidence',
    execute: async ctx => {
      const text = ctx.resolveEvidence();
      return text ? { text } : null;
    },
  },
  {
    id: 'not-found',
    canHandle: ctx => ctx.answerRoute === 'not_found',
    execute: async ctx => ctx.resolveNotFound(),
  },
  {
    // Local Corrective RAG gate: weak grounding after the (optional) pre-pipeline
    // re-search still blocks LLM synthesis — prefer evidence / extractive / not-found.
    // The actual corrective re-retrieve runs in KnowledgeChatPanel (max 1 extra search).
    id: 'corrective-rag',
    canHandle: ctx => isWeakGrounding(ctx.contextHits, ctx.productConfig),
    execute: async ctx => {
      if (ctx.extractivePreview) {
        return { text: ctx.formatAnswer(ctx.extractivePreview, true) };
      }
      const evidence = ctx.resolveEvidence();
      if (evidence) return { text: evidence };
      return ctx.resolveNotFound();
    },
  },
  {
    id: 'llm-synthesis',
    // Never synthesize when extractive already answered a code-symbol question.
    canHandle: ctx => !(
      !!ctx.extractivePreview
      && isCodeSymbolQuestion(ctx.question)
    ),
    execute: async ctx => ctx.resolveLlm(),
  },
];

export function answerStages(): AnswerStage[] {
  return stages;
}

/**
 * Run the ordered registry: the first stage whose `canHandle` passes and whose
 * `execute` returns a non-null result wins. Stages that return null pass to the next.
 */
export async function runAnswerPipeline(ctx: AnswerContext): Promise<AnswerResult | null> {
  for (const stage of stages) {
    if (ctx.isStale()) return null;
    if (!stage.canHandle(ctx)) continue;
    const result = await stage.execute(ctx);
    if (result) return result;
  }
  return null;
}
