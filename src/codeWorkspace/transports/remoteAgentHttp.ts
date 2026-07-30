import { invoke } from '@tauri-apps/api/tauri';
import type {
  DirEntryInfo,
  EditPreview,
  PocketCodePlan,
  PocketCodePlanTodo,
  RunnersStatus,
  SandboxRunResult,
} from '../types';
import type { SandboxPendingRequest } from '../sandboxTypes';
import type { TerminalSnapshot, TerminalStartInfo } from '../terminalTypes';
import type { CheckpointManifest, CheckpointSummary, SymbolHit } from '../../api/codeWorkspaceTypes';
import type { WorkspaceTools } from '../workspaceTransport';

export interface RemoteAgentHttpOptions {
  baseUrl: string;
  workspaceId: string;
}

async function bearerToken(): Promise<string> {
  return invoke<string>('get_enterprise_server_token').catch(() => '');
}

function joinUrl(base: string, path: string): string {
  const b = base.replace(/\/+$/, '');
  const p = path.startsWith('/') ? path : `/${path}`;
  return `${b}${p}`;
}

async function agentFetch<T>(
  opts: RemoteAgentHttpOptions,
  path: string,
  body: Record<string, unknown>,
): Promise<T> {
  const token = await bearerToken();
  if (!token.trim()) {
    throw new Error('Remote agent host requires an organization server API token.');
  }
  const url = joinUrl(opts.baseUrl, path);
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ workspace_id: opts.workspaceId, ...body }),
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const msg =
      typeof data === 'object' && data && 'error' in data
        ? String((data as { error: unknown }).error)
        : text || res.statusText;
    throw new Error(`Agent host ${res.status}: ${msg}`);
  }
  return data as T;
}

/**
 * Remote agent-host HTTP transport — never calls local Tauri `cw_*` tools.
 * Unsupported parity endpoints return explicit errors (no silent local fallback).
 */
