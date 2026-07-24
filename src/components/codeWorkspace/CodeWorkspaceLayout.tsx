import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { open } from '@tauri-apps/api/dialog';
import {
  FolderOpen, Play, Square, ChevronRight, ChevronDown, File, Folder,
  Code2, RefreshCw, AlertCircle,
} from 'lucide-react';
import { useAppStore } from '../../store';
import { FEATURE_FLAGS } from '../../featureFlags';
import { cwApplyEditWrite, cwCanUse, cwListDir } from '../../api/codeWorkspace';
import type { AgentStep, DirEntryInfo, PendingPatch, SandboxRunResult } from '../../codeWorkspace/types';
import DiffViewer from '../DiffViewer';
import AgentTranscript from './AgentTranscript';
import SandboxPanel from './SandboxPanel';
import { runCodeWorkspaceAgent, runSandboxConfirmed } from './agentLoop';
import { getSetting, setSetting } from '../../api/powerFeatures';

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
  onSelect: (path: string) => void;
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
        onClick={() => onSelect(entry.path)}
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
        onClick={() => { setOpenDir(v => !v); onSelect(entry.path); }}
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

export default function CodeWorkspaceLayout() {
  const currentModel = useAppStore(s => s.currentModel);
  const defaultParams = useAppStore(s => s.defaultParams);

  const [workspaceRoot, setWorkspaceRoot] = useState('');
  const [tree, setTree] = useState<DirEntryInfo[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [task, setTask] = useState('');
  const [agentSteps, setAgentSteps] = useState<AgentStep[]>([]);
  const [pendingPatch, setPendingPatch] = useState<PendingPatch | null>(null);
  const [sandboxPending, setSandboxPending] = useState<{ language: 'python' | 'javascript'; code: string } | null>(null);
  const [sandboxResult, setSandboxResult] = useState<SandboxRunResult | null>(null);
  const [gateReason, setGateReason] = useState<string | null>(null);
  const [gateAllowed, setGateAllowed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const sandboxResolverRef = useRef<((r: SandboxRunResult | null) => void) | null>(null);

  useEffect(() => {
    void getSetting('cw.workspace_root').then(v => { if (v) setWorkspaceRoot(v); });
  }, []);

  useEffect(() => {
    void cwCanUse(currentModel).then(g => {
      setGateAllowed(g.allowed);
      setGateReason(g.reason);
    });
  }, [currentModel]);

  const refreshTree = useCallback(async (root?: string) => {
    const r = root ?? workspaceRoot;
    if (!r) return;
    try {
      const entries = await cwListDir(r, '.');
      setTree(entries.sort((a, b) => Number(b.is_dir) - Number(a.is_dir) || a.name.localeCompare(b.name)));
    } catch (err) {
      setStatus(String(err));
    }
  }, [workspaceRoot]);

  const pickFolder = async () => {
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected !== 'string' || !selected) return;
    setWorkspaceRoot(selected);
    await setSetting('cw.workspace_root', selected);
    setSelectedPath(null);
    await refreshTree(selected);
  };

  const stopAgent = () => {
    abortRef.current?.abort();
    setBusy(false);
    setStatus('Agent stopped.');
  };

  const acceptPatch = async () => {
    if (!pendingPatch || !workspaceRoot) return;
    try {
      await cwApplyEditWrite(workspaceRoot, pendingPatch.path, pendingPatch.modified);
      setPendingPatch(null);
      setStatus(`Applied edit to ${pendingPatch.path}`);
      await refreshTree();
    } catch (err) {
      setStatus(String(err));
    }
  };

  const rejectPatch = () => {
    setPendingPatch(null);
    setStatus('Edit rejected.');
  };

  const confirmSandbox = async () => {
    if (!sandboxPending || !workspaceRoot) return;
    setBusy(true);
    try {
      const result = await runSandboxConfirmed(workspaceRoot, sandboxPending.language, sandboxPending.code);
      setSandboxResult(result);
      sandboxResolverRef.current?.(result);
    } catch (err) {
      setSandboxResult(null);
      sandboxResolverRef.current?.(null);
      setStatus(String(err));
    } finally {
      setSandboxPending(null);
      setBusy(false);
      sandboxResolverRef.current = null;
    }
  };

  const cancelSandbox = () => {
    setSandboxPending(null);
    sandboxResolverRef.current?.(null);
    sandboxResolverRef.current = null;
  };

  const runAgent = async () => {
    if (!FEATURE_FLAGS.codeWorkspace || !workspaceRoot || !task.trim() || !currentModel) return;
    if (!gateAllowed) {
      setStatus(gateReason || 'Model not allowed for Code Workspace.');
      return;
    }
    setBusy(true);
    setAgentSteps([]);
    setStatus('Agent running…');
    abortRef.current = new AbortController();
    try {
      const { summary } = await runCodeWorkspaceAgent({
        workspaceRoot,
        task: task.trim(),
        modelPath: currentModel,
        params: defaultParams,
        signal: abortRef.current.signal,
        callbacks: {
          onStep: step => setAgentSteps(prev => [...prev, step]),
          onPendingPatch: patch => setPendingPatch(patch),
          onSandboxRequest: payload => new Promise(resolve => {
            setSandboxPending(payload);
            sandboxResolverRef.current = resolve;
          }),
        },
      });
      setStatus(summary);
    } catch (err) {
      setStatus(String(err));
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  };

  const headerPath = useMemo(() => workspaceRoot || 'No folder open', [workspaceRoot]);

  return (
    <div className="flex-1 flex flex-col h-full min-w-0">
      <div className="border-b border-surface-200 dark:border-surface-800 px-4 py-3 flex flex-wrap items-center justify-between gap-3 glass-panel">
        <div className="min-w-0">
          <h1 className="text-lg font-black flex items-center gap-2">
            <Code2 className="w-5 h-5 text-primary-600" /> Code Workspace
          </h1>
          <p className="text-xs text-surface-500 truncate">{headerPath}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button onClick={() => void pickFolder()} className="btn-secondary text-sm flex items-center gap-2">
            <FolderOpen className="w-4 h-4" /> Open folder
          </button>
          <button disabled={!workspaceRoot} onClick={() => void refreshTree()} className="btn-secondary text-sm flex items-center gap-2">
            <RefreshCw className="w-4 h-4" /> Refresh tree
          </button>
        </div>
      </div>

      {!gateAllowed && (
        <div className="mx-4 mt-4 rounded-xl border border-amber-300/60 bg-amber-50 dark:bg-amber-950/20 p-3 text-sm text-amber-800 dark:text-amber-200 flex gap-2">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          {gateReason || 'Select a ≥70B local model or large online model for edit/run tools.'}
        </div>
      )}

      {status && (
        <div className="mx-4 mt-3 rounded-xl border border-primary-200 dark:border-primary-900/60 bg-primary-50 dark:bg-primary-950/20 p-3 text-sm text-primary-800 dark:text-primary-200">
          {status}
        </div>
      )}

      <div className="flex-1 min-h-0 grid lg:grid-cols-[minmax(12rem,16rem)_1fr] xl:grid-cols-[minmax(12rem,16rem)_1fr_minmax(18rem,22rem)]">
        <aside className="border-r border-surface-200 dark:border-surface-800 overflow-y-auto p-2 bg-white/50 dark:bg-surface-950/30">
          <p className="text-[11px] font-bold uppercase tracking-wider text-surface-500 px-2 py-2">Files</p>
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
              onSelect={setSelectedPath}
            />
          ))}
        </aside>

        <section className="flex flex-col min-h-0 border-r border-surface-200 dark:border-surface-800">
          <div className="p-4 space-y-3 flex-1 min-h-0 overflow-y-auto">
            <label className="block text-sm font-semibold">Agent task</label>
            <textarea
              value={task}
              onChange={e => setTask(e.target.value)}
              rows={3}
              placeholder="Describe what to change in this folder…"
              className="input-field w-full text-sm"
            />
            <div className="flex gap-2">
              {busy ? (
                <button onClick={stopAgent} className="btn-secondary text-sm flex items-center gap-2">
                  <Square className="w-4 h-4" /> Stop
                </button>
              ) : (
                <button
                  disabled={!workspaceRoot || !task.trim() || !currentModel}
                  onClick={() => void runAgent()}
                  className="btn-primary text-sm flex items-center gap-2 disabled:opacity-50"
                >
                  <Play className="w-4 h-4" /> Run agent
                </button>
              )}
            </div>
            <AgentTranscript steps={agentSteps} />
          </div>

          {pendingPatch && (
            <div className="border-t border-surface-200 dark:border-surface-800 p-4 space-y-3 bg-surface-50/80 dark:bg-surface-900/40">
              <p className="text-sm font-bold">Pending edit · {pendingPatch.path}</p>
              <DiffViewer original={pendingPatch.original} modified={pendingPatch.modified} />
              <div className="flex gap-2">
                <button onClick={() => void acceptPatch()} className="btn-primary text-sm">Accept</button>
                <button onClick={rejectPatch} className="btn-secondary text-sm">Reject</button>
              </div>
            </div>
          )}
        </section>

        <aside className="hidden xl:flex flex-col min-h-0 overflow-y-auto p-4 space-y-4 bg-white/40 dark:bg-surface-950/20">
          {FEATURE_FLAGS.codeWorkspaceSandbox && (
            <SandboxPanel
              pending={sandboxPending}
              lastResult={sandboxResult}
              busy={busy}
              onConfirm={() => void confirmSandbox()}
              onCancel={cancelSandbox}
            />
          )}
          {selectedPath && (
            <div className="text-xs text-surface-500 break-all">
              Selected: {selectedPath}
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
