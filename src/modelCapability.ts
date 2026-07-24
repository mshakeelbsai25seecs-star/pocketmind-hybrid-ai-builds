/**
 * Gates Code Workspace write/run tools to ≥70B local models or large online models.
 * Smaller models keep read-only Knowledge Chat / Codebase Explorer.
 */

const LARGE_ONLINE_IDS = [
  'gpt-4o',
  'gpt-4.1',
  'gpt-4-turbo',
  'claude-3.5-sonnet',
  'claude-3-opus',
  'claude-sonnet-4',
  'claude-opus',
  'deepseek-chat',
  'deepseek-reasoner',
  'deepseek-v3',
  'deepseek-chat-v3',
  'llama-3.3-70b',
  'llama-3.1-70b',
  'llama-3.1-405b',
  'meta-llama-3.1-405b',
  'qwen2.5-72b',
  'qwen-2.5-72b',
  'command-r-plus',
  'glm-5.2',
  'glm-5',
  'z-ai/glm',
];

export function parseParamsBillions(label: string | null | undefined): number | null {
  if (!label) return null;
  const m = label.match(/(\d+(?:\.\d+)?)\s*b\b/i) || label.match(/[-_](\d+(?:\.\d+)?)b(?:[-_.]|$)/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

export function isLargeOnlineModel(modelPath: string | null | undefined): boolean {
  if (!modelPath) return false;
  const lower = modelPath.toLowerCase();
  if (lower.includes('capabilities.code_workspace=true')) return true;
  return LARGE_ONLINE_IDS.some(id => lower.includes(id));
}

export function canUseCodeWorkspaceAgent(
  modelPath: string | null | undefined,
  opts?: { paramsBillions?: number | null; forceAllow?: boolean },
): { allowed: boolean; reason: string } {
  if (opts?.forceAllow) return { allowed: true, reason: 'Override enabled' };
  if (!modelPath) {
    return { allowed: false, reason: 'Select a model of 70B+ parameters (or a large online model) for Code Workspace.' };
  }
  if (modelPath.startsWith('remote:') || modelPath.startsWith('enterprise:')) {
    if (isLargeOnlineModel(modelPath)) {
      return { allowed: true, reason: 'Large online / org model' };
    }
    return {
      allowed: false,
      reason: 'This online model is not tagged as large enough for Code Workspace edit/run tools. Use Folder Q&A / Codebase Explorer instead, or pick a 70B-class / frontier model.',
    };
  }
  const params = opts?.paramsBillions ?? parseParamsBillions(modelPath);
  if (params != null && params >= 70) {
    return { allowed: true, reason: `Local model ≈ ${params}B` };
  }
  if (params != null) {
    return {
      allowed: false,
      reason: `Local model ≈ ${params}B is below the 70B Code Workspace gate. Use Knowledge Chat Codebase Explorer (read-only) or switch to a 70B+ GGUF.`,
    };
  }
  // Unknown size: deny write/run by default (safer).
  return {
    allowed: false,
    reason: 'Could not determine model size. Code Workspace requires an explicit ≥70B local GGUF or a known large online model.',
  };
}
