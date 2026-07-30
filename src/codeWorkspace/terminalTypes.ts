/**
 * Streaming terminal sessions. Shape is identical for local Tauri and remote agent-host so the
 * agent loop and the terminal panel never branch on transport.
 */

export interface TerminalStartInfo {
  id: string;
  label: string;
  command: string;
  background: boolean;
  timeout_secs: number;
}

export interface TerminalSnapshot {
  id: string;
  label: string;
  command: string;
  background: boolean;
  running: boolean;
  exit_code: number | null;
  timed_out: boolean;
  killed: boolean;
  started_at: number;
  duration_ms: number;
  output: string;
  total_bytes: number;
  /** True when `output` is only the tail of a longer stream. */
  truncated: boolean;
}

export interface TerminalStartRequest {
  argv?: string[];
  language?: string;
  code?: string;
  args?: string[];
  background?: boolean;
}

export function terminalStatusLabel(snap: TerminalSnapshot): string {
  if (snap.running) return snap.background ? 'running (background)' : 'running';
  if (snap.timed_out) return 'timed out';
  if (snap.killed) return 'killed';
  if (snap.exit_code === 0) return 'exit 0';
  if (snap.exit_code == null) return 'stopped';
  return `exit ${snap.exit_code}`;
}

/** Keep the last N lines — what the model needs from a long build log. */
export function tailLines(text: string, maxLines: number): string {
  const lines = text.split('\n');
  if (lines.length <= maxLines) return text;
  return `…[${lines.length - maxLines} earlier lines omitted]\n${lines.slice(-maxLines).join('\n')}`;
}
