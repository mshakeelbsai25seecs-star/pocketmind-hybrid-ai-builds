import type { GenerationParams, Message } from './types';

/** Rough token estimate used for UI budget bars (chars/4). */
export function estimateTokens(text: string | null | undefined): number {
  if (!text) return 0;
  return Math.max(0, Math.ceil(text.length / 4));
}

export function estimateMessagesTokens(messages: Message[]): number {
  return messages.reduce((sum, m) => sum + estimateTokens(m.content) + 4, 0);
}

export interface ContextBudgetInput {
  systemPrompt?: string | null;
  messages: Message[];
  attachmentText?: string | null;
  ragBundle?: string | null;
  contextSize: number;
  keepLastN: number;
}

export interface ContextBudgetResult {
  contextSize: number;
  keepLastN: number;
  retainedMessages: Message[];
  usedTokens: number;
  limitTokens: number;
  ratio: number;
  level: 'ok' | 'warn' | 'critical';
  droppedCount: number;
}

export function computeContextBudget(input: ContextBudgetInput): ContextBudgetResult {
  const limitTokens = Math.max(512, input.contextSize | 0);
  const keepLastN = Math.max(1, Math.min(200, input.keepLastN | 0));
  const retainedMessages = input.messages.slice(-keepLastN);
  const droppedCount = Math.max(0, input.messages.length - retainedMessages.length);
  const usedTokens =
    estimateTokens(input.systemPrompt) +
    estimateMessagesTokens(retainedMessages) +
    estimateTokens(input.attachmentText) +
    estimateTokens(input.ragBundle);
  const ratio = Math.min(1, usedTokens / limitTokens);
  const level = ratio >= 0.9 ? 'critical' : ratio >= 0.7 ? 'warn' : 'ok';
  return { contextSize: limitTokens, keepLastN, retainedMessages, usedTokens, limitTokens, ratio, level, droppedCount };
}

export function defaultKeepLastN(params?: Partial<GenerationParams> | null): number {
  void params;
  return 6;
}

export function formatBudgetLabel(b: ContextBudgetResult): string {
  return `~${b.usedTokens.toLocaleString()} / ${b.limitTokens.toLocaleString()} tokens`;
}
