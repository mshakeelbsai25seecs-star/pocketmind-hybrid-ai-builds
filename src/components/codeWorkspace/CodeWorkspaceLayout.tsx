import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { open } from '@tauri-apps/api/dialog';
import { invoke } from '@tauri-apps/api/tauri';
import {
  FolderOpen, Square, ChevronRight, ChevronDown, ChevronLeft, File, Folder,
  RefreshCw, AlertCircle, Plus, RotateCcw, ArrowUp, ImagePlus, X, Mic, PanelLeftOpen,
} from 'lucide-react';
import { useAppStore } from '../../store';
import { FEATURE_FLAGS } from '../../featureFlags';
import {
  cwApplyEditWrite,
  cwCanUse,
  cwEnsureSymbolIndex,
  cwListCheckpoints,
  cwListDir,
  cwPlanUpdateMarkdown,
  cwPlanUpdateStatus,
  cwReadFile,
  cwRestoreCheckpoint,
  type CheckpointSummary,
} from '../../api/codeWorkspace';
import type { AgentStep, DirEntryInfo, PocketCodeImageAttach, PocketCodePlan } from '../../codeWorkspace/types';
import type { Conversation, Message } from '../../types';
import {
  MODE_PLACEHOLDERS,
  cycleMode,
  parseAgentMode,
  type PocketCodeAgentMode,
} from '../../codeWorkspace/agentModes';
import {
  ATTACH_FILE_FILTERS,
  chipForPath,
  prepareAttachmentsForModel,
} from '../../attachments/prepareAttachments';
import AgentTranscript from './AgentTranscript';
import SandboxPanel from './SandboxPanel';
import ComposerModelBar from './ComposerModelBar';
import PaneResizeHandle from './PaneResizeHandle';
import PlanReviewPanel from './PlanReviewPanel';
import ServerBackendStrip, { preflightEnterprise } from './ServerBackendStrip';
import { agentSession, useAgentSession } from './agentSession';
import { getSetting, setSetting } from '../../api/powerFeatures';
import { conversationMatchesHistoryMode } from '../../conversationModes';
import {
  cleanupTranscript,
  recordMicrophone,
  resolveVoiceEngine,
  startBrowserDictation,
  transcribeWithWhisper,
} from '../../voice/dictate';
import { refreshLocalVisionCapability } from '../../codeWorkspace/visionCapability';

