import { invoke } from '@tauri-apps/api/tauri';

export interface PtyShellInfo {
  id: string;
  label: string;
  available: boolean;
  path: string | null;
  note: string | null;
}

export interface PtySessionInfo {
  id: string;
  shell: string;
  cwd: string;
  running: boolean;
  started_at: number;
  exit_code: number | null;
}

export interface GitFileStatus {
  path: string;
  index: string;
  worktree: string;
  untracked: boolean;
  conflicted: boolean;
}

export interface GitStatusReport {
  is_repo: boolean;
  git_available: boolean;
  root: string | null;
  branch: string | null;
  files: GitFileStatus[];
  error: string | null;
}

export interface GitDiffResult {
  path: string;
  original: string;
  modified: string;
  unified: string;
  binary: boolean;
  untracked: boolean;
  too_large: boolean;
  is_repo: boolean;
  git_available: boolean;
  error: string | null;
}

export interface DiagnosticItem {
  path: string;
  line: number;
  column: number;
  severity: string;
  source: string;
  message: string;
}

export interface DiagnosticsReport {
  diagnostics: DiagnosticItem[];
  scanned: string[];
  notes: string[];
}

export interface OutputLine {
  ts: number;
  channel: string;
  text: string;
}

export interface DebugSessionInfo {
  id: string;
  runtime: string;
  running: boolean;
  cwd: string;
}

export interface ImageGenRequest {
  provider: string;
  modelId: string;
  prompt: string;
  negativePrompt?: string;
  width: number;
  height: number;
  seed?: number;
  quality?: string;
}

export interface ImageGenResult {
  url: string | null;
  b64: string | null;
  mime: string;
  provider: string;
  model_id: string;
}

export function ptyShells() {
  return invoke<PtyShellInfo[]>('cw_pty_shells');
}
export function ptySpawn(shell: string, cwd: string | null, cols: number, rows: number) {
  return invoke<PtySessionInfo>('cw_pty_spawn', { shell, cwd, cols, rows });
}
export function ptyWrite(id: string, data: string) {
  return invoke<void>('cw_pty_write', { id, data });
}
export function ptyResize(id: string, cols: number, rows: number) {
  return invoke<void>('cw_pty_resize', { id, cols, rows });
}
export function ptyKill(id: string) {
  return invoke<PtySessionInfo>('cw_pty_kill', { id });
}
export function ptyList() {
  return invoke<PtySessionInfo[]>('cw_pty_list');
}
export function gitStatus(workspaceRoot: string) {
  return invoke<GitStatusReport>('cw_git_status', { workspaceRoot });
}
export function gitDiff(workspaceRoot: string, path: string) {
  return invoke<GitDiffResult>('cw_git_diff', { workspaceRoot, path });
}
export function diagnosticsRun(workspaceRoot: string) {
  return invoke<DiagnosticsReport>('cw_diagnostics_run', { workspaceRoot });
}
export function outputSnapshot(channel?: string | null) {
  return invoke<OutputLine[]>('cw_output_snapshot', { channel: channel ?? null });
}
export function outputClear(channel?: string | null) {
  return invoke<void>('cw_output_clear', { channel: channel ?? null });
}
export function debugStart(workspaceRoot: string, runtime?: string) {
  return invoke<DebugSessionInfo>('cw_debug_start', { workspaceRoot, runtime: runtime ?? 'auto' });
}
export function debugEval(expr: string) {
  return invoke<void>('cw_debug_eval', { expr });
}
export function debugStop() {
  return invoke<void>('cw_debug_stop');
}
export function debugCurrent() {
  return invoke<DebugSessionInfo | null>('cw_debug_current');
}
export function imageStudioGenerate(request: ImageGenRequest) {
  return invoke<ImageGenResult>('image_studio_generate', { request });
}
export function imageStudioSaveB64(path: string, b64: string) {
  return invoke<void>('image_studio_save_b64', { path, b64 });
}
