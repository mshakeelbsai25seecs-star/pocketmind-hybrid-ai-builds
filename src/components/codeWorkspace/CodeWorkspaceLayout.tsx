import { useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent } from 'react';
import { open } from '@tauri-apps/api/dialog';
import { invoke } from '@tauri-apps/api/tauri';
import {
  FolderOpen, Square, ChevronRight, ChevronDown, File, Folder,
  RefreshCw, AlertCircle, Plus, RotateCcw, ArrowUp, ImagePlus, X, Mic, PanelLeftOpen,
} from 'lucide-react';
import { useAppStore } from '../../store';
import { FEATURE_FLAGS } from '../../featureFlags';
import {
  cwApplyEditWrite,
  cwCanUse,
  cwEnsureSymbolIndex,
  cwCheckpointManifest,
  cwListCheckpoints,
  cwListDir,
  cwPlanUpdateMarkdown,
  cwPlanUpdateStatus,
  cwImageBase64,
  cwPreparePdfs,
  cwReadFile,
  cwRestoreCheckpoint,
  cwSaveTempImage,
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
import FilePreviewPane from './FilePreviewPane';
import GitDiffPane from './GitDiffPane';
import IdeBottomPanel from './IdeBottomPanel';
import McpToolsPanel from './McpToolsPanel';
import FileWriteApproval from './FileWriteApproval';
import {
  gitDiff,
  gitStatus,
  type GitDiffResult,
  type GitFileStatus,
} from '../../codeWorkspace/ideApi';
import SandboxPanel from './SandboxPanel';
import ComposerModelBar from './ComposerModelBar';
import { useAutoResizeTextarea } from '../../hooks/useAutoResizeTextarea';
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
import {
  isThinClient,
  loadRuntimeProfile,
  usesRemoteWorkspace,
  type PocketCodeRuntimeProfile,
} from '../../codeWorkspace/runtimeProfile';
import { remoteWorkspaceRootToken } from '../../api/codeWorkspace';
import RuntimeProfileBar from './RuntimeProfileBar';
import { formatInvokeError } from './agentLoop';

function normPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/** Match relative vs absolute / slash-style paths after agent deletes. */
function pathsReferToSameFile(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const na = normPath(a);
  const nb = normPath(b);
  if (na === nb) return true;
  return na.endsWith(`/${nb}`) || nb.endsWith(`/${na}`);
}

function gitMark(path: string, files: GitFileStatus[]): string | null {
  const n = path.replace(/\\/g, '/').toLowerCase();
  const row = files.find(f => {
    const p = f.path.replace(/\\/g, '/').toLowerCase();
    return p === n || n.endsWith(`/${p}`) || p.endsWith(`/${n.split('/').pop()}`);
  });
  if (!row) return null;
  if (row.conflicted) return 'U';
  if (row.untracked) return 'U';
  if (row.worktree === 'M' || row.index === 'M') return 'M';
  if (row.worktree === 'A' || row.index === 'A') return 'A';
  if (row.worktree === 'D' || row.index === 'D') return 'D';
  return row.worktree !== ' ' ? row.worktree : row.index;
}

function TreeNode({
  workspaceRoot,
  entry,
  depth,
  selectedPath,
  onSelect,
  treeEpoch,
  gitFiles,
}: {
  workspaceRoot: string;
  entry: DirEntryInfo;
  depth: number;
  selectedPath: string | null;
  onSelect: (path: string, isDir: boolean) => void;
  /** Bumped after agent create/edit/delete so expanded folders reload. */
  treeEpoch: number;
  gitFiles: GitFileStatus[];
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
    if (openDir && entry.is_dir) void loadChildren();
  }, [openDir, entry.is_dir, loadChildren, treeEpoch]);

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
        {gitMark(entry.path, gitFiles) && (
          <span className="ml-auto text-[10px] text-amber-300 font-mono">{gitMark(entry.path, gitFiles)}</span>
        )}
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
        <Folder className="w-3.5 h-3.5 shrink-0 text-primary-300" />
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
          treeEpoch={treeEpoch}
          gitFiles={gitFiles}
        />
      ))}
    </div>
  );
}

/**
 * Cursor-style turn header: the prompt pins to the top of the chat scroll area while its reply is
 * on screen, and the next turn's prompt pushes it away — so you always see which question the
 * visible answer belongs to.
 */
