import { invoke } from '@tauri-apps/api/tauri';
import { pickChatBackend } from '../../docStudio';
import { logAuditEvent } from '../../auditLog';
import type { GenerationChunk } from '../../types';
import { createEvidenceStep } from '../caseFactory';
import { socUpsertCase, socWriteCaseArtifact } from '../caseStore';
import { matchMemoryForCase, socListMemory } from '../memoryStore';
import type { SocCase } from '../types';
import { extractIocsFromText } from './extractIocs';
import { parseVerdictFromModelText } from './parseVerdict';
import { buildInvestigationUserPrompt, SOC_INVESTIGATION_SYSTEM } from './prompts';

export interface InvestigationDeps {
  currentModel: string;
  defaultParams: Record<string, unknown>;
  knowledgeContext?: string;
  knowledgeHitCount?: number;
  knowledgeTitles?: string[];
}

export async function runInvestigation(
  inputCase: SocCase,
  deps: InvestigationDeps,
): Promise<SocCase> {
  if (!deps.currentModel?.trim()) {
    throw new Error('Select a model before investigating.');
  }
  const hasEvidence = Boolean(
    inputCase.summary?.trim()
    || inputCase.rawEvidence?.trim()
    || inputCase.entities.sourceIp?.trim()
    || inputCase.entities.username?.trim()
    || inputCase.entities.asset?.trim(),
  );
  if (!hasEvidence) {
    throw new Error('Add a summary, raw evidence, or entities before investigating.');
  }

  const now = Date.now();
  let socCase: SocCase = {
    ...inputCase,
    status: 'investigating',
    updatedAt: now,
    timings: {
      ...inputCase.timings,
      firstInvestigatedAt: inputCase.timings.firstInvestigatedAt || now,
    },
    evidenceChain: [
      ...inputCase.evidenceChain,
      createEvidenceStep('agent', 'Investigation started', `Model ${deps.currentModel}`, { at: now }),
    ],
  };
  socCase = await socUpsertCase(socCase);

  const memory = await socListMemory();
  const memoryHits = matchMemoryForCase(memory, {
    sourceIp: socCase.entities.sourceIp,
    destinationIp: socCase.entities.destinationIp,
    username: socCase.entities.username,
    asset: socCase.entities.asset,
    hostnames: socCase.entities.hostnames,
  });
  if (memoryHits.length) {
    socCase = {
      ...socCase,
      evidenceChain: [
        ...socCase.evidenceChain,
        createEvidenceStep(
          'memory',
          'Matched analyst memory',
          memoryHits.map(m => `${m.entityType}:${m.key} (${m.classification})`).join('; '),
        ),
      ],
    };
  }

  const iocs = extractIocsFromText(
    [socCase.rawEvidence, socCase.summary, socCase.notes].filter(Boolean).join('\n'),
  );
  if (iocs.length) {
    socCase = {
      ...socCase,
      evidenceChain: [
        ...socCase.evidenceChain,
        createEvidenceStep('agent', 'Extracted IOCs from evidence', iocs.slice(0, 20).join(', ')),
      ],
    };
  }

  if ((deps.knowledgeHitCount || 0) > 0) {
    socCase = {
      ...socCase,
      evidenceChain: [
        ...socCase.evidenceChain,
        createEvidenceStep(
          'knowledge',
          'Retrieved company knowledge',
          `${deps.knowledgeHitCount} snippet(s)${deps.knowledgeTitles?.length ? `: ${deps.knowledgeTitles.slice(0, 5).join('; ')}` : ''}`,
        ),
      ],
    };
  } else {
    socCase = {
      ...socCase,
      evidenceChain: [
        ...socCase.evidenceChain,
        createEvidenceStep(
          'knowledge',
          'Company knowledge retrieval',
          'No indexed snippets matched (or knowledge not indexed).',
          { ok: true },
        ),
      ],
    };
  }

  const prompt = buildInvestigationUserPrompt({
    case: socCase,
    knowledgeContext: deps.knowledgeContext,
    memoryEntries: memoryHits,
    extractedIocs: iocs,
  });

  const { backend, modelPath } = pickChatBackend(deps.currentModel);
  let chunk: GenerationChunk;
  try {
    chunk = await invoke<GenerationChunk>('generate_response', {
      request: {
        prompt,
        system_prompt: SOC_INVESTIGATION_SYSTEM,
        params: {
          ...deps.defaultParams,
          max_tokens: Math.max(Number(deps.defaultParams.max_tokens) || 0, 1200),
          temperature: 0.2,
        },
        model_path: modelPath || deps.currentModel,
        backend,
        messages: [
          { role: 'system', content: SOC_INVESTIGATION_SYSTEM },
          { role: 'user', content: prompt },
        ],
      },
    });
  } catch (err) {
    const failed = {
      ...socCase,
      status: 'needs_human' as const,
      evidenceChain: [
        ...socCase.evidenceChain,
        createEvidenceStep(
          'agent',
          'Investigation failed',
          err instanceof Error ? err.message : String(err),
          { ok: false },
        ),
      ],
      updatedAt: Date.now(),
    };
    await socUpsertCase(failed);
    throw new Error(
      `Investigation model call failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const rawText = (chunk.text || '').trim();
  if (!rawText) {
    const failed = {
      ...socCase,
      status: 'needs_human' as const,
      evidenceChain: [
        ...socCase.evidenceChain,
        createEvidenceStep('agent', 'Investigation failed', 'Model returned an empty response.', { ok: false }),
      ],
      updatedAt: Date.now(),
    };
    await socUpsertCase(failed);
    throw new Error('Model returned an empty investigation response.');
  }

  const artifactPath = await socWriteCaseArtifact(
    socCase.id,
    `investigation-${now}.md`,
    rawText,
  );

  const { verdict, parseOk } = parseVerdictFromModelText(rawText, {
    modelId: deps.currentModel,
    generatedAt: Date.now(),
  });

  const evidenceFromModel = (verdict.evidenceFound || []).slice(0, 12).map(item =>
    createEvidenceStep('agent', 'Model evidence note', item),
  );

  const closedDisposition = verdict.disposition;
  const nextStatus = !parseOk || closedDisposition === 'needs_evidence' || verdict.confidence === 'low'
    ? 'needs_human'
    : 'pending_approval';

  const verdictAt = Date.now();
  socCase = {
    ...socCase,
    status: nextStatus,
    disposition: closedDisposition === 'undetermined' ? 'needs_evidence' : closedDisposition,
    verdict,
    updatedAt: verdictAt,
    timings: {
      ...socCase.timings,
      firstVerdictAt: socCase.timings.firstVerdictAt || verdictAt,
    },
    evidenceChain: [
      ...socCase.evidenceChain,
      createEvidenceStep(
        'agent',
        parseOk ? 'Verdict parsed' : 'Verdict parse incomplete',
        `${verdict.disposition} · confidence ${verdict.confidence}`,
        { ok: parseOk, artifactPath },
      ),
      ...evidenceFromModel,
    ],
  };

  socCase = await socUpsertCase(socCase);
  void logAuditEvent({
    eventType: 'soc.investigate',
    category: 'soc',
    summary: `Investigated ${socCase.id}`,
    detail: `disposition=${socCase.disposition}; parseOk=${parseOk}`,
  });
  return socCase;
}
