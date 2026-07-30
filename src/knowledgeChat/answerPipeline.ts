import type { ProductConfig } from '../productConfig';
import type { AnswerRoute } from './answerRouting';
import { isWeakGrounding } from './answerRouting';
import { effectiveAnswerIntent } from './types';
import type { KcSearchHit, KcSearchResult, QueryIntent } from './types';

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
  /** Winning answer-pipeline stage id for observability. */
  stageId?: string;
}

export interface AnswerContext {
  question: string;
  searchResult: KcSearchResult;
  contextHits: KcSearchHit[];
  productConfig: ProductConfig | null | undefined;
  explorerMode: boolean;
  answerRoute: AnswerRoute;
  /**
   * When true (online API answer model), skip extractive/evidence short-circuits
   * so the selected remote model actually synthesizes the answer.
   */
  preferOnlineLlm?: boolean;
  /**
   * When true, the LLM owns interpretation + answering. Specialist structured /
   * extractive / weak-grounding stages are demoted so they do not short-circuit.
   */
  preferLlmOrchestration?: boolean;
  /** Pre-rendered deterministic answers (null when not applicable). */
  structuredAnswer: string | null;
  extractivePreview: string | null;
  isStale: () => boolean;
  /** Apply the shared quality gate / citation formatting to a raw answer string. */
  formatAnswer: (text: string, skipQualityGate?: boolean) => string;
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
 * single-symbol extractive answer (e.g. "how does a message get from UserPanel to the
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

function answerIntent(ctx: AnswerContext): QueryIntent {
  return effectiveAnswerIntent(ctx.searchResult);
}

function llmOwnsAnswer(ctx: AnswerContext): boolean {
  return !!ctx.preferLlmOrchestration || !!ctx.preferOnlineLlm;
}

const stages: AnswerStage[] = [
  {
    id: 'structured',
    // Specialists only when answer_intent matches (structured already intent-tagged).
    // Skipped when LLM orchestration owns interpretation of the question.
    canHandle: ctx =>
      !llmOwnsAnswer(ctx)
      && ctx.answerRoute === 'structured'
      && !!ctx.structuredAnswer,
    execute: async ctx => ({ text: ctx.formatAnswer(ctx.structuredAnswer!, true) }),
  },
  {
    id: 'extractive-code-symbol',
    // Prefer extractive only for explain_symbol — list/locate use structured instead.
    canHandle: ctx =>
      !llmOwnsAnswer(ctx)
      && !!ctx.extractivePreview
      && answerIntent(ctx) === 'explain_symbol',
    execute: async ctx => ({ text: ctx.formatAnswer(ctx.extractivePreview!, true) }),
  },
  {
    id: 'codebase-explorer',
    // Reserve the Explorer LLM for cross-file / general questions. Specialist
    // intents (list/locate/env/imports/explain) must not fall through to a
    // citation-only explorer stub when structured extraction misses.
    canHandle: ctx =>
      ctx.explorerMode
      && !ctx.extractivePreview
      && !ctx.structuredAnswer
      && (
        isMultiFileQuestion(ctx.question)
        || answerIntent(ctx) === 'general'
        || !!ctx.preferLlmOrchestration
      ),
    execute: async ctx => {
      const text = await ctx.resolveExplorer();
      return text ? { text } : null;
    },
  },
  {
    id: 'evidence',
    canHandle: ctx => !llmOwnsAnswer(ctx) && ctx.answerRoute === 'evidence',
    execute: async ctx => {
      const text = ctx.resolveEvidence();
      return text ? { text } : null;
    },
  },
  {
    id: 'not-found',
    // With LLM orchestration, empty/weak retrieval still attempts synthesis after
    // the panel's re-retrieve loop; only hard-stop when route is not_found and
    // we are not letting the model decide.
    canHandle: ctx => ctx.answerRoute === 'not_found' && !llmOwnsAnswer(ctx),
    execute: async ctx => ctx.resolveNotFound(),
  },
  {
    // Local Corrective RAG gate: weak grounding after the (optional) pre-pipeline
    // re-search still blocks LLM synthesis — prefer evidence / extractive / not-found.
    // The actual corrective re-retrieve runs in KnowledgeChatPanel (max 1 extra search).
    // Skipped when LLM orchestration / online models own the answer path.
    id: 'corrective-rag',
    canHandle: ctx =>
      !llmOwnsAnswer(ctx) && isWeakGrounding(ctx.contextHits, ctx.productConfig),
    execute: async ctx => {
      if (ctx.extractivePreview && answerIntent(ctx) === 'explain_symbol') {
        return { text: ctx.formatAnswer(ctx.extractivePreview, true) };
      }
      if (ctx.structuredAnswer) {
        return { text: ctx.formatAnswer(ctx.structuredAnswer, true) };
      }
      const evidence = ctx.resolveEvidence();
      if (evidence) return { text: evidence };
      return ctx.resolveNotFound();
    },
  },
  {
    id: 'llm-synthesis',
    // Never synthesize when extractive already answered an explain_symbol question
    // on the legacy specialist path. Orchestration / online always reach the LLM.
    canHandle: ctx =>
      llmOwnsAnswer(ctx)
      || !(
        !!ctx.extractivePreview
        && answerIntent(ctx) === 'explain_symbol'
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
    if (result) return { ...result, stageId: result.stageId || stage.id };
  }
  return null;
}