function StickyTurnPrompt({
  content,
  index,
  total,
}: {
  content: string;
  index: number;
  total: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const preview = content.replace(/\s+/g, ' ').trim();
  const isLong = preview.length > 120 || content.includes('\n');

  return (
    <div className="sticky top-0 z-20 -mx-2.5 px-2.5 pt-1.5 pb-1.5 bg-white/95 dark:bg-surface-950/95 backdrop-blur-sm border-b border-surface-200 dark:border-surface-800">
      <div className="flex items-start gap-1.5">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-surface-400 mt-0.5 shrink-0">
          You
        </span>
        {expanded ? (
          <p className="flex-1 min-w-0 text-[13px] leading-relaxed whitespace-pre-wrap break-words text-surface-800 dark:text-surface-100 max-h-56 overflow-y-auto">
            {content}
          </p>
        ) : (
          <p className="flex-1 min-w-0 text-[13px] leading-snug line-clamp-2 break-words text-surface-800 dark:text-surface-100">
            {preview}
          </p>
        )}
        <span className="text-[10px] text-surface-400 tabular-nums shrink-0 mt-0.5">
          {index + 1}/{total}
        </span>
        {isLong && (
          <button
            type="button"
            onClick={() => setExpanded(v => !v)}
            title={expanded ? 'Collapse message' : 'Show full message'}
            className="shrink-0 p-0.5 rounded text-surface-400 hover:text-surface-700 dark:hover:text-surface-200"
          >
            <ChevronDown className={`w-3.5 h-3.5 transition-transform ${expanded ? '' : '-rotate-90'}`} />
          </button>
        )}
      </div>
    </div>
  );
}

/** Persist structured steps (Cursor-style cards), not a raw transcript dump. */
function stepsForPersist(steps: AgentStep[]): AgentStep[] {
  return steps
    .filter(s => s.kind === 'tool' || s.kind === 'done' || s.kind === 'error')
    .map((s, i) => ({
      step: s.step || i + 1,
      kind: s.kind,
      content: s.content || '',
      tool: s.tool,
      toolResult: s.toolResult && s.toolResult.length > 4_000
        ? `${s.toolResult.slice(0, 4_000)}\n…[truncated]`
        : s.toolResult,
    }));
}

function encodePocketCodeMetadata(steps: AgentStep[]): string {
  return JSON.stringify({ v: 1, pocketcodeSteps: stepsForPersist(steps) });
}

function parseStepsFromMetadata(metadata?: string | null): AgentStep[] | null {
  if (!metadata?.trim()) return null;
  try {
    const raw = JSON.parse(metadata) as { pocketcodeSteps?: unknown };
    if (!Array.isArray(raw.pocketcodeSteps)) return null;
    return raw.pocketcodeSteps.filter((s): s is AgentStep => (
      !!s && typeof s === 'object' && typeof (s as AgentStep).kind === 'string'
    ));
  } catch {
    return null;
  }
}

/** Best-effort recovery for older messages that stored a text transcript block. */
function parseStepsFromLegacyTranscript(transcript: string): AgentStep[] {
  if (!transcript.trim()) return [];
  const blocks = transcript.split(/\n\n+/);
  const steps: AgentStep[] = [];
  let n = 0;
  for (const block of blocks) {
    const toolMatch = /^\[tool\s+([^\]]+)\]\s*([\s\S]*)$/.exec(block.trim());
    if (toolMatch) {
      n += 1;
      steps.push({
        step: n,
        kind: 'tool',
        content: `Tool ${toolMatch[1]}`,
        tool: toolMatch[1],
        toolResult: (toolMatch[2] || '').trim(),
      });
      continue;
    }
    const kindMatch = /^\[(done|error|assistant)\]\s*([\s\S]*)$/.exec(block.trim());
    if (kindMatch && kindMatch[1] !== 'assistant') {
      n += 1;
      // Keep the full block body (including paragraphs after the first line).
      steps.push({
        step: n,
        kind: kindMatch[1] as 'done' | 'error',
        content: (kindMatch[2] || '').trim(),
      });
    }
  }
  return steps;
}

