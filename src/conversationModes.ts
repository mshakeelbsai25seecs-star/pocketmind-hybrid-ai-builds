import type { AppView } from './types';

/** Legacy conversation.mode values from removed Knowledge Chat. Hidden from the sidebar. */
export const KNOWLEDGE_CHAT_MODES = ['knowledge', 'knowledge-server-rag'] as const;

export type HistoryModeKey = 'chat' | 'knowledge' | 'pocketcode' | 'soc';

export function normalizeConversationMode(mode: string | null | undefined): string {
  const m = (mode || 'chat').trim().toLowerCase();
  return m || 'chat';
}

export function isKnowledgeChatMode(mode: string | null | undefined): boolean {
  const m = normalizeConversationMode(mode);
  return m === 'knowledge' || m === 'knowledge-server-rag';
}

export function isChatMode(mode: string | null | undefined): boolean {
  const m = normalizeConversationMode(mode);
  return m === 'chat' || m === 'organization-server';
}

export function isPocketCodeMode(mode: string | null | undefined): boolean {
  return normalizeConversationMode(mode) === 'pocketcode';
}

/** Which history bucket a view shows in the global Sidebar (null = hide list). */
export function historyModeForView(view: AppView): HistoryModeKey | null {
  switch (view) {
    case 'chat':
      return 'chat';
    case 'knowledge-chat':
      // Knowledge Chat was removed from the product. Do not show a KC history rail.
      return 'chat';
    case 'code-workspace':
      return 'pocketcode';
    case 'soc':
      return 'soc';
    default:
      return null;
  }
}

export function conversationMatchesHistoryMode(
  mode: string | null | undefined,
  historyMode: HistoryModeKey,
): boolean {
  const m = normalizeConversationMode(mode);
  switch (historyMode) {
    case 'chat':
      return m === 'chat' || m === 'organization-server';
    case 'knowledge':
      return m === 'knowledge' || m === 'knowledge-server-rag';
    case 'pocketcode':
      return m === 'pocketcode';
    case 'soc':
      return m === 'soc';
    default:
      return false;
  }
}

export function historySectionTitle(historyMode: HistoryModeKey): string {
  switch (historyMode) {
    case 'chat':
      return 'Chats';
    case 'knowledge':
      return 'Chats';
    case 'pocketcode':
      return 'PocketCode';
    case 'soc':
      return 'Fortinet chats';
    default:
      return 'Chats';
  }
}

/** Map a conversation mode to the lastConversationIdByMode key. */
export function historyKeyForConversationMode(mode: string | null | undefined): HistoryModeKey {
  const m = normalizeConversationMode(mode);
  if (m === 'knowledge' || m === 'knowledge-server-rag') return 'knowledge';
  if (m === 'pocketcode') return 'pocketcode';
  if (m === 'soc') return 'soc';
  // chat + organization-server share the Chat history bucket
  return 'chat';
}
