import type { SandboxRunResult } from './types';

/**
 * Pending sandbox permission request (script or CLI mode).
 * `background` leaves the process running (dev server, watcher) instead of waiting for exit.
 */
export type SandboxPendingRequest =
  | { mode: 'script'; language: string; code: string; args?: string[]; background?: boolean }
  | { mode: 'cli'; argv: string[]; background?: boolean };

/** Result of the sandbox permission / auto-run gate (never conflates fail with cancel). */
export type SandboxGateResult =
  | { ok: true; result: SandboxRunResult }
  | { ok: false; reason: 'cancelled' | 'failed'; message: string };

export function describeSandboxRequest(req: SandboxPendingRequest): string {
  const suffix = req.background ? ' · background' : '';
  if (req.mode === 'cli') return `cli: ${req.argv.join(' ')}${suffix}`;
  return `${req.language} script${suffix}`;
}

export function sandboxCancelled(
  message = 'Sandbox run cancelled by user.',
): Extract<SandboxGateResult, { ok: false }> {
  return { ok: false, reason: 'cancelled', message };
}

export function sandboxFailed(message: string): Extract<SandboxGateResult, { ok: false }> {
  const msg = message.startsWith('Sandbox failed:') ? message : `Sandbox failed: ${message}`;
  return { ok: false, reason: 'failed', message: msg };
}

export function sandboxOk(result: SandboxRunResult): Extract<SandboxGateResult, { ok: true }> {
  return { ok: true, result };
}
