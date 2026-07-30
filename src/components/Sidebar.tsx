import { useMemo, useState, useEffect } from 'react';
import {
  MessageSquare, Cpu, Download, Users, Settings,
  Plus, Home, Wrench, BookOpen,
  HardDrive, DatabaseBackup, HelpCircle, ImageIcon, MoreVertical,
  Edit3, Trash2, Copy, PanelLeftClose, PanelLeftOpen, Monitor, ServerCog, ShieldCheck, LibraryBig,
  Menu, ChevronDown, ChevronRight, Code2, Layers, FileText
} from 'lucide-react';
import { useAppStore } from '../store';
import { invoke } from '@tauri-apps/api/tauri';
import { AppView, Conversation, Message } from '../types';
import { FEATURE_FLAGS } from '../featureFlags';
import {
  createWorkspaceProfile,
  listWorkspaceProfiles,
  switchWorkspaceProfile,
} from '../api/powerFeatures';
import type { WorkspaceProfile } from '../codeWorkspace/types';
import {
  conversationMatchesHistoryMode,
  historyModeForView,
  historySectionTitle,
  isKnowledgeChatMode,
  isPocketCodeMode,
} from '../conversationModes';
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
  const bumpWorkspaceEpoch = useAppStore(s => s.bumpWorkspaceEpoch);

  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [busyChatId, setBusyChatId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [toolsOpen, setToolsOpen] = useState(false);
  const [profiles, setProfiles] = useState<WorkspaceProfile[]>([]);
  const [activeProfileId, setActiveProfileId] = useState('default');
  const [profileBusy, setProfileBusy] = useState(false);

  // PocketCode uses an in-layout history rail; other non-chat views hide the list.
  const historyMode = historyModeForView(activeView);
  const showHistoryList = historyMode === 'chat' || historyMode === 'knowledge' || historyMode === 'soc';

  const filteredConversations = useMemo(() => {
    if (!historyMode || !showHistoryList) return [];
    const byMode = conversations.filter(c => conversationMatchesHistoryMode(c.mode, historyMode));
    const q = search.trim().toLowerCase();
    if (!q) return byMode;
    return byMode.filter(c => safeTitle(c.title).toLowerCase().includes(q));
  }, [conversations, search, historyMode, showHistoryList]);

  const refreshConversations = async () => {
    const convs = await invoke<Conversation[]>('get_conversations');
    useAppStore.getState().setConversations(convs);
  };

  const loadProfiles = async () => {
    if (!FEATURE_FLAGS.workspaceProfiles) return;
    try {
      const rows = await listWorkspaceProfiles();
      setProfiles(rows);
      const { getActiveWorkspaceProfile } = await import('../api/powerFeatures');
      const activeId = await getActiveWorkspaceProfile();
      if (activeId && rows.some(p => p.id === activeId)) setActiveProfileId(activeId);
      else {
        const active = rows.find(p => p.is_default) || rows[0];
        if (active) setActiveProfileId(active.id);
      }
    } catch (err) {
      console.error('Failed to load workspace profiles:', err);
    }
  };

  useEffect(() => { void loadProfiles(); }, []);

  const handleProfileSwitch = async (profileId: string) => {
    if (profileId === activeProfileId || profileBusy) return;
    setProfileBusy(true);
    try {
      await switchWorkspaceProfile(profileId);
      setActiveProfileId(profileId);
      useAppStore.getState().setActiveConversation(null);
      await refreshConversations();
      bumpWorkspaceEpoch();
    } catch (err) {
      console.error('Profile switch failed:', err);
      alert(String(err));
    } finally {
      setProfileBusy(false);
    }
  };

  const handleCreateProfile = async () => {
    const name = window.prompt('New workspace profile name');
    if (!name?.trim()) return;
    setProfileBusy(true);
    try {
      const created = await createWorkspaceProfile(name.trim());
      await loadProfiles();
      await handleProfileSwitch(created.id);
    } catch (err) {
      alert(String(err));
    } finally {
      setProfileBusy(false);
    }
  };

  const handleNewChat = async () => {
    if (historyMode === 'knowledge') {
      setActiveView('knowledge-chat');
      setSidebarOpen(false);
      return;
    }
    if (historyMode === 'pocketcode' || activeView === 'code-workspace') {
      useAppStore.getState().requestNewPocketcodeSession();
      setActiveView('code-workspace');
      setSidebarOpen(false);
      return;
    }
    try {
      const id = await invoke<string>('create_conversation', {
        title: 'New Chat',
        characterId: activeCharacterId || null,
        modelId: currentModel || null,
        mode: 'chat'
      });
      setActiveConversation(id);
      useAppStore.getState().rememberConversationForMode('chat', id);
      setMessages(id, []);
      await refreshConversations();
      setActiveView('chat');
      setSidebarOpen(false);
    } catch (err) {
      console.error('Failed to create conversation:', err);
      alert(`Could not start a new chat: ${String(err)}`);
    }
  };

  const handleSelectConversation = async (id: string) => {
    const conv = conversations.find(c => c.id === id);
    if (!conv) return;
    // Never open a conversation from the wrong mode list into Chat/KC incorrectly.
    if (isPocketCodeMode(conv.mode)) {
      setActiveView('code-workspace');
      useAppStore.getState().rememberConversationForMode('pocketcode', id);
      setSidebarOpen(false);
      return;
    }
    setActiveConversation(id);
    setActiveCharacter(conv.character_id || null);
    const msgs = await invoke<Message[]>('get_messages', { conversationId: id });
    setMessages(id, msgs);
    if (isKnowledgeChatMode(conv.mode)) {
      useAppStore.getState().rememberConversationForMode('knowledge', id);
      setActiveView('knowledge-chat');
    } else if (conv.mode === 'soc') {
      useAppStore.getState().rememberConversationForMode('soc', id);
      setActiveView('soc');
    } else {
      useAppStore.getState().rememberConversationForMode('chat', id);
      setActiveView('chat');
    }
    setSidebarOpen(false);
  };

  const navigateToView = (viewId: AppView) => {
    const store = useAppStore.getState();
    const targetHistory = historyModeForView(viewId);
    if (targetHistory === 'chat') {
      const lastId = store.lastConversationIdByMode.chat;
      const last = lastId ? store.conversations.find(c => c.id === lastId && conversationMatchesHistoryMode(c.mode, 'chat')) : null;
      if (last) {
        void handleSelectConversation(last.id);
        return;
      }
      const chatOnly = store.conversations.find(c => conversationMatchesHistoryMode(c.mode, 'chat'));
      if (chatOnly) {
        void handleSelectConversation(chatOnly.id);
        return;
      }
      store.setActiveConversation(null);
    } else if (targetHistory === 'knowledge') {
      const active = store.conversations.find(c => c.id === store.activeConversationId);
      if (active && !isKnowledgeChatMode(active.mode)) {
        store.setActiveConversation(null);
      }
    } else if (targetHistory === 'pocketcode') {
      const active = store.conversations.find(c => c.id === store.activeConversationId);
      if (active && !isPocketCodeMode(active.mode)) {
        store.setActiveConversation(null);
      }
    }
    setActiveView(viewId);
    if (window.innerWidth < 768) setSidebarOpen(false);
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

  const primaryNavItems = [
    { id: 'home' as const, icon: Home, label: 'Home' },
    { id: 'chat' as const, icon: MessageSquare, label: 'Chats' },
    { id: 'soc' as const, icon: ShieldCheck, label: 'Fortinet Copilot' },
    { id: 'knowledge-chat' as const, icon: LibraryBig, label: 'Knowledge Chat' },
    ...(FEATURE_FLAGS.codeWorkspace ? [{ id: 'code-workspace' as const, icon: Code2, label: 'PocketCode' }] : []),
    { id: 'models' as const, icon: Download, label: 'Models' },
    { id: 'enterprise-server' as const, icon: ServerCog, label: 'Org Server' },
    { id: 'image-studio' as const, icon: ImageIcon, label: 'Image Studio' },
    { id: 'document-studio' as const, icon: FileText, label: 'Document Studio' },
  ];

  const toolsNavItems = [
    { id: 'hardware' as const, icon: Cpu, label: 'System' },
    { id: 'runtime' as const, icon: Monitor, label: 'Runtime' },
    { id: 'diagnostics' as const, icon: Wrench, label: 'Diagnostics' },
    { id: 'prompts' as const, icon: BookOpen, label: 'Prompts' },
    { id: 'characters' as const, icon: Users, label: 'Characters' },
    { id: 'storage' as const, icon: HardDrive, label: 'Storage' },
    { id: 'backup' as const, icon: DatabaseBackup, label: 'Backup' },
    { id: 'help' as const, icon: HelpCircle, label: 'Help' },
    { id: 'settings' as const, icon: Settings, label: 'Settings' },
  ];

  const toolsActive = toolsNavItems.some(item => item.id === activeView);

  if (!sidebarOpen) {
    // PocketCode hosts its own open-nav control in the Files toolbar.
    if (activeView === 'code-workspace') return null;
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

      <aside className="fixed left-0 top-0 h-full w-[min(20rem,calc(100vw-1rem))] md:w-72 bg-white dark:bg-black border-r border-surface-200 dark:border-white/5 flex flex-col z-40 shadow-sm">
        <div className="px-4 pt-4 pb-3 flex items-center justify-between flex-shrink-0 bg-white dark:bg-black">
          <div className="flex items-center gap-3 min-w-0">
            <img
              src="/pocketmind-logo-mark.png"
              alt="PocketMind Hybrid AI"
              className="w-10 h-10 rounded-xl shrink-0 object-cover bg-black"
              draggable={false}
            />
            <div className="min-w-0">
              <span className="app-brand-name font-black text-xl tracking-tight block truncate text-primary-400 dark:text-primary-300">PocketMind Hybrid AI</span>
              <span className="text-[11px] text-surface-500 block truncate">Offline AI workspace</span>
            </div>
          </div>
          <button
            onClick={() => setSidebarOpen(false)}
            className="p-2 rounded-xl hover:bg-surface-200 dark:hover:bg-white/5 transition-colors"
            title="Collapse navigation"
          >
            <PanelLeftClose className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-shrink-0 bg-white dark:bg-black">
          <div className="px-3 pb-3 pt-1">
            <p className="px-1 pb-2 text-[11px] font-bold uppercase tracking-[0.18em] text-surface-500">Workspace</p>
            {FEATURE_FLAGS.workspaceProfiles && profiles.length > 0 && (
              <div className="mb-2 px-1 space-y-1">
                <label className="text-[10px] font-semibold uppercase tracking-wider text-surface-400 flex items-center gap-1">
                  <Layers className="w-3 h-3" /> Profile
                </label>
                <div className="flex gap-1">
                  <select
                    value={activeProfileId}
                    disabled={profileBusy}
                    onChange={e => void handleProfileSwitch(e.target.value)}
                    className="input-field text-xs flex-1 py-1.5"
                  >
                    {profiles.map(p => (
                      <option key={p.id} value={p.id}>{p.name}{p.is_default ? ' (default)' : ''}</option>
                    ))}
                  </select>
                  <button
                    type="button"
                    disabled={profileBusy}
                    onClick={() => void handleCreateProfile()}
                    className="p-2 rounded-lg hover:bg-surface-100 dark:hover:bg-surface-800"
                    title="Create profile"
                  >
                    <Plus className="w-4 h-4" />
                  </button>
                </div>
              </div>
            )}
            <div className="max-h-[34vh] overflow-y-auto pr-1 sidebar-nav-scroll space-y-1">
              {primaryNavItems.map(item => (
                <button
                  key={item.id}
                  onClick={() => navigateToView(item.id)}
                  className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl transition-colors duration-150 ${
                    activeView === item.id
                      ? 'bg-primary-100 dark:bg-primary-950/40 text-primary-700 dark:text-primary-200'
                      : 'hover:bg-surface-100 dark:hover:bg-surface-800 text-surface-600 dark:text-surface-400 hover:text-surface-950 dark:hover:text-white'
                  }`}
                >
                  <item.icon className="w-5 h-5 shrink-0" />
                  <span className="font-semibold text-sm truncate">{item.label}</span>
                </button>
              ))}

              <div className="pt-1">
                <button
                  onClick={() => setToolsOpen(open => !open)}
                  className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl transition-colors duration-150 ${
                    toolsActive
                      ? 'bg-primary-100 dark:bg-primary-950/40 text-primary-700 dark:text-primary-200'
                      : 'hover:bg-surface-100 dark:hover:bg-surface-800 text-surface-600 dark:text-surface-400 hover:text-surface-950 dark:hover:text-white'
                  }`}
                  title="Secondary tools"
                >
                  <Menu className="w-5 h-5 shrink-0" />
                  <span className="font-semibold text-sm truncate flex-1 text-left">Tools</span>
                  {toolsOpen || toolsActive
                    ? <ChevronDown className="w-4 h-4 shrink-0 opacity-70" />
                    : <ChevronRight className="w-4 h-4 shrink-0 opacity-70" />}
                </button>
                {(toolsOpen || toolsActive) && (
                  <div className="mt-1 ml-2 pl-2 border-l border-surface-200 dark:border-surface-700 space-y-1">
                    {toolsNavItems.map(item => (
                      <button
                        key={item.id}
                        onClick={() => {
                          setActiveView(item.id);
                          setToolsOpen(true);
                          if (window.innerWidth < 768) setSidebarOpen(false);
                        }}
                        className={`w-full flex items-center gap-3 px-3 py-2 rounded-xl transition-colors duration-150 ${
                          activeView === item.id
                            ? 'bg-primary-100 dark:bg-primary-950/40 text-primary-700 dark:text-primary-200'
                            : 'hover:bg-surface-100 dark:hover:bg-surface-800 text-surface-600 dark:text-surface-400 hover:text-surface-950 dark:hover:text-white'
                        }`}
                      >
                        <item.icon className="w-4 h-4 shrink-0" />
                        <span className="font-medium text-sm truncate">{item.label}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {showHistoryList && historyMode ? (
          <div className="flex-1 min-h-0 flex flex-col p-3">
            <div className="flex items-center justify-between gap-2 mb-2 px-1 flex-shrink-0">
              <span className="text-[11px] font-bold text-surface-500 uppercase tracking-[0.18em]">
                {historySectionTitle(historyMode)}
              </span>
              <button
                onClick={() => void handleNewChat()}
                className="p-1.5 rounded-lg hover:bg-surface-200 dark:hover:bg-surface-800 transition-colors"
                title={historyMode === 'knowledge' ? 'Open Knowledge Chat' : 'New chat'}
              >
                <Plus className="w-4 h-4" />
              </button>
            </div>

            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder={historyMode === 'knowledge' ? 'Search knowledge chats…' : 'Search chats…'}
              className="input-field mb-3 text-sm flex-shrink-0 shadow-sm"
            />

            <div className="flex-1 min-h-0 overflow-y-auto pr-1 space-y-1 sidebar-chat-scroll">
              {filteredConversations.length === 0 && (
                <div className="rounded-2xl border border-dashed border-surface-300 dark:border-surface-700 p-4 text-sm text-surface-500 text-center">
                  {historyMode === 'knowledge'
                    ? 'No knowledge chats yet. Open Knowledge Chat to start.'
                    : 'No chats yet. Start a new conversation.'}
                </div>
              )}

              {filteredConversations.map(conv => {
                const active = activeConversationId === conv.id;
                const title = safeTitle(conv.title);
                return (
                  <div key={conv.id} className="relative group/chat">
                    <button
                      onClick={() => void handleSelectConversation(conv.id)}
                      disabled={busyChatId === conv.id}
                      className={`w-full text-left px-3 py-2.5 pr-10 rounded-xl text-sm transition-colors ${
                        active
                          ? 'bg-surface-100 dark:bg-surface-800 text-surface-950 dark:text-surface-50 font-semibold'
                          : 'hover:bg-surface-100 dark:hover:bg-surface-800/70 text-surface-600 dark:text-surface-400 hover:text-surface-950 dark:hover:text-white'
                      }`}
                      title={title}
                    >
                      <span className="block truncate">{title}</span>
                      <span className="block text-[11px] text-surface-500 font-normal truncate">{shortDate(conv.updated_at)}</span>
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
                        <button onClick={() => void handleRename(conv)} className="w-full flex items-center gap-2 px-3 py-2 rounded-xl text-sm hover:bg-surface-100 dark:hover:bg-surface-800">
                          <Edit3 className="w-4 h-4" /> Rename
                        </button>
                        <button onClick={() => void handleCopyChat(conv)} className="w-full flex items-center gap-2 px-3 py-2 rounded-xl text-sm hover:bg-surface-100 dark:hover:bg-surface-800">
                          <Copy className="w-4 h-4" /> Copy chat
                        </button>
                        <button onClick={() => void handleDelete(conv)} className="w-full flex items-center gap-2 px-3 py-2 rounded-xl text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30">
                          <Trash2 className="w-4 h-4" /> Delete
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="flex-1 min-h-0 p-4 text-xs text-surface-500">
            {activeView === 'code-workspace'
              ? 'Agent history lives inside PocketCode.'
              : 'Switch to Chats or Knowledge Chat to see that mode’s history.'}
          </div>
        )}

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
