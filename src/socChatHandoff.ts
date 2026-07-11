import type { Conversation, GenerationParams } from './types';

export const SOC_HUMAN_APPROVAL_NOTICE =
  'AI recommendations require human approval before production response actions.';

export const SOC_SYSTEM_PROMPT = [
  'You are Nexus AI Fortinet SOC Copilot.',
  'You help security analysts with FortiSIEM and FortiSOAR work: triage, investigation, rules, parsers, playbooks, and connectors.',
  'Use only evidence the user provides or that appears in retrieved company documents.',
  'Do not claim live FortiSIEM or FortiSOAR integration unless the user supplied exported data.',
  SOC_HUMAN_APPROVAL_NOTICE,
  'Do not recommend destructive actions without human approval and a rollback plan.',
  'Say clearly when evidence is missing. Use structured Markdown.',
  'When the user message lists OUTPUT FORMAT sections, complete each section in order.',
  'Write in a clear analyst tone suitable for team handoff.',
].join('\n');

export const SOC_GENERATION_PARAMS: Partial<GenerationParams> = {
  temperature: 0.35,
  top_k: 40,
  top_p: 0.82,
  repetition_penalty: 1.14,
  max_tokens: 1024,
  context_size: 8192,
  gpu_layers: -1,
  batch_size: 256,
  flash_attention: false,
};

export interface PendingChatOptions {
  soc?: boolean;
  autoSend?: boolean;
}

export function isSocPrompt(content: string): boolean {
  const text = content.trim();
  if (!text) return false;
  return (
    text.includes('Fortinet SOC Copilot') || text.includes('Nexus AI')
    || text.includes('Fortinet SOC L3')
    || /\bOUTPUT FORMAT:\s*\n\s*1\./i.test(text)
    || /\bTASK:\s*(Perform Fortinet SOC|Draft a FortiSIEM|Draft FortiSOAR|Generate a Fortinet SOC)/i.test(text)
  );
}

export function isSocConversation(conversation?: Conversation | null): boolean {
  return conversation?.mode === 'soc';
}

export function shouldUseSocGeneration(content: string, conversation?: Conversation | null, forceSoc?: boolean): boolean {
  return Boolean(forceSoc || isSocConversation(conversation) || isSocPrompt(content));
}

export function mergeGenerationParams(
  base: GenerationParams,
  override?: Partial<GenerationParams>,
): GenerationParams {
  return { ...base, ...override };
}
