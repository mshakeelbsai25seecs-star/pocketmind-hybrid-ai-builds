/**
 * Gates PocketCode write/run tools to ≥30B local models, large online models,
 * or any organization (enterprise:) server model.
 * Smaller models keep read-only Knowledge Chat / Codebase Explorer.
 */

export const POCKETCODE_MIN_LOCAL_B = 30;

const LARGE_ONLINE_IDS = [
  'gpt-5.5',
  'gpt-5.4',
  'gpt-5',
  'gpt-4o',
  'gpt-4.1',
  'gpt-4-turbo',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-sonnet-4-6',
  'claude-sonnet-5',
  'claude-3.5-sonnet',
  'claude-3-opus',
  'claude-sonnet-4',
  'claude-opus',
  'deepseek-v4-pro',
  'deepseek-v4-flash',
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
  'qwen2.5-coder-32b',
  'command-r-plus',
  'glm-5.2',
  'glm-5',
  'z-ai/glm',
  'gemini-2.5-pro',
  'gemini-2.5-flash',
  'gemini-2.0-flash',
  'pixtral',
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
    return { allowed: false, reason: 'Select a 30B+ local model, an online model, or an org server model for PocketCode.' };
  }
  if (modelPath.startsWith('enterprise:')) {
    return { allowed: true, reason: 'Organization server model' };
  }
  if (modelPath.startsWith('remote:')) {
    // User-selected online models are always allowed (including Gemini 2.5 Flash, etc.).
    return {
      allowed: true,
      reason: isLargeOnlineModel(modelPath) ? 'Online model' : 'Online model (user selected)',
    };
  }
  const params = opts?.paramsBillions ?? parseParamsBillions(modelPath);
  if (params != null && params >= POCKETCODE_MIN_LOCAL_B) {
    return { allowed: true, reason: `Local model ≈ ${params}B` };
  }
  if (params != null) {
    return {
      allowed: false,
      reason: `Local model ≈ ${params}B is below the 30B PocketCode gate. Use Knowledge Chat Codebase Explorer (read-only) or switch to a 30B+ GGUF / org server.`,
    };
  }
  return {
    allowed: false,
    reason: 'Could not determine model size. PocketCode requires an explicit ≥30B local GGUF, an online model, or an org server model.',
  };
}
