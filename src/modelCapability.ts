/**
 * Gates PocketCode write/run tools to ≥20B local models, local VL+mmproj models,
 * large online models, or any organization (enterprise:) server model.
 * Smaller text-only models keep read-only Knowledge Chat / Codebase Explorer.
 */

import { modelSupportsVision } from './codeWorkspace/visionCapability';

export const POCKETCODE_MIN_LOCAL_B = 20;

/** ~18 GiB+ GGUFs are treated as PocketCode-eligible when the filename has no Nb marker. */
export const POCKETCODE_MIN_LOCAL_BYTES = 18 * 1024 * 1024 * 1024;

/** Path/name heuristic for offline VL GGUFs (mmproj presence is checked on the Rust side). */
export function looksLikeLocalVisionModel(modelPath: string | null | undefined): boolean {
  if (!modelPath || modelPath.startsWith('remote:') || modelPath.startsWith('enterprise:')) {
    return false;
  }
  return /\b(vl|llava|vision|qwen2\.5-vl|qwen2-vl|qwen3-vl|qwen3\.5|instinctrazor|minimax-m3|kimi-k2|kimi-k3|llama-4-maverick|maverick|minicpm-v)\b/i.test(modelPath)
    || modelSupportsVision(modelPath);
}

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
  'llama-4-maverick',
  'qwen2.5-72b',
  'qwen-2.5-72b',
  'qwen2.5-coder-32b',
  'qwen3-coder',
  'command-r-plus',
  'glm-5.2',
  'glm-5',
  'z-ai/glm',
  'kimi-k3',
  'kimi-k2.6',
  'kimi-k2',
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
  opts?: {
    paramsBillions?: number | null;
    forceAllow?: boolean;
    localVisionReady?: boolean;
    /** File size in bytes (from Local Model Library) when the path has no Nb token. */
    sizeBytes?: number | null;
  },
): { allowed: boolean; reason: string } {
  if (opts?.forceAllow) return { allowed: true, reason: 'Override enabled' };
  if (!modelPath) {
    return {
      allowed: false,
      reason: 'Select a 20B+ local model, a local vision GGUF with mmproj, an online model, or an org server model for PocketCode.',
    };
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
  // Trust disk probe (mmproj beside GGUF). Path heuristics alone are not enough —
  // Rust `cw_can_use` is the source of truth for the Send gate.
  if (opts?.localVisionReady) {
    return { allowed: true, reason: 'Local vision model (mmproj ready)' };
  }
  const params = opts?.paramsBillions ?? parseParamsBillions(modelPath);
  if (params != null && params >= POCKETCODE_MIN_LOCAL_B) {
    return { allowed: true, reason: `Local model ≈ ${params}B` };
  }
  const sizeBytes = opts?.sizeBytes;
  if (sizeBytes != null && sizeBytes >= POCKETCODE_MIN_LOCAL_BYTES) {
    return { allowed: true, reason: 'Local GGUF ≥ ~18 GB (treated as PocketCode-capable)' };
  }
  if (params != null) {
    return {
      allowed: false,
      reason: `Local model ≈ ${params}B is below the ${POCKETCODE_MIN_LOCAL_B}B PocketCode gate. Use a ≥${POCKETCODE_MIN_LOCAL_B}B GGUF, a VL GGUF with mmproj beside it (for vision), or an online/org model.`,
    };
  }
  return {
    allowed: false,
    reason: `Could not determine model size. PocketCode requires a ≥${POCKETCODE_MIN_LOCAL_B}B local GGUF (~18 GB+), a local VL GGUF with mmproj beside it, an online model, or an org server model.`,
  };
}
