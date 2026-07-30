/**
 * Workspace tool transport factory. Mode switching lives here — never in agentLoop.
 */

import type {
  DirEntryInfo,
  EditPreview,
  PocketCodePlan,
  PocketCodePlanTodo,
  RunnersStatus,
  SandboxRunResult,
} from './types';
import type { SandboxPendingRequest } from './sandboxTypes';
import type {
  TerminalSnapshot,
  TerminalStartInfo,
  TerminalStartRequest,
} from './terminalTypes';
import type { CheckpointManifest, CheckpointSummary, SymbolHit } from '../api/codeWorkspaceTypes';
import type { PocketCodeRuntimeProfile } from './runtimeProfile';
import { validateRuntimeProfile } from './runtimeProfile';
import { createLocalTauriWorkspaceTools } from './transports/localTauri';
import { createRemoteAgentHttpWorkspaceTools } from './transports/remoteAgentHttp';

export interface WorkspaceTools {
  listDir(workspaceRoot: string, path?: string): Promise<DirEntryInfo[]>;
  glob(workspaceRoot: string, pattern: string): Promise<string[]>;
  grep(
    workspaceRoot: string,
    pattern: string,
    path?: string | null,
    glob?: string | null,
    caseInsensitive?: boolean,
  ): Promise<string>;
  readFile(
    workspaceRoot: string,
    path: string,
    offset?: number,
    limit?: number,
    forUi?: boolean,
  ): Promise<string>;
  ensureSymbolIndex(workspaceRoot: string): Promise<[number, number]>;
  repoMap(workspaceRoot: string): Promise<string>;
  findSymbol(workspaceRoot: string, query: string): Promise<SymbolHit[]>;
  readSymbol(
    workspaceRoot: string,
    path: string,
    name: string,
    lineStart?: number | null,
  ): Promise<string>;
  deleteFile(workspaceRoot: string, path: string): Promise<void>;
  checkpointBegin(workspaceRoot: string): Promise<string>;
  checkpointSnapshotWrite(workspaceRoot: string, runId: string, path: string): Promise<void>;
  checkpointSnapshotDelete(workspaceRoot: string, runId: string, path: string): Promise<void>;
  listCheckpoints(workspaceRoot: string): Promise<CheckpointSummary[]>;
  restoreCheckpoint(workspaceRoot: string, runId: string): Promise<number>;
  restoreCheckpointFile(workspaceRoot: string, runId: string, path: string): Promise<void>;
  checkpointManifest(workspaceRoot: string, runId: string): Promise<CheckpointManifest>;
  applyEditPreview(
    workspaceRoot: string,
    path: string,
    oldString: string,
    newString: string,
  ): Promise<EditPreview>;
  applyEditWrite(workspaceRoot: string, path: string, content: string): Promise<void>;
  runSandbox(workspaceRoot: string, request: SandboxPendingRequest): Promise<SandboxRunResult>;
  listRunners(): Promise<RunnersStatus>;
  /** Start a command as a live session; poll with terminalRead. */
  terminalStart(workspaceRoot: string, request: TerminalStartRequest): Promise<TerminalStartInfo>;
  terminalRead(id: string, tailBytes?: number | null): Promise<TerminalSnapshot>;
  terminalKill(id: string): Promise<TerminalSnapshot>;
  terminalList(): Promise<TerminalSnapshot[]>;
  loadProjectRules(workspaceRoot: string): Promise<string>;
  planWrite(
    workspaceRoot: string,
    id: string | null,
    title: string,
    markdown: string,
    todos: string[],
    status?: string | null,
  ): Promise<PocketCodePlan>;
  planRead(workspaceRoot: string, id: string): Promise<PocketCodePlan>;
  planList(
    workspaceRoot: string,
  ): Promise<Array<{ id: string; title: string; status: string; updated_at: number; todo_count: number }>>;
  planUpdateMarkdown(
    workspaceRoot: string,
    id: string,
    markdown: string,
    todos?: PocketCodePlanTodo[] | null,
  ): Promise<PocketCodePlan>;
  planUpdateStatus(
    workspaceRoot: string,
    id: string,
    status: string,
    checkpointRunId?: string | null,
  ): Promise<PocketCodePlan>;
}

let activeTools: WorkspaceTools | null = null;
let activeProfileKey = '';

function profileKey(profile: PocketCodeRuntimeProfile): string {
  return JSON.stringify({
    workspaceHost: profile.workspaceHost,
    provision: profile.provision,
    uiShell: profile.uiShell,
    remote: profile.remote || null,
  });
}

/**
 * Resolve the active workspace tool backend for the given profile.
 * Fails closed: never falls back from remote → local on misconfiguration.
 */
export function resolveWorkspaceTools(profile: PocketCodeRuntimeProfile): WorkspaceTools {
  const key = profileKey(profile);
  if (activeTools && activeProfileKey === key) return activeTools;

  if (profile.workspaceHost === 'local') {
    if (profile.uiShell === 'thin_client') {
      throw new Error('Thin client cannot use local workspace tools.');
    }
    activeTools = createLocalTauriWorkspaceTools();
    activeProfileKey = key;
    return activeTools;
  }

  const v = validateRuntimeProfile(profile);
  if (!v.ok) {
    throw new Error(v.reason);
  }
  const baseUrl = profile.remote!.baseUrl.trim();
  const workspaceId = profile.remote!.workspaceId.trim();
  activeTools = createRemoteAgentHttpWorkspaceTools({ baseUrl, workspaceId });
  activeProfileKey = key;
  return activeTools;
}

export function resetWorkspaceToolsCache(): void {
  activeTools = null;
  activeProfileKey = '';
}

/** Logical root token for remote workspaces (agent-host resolves via workspace_id). */
export function remoteWorkspaceRootToken(workspaceId: string): string {
  return `remote://${workspaceId}`;
}
