import { useMemo, useState } from 'react';
import {
  MessageSquare, Cpu, Download, Users, Settings,
  Plus, Home, Wrench, BookOpen,
  HardDrive, DatabaseBackup, HelpCircle, ImageIcon, MoreVertical,
  Edit3, Trash2, Copy, PanelLeftClose, PanelLeftOpen, Monitor, ServerCog, ShieldCheck, LibraryBig
} from 'lucide-react';
import { useAppStore } from '../store';
import { invoke } from '@tauri-apps/api/tauri';
import { Conversation, Message } from '../types';

function safeTitle(title: string | null | undefined): string {
  const value = (title || '').trim();
  return value || 'Untitled chat';
}

function shortDate(ts: number): string {
  if (!ts) return '';
  try {
    return new Date(ts * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  } catch {
    return '';
  }
}

export default function Sidebar() {
  const sidebarOpen = useAppStore(s => s.sidebarOpen);
  const setSidebarOpen = useAppStore(s => s.setSidebarOpen);
  const activeView = useAppStore(s => s.activeView);
  const setActiveView = useAppStore(s => s.setActiveView);
  const conversations = useAppStore(s => s.conversations);
  const activeConversationId = useAppStore(s => s.activeConversationId);
  const activeCharacterId = useAppStore(s => s.activeCharacterId);
  const setActiveConversation = useAppStore(s => s.setActiveConversation);
  const setActiveCharacter = useAppStore(s => s.setActiveCharacter);
  const setMessages = useAppStore(s => s.setMessages);
  const setupCompleted = useAppStore(s => s.setupCompleted);
  const currentModel = useAppStore(s => s.currentModel);

  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [busyChatId, setBusyChatId] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  const filteredConversations = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return conversations;
    return conversations.filter(c => safeTitle(c.title).toLowerCase().includes(q));
  }, [conversations, search]);

  const refreshConversations = async () => {
    const convs = await invoke<Conversation[]>('get_conversations');
    useAppStore.getState().setConversations(convs);
  };

  const handleNewChat = async () => {
    try {
      const id = await invoke<string>('create_conversation', {
        title: 'New Chat',
        characterId: activeCharacterId || null,
        modelId: currentModel || null,
        mode: 'chat'
      });
      setActiveConversation(id);
      setMessages(id, []);
      await refreshConversations();
      setActiveView('chat');
      setSidebarOpen(false);
    } catch (err) {
      console.error('Failed to create conversation:', err);
    }
  };

  const handleSelectConversation = async (id: string) => {
    setActiveConversation(id);
    const conv = conversations.find(c => c.id === id);
    setActiveCharacter(conv?.character_id || null);
    const msgs = await invoke<Message[]>('get_messages', { conversationId: id });
    setMessages(id, msgs);
    setActiveView('chat');
    setSidebarOpen(false);
  };

  const handleRename = async (conv: Conversation) => {
    setOpenMenuId(null);
    const next = window.prompt('Rename chat', safeTitle(conv.title));
    if (next === null) return;
    const clean = next.trim().slice(0, 80);
    if (!clean) return;
    setBusyChatId(conv.id);
    try {
      await invoke('update_conversation_title', { id: conv.id, title: clean });
      useAppStore.getState().renameConversationLocal(conv.id, clean);
      await refreshConversations();
    } catch (err) {
      console.error('Failed to rename chat:', err);
      alert(`Rename failed: ${String(err)}`);
    } finally {
      setBusyChatId(null);
    }
  };

  const handleDelete = async (conv: Conversation) => {
    setOpenMenuId(null);
    if (!confirm(`Delete "${safeTitle(conv.title)}"? This cannot be undone.`)) return;
    setBusyChatId(conv.id);
    try {
      await invoke('delete_conversation', { id: conv.id });
      useAppStore.getState().removeConversationLocal(conv.id);
      await refreshConversations();
      if (activeConversationId === conv.id) setActiveView('chat');
    } catch (err) {
      console.error('Failed to delete chat:', err);
      alert(`Delete failed: ${String(err)}`);
    } finally {
      setBusyChatId(null);
    }
  };

  const handleCopyChat = async (conv: Conversation) => {
    setOpenMenuId(null);
    try {
      const msgs = await invoke<Message[]>('get_messages', { conversationId: conv.id });
      const text = msgs.map(m => `${m.role.toUpperCase()}:\n${m.content}`).join('\n\n---\n\n');
      await navigator.clipboard.writeText(text || safeTitle(conv.title));
    } catch (err) {
      console.error('Failed to copy chat:', err);
    }
  };

  const navItems = [
    { id: 'home' as const, icon: Home, label: 'Home' },
    { id: 'chat' as const, icon: MessageSquare, label: 'Chats' },
    { id: 'soc' as const, icon: ShieldCheck, label: 'Fortinet Copilot' },
    { id: 'knowledge-chat' as const, icon: LibraryBig, label: 'Knowledge Chat' },
    { id: 'hardware' as const, icon: Cpu, label: 'System' },
    { id: 'runtime' as const, icon: Monitor, label: 'Runtime' },
    { id: 'models' as const, icon: Download, label: 'Models' },
    { id: 'enterprise-server' as const, icon: ServerCog, label: 'Org Server' },
    { id: 'image-studio' as const, icon: ImageIcon, label: 'Image Studio' },
    { id: 'diagnostics' as const, icon: Wrench, label: 'Diagnostics' },
    { id: 'prompts' as const, icon: BookOpen, label: 'Prompts' },
    { id: 'storage' as const, icon: HardDrive, label: 'Storage' },
    { id: 'backup' as const, icon: DatabaseBackup, label: 'Backup' },
    { id: 'characters' as const, icon: Users, label: 'Characters' },
    { id: 'help' as const, icon: HelpCircle, label: 'Help' },
    { id: 'settings' as const, icon: Settings, label: 'Settings' },
  ];

  if (!sidebarOpen) {
    return (
      <button
        onClick={() => setSidebarOpen(true)}
        className="fixed left-4 top-4 z-50 p-3 rounded-xl bg-white dark:bg-surface-900 hover:bg-surface-100 dark:hover:bg-surface-800 transition-colors shadow-sm border border-surface-200 dark:border-surface-700 text-surface-800 dark:text-surface-100"
        title="Open navigation"
      >
        <PanelLeftOpen className="w-5 h-5" />
      </button>
    );
  }

  return (
    <>
      <button
        className="fixed inset-0 z-30 bg-black/40 md:hidden"
        onClick={() => setSidebarOpen(false)}
        aria-label="Close navigation overlay"
      />

      <aside className="fixed left-0 top-0 h-full w-[min(20rem,calc(100vw-1rem))] md:w-72 bg-white dark:bg-surface-950 border-r border-surface-200 dark:border-surface-800 flex flex-col z-40 shadow-sm">
        <div className="p-4 flex items-center justify-between border-b border-surface-200 dark:border-surface-800 flex-shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 rounded-xl bg-sky-600 flex items-center justify-center shrink-0">
              <MessageSquare className="w-5 h-5 text-white" />
            </div>
            <div className="min-w-0">
              <span className="font-black text-lg tracking-tight block truncate text-surface-950 dark:text-white">NexusAI</span>
              <span className="text-[11px] text-surface-500 block truncate">Offline AI workspace</span>
            </div>
          </div>
          <button
            onClick={() => setSidebarOpen(false)}
            className="p-2 rounded-xl hover:bg-surface-200 dark:hover:bg-surface-800 transition-colors"
            title="Collapse navigation"
          >
            <PanelLeftClose className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-shrink-0 border-b border-surface-200 dark:border-surface-800">
          <div className="px-3 py-3">
            <p className="px-1 pb-2 text-[11px] font-bold uppercase tracking-[0.18em] text-surface-500">Workspace</p>
            <div className="max-h-[34vh] overflow-y-auto pr-1 sidebar-nav-scroll space-y-1">
              {navItems.map(item => (
                <button
                  key={item.id}
                  onClick={() => {
                    setActiveView(item.id);
                    if (window.innerWidth < 768) setSidebarOpen(false);
                  }}
                  className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl transition-colors duration-150 ${
                    activeView === item.id
                      ? 'bg-sky-100 dark:bg-sky-950/40 text-sky-700 dark:text-sky-200'
                      : 'hover:bg-surface-100 dark:hover:bg-surface-800 text-surface-600 dark:text-surface-400 hover:text-surface-950 dark:hover:text-white' 
                  }`}
                >
                  <item.icon className="w-5 h-5 shrink-0" />
                  <span className="font-semibold text-sm truncate">{item.label}</span>
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="flex-1 min-h-0 flex flex-col p-3">
          <div className="flex items-center justify-between gap-2 mb-2 px-1 flex-shrink-0">
            <span className="text-[11px] font-bold text-surface-500 uppercase tracking-[0.18em]">Chats</span>
            <button onClick={handleNewChat} className="p-1.5 rounded-lg hover:bg-surface-200 dark:hover:bg-surface-800 transition-colors" title="New chat">
              <Plus className="w-4 h-4" />
            </button>
          </div>

          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search chats..."
            className="input-field mb-3 text-sm flex-shrink-0 shadow-sm"
          />

          <div className="flex-1 min-h-0 overflow-y-auto pr-1 space-y-1 sidebar-chat-scroll">
            {filteredConversations.length === 0 && (
              <div className="rounded-2xl border border-dashed border-surface-300 dark:border-surface-700 p-4 text-sm text-surface-500 text-center">
                No chats yet. Start a new conversation.
              </div>
            )}

            {filteredConversations.map(conv => {
              const active = activeConversationId === conv.id;
              const title = safeTitle(conv.title);
              return (
                <div key={conv.id} className="relative group/chat">
                  <button
                    onClick={() => handleSelectConversation(conv.id)}
                    disabled={busyChatId === conv.id}
                    className={`w-full text-left px-3 py-2.5 pr-10 rounded-xl text-sm transition-colors ${
                      active
                        ? 'bg-surface-100 dark:bg-surface-800 text-surface-950 dark:text-surface-50 font-semibold'
                        : 'hover:bg-surface-100 dark:hover:bg-surface-800/70 text-surface-600 dark:text-surface-400 hover:text-surface-950 dark:hover:text-white' 
                    }`}
                    title={title}
                  >
                    <span className="block truncate">{title}</span>
                    <span className="block text-[11px] text-surface-500 font-normal truncate">{shortDate(conv.updated_at)} • {conv.mode || 'chat'}</span>
                  </button>

                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setOpenMenuId(openMenuId === conv.id ? null : conv.id);
                    }}
                    className={`absolute right-2 top-2 p-1.5 rounded-lg transition-colors ${openMenuId === conv.id ? 'bg-surface-300 dark:bg-surface-700' : 'opacity-100 md:opacity-0 md:group-hover/chat:opacity-100 hover:bg-surface-300 dark:hover:bg-surface-700'}`}
                    title="Chat options"
                  >
                    <MoreVertical className="w-4 h-4" />
                  </button>

                  {openMenuId === conv.id && (
                    <div className="absolute right-2 top-10 z-50 w-44 rounded-xl border border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-900 shadow-md p-1">
                      <button onClick={() => handleRename(conv)} className="w-full flex items-center gap-2 px-3 py-2 rounded-xl text-sm hover:bg-surface-100 dark:hover:bg-surface-800">
                        <Edit3 className="w-4 h-4" /> Rename
                      </button>
                      <button onClick={() => handleCopyChat(conv)} className="w-full flex items-center gap-2 px-3 py-2 rounded-xl text-sm hover:bg-surface-100 dark:hover:bg-surface-800">
                        <Copy className="w-4 h-4" /> Copy chat
                      </button>
                      <button onClick={() => handleDelete(conv)} className="w-full flex items-center gap-2 px-3 py-2 rounded-xl text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30">
                        <Trash2 className="w-4 h-4" /> Delete
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        <div className="p-4 border-t border-surface-200 dark:border-surface-800 flex-shrink-0">
          <div className="flex items-center gap-2 text-xs text-surface-500">
            <div className="w-2 h-2 rounded-full bg-green-500" />
            <span className="truncate">{setupCompleted ? 'Ready' : 'Setup incomplete'} • {currentModel?.startsWith('enterprise:') ? 'server' : currentModel?.startsWith('remote:') ? 'online' : 'local'}</span>
          </div>
        </div>
      </aside>
    </>
  );
}
