import type { SocConfidence, SocDisposition, SocVerdict } from '../types';

const FENCE_RE = /---SOC_VERDICT_JSON---\s*([\s\S]*?)\s*---END_SOC_VERDICT_JSON---/i;

function asDisposition(v: unknown): SocDisposition {
  const s = String(v || '').trim().toLowerCase().replace(/\s+/g, '_');
  if (s === 'benign' || s === 'false_positive' || s === 'fp') return 'benign';
  if (s === 'suspicious') return 'suspicious';
  if (s === 'malicious' || s === 'true_positive' || s === 'tp') return 'malicious';
  if (s === 'needs_evidence' || s === 'needs_more_evidence' || s === 'unknown') return 'needs_evidence';
  return 'undetermined';
}

function asConfidence(v: unknown): SocConfidence {
  const s = String(v || '').trim().toLowerCase();
  if (s === 'low' || s === 'medium' || s === 'high') return s;
  return 'unknown';
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map(item => String(item ?? '').trim()).filter(Boolean);
}

export function extractVerdictJsonBlock(text: string): string | null {
  const m = text.match(FENCE_RE);
  if (m?.[1]) return m[1].trim();
  const bare = text.match(/\{[\s\S]*"disposition"[\s\S]*\}/);
  return bare?.[0]?.trim() || null;
}

export function parseVerdictFromModelText(
  text: string,
  opts?: { modelId?: string; generatedAt?: number },
): { verdict: SocVerdict; parseOk: boolean } {
  const generatedAt = opts?.generatedAt ?? Date.now();
  const block = extractVerdictJsonBlock(text);
  if (!block) {
    return {
      parseOk: false,
      verdict: {
        disposition: 'needs_evidence',
        confidence: 'unknown',
        summary: 'Model response did not include a parseable verdict block.',
        reasoning: text.trim(),
        evidenceFound: [],
        missingEvidence: ['Structured SOC_VERDICT_JSON block'],
        recommendedActions: ['Review raw model output and complete disposition manually'],
        mitreTechniques: [],
        interviewQuestions: [],
        generatedAt,
        modelId: opts?.modelId,
        rawModelText: text,
      },
    };
  }

  try {
    const json = JSON.parse(block) as Record<string, unknown>;
    const disposition = asDisposition(json.disposition);
    const confidence = asConfidence(json.confidence);
    const verdict: SocVerdict = {
      disposition,
      confidence,
      summary: String(json.summary ?? json.executive_summary ?? '').trim()
        || 'Investigation completed.',
      reasoning: String(json.reasoning ?? json.rationale ?? '').trim() || text.trim(),
      evidenceFound: asStringArray(json.evidenceFound ?? json.evidence_found),
      missingEvidence: asStringArray(json.missingEvidence ?? json.missing_evidence),
      recommendedActions: asStringArray(json.recommendedActions ?? json.recommended_actions),
      mitreTechniques: asStringArray(json.mitreTechniques ?? json.mitre),
      interviewQuestions: asStringArray(json.interviewQuestions ?? json.interview_questions),
      aiDisposition: disposition,
      aiConfidence: confidence,
      generatedAt,
      modelId: opts?.modelId,
      rawModelText: text,
    };
    return { verdict, parseOk: true };
  } catch {
    return {
      parseOk: false,
      verdict: {
        disposition: 'needs_evidence',
        confidence: 'unknown',
        summary: 'Verdict JSON could not be parsed.',
        reasoning: text.trim(),
        evidenceFound: [],
        missingEvidence: ['Valid JSON inside SOC_VERDICT_JSON fence'],
        recommendedActions: ['Review raw model output and set disposition manually'],
        mitreTechniques: [],
        interviewQuestions: [],
        generatedAt,
        modelId: opts?.modelId,
        rawModelText: text,
      },
    };
  }
}
