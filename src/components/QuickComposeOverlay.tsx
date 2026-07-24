import { useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/tauri';
import { appWindow } from '@tauri-apps/api/window';
import { useAppStore } from '../store';
import type { Conversation, Message } from '../types';

/**
 * Desktop global-hotkey compose overlay (Ctrl+Shift+Space).
 * Android has no true system-wide Spotlight overlay — in-app only.
 */
export default function QuickComposeOverlay() {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const currentModel = useAppStore(s => s.currentModel);
  const activeConversationId = useAppStore(s => s.activeConversationId);
  const setActiveConversation = useAppStore(s => s.setActiveConversation);
  const setActiveView = useAppStore(s => s.setActiveView);
  const setMessages = useAppStore(s => s.setMessages);
  const setConversations = useAppStore(s => s.setConversations);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen('quick-compose-open', async () => {
      try {
        await appWindow.show();
        await appWindow.unminimize();
        await appWindow.setFocus();
      } catch {
        // best-effort focus
      }
      setOpen(true);
      setStatus(null);
    }).then(fn => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, []);

  const send = async () => {
    const prompt = text.trim();
    if (!prompt || busy) return;
    setBusy(true);
    setStatus(null);
    try {
      let conversationId = activeConversationId;
      if (!conversationId) {
        conversationId = await invoke<string>('create_conversation', {
          title: prompt.slice(0, 48) || 'Quick compose',
          characterId: null,
          modelId: currentModel || null,
          mode: 'chat',
        });
        setActiveConversation(conversationId);
      }
      await invoke('add_message', {
        conversationId,
        role: 'user',
        content: prompt,
      });
      const convs = await invoke<Conversation[]>('get_conversations');
      setConversations(convs);
      const msgs = await invoke<Message[]>('get_messages', { conversationId });
      setMessages(conversationId, msgs);
      setActiveView('chat');
      setText('');
      setOpen(false);
      setStatus('Sent to chat');
    } catch (err) {
      setStatus(String(err));
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[80] flex items-start justify-center bg-black/45 p-4 pt-[12vh]">
      <div className="w-full max-w-xl rounded-2xl border border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-950 shadow-xl p-4 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.16em] text-surface-500">Quick compose</p>
            <h2 className="font-semibold">Ctrl+Shift+Space</h2>
          </div>
          <button className="btn-secondary text-sm" onClick={() => setOpen(false)}>Close</button>
        </div>
        <textarea
          autoFocus
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void send();
            }
          }}
          rows={4}
          placeholder="Type a prompt and send it to the active chat (or a new one)…"
          className="input-field w-full resize-y"
        />
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-surface-500">{status || 'Ctrl/Cmd+Enter to send'}</p>
          <button className="btn-primary" disabled={busy || !text.trim()} onClick={() => void send()}>
            {busy ? 'Sending…' : 'Send to chat'}
          </button>
        </div>
      </div>
    </div>
  );
}
