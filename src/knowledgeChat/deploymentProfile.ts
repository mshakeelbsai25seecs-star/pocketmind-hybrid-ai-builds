import type { ProductConfig } from '../productConfig';

export type KcDeploymentProfile = 'demo' | 'server';

export interface KcRuntimeLimits {
  contextCharBudget: number;
  maxSources: number;
  maxTokens: number;
  contextSize: number;
  topKDefault: number;
}

export function resolveDeploymentProfile(config: ProductConfig | null | undefined): KcDeploymentProfile {
  return config?.knowledge_chat_deployment_profile === 'server' ? 'server' : 'demo';
}

export function limitsForProfile(profile: KcDeploymentProfile): KcRuntimeLimits {
  if (profile === 'server') {
    return {
      contextCharBudget: 256_000,
      maxSources: 64,
      maxTokens: 4096,
      contextSize: 32768,
      topKDefault: 12,
    };
  }
  // Accuracy-first demo: still laptop-sane, but no longer starved of context.
  return {
    contextCharBudget: 64_000,
    maxSources: 32,
    maxTokens: 3072,
    contextSize: 16384,
    topKDefault: 12,
  };
}

export function runtimeLimitsForConfig(config: ProductConfig | null | undefined): KcRuntimeLimits {
  return limitsForProfile(resolveDeploymentProfile(config));
}
