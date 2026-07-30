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

/** Desktop Tauri `cw_*` transport — never talks to agent-host. */
export function createLocalTauriWorkspaceTools(): WorkspaceTools {
  return {
    listDir: (workspaceRoot, path = '.') =>
      invoke<DirEntryInfo[]>('cw_list_dir', { workspaceRoot, rel: path }),
    glob: (workspaceRoot, pattern) =>
      invoke<string[]>('cw_glob', { workspaceRoot, pattern }),
    grep: (workspaceRoot, pattern, path = null, glob = null, caseInsensitive = false) =>
      invoke<string>('cw_grep', {
        workspaceRoot,
        pattern,
        path: path ?? null,
        glob: glob ?? null,
        caseInsensitive,
      }),
    readFile: (workspaceRoot, path, offset = 0, limit = 120, forUi = false) =>
      invoke<string>('cw_read_file', { workspaceRoot, path, offset, limit, forUi }),
    ensureSymbolIndex: (workspaceRoot) =>
      invoke<[number, number]>('cw_ensure_symbol_index', { workspaceRoot }),
    repoMap: (workspaceRoot) => invoke<string>('cw_repo_map', { workspaceRoot }),
    findSymbol: (workspaceRoot, query) =>
      invoke<SymbolHit[]>('cw_find_symbol', { workspaceRoot, query }),
    readSymbol: (workspaceRoot, path, name, lineStart = null) =>
      invoke<string>('cw_read_symbol', {
        workspaceRoot,
        path,
        name,
        lineStart: lineStart ?? null,
      }),
    deleteFile: async (workspaceRoot, path) => {
      await invoke('cw_delete_file', { workspaceRoot, path });
    },
    checkpointBegin: (workspaceRoot) =>
      invoke<string>('cw_checkpoint_begin', { workspaceRoot }),
    checkpointSnapshotWrite: async (workspaceRoot, runId, path) => {
      await invoke('cw_checkpoint_snapshot_write', { workspaceRoot, runId, path });
    },
    checkpointSnapshotDelete: async (workspaceRoot, runId, path) => {
      await invoke('cw_checkpoint_snapshot_delete', { workspaceRoot, runId, path });
    },
    listCheckpoints: (workspaceRoot) =>
      invoke<CheckpointSummary[]>('cw_list_checkpoints', { workspaceRoot }),
    restoreCheckpoint: (workspaceRoot, runId) =>
      invoke<number>('cw_restore_checkpoint', { workspaceRoot, runId }),
    restoreCheckpointFile: async (workspaceRoot, runId, path) => {
      await invoke('cw_restore_checkpoint_file', { workspaceRoot, runId, path });
    },
    checkpointManifest: (workspaceRoot, runId) =>
      invoke<CheckpointManifest>('cw_checkpoint_manifest', { workspaceRoot, runId }),
    applyEditPreview: (workspaceRoot, path, oldString, newString) =>
      invoke<EditPreview>('cw_apply_edit_preview', {
        workspaceRoot,
        path,
        oldString,
        newString,
      }),
    applyEditWrite: async (workspaceRoot, path, content) => {
      await invoke('cw_apply_edit_write', { workspaceRoot, path, content });
    },
    runSandbox: async (workspaceRoot, request: SandboxPendingRequest) => {
      if (request.mode === 'cli') {
        return invoke<SandboxRunResult>('cw_run_sandbox', {
          workspaceRoot,
          language: null,
          script: null,
          args: null,
          argv: request.argv,
        });
      }
      return invoke<SandboxRunResult>('cw_run_sandbox', {
        workspaceRoot,
        language: request.language,
        script: request.code,
        args: request.args ?? null,
        argv: null,
      });
    },
    listRunners: () => invoke<RunnersStatus>('cw_list_runners'),
    terminalStart: (workspaceRoot, request) =>
      invoke<TerminalStartInfo>('cw_terminal_start', {
        workspaceRoot,
        language: request.language ?? null,
        script: request.code ?? null,
        args: request.args ?? null,
        argv: request.argv && request.argv.length > 0 ? request.argv : null,
        background: Boolean(request.background),
      }),
    terminalRead: (id, tailBytes = null) =>
      invoke<TerminalSnapshot>('cw_terminal_read', { id, tailBytes: tailBytes ?? null }),
    terminalKill: (id) => invoke<TerminalSnapshot>('cw_terminal_kill', { id }),
    terminalList: () => invoke<TerminalSnapshot[]>('cw_terminal_list'),
    loadProjectRules: (workspaceRoot) =>
      invoke<string>('cw_load_project_rules', { workspaceRoot }),
    planWrite: (workspaceRoot, id, title, markdown, todos, status = null) =>
      invoke<PocketCodePlan>('cw_plan_write', {
        workspaceRoot,
        id,
        title,
        markdown,
        todos,
        status: status ?? null,
      }),
    planRead: (workspaceRoot, id) =>
      invoke<PocketCodePlan>('cw_plan_read', { workspaceRoot, id }),
    planList: (workspaceRoot) => invoke('cw_plan_list', { workspaceRoot }),
    planUpdateMarkdown: (workspaceRoot, id, markdown, todos = null) =>
      invoke<PocketCodePlan>('cw_plan_update_markdown', {
        workspaceRoot,
        id,
        markdown,
        todos: todos ?? null,
      }),
    planUpdateStatus: (workspaceRoot, id, status, checkpointRunId = null) =>
      invoke<PocketCodePlan>('cw_plan_update_status', {
        workspaceRoot,
        id,
        status,
        checkpointRunId: checkpointRunId ?? null,
      }),
  };
}