function assistantDisplayParts(m: Message): { summary: string; steps: AgentStep[] } {
  const fromMeta = parseStepsFromMetadata(m.metadata);
  const parts = m.content.split(/\n---\nAgent transcript\n/);
  const summary = (parts[0] || '').trim();
  if (fromMeta && fromMeta.length > 0) {
    return { summary, steps: fromMeta };
  }
  const legacy = parseStepsFromLegacyTranscript(parts.slice(1).join('\n---\nAgent transcript\n').trim());
  return { summary, steps: legacy };
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
  const pocketcodeNewSessionNonce = useAppStore(s => s.pocketcodeNewSessionNonce);
  const requestNewPocketcodeSession = useAppStore(s => s.requestNewPocketcodeSession);
  /** When true, do not auto-reopen the last PocketCode thread (user clicked New). */
  const skipThreadAutoRestoreRef = useRef(false);
  const allMessages = useAppStore(s => s.messages);
  const sidebarOpen = useAppStore(s => s.sidebarOpen);
  const setSidebarOpen = useAppStore(s => s.setSidebarOpen);
  const session = useAgentSession();

  const [workspaceRoot, setWorkspaceRoot] = useState('');
  const [runtimeProfile, setRuntimeProfile] = useState<PocketCodeRuntimeProfile | null>(null);
  const [tree, setTree] = useState<DirEntryInfo[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [openFilePath, setOpenFilePath] = useState<string | null>(null);
  const [openTabs, setOpenTabs] = useState<string[]>([]);
  const [editorTab, setEditorTab] = useState<'editor' | 'diff'>('diff');
  const [editorContent, setEditorContent] = useState('');
  const [editorError, setEditorError] = useState<string | null>(null);
  const [gitFiles, setGitFiles] = useState<GitFileStatus[]>([]);
  const [gitNote, setGitNote] = useState<string | null>(null);
  const [diffResult, setDiffResult] = useState<GitDiffResult | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [bottomPx, setBottomPx] = useState(220);
  /** Forces expanded folder nodes to re-list after agent mutations. */
  const [treeEpoch, setTreeEpoch] = useState(0);
  const openFilePathRef = useRef<string | null>(null);
  const selectedPathRef = useRef<string | null>(null);
  openFilePathRef.current = openFilePath;
  selectedPathRef.current = selectedPath;
  const [task, setTask] = useState('');
  const taskInputRef = useAutoResizeTextarea(task);
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
  /** Prompt for the in-flight live agent run (shown while running). */
  const [liveQuery, setLiveQuery] = useState<string | null>(null);
  const chatScrollRef = useRef<HTMLDivElement | null>(null);
  const chatEndRef = useRef<HTMLDivElement | null>(null);
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
    void getSetting('cw.agent_mode').then(v => setAgentMode(parseAgentMode(v)));
    void getSetting('cw.pane_left_px').then(v => {
      const n = Number(v);
      if (Number.isFinite(n) && n >= 160 && n <= 520) setLeftPanePx(n);
    });
    void getSetting('cw.pane_right_px').then(v => {
      const n = Number(v);
      if (Number.isFinite(n) && n >= 280 && n <= 720) setRightPanePx(n);
    });
    void (async () => {
      const profile = await loadRuntimeProfile();
      setRuntimeProfile(profile);
      if (usesRemoteWorkspace(profile) && profile.remote?.workspaceId) {
        setWorkspaceRoot(remoteWorkspaceRootToken(profile.remote.workspaceId));
      } else {
        const v = await getSetting('cw.workspace_root');
        if (v) setWorkspaceRoot(v);
      }
    })();
  }, []);

  const thinClient = Boolean(runtimeProfile && isThinClient(runtimeProfile));
  const remoteWorkspace = Boolean(runtimeProfile && usesRemoteWorkspace(runtimeProfile));

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
    let cancelled = false;
    (async () => {
      const visionReady = await refreshLocalVisionCapability(currentModel);
      const g = await cwCanUse(currentModel);
      if (cancelled) return;
      // Prefer Rust gate (includes mmproj-on-disk). Vision probe keeps UI chips in sync.
      setGateAllowed(g.allowed || visionReady);
      setGateReason(
        g.allowed
          ? g.reason
          : visionReady
            ? 'Local vision model (mmproj ready)'
            : g.reason,
      );
    })().catch(() => {
      if (!cancelled) {
        setGateAllowed(false);
        setGateReason('Could not verify model for PocketCode.');
      }
    });
    return () => { cancelled = true; };
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

  const refreshGit = useCallback(async (root?: string) => {
    const r = root ?? workspaceRoot;
    if (!r) {
      setGitFiles([]);
      setGitNote(null);
      return;
    }
    try {
      const report = await gitStatus(r);
      setGitFiles(report.files || []);
      setGitNote(report.error || (report.is_repo ? (report.branch ? `git ${report.branch}` : null) : 'Not a git repository'));
    } catch (err) {
      setGitFiles([]);
      setGitNote(formatInvokeError(err));
    }
  }, [workspaceRoot]);

  const refreshTree = useCallback(async (root?: string, opts?: { bustCache?: boolean }) => {
    const r = root ?? workspaceRoot;
    if (!r) return;
    try {
      const entries = await cwListDir(r, '.');
      setTree(entries.sort((a, b) => Number(b.is_dir) - Number(a.is_dir) || a.name.localeCompare(b.name)));
      if (opts?.bustCache !== false) setTreeEpoch(v => v + 1);
      await refreshGit(r);
    } catch (err) {
      setLocalStatus(formatInvokeError(err));
    }
  }, [workspaceRoot, refreshGit]);

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
    if (skipThreadAutoRestoreRef.current) return;
    if (lastPocketId && pocketThreads.some(t => t.id === lastPocketId)) {
      setThreadId(lastPocketId);
      const t = pocketThreads.find(x => x.id === lastPocketId);
      if (t) setThreadTitle(t.title || 'Agent chat');
    }
  }, [lastPocketId, pocketThreads, threadId]);

  useEffect(() => {
    if (!pocketcodeNewSessionNonce) return;
    skipThreadAutoRestoreRef.current = true;
    setThreadId(null);
    setThreadTitle('New agent chat');
    setLiveQuery(null);
    agentSession.stop();
    setLocalStatus(null);
    setReviewPlan(null);
    agentSession.setLastPlan(null);
  }, [pocketcodeNewSessionNonce]);

  const prepareWorkspacePdfs = useCallback(async (root: string) => {
    if (!root || thinClient || remoteWorkspace) return;
    setLocalStatus('Preparing PDFs (extract / Unlimited-OCR)…');
    try {
      const report = await cwPreparePdfs(root);
      setLocalStatus(report.summary);
    } catch (err) {
      setLocalStatus(`PDF prepare skipped: ${formatInvokeError(err)}`);
    }
  }, [thinClient, remoteWorkspace]);

  const pickFolder = async () => {
    if (thinClient || remoteWorkspace) {
      setLocalStatus(
        thinClient
          ? 'Thin client cannot open a local folder. Provision or select a remote workspace.'
          : 'Remote tools profile active — use the runtime profile bar to select/provision a server workspace.',
      );
      return;
    }
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected !== 'string' || !selected) return;
    setWorkspaceRoot(selected);
    await setSetting('cw.workspace_root', selected);
    setSelectedPath(null);
    setOpenFilePath(null);
    setEditorContent('');
    await refreshTree(selected);
    // Background OCR/extract so agents can read_file/grep PDFs without a separate index.
    void prepareWorkspacePdfs(selected);
  };

  const loadDiff = async (path: string) => {
    if (!workspaceRoot) return;
    setDiffLoading(true);
    try {
      setDiffResult(await gitDiff(workspaceRoot, path));
    } catch (err) {
      setDiffResult(null);
      setLocalStatus(formatInvokeError(err));
    } finally {
      setDiffLoading(false);
    }
  };

  const openFile = async (path: string) => {
    if (!workspaceRoot) return;
    setSelectedPath(path);
    setOpenFilePath(path);
    setOpenTabs(prev => (prev.includes(path) ? prev : [...prev, path]));
    setEditorError(null);
    void loadDiff(path);
    try {
      const text = await cwReadFile(workspaceRoot, path, 0, 4000, true);
      setEditorContent(text);
    } catch (err) {
      setEditorContent('');
      setEditorError(formatInvokeError(err));
    }
  };

  const closePreviewIfPath = useCallback((path: string) => {
    if (
      pathsReferToSameFile(openFilePathRef.current, path)
      || pathsReferToSameFile(selectedPathRef.current, path)
    ) {
      setOpenFilePath(null);
      setSelectedPath(null);
      setEditorContent('');
      setEditorError(null);
    }
  }, []);

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
    const assistantBody = summary.trim() || 'Done.';
    // Ensure the done step carries the full reply (model done.args can be a short teaser).
    const stepsToStore = steps.map(s => (
      s.kind === 'done' && assistantBody.length > (s.content || '').length
        ? { ...s, content: assistantBody }
        : s
    ));
    const metadata = encodePocketCodeMetadata(stepsToStore);
    const userMsg: Message = {
      id: `${Date.now()}-u`,
      conversation_id: convId,
      role: 'user',
      content: userText,
      created_at: Math.floor(Date.now() / 1000),
    };
    const asstMsg: Message = {
      id: `${Date.now()}-a`,
      conversation_id: convId,
      role: 'assistant',
      content: assistantBody,
      metadata,
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
      metadata,
    });
    const existing = useAppStore.getState().messages[convId] || [];
    setMessages(convId, [
      ...existing,
      { ...userMsg, id: userMsgId },
      { ...asstMsg, id: assistantMsgId, metadata },
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
        // Keep existing thumbnail when model changes.
        previewDataUrl: f.previewDataUrl,
      };
    }));
  }, [currentModel]);

  const ensureImagePreviews = useCallback(async (paths: string[]) => {
    for (const path of paths) {
      const mime = mimeFromPath(path);
      if (!mime.startsWith('image/')) continue;
      try {
        const [resolvedMime, base64] = await cwImageBase64(path);
        const previewDataUrl = `data:${resolvedMime || mime};base64,${base64}`;
        setAttachments(prev => prev.map(a => (
          a.path === path && !a.previewDataUrl ? { ...a, previewDataUrl } : a
        )));
      } catch {
        /* preview optional */
      }
    }
  }, []);

  const pushAttachments = useCallback((items: PocketCodeImageAttach[]) => {
    if (!items.length) return;
    setAttachments(prev => [...prev, ...items].slice(0, 6));
    void ensureImagePreviews(items.filter(i => !i.previewDataUrl).map(i => i.path));
  }, [ensureImagePreviews]);

  const pushAttachmentPaths = useCallback((paths: string[]) => {
    if (!paths.length) return;
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
    pushAttachments(next);
  }, [currentModel, pushAttachments]);

  const attachFiles = async () => {
    const selected = await open({
      multiple: true,
      filters: ATTACH_FILE_FILTERS,
    });
    if (!selected) return;
    const paths = Array.isArray(selected) ? selected : [selected];
    pushAttachmentPaths(paths);
  };

  const fileToDataUrl = (file: Blob): Promise<string> => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('Failed to read clipboard image'));
    reader.readAsDataURL(file);
  });

  /** Ctrl+V / Cmd+V screenshots from clipboard → attachment chips (Cursor-style). */
  const pasteClipboardImages = useCallback(async (e: ClipboardEvent) => {
    const dt = e.clipboardData;
    if (!dt) return;

    const files: File[] = [];
    if (dt.items?.length) {
      for (const item of Array.from(dt.items)) {
        if (item.kind === 'file' && item.type.startsWith('image/')) {
          const f = item.getAsFile();
          if (f) files.push(f);
        }
      }
    }
    if (!files.length && dt.files?.length) {
      for (const f of Array.from(dt.files)) {
        if (f.type.startsWith('image/')) files.push(f);
      }
    }
    if (!files.length) return;

    e.preventDefault();
    try {
      const next: PocketCodeImageAttach[] = [];
      for (const file of files.slice(0, 6)) {
        const dataUrl = await fileToDataUrl(file);
        const comma = dataUrl.indexOf(',');
        const b64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
        const mime = file.type || 'image/png';
        const path = await cwSaveTempImage(b64, mime);
        const chip = chipForPath(path, currentModel);
        next.push({
          path,
          name: chip.name.startsWith('paste-') ? 'Screenshot' : chip.name,
          mime,
          kind: chip.kind,
          understand: chip.understand,
          notice: chip.notice,
          previewDataUrl: dataUrl,
        });
      }
      pushAttachments(next);
      setLocalStatus(
        next.length === 1
          ? 'Screenshot pasted from clipboard.'
          : `${next.length} images pasted from clipboard.`,
      );
    } catch (err) {
      setLocalStatus(formatInvokeError(err));
    }
  }, [currentModel, pushAttachments]);

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

    // Ensure mmproj disk probe is fresh before vision attach decisions.
    await refreshLocalVisionCapability(currentModel);
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
        await refreshTree(undefined, { bustCache: true });
        if (pathsReferToSameFile(openFilePathRef.current, path)) {
          setEditorContent(content);
          setEditorError(null);
          void loadDiff(path);
        }
      },
      onFileDeleted: async (path) => {
        closePreviewIfPath(path);
        await refreshTree(undefined, { bustCache: true });
      },
      onAfterDone: async (summary, steps) => {
        try {
          await persistUserAndAssistant(convId, fullPrompt, summary, steps);
        } catch (err) {
          console.warn('Failed to persist PocketCode thread:', err);
        }
        setLiveQuery(null);
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
    skipThreadAutoRestoreRef.current = true;
    requestNewPocketcodeSession();
    setThreadId(null);
    setThreadTitle('New agent chat');
    setLiveQuery(null);
    agentSession.stop();
    setLocalStatus(null);
    setReviewPlan(null);
    agentSession.setLastPlan(null);
  };

  const selectThread = async (conv: Conversation) => {
    skipThreadAutoRestoreRef.current = false;
    setThreadId(conv.id);
    setThreadTitle(conv.title || 'Agent chat');
    setLiveQuery(null);
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
      let fileCount = 0;
      try {
        const manifest = await cwCheckpointManifest(workspaceRoot, runId);
        fileCount = manifest.files?.length ?? 0;
      } catch {
        /* ignore — restore may still work */
      }
      if (fileCount === 0) {
        setLocalStatus(
          'Nothing to restore — this run did not change any project files (for example the model failed before any edit).',
        );
        return;
      }
      const n = await cwRestoreCheckpoint(workspaceRoot, runId);
      setLocalStatus(
        n > 0
          ? `Restored ${n} file(s) from checkpoint ${runId}.`
          : 'Restore finished, but no files were written back.',
      );
      await refreshTree();
      await refreshCheckpoints();
      if (openFilePath) await openFile(openFilePath);
    } catch (err) {
      setLocalStatus(`Restore failed: ${String(err)}`);
    }
  };

  const folderLabel = useMemo(() => {
    if (!workspaceRoot) return 'No folder';
    const parts = workspaceRoot.replace(/[\\/]+$/, '').split(/[/\\]/);
    return parts[parts.length - 1] || workspaceRoot;
  }, [workspaceRoot]);
  // Prefer localStatus so restore / mic / attach feedback is not hidden by the last agent summary.
  const status = localStatus ?? session.status;
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

  const headerTitle = threadId ? threadTitle : 'New agent chat';
  /** Live run panel while the agent is working (history stays scrollable above). */
  const showLiveRun = busy || (session.running && session.steps.length > 0);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [turns.length, session.steps.length, showLiveRun, liveQuery, status]);

  return (
    <div className="flex-1 flex flex-col h-full min-w-0 bg-white dark:bg-black">
      {!gateAllowed && (
        <div className="mx-3 mt-2 rounded-xl border border-amber-300/60 bg-amber-50 dark:bg-amber-950/20 p-2.5 text-xs text-amber-800 dark:text-amber-200 flex gap-2">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          {gateReason || 'Select a ≥20B local model, an online model, or an org server model for PocketCode.'}
        </div>
      )}

      <ServerBackendStrip
        onOpenOrgServer={() => setActiveView('enterprise-server')}
        lastError={session.lastError || (localStatus && currentModel?.startsWith('enterprise:') ? localStatus : null)}
        onRetry={lastFailedPrompt ? () => void runAgent({ prompt: lastFailedPrompt, clearTask: false }) : undefined}
      />

      <RuntimeProfileBar
        thinClient={thinClient}
        onWorkspaceRootChange={(root) => {
          if (root) {
            setWorkspaceRoot(root);
            setSelectedPath(null);
            setOpenFilePath(null);
            setEditorContent('');
          }
          void loadRuntimeProfile().then(async (p) => {
            setRuntimeProfile(p);
            if (usesRemoteWorkspace(p) && p.remote?.workspaceId) {
              setWorkspaceRoot(remoteWorkspaceRootToken(p.remote.workspaceId));
            } else if (!usesRemoteWorkspace(p) && !root) {
              const local = await getSetting('cw.workspace_root');
              if (local) setWorkspaceRoot(local);
            }
          });
        }}
      />

      <div className="flex-1 min-h-0 flex flex-col lg:flex-row">
        <aside
          className="overflow-y-auto p-1.5 bg-surface-50/80 dark:bg-black min-h-[10rem] lg:min-h-0 lg:h-full shrink-0 border-b lg:border-b-0 border-surface-200 dark:border-white/5"
          style={wideLayout ? { width: leftPanePx } : { width: '100%' }}
        >
          <div className="flex items-center gap-0.5 px-1 py-0.5 mb-0.5 sticky top-0 z-10 bg-surface-50/95 dark:bg-black">
            <div className="min-w-0 flex-1 px-1">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-surface-500">
                {remoteWorkspace ? 'Remote files' : 'Explorer'}
              </p>
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
            {!remoteWorkspace && !thinClient && (
              <button
                type="button"
                onClick={() => void pickFolder()}
                className="p-1 rounded-md text-surface-500 hover:bg-surface-200/80 dark:hover:bg-surface-800"
                title="Open folder"
              >
                <FolderOpen className="w-3.5 h-3.5" />
              </button>
            )}
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
            <p className="text-xs text-surface-500 px-2">
              {remoteWorkspace
                ? 'Select or provision a remote workspace in the profile bar.'
                : 'Open a project folder to browse files.'}
            </p>
          )}
          {tree.map(entry => (
            <TreeNode
              key={entry.path}
              workspaceRoot={workspaceRoot}
              entry={entry}
              depth={0}
              selectedPath={selectedPath}
              treeEpoch={treeEpoch}
              gitFiles={gitFiles}
              onSelect={(path, isDir) => {
                if (!isDir) void openFile(path);
                else setSelectedPath(path);
              }}
            />
          ))}
        </aside>

        <PaneResizeHandle onDrag={onResizeLeft} title="Resize files pane" />

        <section className="flex flex-col min-h-0 min-w-0 flex-1">
          {openTabs.length > 0 && (
            <div className="flex items-center gap-1 px-1 border-b border-white/10 overflow-x-auto shrink-0">
              {openTabs.map(tab => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => void openFile(tab)}
                  className={`px-2 py-1 text-[11px] rounded-t ${openFilePath === tab ? 'bg-white/10 text-white' : 'text-surface-500'}`}
                >
                  {basename(tab)}
                </button>
              ))}
            </div>
          )}
          <div className="flex items-center gap-2 px-2 py-1 border-b border-white/10 text-[11px] font-semibold uppercase tracking-wider">
            <button type="button" onClick={() => setEditorTab('editor')} className={editorTab === 'editor' ? 'text-white' : 'text-surface-500'}>Editor</button>
            <button type="button" onClick={() => setEditorTab('diff')} className={editorTab === 'diff' ? 'text-white' : 'text-surface-500'}>
              Diff{diffResult?.unified ? ` (${diffResult.unified.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++')).length > 0 ? '1' : '0'})` : ''}
            </button>
            {gitNote && <span className="ml-auto normal-case tracking-normal font-normal text-surface-500 truncate">{gitNote}</span>}
          </div>
          <div className="flex-1 min-h-0 overflow-hidden">
            {editorTab === 'diff' ? (
              <GitDiffPane diff={diffResult} loading={diffLoading} />
            ) : (
              <FilePreviewPane
                workspaceRoot={workspaceRoot}
                filePath={openFilePath}
                content={editorContent}
                error={editorError}
              />
            )}
          </div>
          <div className="shrink-0 border-t border-white/10" style={{ height: bottomPx }}>
            <IdeBottomPanel
              workspaceRoot={workspaceRoot || null}
              onOpenFile={(path, line) => {
                void openFile(path);
                if (line) setLocalStatus(`Opened ${basename(path)}:${line}`);
              }}
            />
          </div>
          <div
            className="h-1 cursor-row-resize bg-transparent hover:bg-primary-500/40"
            onMouseDown={e => {
              const startY = e.clientY;
              const startH = bottomPx;
              const move = (ev: MouseEvent) => setBottomPx(Math.min(420, Math.max(140, startH - (ev.clientY - startY))));
              const up = () => {
                window.removeEventListener('mousemove', move);
                window.removeEventListener('mouseup', up);
              };
              window.addEventListener('mousemove', move);
              window.addEventListener('mouseup', up);
            }}
          />
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
            <p
              className="flex-1 min-w-0 text-[12px] font-medium text-surface-800 dark:text-surface-100 truncate px-1"
              title={headerTitle}
            >
              {headerTitle}
            </p>
            {turns.length > 0 && (
              <span className="text-[10px] text-surface-400 tabular-nums shrink-0 pr-0.5">
                {turns.length} msg{turns.length === 1 ? '' : 's'}
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

          {session.followupQuestion && (
            <div className="mx-2 mb-1 rounded-md border border-sky-200 dark:border-sky-900 bg-sky-50/50 dark:bg-sky-950/20 px-2 py-1.5 text-[11px] flex-shrink-0">
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

          <div ref={chatScrollRef} className="flex-1 min-h-0 overflow-y-auto px-2.5 space-y-4 pb-3">
            <FileWriteApproval />
            <McpToolsPanel />
            {reviewPlan && (agentMode === 'plan' || reviewPlan.status === 'draft' || reviewPlan.status === 'approved') && (
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
            {showInlineSandbox && (
              <SandboxPanel
                pending={session.sandboxPending}
                lastResult={session.sandboxResult}
                busy={session.sandboxConfirming}
                onConfirm={() => void agentSession.confirmSandbox()}
                onCancel={() => agentSession.cancelSandbox()}
              />
            )}

            {turns.length === 0 && !showLiveRun && (
              <p className="text-surface-400 pt-8 text-center text-[13px] px-4">
                Ask PocketCode to explore or edit this folder. The full conversation scrolls here.
              </p>
            )}

            {turns.map((turn, turnIdx) => (
              <div key={turn.user.id || `turn-${turnIdx}`} className="space-y-2">
                <StickyTurnPrompt
                  content={turn.user.content}
                  index={turnIdx}
                  total={turns.length}
                />
                {turn.assistants.length === 0 ? (
                  <p className="text-[12px] text-surface-400 px-1">No response for this message.</p>
                ) : (
                  turn.assistants.map(m => {
                    const { summary, steps } = assistantDisplayParts(m);
                    return (
                      <div key={m.id} className="space-y-2 px-0.5">
                        <p className="text-[10px] font-semibold uppercase tracking-wide text-surface-400">Assistant</p>
                        <AgentTranscript steps={steps} answer={summary} />
                      </div>
                    );
                  })
                )}
              </div>
            ))}

            {showLiveRun && (
              <div className="space-y-2 border-t border-dashed border-surface-200 dark:border-surface-800 pt-3">
                {liveQuery && (
                  <div className="rounded-xl bg-primary-50 dark:bg-primary-950/30 border border-primary-200 dark:border-primary-900 px-3 py-2">
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-primary-600 dark:text-primary-300 mb-1">You</p>
                    <p className="text-[13px] leading-relaxed whitespace-pre-wrap break-words text-surface-800 dark:text-surface-100">
                      {liveQuery}
                    </p>
                  </div>
                )}
                <p className="text-[10px] font-semibold uppercase tracking-wide text-surface-400 px-0.5">Assistant</p>
                <AgentTranscript steps={session.steps} answer={session.lastSummary} />
                {session.checkpointRunId
                  && session.steps.some(s => s.kind === 'tool' && (s.tool === 'apply_edit' || s.tool === 'delete_file'))
                  && (
                  <button
                    type="button"
                    className="text-[11px] text-primary-700 dark:text-primary-300 underline px-0.5"
                    onClick={() => void restoreRun(session.checkpointRunId!)}
                  >
                    Restore this run
                  </button>
                )}
              </div>
            )}
            <div ref={chatEndRef} />
          </div>

          <div
            className="border-t border-surface-200 dark:border-surface-800 px-2 pt-2 pb-2 flex-shrink-0 space-y-1.5"
            onPaste={e => {
              // Single handler on the composer shell (do not also bind textarea — that doubles attaches).
              void pasteClipboardImages(e);
            }}
            onKeyDown={e => {
              if (e.key === 'Tab' && e.shiftKey) {
                e.preventDefault();
                void changeMode(cycleMode(agentMode));
              }
            }}
          >
            {attachments.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {attachments.map(a => (
                  <span
                    key={a.path}
                    className="inline-flex items-center gap-1.5 pl-0.5 pr-1.5 py-0.5 rounded-lg bg-surface-100 dark:bg-surface-800 border border-surface-200/80 dark:border-surface-700 text-[10px] max-w-[11rem]"
                    title={a.notice || a.name}
                  >
                    {a.previewDataUrl || (a.kind === 'image' && a.mime.startsWith('image/')) ? (
                      a.previewDataUrl ? (
                        <img
                          src={a.previewDataUrl}
                          alt=""
                          className="w-9 h-9 rounded-md object-cover shrink-0 bg-black/40"
                        />
                      ) : (
                        <span className="w-9 h-9 rounded-md shrink-0 bg-surface-200 dark:bg-surface-700 animate-pulse" />
                      )
                    ) : null}
                    <span className="min-w-0 flex flex-col leading-tight">
                      <span className={`font-semibold uppercase ${
                        a.understand === 'vision' ? 'text-emerald-600 dark:text-emerald-400'
                          : a.understand === 'doc-text' ? 'text-sky-600 dark:text-sky-400'
                            : a.understand === 'ocr' ? 'text-violet-600 dark:text-violet-400'
                              : 'text-amber-600 dark:text-amber-400'
                      }`}
                      >
                        {a.understand === 'doc-text' ? 'doc' : a.understand}
                      </span>
                      <span className="truncate text-surface-600 dark:text-surface-300">{a.name}</span>
                    </span>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => setAttachments(prev => prev.filter(x => x.path !== a.path))}
                      className="opacity-60 hover:opacity-100 shrink-0 self-start mt-0.5"
                      title="Remove"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <div className="composer-shell flex flex-col gap-2 p-2.5 sm:p-3">
              <textarea
                ref={taskInputRef}
                value={task}
                onChange={e => setTask(e.target.value)}
                rows={1}
                placeholder={MODE_PLACEHOLDERS[agentMode]}
                className="composer-textarea w-full bg-transparent border-0 focus:outline-none focus:ring-0 text-[13px] leading-relaxed resize-none text-surface-900 dark:text-surface-100 placeholder:text-surface-400 px-1 py-1.5 min-h-[2.5rem] max-h-[min(40vh,20rem)]"
                disabled={busy || voiceBusy}
                onKeyDown={e => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    if (!busy) void runAgent();
                  }
                }}
              />
              <div className="flex items-center gap-1 min-w-0 pt-1 border-t border-surface-200/70 dark:border-surface-800/80">
              <ComposerModelBar
                mode={agentMode}
                disabled={busy}
                onModeChange={m => void changeMode(m)}
                workspaceRoot={workspaceRoot}
                thinClient={thinClient}
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
                title="Attach file (or Ctrl+V a screenshot)"
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
          </div>
        </aside>
      </div>
    </div>
  );
}
