export type CodeWorkspaceToolName =
  | 'list_dir'
  | 'glob_file_search'
  | 'grep'
  | 'read_file'
  | 'apply_edit'
  | 'run_command'
  | 'done';

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

export interface ToolingStatus {
  rg_path: string | null;
  python_path: string | null;
  node_path: string | null;
  rg_ok: boolean;
  python_ok: boolean;
  node_ok: boolean;
  message: string;
}

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
