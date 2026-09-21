import { agentSession, useAgentSession } from './agentSession';

/** Inline Allow/Deny card for PocketCode file writes (Store screenshot 04). */
export default function FileWriteApproval() {
  const { waitingFor, pendingPatch } = useAgentSession();
  if (waitingFor !== 'edit' || !pendingPatch) return null;

  return (
    <div className="rounded-xl border border-amber-400/70 bg-amber-950/40 p-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[13px] font-semibold text-amber-100">Approval required</p>
        <span className="text-[11px] text-amber-200/80">File write</span>
      </div>
      <p className="text-[12px] text-surface-200">
        PocketMind Agent wants to edit a file in your workspace.
      </p>
      <p className="text-[11px] text-surface-400">File</p>
      <p className="text-[12px] font-mono text-surface-100 break-all">{pendingPatch.path}</p>
      <div className="flex gap-2 pt-1">
        <button
          type="button"
          className="flex-1 h-9 rounded-lg bg-primary-500 text-surface-950 font-semibold text-sm hover:bg-primary-400"
          onClick={() => agentSession.resolveEdit('accepted')}
        >
          Allow
        </button>
        <button
          type="button"
          className="flex-1 h-9 rounded-lg border border-white/15 text-surface-100 font-semibold text-sm hover:bg-white/5"
          onClick={() => agentSession.resolveEdit('rejected')}
        >
          Deny
        </button>
      </div>
      <button
        type="button"
        className="text-[11px] text-primary-300 underline"
        onClick={() => agentSession.resolveEdit('accepted', true)}
      >
        Always allow writes this session
      </button>
    </div>
  );
}
