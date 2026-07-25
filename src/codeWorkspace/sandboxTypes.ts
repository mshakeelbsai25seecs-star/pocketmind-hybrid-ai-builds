/** Pending sandbox permission request (script or CLI mode). */
export type SandboxPendingRequest =
  | { mode: 'script'; language: string; code: string; args?: string[] }
  | { mode: 'cli'; argv: string[] };

export function describeSandboxRequest(req: SandboxPendingRequest): string {
  if (req.mode === 'cli') return `cli: ${req.argv.join(' ')}`;
  return `${req.language} script`;
}