function TreeNode({
  workspaceRoot,
  entry,
  depth,
  selectedPath,
  onSelect,
}: {
  workspaceRoot: string;
  entry: DirEntryInfo;
  depth: number;
  selectedPath: string | null;
  onSelect: (path: string, isDir: boolean) => void;
}) {
  const [openDir, setOpenDir] = useState(depth < 2);
  const [children, setChildren] = useState<DirEntryInfo[]>([]);
  const [loading, setLoading] = useState(false);

  const loadChildren = useCallback(async () => {
    if (!entry.is_dir) return;
    setLoading(true);
    try {
      const rows = await cwListDir(workspaceRoot, entry.path);
      setChildren(rows.sort((a, b) => Number(b.is_dir) - Number(a.is_dir) || a.name.localeCompare(b.name)));
    } catch {
      setChildren([]);
    } finally {
      setLoading(false);
    }
  }, [entry.is_dir, entry.path, workspaceRoot]);

  useEffect(() => {
    if (openDir && entry.is_dir && children.length === 0) void loadChildren();
  }, [openDir, entry.is_dir, children.length, loadChildren]);

  const active = selectedPath === entry.path;

  if (!entry.is_dir) {
    return (
      <button
        type="button"
        onClick={() => onSelect(entry.path, false)}
        className={`w-full flex items-center gap-1.5 py-1 pr-2 rounded-lg text-left text-xs truncate ${active ? 'bg-primary-100 dark:bg-primary-950/40 text-primary-700 dark:text-primary-200' : 'hover:bg-surface-100 dark:hover:bg-surface-800'}`}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
      >
        <File className="w-3.5 h-3.5 shrink-0 opacity-70" />
        <span className="truncate">{entry.name}</span>
      </button>
    );
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => { setOpenDir(v => !v); onSelect(entry.path, true); }}
        className={`w-full flex items-center gap-1 py-1 pr-2 rounded-lg text-left text-xs truncate ${active ? 'bg-primary-100 dark:bg-primary-950/40' : 'hover:bg-surface-100 dark:hover:bg-surface-800'}`}
        style={{ paddingLeft: `${depth * 12 + 4}px` }}
      >
        {openDir ? <ChevronDown className="w-3.5 h-3.5 shrink-0" /> : <ChevronRight className="w-3.5 h-3.5 shrink-0" />}
        <Folder className="w-3.5 h-3.5 shrink-0 text-amber-500" />
        <span className="truncate font-medium">{entry.name}</span>
        {loading && <RefreshCw className="w-3 h-3 ml-auto animate-spin opacity-50" />}
      </button>
      {openDir && children.map(child => (
        <TreeNode
          key={child.path}
          workspaceRoot={workspaceRoot}
          entry={child}
          depth={depth + 1}
          selectedPath={selectedPath}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}

function stepsToTranscriptText(steps: AgentStep[]): string {
  return steps.map(s => {
    if (s.kind === 'tool') return `[tool ${s.tool}] ${s.toolResult || s.content}`;
    return `[${s.kind}] ${s.content}`;
  }).join('\n\n');
}

function mimeFromPath(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.bmp')) return 'image/bmp';
  return 'image/jpeg';
}

function basename(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || path;
}

export default function CodeWorkspaceLayout() {
  const currentModel = useAppStore(s => s.currentModel);
  const defaultParams = useAppStore(s => s.defaultParams);
  const conversations = useAppStore(s => s.conversations);
  const setConversations = useAppStore(s => s.setConversations);
  const setActiveConversation = useAppStore(s => s.setActiveConversation);
  const setMessages = useAppStore(s => s.setMessages);
  const rememberConversationForMode = useAppStore(s => s.rememberConversationForMode);
  const setActiveView = useAppStore(s => s.setActiveView);
  const lastPocketId = useAppStore(s => s.lastConversationIdByMode.pocketcode);
  const allMessages = useAppStore(s => s.messages);
  const sidebarOpen = useAppStore(s => s.sidebarOpen);
  const setSidebarOpen = useAppStore(s => s.setSidebarOpen);
  const session = useAgentSession();

  const [workspaceRoot, setWorkspaceRoot] = useState('');
  const [tree, setTree] = useState<DirEntryInfo[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [openFilePath, setOpenFilePath] = useState<string | null>(null);
  const [editorContent, setEditorContent] = useState('');
  const [editorError, setEditorError] = useState<string | null>(null);
  const [task, setTask] = useState('');
  const [gateReason, setGateReason] = useState<string | null>(null);
  const [gateAllowed, setGateAllowed] = useState(false);
  const [localStatus, setLocalStatus] = useState<string | null>(null);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [threadTitle, setThreadTitle] = useState('New agent chat');
  const [checkpoints, setCheckpoints] = useState<CheckpointSummary[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [agentMode, setAgentMode] = useState<PocketCodeAgentMode>('agent');
  const [reviewPlan, setReviewPlan] = useState<PocketCodePlan | null>(null);
  const [attachments, setAttachments] = useState<PocketCodeImageAttach[]>([]);
  const [lastFailedPrompt, setLastFailedPrompt] = useState<string | null>(null);
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [voiceRecording, setVoiceRecording] = useState(false);
  const [voiceEngineLabel, setVoiceEngineLabel] = useState('');
  const voiceSessionRef = useRef<{ stop: () => Promise<unknown> } | null>(null);
  /** Prompt for the in-flight / just-finished live agent run (shown in top bar). */
  const [liveQuery, setLiveQuery] = useState<string | null>(null);
  /** Which historical turn is focused when not in a live run (-1 = latest). */
  const [activeTurnIndex, setActiveTurnIndex] = useState(-1);
  const [leftPanePx, setLeftPanePx] = useState(220);
  const [rightPanePx, setRightPanePx] = useState(380);
  const [wideLayout, setWideLayout] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia('(min-width: 1024px)').matches : true,
  );
  const panePersistTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const pocketThreads = useMemo(
    () => conversations
      .filter(c => conversationMatchesHistoryMode(c.mode, 'pocketcode'))
      .sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0)),
    [conversations],
  );

  const refreshConversations = useCallback(async () => {
    try {
      const convs = await invoke<Conversation[]>('get_conversations');
      setConversations(convs);
    } catch {
      /* ignore */
    }
  }, [setConversations]);

  const refreshCheckpoints = useCallback(async (root?: string) => {
    const r = root ?? workspaceRoot;
    if (!r) {
      setCheckpoints([]);
      return;
    }
    try {
      setCheckpoints(await cwListCheckpoints(r));
    } catch {
      setCheckpoints([]);
    }
  }, [workspaceRoot]);

  useEffect(() => {
    void getSetting('cw.workspace_root').then(v => { if (v) setWorkspaceRoot(v); });
    void getSetting('cw.agent_mode').then(v => setAgentMode(parseAgentMode(v)));
    void getSetting('cw.pane_left_px').then(v => {
      const n = Number(v);
      if (Number.isFinite(n) && n >= 160 && n <= 520) setLeftPanePx(n);
    });
    void getSetting('cw.pane_right_px').then(v => {
      const n = Number(v);
      if (Number.isFinite(n) && n >= 280 && n <= 720) setRightPanePx(n);
    });
  }, []);

  const persistPaneWidths = useCallback((left: number, right: number) => {
    if (panePersistTimer.current) clearTimeout(panePersistTimer.current);
    panePersistTimer.current = setTimeout(() => {
      void setSetting('cw.pane_left_px', String(Math.round(left)));
      void setSetting('cw.pane_right_px', String(Math.round(right)));
    }, 250);
  }, []);

  const onResizeLeft = useCallback((dx: number) => {
    setLeftPanePx(prev => {
      const next = Math.min(520, Math.max(160, prev + dx));
      persistPaneWidths(next, rightPanePx);
      return next;
    });
  }, [persistPaneWidths, rightPanePx]);

  const onResizeRight = useCallback((dx: number) => {
    setRightPanePx(prev => {
      // Handle sits on the left edge of the agent pane: drag right shrinks it.
      const next = Math.min(720, Math.max(280, prev - dx));
      persistPaneWidths(leftPanePx, next);
      return next;
    });
  }, [persistPaneWidths, leftPanePx]);

  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1024px)');
    const apply = () => setWideLayout(mq.matches);
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);

  useEffect(() => {
    void refreshLocalVisionCapability(currentModel);
  }, [currentModel]);

  const toggleVoice = async () => {
    if (voiceBusy) return;
    if (voiceRecording && voiceSessionRef.current) {
      setVoiceBusy(true);
      try {
        const result = await voiceSessionRef.current.stop();
        voiceSessionRef.current = null;
        setVoiceRecording(false);
        let text = '';
        if (result instanceof Blob) {
          setVoiceEngineLabel('Whisper…');
          text = await transcribeWithWhisper(result);
        } else {
          text = String(result || '');
        }
        text = cleanupTranscript(text);
        if (text) {
          setTask(prev => (prev.trim() ? `${prev.trim()} ${text}` : text));
          setLocalStatus(`Dictated via ${voiceEngineLabel || 'voice'}.`);
        }
      } catch (err) {
        setLocalStatus(String(err));
      } finally {
        setVoiceBusy(false);
        setVoiceEngineLabel('');
      }
      return;
    }

    setVoiceBusy(true);
    try {
      const engine = await resolveVoiceEngine('auto');
      setVoiceEngineLabel(engine === 'whisper' ? 'Whisper' : 'Browser');
      if (engine === 'whisper') {
        const session = await recordMicrophone();
        voiceSessionRef.current = { stop: session.stop };
      } else {
        const session = startBrowserDictation({
          onInterim: (t) => setLocalStatus(`Listening… ${t.slice(0, 80)}`),
        });
        voiceSessionRef.current = session;
      }
      setVoiceRecording(true);
      setLocalStatus(`Listening (${engine === 'whisper' ? 'Whisper on stop' : 'Browser speech'})… tap mic again to finish.`);
    } catch (err) {
      setLocalStatus(String(err));
      voiceSessionRef.current = null;
      setVoiceRecording(false);
    } finally {
      setVoiceBusy(false);
    }
  };

  useEffect(() => {
    void cwCanUse(currentModel).then(g => {
      setGateAllowed(g.allowed);
      setGateReason(g.reason);
    });
  }, [currentModel]);

  useEffect(() => {
    if (session.lastPlan) setReviewPlan(session.lastPlan);
  }, [session.lastPlan]);

  const changeMode = useCallback(async (next: PocketCodeAgentMode) => {
    if (next === agentMode) return;
    if (session.running) {
      if (!confirm('Stop the current run and switch mode?')) return;
      agentSession.stop();
    }
    setAgentMode(next);
    await setSetting('cw.agent_mode', next);
  }, [agentMode, session.running]);

  const refreshTree = useCallback(async (root?: string) => {
    const r = root ?? workspaceRoot;
    if (!r) return;
    try {
      const entries = await cwListDir(r, '.');
      setTree(entries.sort((a, b) => Number(b.is_dir) - Number(a.is_dir) || a.name.localeCompare(b.name)));
    } catch (err) {
      setLocalStatus(String(err));
    }
  }, [workspaceRoot]);

  useEffect(() => {
    if (workspaceRoot) {
      void refreshTree(workspaceRoot);
      void refreshCheckpoints(workspaceRoot);
      void cwEnsureSymbolIndex(workspaceRoot).catch(() => undefined);
    }
  }, [workspaceRoot, refreshTree, refreshCheckpoints]);

  useEffect(() => {
    void refreshConversations();
  }, [refreshConversations]);

  useEffect(() => {
    if (threadId) return;
    if (lastPocketId && pocketThreads.some(t => t.id === lastPocketId)) {
      setThreadId(lastPocketId);
      const t = pocketThreads.find(x => x.id === lastPocketId);
      if (t) setThreadTitle(t.title || 'Agent chat');
    }
  }, [lastPocketId, pocketThreads, threadId]);

  const pickFolder = async () => {
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected !== 'string' || !selected) return;
    setWorkspaceRoot(selected);
    await setSetting('cw.workspace_root', selected);
    setSelectedPath(null);
    setOpenFilePath(null);
    setEditorContent('');
    await refreshTree(selected);
  };

  const openFile = async (path: string) => {
    if (!workspaceRoot) return;
    setSelectedPath(path);
    setOpenFilePath(path);
    setEditorError(null);
    try {
      const text = await cwReadFile(workspaceRoot, path, 0, 4000, true);
      setEditorContent(text);
    } catch (err) {
      setEditorContent('');
      setEditorError(String(err));
    }
  };

  const ensureThread = async (firstTask: string): Promise<string> => {
    if (threadId) return threadId;
    const title = firstTask.trim().slice(0, 60) || 'New agent chat';
    const id = await invoke<string>('create_conversation', {
      title,
      characterId: null,
      modelId: currentModel || null,
      mode: 'pocketcode',
    });
    setThreadId(id);
    setThreadTitle(title);
    setActiveConversation(id);
    rememberConversationForMode('pocketcode', id);
    setMessages(id, []);
    await refreshConversations();
    return id;
  };

  const persistUserAndAssistant = async (
    convId: string,
    userText: string,
    summary: string,
    steps: AgentStep[],
  ) => {
    const userMsg: Message = {
      id: `${Date.now()}-u`,
      conversation_id: convId,
      role: 'user',
      content: userText,
      created_at: Math.floor(Date.now() / 1000),
    };
    const assistantBody = [
      summary,
      '',
      '---',
      'Agent transcript',
      stepsToTranscriptText(steps),
    ].join('\n');
    const asstMsg: Message = {
      id: `${Date.now()}-a`,
      conversation_id: convId,
      role: 'assistant',
      content: assistantBody,
      created_at: Math.floor(Date.now() / 1000),
    };
    const userMsgId = await invoke<string>('add_message', {
      conversationId: convId,
      role: 'user',
      content: userText,
      metadata: null,
    });
    const assistantMsgId = await invoke<string>('add_message', {
      conversationId: convId,
      role: 'assistant',
      content: assistantBody,
      metadata: null,
    });
    const existing = useAppStore.getState().messages[convId] || [];
    setMessages(convId, [
      ...existing,
      { ...userMsg, id: userMsgId },
      { ...asstMsg, id: assistantMsgId },
    ]);
    await refreshConversations();
  };

  useEffect(() => {
    setAttachments(prev => prev.map(f => {
      const chip = chipForPath(f.path, currentModel);
      return {
        ...f,
        kind: chip.kind,
        understand: chip.understand,
        notice: chip.notice,
      };
    }));
  }, [currentModel]);

  const attachFiles = async () => {
    const selected = await open({
      multiple: true,
      filters: ATTACH_FILE_FILTERS,
    });
    if (!selected) return;
    const paths = Array.isArray(selected) ? selected : [selected];
    const next: PocketCodeImageAttach[] = paths.map(path => {
      const chip = chipForPath(path, currentModel);
      return {
        path,
        name: chip.name,
        mime: mimeFromPath(path),
        kind: chip.kind,
        understand: chip.understand,
        notice: chip.notice,
      };
    });
    setAttachments(prev => [...prev, ...next].slice(0, 6));
  };

  const runAgent = async (override?: {
    prompt?: string;
    mode?: PocketCodeAgentMode;
    clearTask?: boolean;
  }) => {
    if (!FEATURE_FLAGS.codeWorkspace || !workspaceRoot || !currentModel) return;
    const prompt = (override?.prompt ?? task).trim();
    if (!prompt && attachments.length === 0) return;
    if (!gateAllowed) {
      setLocalStatus(gateReason || 'Model not allowed for PocketCode.');
      return;
    }

    const mode = override?.mode ?? agentMode;
    setLocalStatus(null);

    const pre = await preflightEnterprise(currentModel);
    if (!pre.ok) {
      setLocalStatus(pre.message);
      setLastFailedPrompt(prompt || task.trim());
      return;
    }

    const prepared = await prepareAttachmentsForModel(
      attachments.map(a => a.path),
      currentModel,
      { maxCharsPerFile: 12_000, maxTotalChars: 24_000, pdfPages: 3 },
    );
    if (prepared.notices.length) setLocalStatus(prepared.notices.join(' · '));

    const fullPrompt = `${prompt || '(See attached files)'}${prepared.textBlock}`;
    const images = prepared.images;
    const convId = await ensureThread(fullPrompt);
    setLiveQuery(fullPrompt);
    setActiveTurnIndex(-1);
    if (override?.clearTask !== false) {
      setTask('');
      setAttachments([]);
    }
    setLastFailedPrompt(null);

    await agentSession.start({
      workspaceRoot,
      task: fullPrompt,
      modelPath: currentModel,
      params: defaultParams,
      mode,
      images: images.length > 0 ? images : undefined,
      onApplyWrite: async (path, content) => {
        await cwApplyEditWrite(workspaceRoot, path, content);
        await refreshTree();
        if (openFilePath === path) {
          setEditorContent(content);
        }
      },
      onAfterDone: async (summary, steps) => {
        try {
          await persistUserAndAssistant(convId, fullPrompt, summary, steps);
        } catch (err) {
          console.warn('Failed to persist PocketCode thread:', err);
        }
        await refreshCheckpoints();
        if (mode === 'plan' && agentSession.getSnapshot().lastPlan) {
          setReviewPlan(agentSession.getSnapshot().lastPlan);
        }
      },
    });

    if (agentSession.getSnapshot().lastError) {
      setLastFailedPrompt(fullPrompt);
    }
  };

  const buildPlan = async () => {
    if (!reviewPlan || !workspaceRoot) return;
    let plan = reviewPlan;
    try {
      plan = await cwPlanUpdateStatus(workspaceRoot, plan.id, 'approved');
      setReviewPlan(plan);
    } catch {
      /* keep in-memory plan */
    }
    await changeMode('agent');
    const seed = [
      'Implement the following approved plan. Follow the steps; edit/create files as needed; use the sandbox to verify.',
      '',
      `# ${plan.title}`,
      '',
      plan.markdown,
      '',
      plan.todos.length
        ? `Todos:\n${plan.todos.map((t, i) => `${i + 1}. ${t.text}`).join('\n')}`
        : '',
    ].filter(Boolean).join('\n');
    setTask(seed);
    await runAgent({ prompt: seed, mode: 'agent', clearTask: true });
    try {
      await cwPlanUpdateStatus(workspaceRoot, plan.id, 'built', agentSession.getSnapshot().checkpointRunId);
    } catch {
      /* ignore */
    }
  };

  const newAgentChat = () => {
    setThreadId(null);
    setThreadTitle('New agent chat');
    setLiveQuery(null);
    setActiveTurnIndex(-1);
    agentSession.stop();
    setLocalStatus(null);
    setReviewPlan(null);
    agentSession.setLastPlan(null);
  };

  const selectThread = async (conv: Conversation) => {
    setThreadId(conv.id);
    setThreadTitle(conv.title || 'Agent chat');
    setLiveQuery(null);
    setActiveTurnIndex(-1);
    rememberConversationForMode('pocketcode', conv.id);
    setActiveConversation(conv.id);
    try {
      const msgs = await invoke<Message[]>('get_messages', { conversationId: conv.id });
      setMessages(conv.id, msgs);
    } catch {
      /* ignore */
    }
  };

  const restoreRun = async (runId: string) => {
    if (!workspaceRoot) return;
    if (!confirm(`Restore all files from checkpoint ${runId}?`)) return;
    try {
      const n = await cwRestoreCheckpoint(workspaceRoot, runId);
      setLocalStatus(`Restored ${n} file(s) from checkpoint ${runId}.`);
      await refreshTree();
      if (openFilePath) await openFile(openFilePath);
    } catch (err) {
      setLocalStatus(String(err));
    }
  };

  const folderLabel = useMemo(() => {
    if (!workspaceRoot) return 'No folder';
    const parts = workspaceRoot.replace(/[\\/]+$/, '').split(/[/\\]/);
    return parts[parts.length - 1] || workspaceRoot;
  }, [workspaceRoot]);
  const status = session.status ?? localStatus;
  const busy = session.running;
  const showInlineSandbox =
    FEATURE_FLAGS.codeWorkspaceSandbox
    && (session.sandboxPending != null || session.sandboxResult != null)
    && !session.autoApproveSandbox;

  const storedMessages = threadId ? (allMessages[threadId] || []) : [];
  const [checkpointsOpen, setCheckpointsOpen] = useState(false);

  const turns = useMemo(() => {
    const out: { user: Message; assistants: Message[] }[] = [];
    let cur: { user: Message; assistants: Message[] } | null = null;
    for (const m of storedMessages) {
      if (m.role === 'user') {
        cur = { user: m, assistants: [] };
        out.push(cur);
      } else if (cur) {
        cur.assistants.push(m);
      }
    }
    return out;
  }, [storedMessages]);

  /** Explicit history focus; -1 means latest / live run. */
  const viewingHistoryTurn = !busy && activeTurnIndex >= 0 && activeTurnIndex < turns.length;
  const latestTurnIndex = Math.max(0, turns.length - 1);
  const focusedTurnIndex = viewingHistoryTurn ? activeTurnIndex : latestTurnIndex;
  const focusedTurn = turns.length > 0 ? turns[focusedTurnIndex] : null;
  const headerQuery = (
    viewingHistoryTurn
      ? focusedTurn?.user.content
      : (liveQuery || focusedTurn?.user.content || null)
  ) || (threadId ? threadTitle : 'New agent chat');
  const showLiveSteps = !viewingHistoryTurn && session.steps.length > 0;
  const canPrevTurn = turns.length > 1 && focusedTurnIndex > 0 && !busy;
  const canNextTurn = turns.length > 1 && viewingHistoryTurn && focusedTurnIndex < latestTurnIndex && !busy;

  return (
    <div className="flex-1 flex flex-col h-full min-w-0 bg-white dark:bg-surface-950">
      {!gateAllowed && (
        <div className="mx-3 mt-2 rounded-xl border border-amber-300/60 bg-amber-50 dark:bg-amber-950/20 p-2.5 text-xs text-amber-800 dark:text-amber-200 flex gap-2">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          {gateReason || 'Select a ≥30B local model, an online model, or an org server model for PocketCode.'}
        </div>
      )}

      <ServerBackendStrip
        onOpenOrgServer={() => setActiveView('enterprise-server')}
        lastError={session.lastError || (localStatus && currentModel?.startsWith('enterprise:') ? localStatus : null)}
        onRetry={lastFailedPrompt ? () => void runAgent({ prompt: lastFailedPrompt, clearTask: false }) : undefined}
      />

      <div className="flex-1 min-h-0 flex flex-col lg:flex-row">
        <aside
          className="overflow-y-auto p-1.5 bg-surface-50/80 dark:bg-surface-950/40 min-h-[10rem] lg:min-h-0 lg:h-full shrink-0 border-b lg:border-b-0 border-surface-200 dark:border-surface-800"
          style={wideLayout ? { width: leftPanePx } : { width: '100%' }}
        >
          <div className="flex items-center gap-0.5 px-1 py-0.5 mb-0.5 sticky top-0 z-10 bg-surface-50/95 dark:bg-surface-950/90 backdrop-blur-sm">
            <div className="min-w-0 flex-1 px-1">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-surface-500">Files</p>
              <p className="text-[11px] text-surface-700 dark:text-surface-300 truncate" title={workspaceRoot || undefined}>
                {folderLabel}
              </p>
            </div>
            {!sidebarOpen && (
              <button
                type="button"
                onClick={() => setSidebarOpen(true)}
                className="p-1 rounded-md text-surface-500 hover:bg-surface-200/80 dark:hover:bg-surface-800"
                title="Open navigation"
              >
                <PanelLeftOpen className="w-3.5 h-3.5" />
              </button>
            )}
            <button
              type="button"
              onClick={() => void pickFolder()}
              className="p-1 rounded-md text-surface-500 hover:bg-surface-200/80 dark:hover:bg-surface-800"
              title="Open folder"
            >
              <FolderOpen className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              disabled={!workspaceRoot}
              onClick={() => void refreshTree()}
              className="p-1 rounded-md text-surface-500 hover:bg-surface-200/80 dark:hover:bg-surface-800 disabled:opacity-40"
              title="Refresh file tree"
            >
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
          </div>
          {!workspaceRoot && (
            <p className="text-xs text-surface-500 px-2">Open a project folder to browse files.</p>
          )}
          {tree.map(entry => (
            <TreeNode
              key={entry.path}
              workspaceRoot={workspaceRoot}
              entry={entry}
              depth={0}
              selectedPath={selectedPath}
              onSelect={(path, isDir) => {
                if (!isDir) void openFile(path);
                else setSelectedPath(path);
              }}
            />
          ))}
        </aside>

        <PaneResizeHandle onDrag={onResizeLeft} title="Resize files pane" />

        <section className="flex flex-col min-h-0 min-w-0 flex-1">
          <div className="px-2.5 py-1.5 border-b border-surface-200 dark:border-surface-800 text-[11px] text-surface-500 truncate flex-shrink-0">
            {openFilePath || 'No file open'}
          </div>
          <div className="flex-1 min-h-0 overflow-auto">
            {editorError ? (
              <p className="p-4 text-sm text-red-600">{editorError}</p>
            ) : openFilePath ? (
              <pre className="p-4 text-xs font-mono whitespace-pre-wrap break-words text-surface-800 dark:text-surface-200 leading-relaxed">
                {editorContent}
              </pre>
            ) : (
              <div className="h-full flex items-center justify-center text-sm text-surface-400 p-6 text-center">
                Select a file to preview it here. The agent edits files automatically; use checkpoints to undo a run.
              </div>
            )}
          </div>
          {checkpoints.length > 0 && (
            <div className="border-t border-surface-200 dark:border-surface-800 flex-shrink-0">
              <button
                type="button"
                onClick={() => setCheckpointsOpen(v => !v)}
                className="w-full flex items-center gap-1.5 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-surface-500 hover:bg-surface-50 dark:hover:bg-surface-900"
              >
                {checkpointsOpen ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                <RotateCcw className="w-3 h-3" />
                Checkpoints
                <span className="normal-case tracking-normal font-medium text-surface-400">{checkpoints.length}</span>
              </button>
              {checkpointsOpen && (
                <div className="max-h-16 overflow-y-auto px-1.5 pb-1 space-y-0.5">
                  {checkpoints.slice(0, 3).map(cp => (
                    <button
                      key={cp.run_id}
                      type="button"
                      onClick={() => void restoreRun(cp.run_id)}
                      className="w-full flex items-center gap-1.5 px-1.5 py-0.5 rounded text-[10px] hover:bg-surface-100 dark:hover:bg-surface-800 text-left"
                      title={`Restore ${cp.run_id}`}
                    >
                      <span className="truncate font-mono text-surface-600 dark:text-surface-300">{cp.run_id.slice(-12)}</span>
                      <span className="ml-auto shrink-0 text-surface-400">{cp.file_count}f</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </section>

        <PaneResizeHandle onDrag={onResizeRight} title="Resize agent pane" />

        <aside
          className="flex flex-col min-h-0 bg-white dark:bg-surface-950 border-t lg:border-t-0 border-surface-200 dark:border-surface-800 shrink-0"
          style={wideLayout ? { width: rightPanePx } : { width: '100%' }}
        >
          <div className="px-1.5 py-1 border-b border-surface-200 dark:border-surface-800 flex items-center gap-0.5 flex-shrink-0">
            <button
              type="button"
              onClick={() => setHistoryOpen(v => !v)}
              className="p-1 rounded-md text-surface-500 hover:bg-surface-100 dark:hover:bg-surface-800 shrink-0"
              title="Chats"
            >
              {historyOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
            </button>
            <button
              type="button"
              disabled={!canPrevTurn}
              onClick={() => setActiveTurnIndex(focusedTurnIndex - 1)}
              className="p-1 rounded-md text-surface-500 hover:bg-surface-100 dark:hover:bg-surface-800 disabled:opacity-25 shrink-0"
              title="Previous query"
            >
              <ChevronLeft className="w-3.5 h-3.5" />
            </button>
            <p
              className="flex-1 min-w-0 text-[12px] font-medium text-surface-800 dark:text-surface-100 truncate px-1"
              title={headerQuery}
            >
              {headerQuery}
            </p>
            <button
              type="button"
              disabled={!canNextTurn}
              onClick={() => {
                if (focusedTurnIndex + 1 >= latestTurnIndex) {
                  setActiveTurnIndex(-1);
                } else {
                  setActiveTurnIndex(focusedTurnIndex + 1);
                }
              }}
              className="p-1 rounded-md text-surface-500 hover:bg-surface-100 dark:hover:bg-surface-800 disabled:opacity-25 shrink-0"
              title="Next query"
            >
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
            {turns.length > 1 && (
              <span className="text-[10px] text-surface-400 tabular-nums shrink-0 pr-0.5">
                {focusedTurnIndex + 1}/{turns.length}
              </span>
            )}
            <button
              type="button"
              onClick={newAgentChat}
              className="p-1 rounded-md hover:bg-surface-100 dark:hover:bg-surface-800 text-surface-500 shrink-0"
              title="New agent chat"
            >
              <Plus className="w-3.5 h-3.5" />
            </button>
          </div>

          {historyOpen && (
            <div className="max-h-28 overflow-y-auto border-b border-surface-200 dark:border-surface-800 px-1.5 py-1 space-y-0.5 flex-shrink-0">
              {pocketThreads.length === 0 && (
                <p className="text-[11px] text-surface-400 px-2 py-1">No chats yet.</p>
              )}
              {pocketThreads.map(conv => (
                <button
                  key={conv.id}
                  type="button"
                  onClick={() => void selectThread(conv)}
                  className={`w-full text-left px-2 py-1 rounded-md text-[11px] truncate ${
                    threadId === conv.id
                      ? 'bg-surface-100 dark:bg-surface-800 font-semibold'
                      : 'hover:bg-surface-50 dark:hover:bg-surface-900 text-surface-600 dark:text-surface-400'
                  }`}
                >
                  {conv.title || 'Agent chat'}
                </button>
              ))}
            </div>
          )}

          {status && (
            <div className={`mx-2 mt-1.5 mb-1 rounded-md border px-2 py-1 text-[11px] flex-shrink-0 ${
              session.waitingFor === 'delete' || session.waitingFor === 'sandbox' || session.waitingFor === 'mcp'
                ? 'border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/20 text-amber-900 dark:text-amber-100'
                : 'border-surface-200 dark:border-surface-700 bg-surface-50 dark:bg-surface-900 text-surface-600 dark:text-surface-300'
            }`}
            >
              {status}
            </div>
          )}

          {session.followupQuestion && !viewingHistoryTurn && (
            <div className="mx-2 mb-1 rounded-md border border-sky-200 dark:border-sky-900 bg-sky-50/50 dark:bg-sky-950/20 px-2 py-1.5 text-[11px]">
              <p className="font-semibold text-sky-800 dark:text-sky-200 mb-0.5">Follow-up</p>
              <p className="text-surface-700 dark:text-surface-200">{session.followupQuestion}</p>
              <button
                type="button"
                className="mt-1 underline text-sky-700"
                onClick={() => {
                  setTask(session.followupQuestion || '');
                  agentSession.clearFollowup();
                }}
              >
                Use as next message
              </button>
            </div>
          )}

          <div className="flex-1 min-h-0 overflow-y-auto px-2.5 space-y-2 pb-2">
            {reviewPlan && !viewingHistoryTurn && (agentMode === 'plan' || reviewPlan.status === 'draft' || reviewPlan.status === 'approved') && (
              <PlanReviewPanel
                plan={reviewPlan}
                busy={busy}
                onBuild={() => void buildPlan()}
                onSave={async (markdown) => {
                  if (!workspaceRoot) {
                    setReviewPlan({ ...reviewPlan, markdown });
                    return;
                  }
                  try {
                    const saved = await cwPlanUpdateMarkdown(workspaceRoot, reviewPlan.id, markdown);
                    setReviewPlan(saved);
                    agentSession.setLastPlan(saved);
                    setLocalStatus('Plan saved.');
                  } catch (err) {
                    setReviewPlan({ ...reviewPlan, markdown });
                    setLocalStatus(`Plan kept in memory (disk save failed): ${String(err)}`);
                  }
                }}
                onDiscard={async () => {
                  if (workspaceRoot && reviewPlan.id) {
                    try {
                      await cwPlanUpdateStatus(workspaceRoot, reviewPlan.id, 'discarded');
                    } catch {
                      /* ignore */
                    }
                  }
                  setReviewPlan(null);
                  agentSession.setLastPlan(null);
                }}
              />
            )}
            {showInlineSandbox && !viewingHistoryTurn && (
              <SandboxPanel
                pending={session.sandboxPending}
                lastResult={session.sandboxResult}
                busy={session.sandboxConfirming}
                onConfirm={() => void agentSession.confirmSandbox()}
                onCancel={() => agentSession.cancelSandbox()}
              />
            )}
            {showLiveSteps ? (
              <>
                <AgentTranscript steps={session.steps} />
                {session.lastSummary
                  && session.steps.some(s => s.kind === 'done')
                  && !session.steps.some(s => s.kind === 'done' && s.content === session.lastSummary)
                  && (
                  <p className="text-[13px] leading-relaxed whitespace-pre-wrap break-words text-surface-800 dark:text-surface-100 px-0.5">
                    {session.lastSummary}
                  </p>
                )}
                {session.checkpointRunId && session.steps.some(s => s.kind === 'done') && (
                  <button
                    type="button"
                    className="text-[11px] text-primary-700 dark:text-primary-300 underline px-0.5"
                    onClick={() => void restoreRun(session.checkpointRunId!)}
                  >
                    Restore this run
                  </button>
                )}
              </>
            ) : focusedTurn ? (
              <div className="space-y-3">
                {focusedTurn.assistants.length === 0 && (
                  <p className="text-surface-400 pt-4 text-center text-[13px]">No response for this query yet.</p>
                )}
                {focusedTurn.assistants.map(m => {
                  const parts = m.content.split(/\n---\nAgent transcript\n/);
                  const summary = (parts[0] || '').trim();
                  const transcript = parts.slice(1).join('\n---\nAgent transcript\n').trim();
                  return (
                    <div key={m.id} className="space-y-2">
                      {summary && (
                        <p className="text-[13px] leading-relaxed whitespace-pre-wrap break-words text-surface-800 dark:text-surface-100 px-0.5">
                          {summary}
                        </p>
                      )}
                      {transcript && (
                        <details className="rounded-md border border-surface-200 dark:border-surface-800">
                          <summary className="cursor-pointer px-2 py-1.5 text-[11px] text-surface-500 hover:bg-surface-50 dark:hover:bg-surface-900">
                            Agent transcript
                          </summary>
                          <pre className="px-2.5 pb-2 text-[11px] font-mono whitespace-pre-wrap break-words text-surface-600 dark:text-surface-300 max-h-56 overflow-auto border-t border-surface-100 dark:border-surface-800 pt-2">
                            {transcript}
                          </pre>
                        </details>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : null}
          </div>

          <div
            className="border-t border-surface-200 dark:border-surface-800 px-2 pt-2 pb-2 flex-shrink-0 space-y-1.5"
            onKeyDown={e => {
              if (e.key === 'Tab' && e.shiftKey) {
                e.preventDefault();
                void changeMode(cycleMode(agentMode));
              }
            }}
          >
            {attachments.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {attachments.map(a => (
                  <span
                    key={a.path}
                    className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-surface-100 dark:bg-surface-800 text-[10px]"
                    title={a.notice}
                  >
                    <span className={`font-semibold uppercase ${
                      a.understand === 'vision' ? 'text-emerald-600'
                        : a.understand === 'doc-text' ? 'text-sky-600'
                          : 'text-amber-600'
                    }`}
                    >
                      {a.understand === 'doc-text' ? 'doc' : a.understand}
                    </span>
                    <span className="truncate max-w-[6rem]">{a.name}</span>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => setAttachments(prev => prev.filter(x => x.path !== a.path))}
                      className="opacity-60 hover:opacity-100"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <textarea
              value={task}
              onChange={e => setTask(e.target.value)}
              rows={2}
              placeholder={MODE_PLACEHOLDERS[agentMode]}
              className="w-full bg-transparent border-0 focus:outline-none focus:ring-0 text-[13px] resize-none text-surface-900 dark:text-surface-100 placeholder:text-surface-400 px-0.5 py-0.5 min-h-[2.5rem] max-h-28"
              disabled={busy || voiceBusy}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  if (!busy) void runAgent();
                }
              }}
            />
            <div className="flex items-center gap-1 min-w-0">
              <ComposerModelBar
                mode={agentMode}
                disabled={busy}
                onModeChange={m => void changeMode(m)}
                workspaceRoot={workspaceRoot}
              />
              <button
                type="button"
                disabled={busy || voiceBusy}
                onClick={() => void toggleVoice()}
                className={`h-7 w-7 shrink-0 rounded-md flex items-center justify-center text-surface-500 hover:bg-surface-100 dark:hover:bg-surface-800 disabled:opacity-40 ${
                  voiceRecording ? 'text-red-500 bg-red-500/10' : ''
                }`}
                title={voiceRecording ? 'Stop dictation' : 'Dictate'}
              >
                <Mic className={`w-3.5 h-3.5 ${voiceRecording ? 'animate-pulse' : ''}`} />
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void attachFiles()}
                className="h-7 w-7 shrink-0 rounded-md flex items-center justify-center text-surface-500 hover:bg-surface-100 dark:hover:bg-surface-800 disabled:opacity-40"
                title="Attach file"
              >
                <ImagePlus className="w-3.5 h-3.5" />
              </button>
              {busy ? (
                <button
                  type="button"
                  onClick={() => agentSession.stop()}
                  className="h-7 w-7 shrink-0 rounded-full flex items-center justify-center bg-surface-200 dark:bg-surface-800 text-surface-700 dark:text-surface-200 hover:bg-surface-300 dark:hover:bg-surface-700"
                  title="Stop"
                >
                  <Square className="w-3 h-3 fill-current" />
                </button>
              ) : (
                <button
                  type="button"
                  disabled={!workspaceRoot || (!task.trim() && attachments.length === 0) || !currentModel || !gateAllowed}
                  onClick={() => void runAgent()}
                  className="h-7 w-7 shrink-0 rounded-full flex items-center justify-center bg-primary-500 text-surface-950 hover:bg-primary-400 disabled:opacity-35 disabled:hover:bg-primary-500"
                  title="Send"
                >
                  <ArrowUp className="w-3.5 h-3.5 stroke-[2.5]" />
                </button>
              )}
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