export function createRemoteAgentHttpWorkspaceTools(opts: RemoteAgentHttpOptions): WorkspaceTools {
  const tool = <T>(name: string, body: Record<string, unknown> = {}) =>
    agentFetch<T>(opts, `/v1/agent/tools/${name}`, body);

  return {
    listDir: (workspaceRoot, path = '.') =>
      tool<DirEntryInfo[]>('list_dir', { path, workspace_root: workspaceRoot }),
    glob: (workspaceRoot, pattern) =>
      tool<string[]>('glob', { pattern, workspace_root: workspaceRoot }),
    grep: (workspaceRoot, pattern, path = null, glob = null, caseInsensitive = false) =>
      tool<string>('grep', {
        pattern,
        path,
        glob,
        case_insensitive: caseInsensitive,
        workspace_root: workspaceRoot,
      }),
    readFile: (workspaceRoot, path, offset = 0, limit = 120, forUi = false) =>
      tool<string>('read_file', {
        path,
        offset,
        limit,
        for_ui: forUi,
        workspace_root: workspaceRoot,
      }),
    ensureSymbolIndex: (workspaceRoot) =>
      tool<[number, number]>('ensure_symbol_index', { workspace_root: workspaceRoot }),
    repoMap: (workspaceRoot) =>
      tool<string>('repo_map', { workspace_root: workspaceRoot }),
    findSymbol: (workspaceRoot, query) =>
      tool<SymbolHit[]>('find_symbol', { query, workspace_root: workspaceRoot }),
    readSymbol: (workspaceRoot, path, name, lineStart = null) =>
      tool<string>('read_symbol', {
        path,
        name,
        line_start: lineStart,
        workspace_root: workspaceRoot,
      }),
    deleteFile: async (workspaceRoot, path) => {
      await tool('delete_file', { path, workspace_root: workspaceRoot });
    },
    checkpointBegin: (workspaceRoot) =>
      tool<string>('checkpoint_begin', { workspace_root: workspaceRoot }),
    checkpointSnapshotWrite: async (workspaceRoot, runId, path) => {
      await tool('checkpoint_snapshot_write', {
        run_id: runId,
        path,
        workspace_root: workspaceRoot,
      });
    },
    checkpointSnapshotDelete: async (workspaceRoot, runId, path) => {
      await tool('checkpoint_snapshot_delete', {
        run_id: runId,
        path,
        workspace_root: workspaceRoot,
      });
    },
    listCheckpoints: (workspaceRoot) =>
      tool<CheckpointSummary[]>('list_checkpoints', { workspace_root: workspaceRoot }),
    restoreCheckpoint: (workspaceRoot, runId) =>
      tool<number>('restore_checkpoint', { run_id: runId, workspace_root: workspaceRoot }),
    restoreCheckpointFile: async (workspaceRoot, runId, path) => {
      await tool('restore_checkpoint_file', {
        run_id: runId,
        path,
        workspace_root: workspaceRoot,
      });
    },
    checkpointManifest: (workspaceRoot, runId) =>
      tool<CheckpointManifest>('checkpoint_manifest', {
        run_id: runId,
        workspace_root: workspaceRoot,
      }),
    applyEditPreview: (workspaceRoot, path, oldString, newString) =>
      tool<EditPreview>('apply_edit_preview', {
        path,
        old_string: oldString,
        new_string: newString,
        workspace_root: workspaceRoot,
      }),
    applyEditWrite: async (workspaceRoot, path, content) => {
      await tool('apply_edit_write', { path, content, workspace_root: workspaceRoot });
    },
    runSandbox: async (workspaceRoot, request: SandboxPendingRequest) => {
      if (request.mode === 'cli') {
        return tool<SandboxRunResult>('run_sandbox', {
          mode: 'cli',
          argv: request.argv,
          workspace_root: workspaceRoot,
        });
      }
      return tool<SandboxRunResult>('run_sandbox', {
        mode: 'script',
        language: request.language,
        script: request.code,
        args: request.args ?? null,
        workspace_root: workspaceRoot,
      });
    },
    listRunners: () => tool<RunnersStatus>('list_runners', {}),
    terminalStart: (workspaceRoot, request) =>
      tool<TerminalStartInfo>('terminal_start', {
        argv: request.argv && request.argv.length > 0 ? request.argv : null,
        language: request.language ?? null,
        script: request.code ?? null,
        args: request.args ?? null,
        background: Boolean(request.background),
        workspace_root: workspaceRoot,
      }),
    terminalRead: (id, tailBytes = null) =>
      tool<TerminalSnapshot>('terminal_read', { id, tail_bytes: tailBytes ?? null }),
    terminalKill: (id) => tool<TerminalSnapshot>('terminal_kill', { id }),
    terminalList: () => tool<TerminalSnapshot[]>('terminal_list', {}),
    loadProjectRules: (workspaceRoot) =>
      tool<string>('project_rules', { workspace_root: workspaceRoot }),
    planWrite: (workspaceRoot, id, title, markdown, todos, status = null) =>
      tool<PocketCodePlan>('plan_write', {
        id,
        title,
        markdown,
        todos,
        status,
        workspace_root: workspaceRoot,
      }),
    planRead: (workspaceRoot, id) =>
      tool<PocketCodePlan>('plan_read', { id, workspace_root: workspaceRoot }),
    planList: (workspaceRoot) =>
      tool('plan_list', { workspace_root: workspaceRoot }),
    planUpdateMarkdown: (workspaceRoot, id, markdown, todos = null) =>
      tool<PocketCodePlan>('plan_update_markdown', {
        id,
        markdown,
        todos,
        workspace_root: workspaceRoot,
      }),
    planUpdateStatus: (workspaceRoot, id, status, checkpointRunId = null) =>
      tool<PocketCodePlan>('plan_update_status', {
        id,
        status,
        checkpoint_run_id: checkpointRunId,
        workspace_root: workspaceRoot,
      }),
  };
}
