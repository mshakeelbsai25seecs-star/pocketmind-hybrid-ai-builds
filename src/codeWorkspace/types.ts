export type CodeWorkspaceToolName =
  | 'list_dir'
  | 'glob_file_search'
  | 'grep'
  | 'repo_map'
  | 'find_symbol'
  | 'read_symbol'
  | 'read_file'
  | 'apply_edit'
  | 'delete_file'
  | 'run_command'
  | 'ask_followup'
  | 'create_plan'
  | 'update_plan'
  | 'mcp_call'
  | 'done';

export interface PendingMcpCall {
  id: string;
  server: string;
  tool: string;
  arguments: Record<string, unknown>;
  status: 'pending' | 'accepted' | 'rejected';
}

export interface PocketCodePlanTodo {
  id: string;
  text: string;
  done: boolean;
}

export interface PocketCodePlan {
  id: string;
  title: string;
  markdown: string;
  todos: PocketCodePlanTodo[];
  status: 'draft' | 'approved' | 'built' | 'discarded';
  created_at: number;
  updated_at: number;
  checkpoint_run_id?: string | null;
}

export interface PocketCodeImageAttach {
  path: string;
  name: string;
  mime: string;
  kind?: 'image' | 'pdf' | 'doc';
  /** How the attachment will be used for the next send */
  understand: 'vision' | 'doc-text' | 'unavailable' | 'ocr';
  ocrText?: string;
  notice?: string;
}

export interface PendingDelete {
  id: string;
  path: string;
  status: 'pending' | 'accepted' | 'rejected';
}

export interface CodeWorkspaceToolCall {
  tool: CodeWorkspaceToolName;
  args: Record<string, unknown>;
}

export interface PendingPatch {
  id: string;
  path: string;
  original: string;
  modified: string;
  status: 'pending' | 'accepted' | 'rejected';
}

export interface SandboxRunResult {
  ok: boolean;
  language: string;
  exit_code: number | null;
  stdout: string;
  stderr: string;
  timed_out: boolean;
  duration_ms: number;
}

export interface RunnerInfo {
  id: string;
  kind: string;
  available: boolean;
  binary: string | null;
  note: string;
}

export interface RunnersStatus {
  runners: RunnerInfo[];
  message: string;
}

export interface ToolingStatus {
  rg_path: string | null;
  python_path: string | null;
  node_path: string | null;
  rg_ok: boolean;
  python_ok: boolean;
  node_ok: boolean;
  message: string;
}

export type { SandboxPendingRequest } from './sandboxTypes';

export interface WorkspaceProfile {
  id: string;
  name: string;
  created_at: number;
  is_default: boolean;
}

export interface DirEntryInfo {
  name: string;
  is_dir: boolean;
  path: string;
}

export interface EditPreview {
  original: string;
  modified: string;
}

export interface OrphanItem {
  path: string;
  size_bytes: number;
  kind: string;
  safe_to_delete: boolean;
}

export interface IntegrityResult {
  path: string;
  sha256: string;
  matched_expected: boolean | null;
  size_bytes: number;
}

export interface BatchFileResult {
  path: string;
  ok: boolean;
  summary: string;
}

export interface BackupScheduleStatus {
  enabled: boolean;
  hours: number;
  dest_dir: string;
  last_run_at?: number | null;
  last_status?: string | null;
}

export interface AgentStep {
  step: number;
  kind: 'assistant' | 'tool' | 'error' | 'done';
  content: string;
  tool?: string;
  toolResult?: string;
}
