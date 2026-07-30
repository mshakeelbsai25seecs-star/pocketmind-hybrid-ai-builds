/**
 * Client-side view of terminal sessions.
 *
 * The backend owns the processes and their output buffers; this module polls them so the terminal
 * panel can show live output and the agent can wait for a command to finish. One poller serves
 * every running session, and it stops itself when nothing is running.
 */

import {
  cwTerminalKill,
  cwTerminalList,
  cwTerminalRead,
  cwTerminalStart,
} from '../api/codeWorkspace';
import type {
  TerminalSnapshot,
  TerminalStartInfo,
  TerminalStartRequest,
} from './terminalTypes';

const POLL_MS = 700;
/** Tail size pulled per poll — enough for a screen of build output without shipping megabytes. */
const POLL_TAIL_BYTES = 64 * 1024;

const sessions = new Map<string, TerminalSnapshot>();
let ordered: TerminalSnapshot[] = [];
const listeners = new Set<() => void>();
let pollTimer: number | null = null;

function rebuild(): void {
  // Newest first, matching the panel's reading order.
  ordered = Array.from(sessions.values()).sort((a, b) => {
    if (a.running !== b.running) return a.running ? -1 : 1;
    return b.started_at - a.started_at;
  });
  for (const l of listeners) l();
}

function put(snap: TerminalSnapshot): void {
  sessions.set(snap.id, snap);
  rebuild();
}

export function subscribeTerminalSessions(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Stable reference between changes so useSyncExternalStore does not loop. */
export function terminalSessionList(): TerminalSnapshot[] {
  return ordered;
}

export function terminalSession(id: string): TerminalSnapshot | undefined {
  return sessions.get(id);
}

function ensurePoller(): void {
  if (pollTimer != null) return;
  pollTimer = window.setInterval(() => {
    const running = Array.from(sessions.values()).filter(s => s.running);
    if (running.length === 0) {
      if (pollTimer != null) {
        window.clearInterval(pollTimer);
        pollTimer = null;
      }
      return;
    }
    void Promise.all(
      running.map(s =>
        cwTerminalRead(s.id, POLL_TAIL_BYTES)
          .then(put)
          .catch(() => {
            // Session vanished (backend restart) — stop tracking it as running.
            const prev = sessions.get(s.id);
            if (prev) put({ ...prev, running: false });
          }),
      ),
    );
  }, POLL_MS);
}

export async function startTerminalSession(
  workspaceRoot: string,
  request: TerminalStartRequest,
): Promise<TerminalStartInfo> {
  const info = await cwTerminalStart(workspaceRoot, request);
  put({
    id: info.id,
    label: info.label,
    command: info.command,
    background: info.background,
    running: true,
    exit_code: null,
    timed_out: false,
    killed: false,
    started_at: Math.floor(Date.now() / 1000),
    duration_ms: 0,
    output: '',
    total_bytes: 0,
    truncated: false,
  });
  ensurePoller();
  return info;
}

export async function refreshTerminalSession(
  id: string,
  tailBytes: number | null = POLL_TAIL_BYTES,
): Promise<TerminalSnapshot> {
  const snap = await cwTerminalRead(id, tailBytes);
  put(snap);
  return snap;
}

export async function killTerminalSession(id: string): Promise<TerminalSnapshot> {
  const snap = await cwTerminalKill(id);
  put(snap);
  return snap;
}

/** Adopt sessions the backend already knows about (panel mount, workspace reopen). */
export async function loadTerminalSessions(): Promise<void> {
  const list = await cwTerminalList().catch(() => [] as TerminalSnapshot[]);
  for (const snap of list) {
    const prev = sessions.get(snap.id);
    // list() omits output bodies; keep whatever we already streamed.
    sessions.set(snap.id, { ...snap, output: snap.output || prev?.output || '' });
  }
  rebuild();
  ensurePoller();
}

export interface WaitForTerminalOptions {
  signal?: AbortSignal;
  /** Client-side ceiling; the backend enforces its own timeout too. */
  maxWaitMs?: number;
  onUpdate?: (snap: TerminalSnapshot) => void;
}

/** Poll until the process exits, the caller aborts, or maxWaitMs elapses. */
export async function waitForTerminalSession(
  id: string,
  opts: WaitForTerminalOptions = {},
): Promise<TerminalSnapshot> {
  const started = Date.now();
  const maxWaitMs = opts.maxWaitMs ?? 10 * 60 * 1000;
  for (;;) {
    const snap = await refreshTerminalSession(id);
    opts.onUpdate?.(snap);
    if (!snap.running) return snap;
    if (opts.signal?.aborted) {
      return killTerminalSession(id).catch(() => snap);
    }
    if (Date.now() - started > maxWaitMs) {
      const killed = await killTerminalSession(id).catch(() => snap);
      return { ...killed, killed: true };
    }
    await new Promise(resolve => setTimeout(resolve, POLL_MS));
  }
}
