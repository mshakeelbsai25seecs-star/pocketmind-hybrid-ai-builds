import type { KcPipelineTrace, KcStageStatus, KcStageTrace } from './types';

const MAX_IO = 1800;

function truncateIo(text: string): string {
  if (text.length <= MAX_IO) return text;
  return `${text.slice(0, MAX_IO)}… [truncated]`;
}

/** Merge answer-side stages into a retrieval trace (client-side). */
export function mergeAnswerStagesIntoTrace(
  base: KcPipelineTrace | null | undefined,
  opts: {
    correctiveUsed: boolean;
    winningStageId?: string | null;
    extractiveUsed: boolean;
    structuredUsed: boolean;
    llmUsed: boolean;
    question?: string;
    extractivePreview?: string | null;
    structuredAnswer?: string | null;
    finalAnswerPreview?: string | null;
  },
): KcPipelineTrace {
  const trace: KcPipelineTrace = {
    stages: [...(base?.stages || [])],
    winning_answer_stage: opts.winningStageId || base?.winning_answer_stage || null,
    corrective_used: opts.correctiveUsed || !!base?.corrective_used,
    overall_status: base?.overall_status || 'ok',
    primary_culprit_stage: base?.primary_culprit_stage,
    diagnosis_summary: base?.diagnosis_summary,
    diagnosis_actions: base?.diagnosis_actions ? [...base.diagnosis_actions] : [],
  };

  const q = opts.question || '';
  const push = (
    id: string,
    status: KcStageStatus,
    detail: string,
    input = '',
    output = '',
  ) => {
    if (trace.stages.some(s => s.id === id)) return;
    const stage: KcStageTrace = {
      id,
      status,
      duration_ms: 0,
      detail,
      remediation: '',
      input: truncateIo(input),
      output: truncateIo(output),
    };
    trace.stages.push(stage);
  };

  push(
    'crag',
    opts.correctiveUsed ? 'ok' : 'skipped',
    opts.correctiveUsed ? 'Corrective re-search used' : 'No corrective re-search',
    q ? `question=${JSON.stringify(q)}` : '',
    opts.correctiveUsed ? 'second_search_completed' : 'skipped',
  );
  push(
    'structured',
    opts.structuredUsed ? 'ok' : 'skipped',
    opts.structuredUsed ? 'Structured answer used' : 'No structured answer',
    q,
    opts.structuredUsed ? (opts.structuredAnswer || 'structured_answer') : 'skipped',
  );
  push(
    'extractive',
    opts.extractiveUsed ? 'ok' : 'skipped',
    opts.extractiveUsed ? 'Extractive symbol/evidence answer used' : 'No extractive answer',
    q,
    opts.extractiveUsed ? (opts.extractivePreview || 'extractive_answer') : 'skipped',
  );
  if (opts.llmUsed || opts.winningStageId === 'llm-synthesis') {
    push(
      'llm',
      'ok',
      'LLM synthesis path ran',
      q,
      opts.finalAnswerPreview || 'llm_answer',
    );
  } else {
    push('llm', 'skipped', 'LLM synthesis not used', q, 'skipped');
  }
  push(
    'finalize',
    'ok',
    `winning_stage=${opts.winningStageId || 'unknown'}`,
    q,
    opts.finalAnswerPreview || '',
  );

  const hasFailed = trace.stages.some(s => s.status === 'failed');
  const hasDegraded = trace.stages.some(s => s.status === 'degraded');
  trace.overall_status = hasFailed ? 'failed' : hasDegraded ? 'degraded' : 'ok';
  return trace;
}

export function stageStatusLabel(status?: KcStageStatus): string {
  switch (status) {
    case 'ok':
      return 'OK';
    case 'skipped':
      return 'Skipped';
    case 'degraded':
      return 'Degraded';
    case 'failed':
      return 'Failed';
    default:
      return 'Unknown';
  }
}
