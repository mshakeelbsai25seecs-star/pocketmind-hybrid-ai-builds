import { AlertTriangle } from 'lucide-react';
import { agentSession, useAgentSession } from './agentSession';
import SandboxPanel from './SandboxPanel';
import { FEATURE_FLAGS } from '../../featureFlags';
import { useAppStore } from '../../store';

/**
 * Always-visible permission gates for delete Confirm, MCP Confirm, and optional sandbox Confirm.
 * Mounted at app shell so navigating away from PocketCode (or remounts)
 * cannot hide the only path to unblock the agent.
 */
export default function AgentPermissionOverlay() {
  const {
    pendingDelete,
    pendingMcp,
    sandboxPending,
    sandboxResult,
    sandboxConfirming,
    waitingFor,
    running,
    pendingPatch,
  } = useAgentSession();
  const activeView = useAppStore(s => s.activeView);
  const showEdit = waitingFor === 'edit' && pendingPatch != null && activeView !== 'code-workspace';
  const showDelete = waitingFor === 'delete' && pendingDelete != null;
  const showMcp = waitingFor === 'mcp' && pendingMcp != null;
  const showSandbox =
    FEATURE_FLAGS.codeWorkspaceSandbox
    && waitingFor === 'sandbox'
    && sandboxPending != null
    && !agentSession.getSnapshot().autoApproveSandbox;

  if (!showEdit && !showDelete && !showSandbox && !showMcp) return null;

  return (
    <div className="fixed inset-0 z-[80] flex items-end sm:items-center justify-center p-3 sm:p-6 bg-black/50 backdrop-blur-[2px]">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={
          showDelete ? 'Confirm file delete'
            : showMcp ? 'Confirm MCP tool'
              : 'Approve sandbox run'
        }
        className="w-full max-w-3xl max-h-[90vh] overflow-y-auto rounded-2xl border border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-950 shadow-2xl p-4 sm:p-5 space-y-4"
      >
        <div className="flex items-start gap-2 text-amber-800 dark:text-amber-200">
          <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-bold text-surface-900 dark:text-surface-50">
              {showEdit ? 'Approval required — file write'
                : showDelete ? 'Confirm file delete'
                : showMcp ? 'Allow MCP tool call'
                  : 'Agent needs sandbox permission'}
            </p>
            <p className="text-xs text-surface-500 mt-0.5">
              {running
                ? 'The agent is paused until you decide. It will continue automatically after your choice.'
                : 'Confirm or cancel to clear this request.'}
            </p>
          </div>
        </div>

        {showEdit && pendingPatch && (
          <div className="space-y-3">
            <p className="text-sm font-semibold break-all">{pendingPatch.path}</p>
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={() => agentSession.resolveEdit('accepted')} className="btn-primary text-sm">Allow</button>
              <button type="button" onClick={() => agentSession.resolveEdit('rejected')} className="btn-secondary text-sm">Deny</button>
            </div>
          </div>
        )}
        {showDelete && pendingDelete && (
          <div className="space-y-3">
            <p className="text-sm font-semibold break-all">
              Delete · <span className="text-red-600 dark:text-red-400">{pendingDelete.path}</span>
            </p>
            <p className="text-xs text-surface-500">
              A checkpoint snapshot is taken before delete so you can restore this run.
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => agentSession.resolveDelete('accepted')}
                className="btn-primary text-sm bg-red-600 hover:bg-red-700 border-red-700"
              >
                Delete & continue
              </button>
              <button
                type="button"
                onClick={() => agentSession.resolveDelete('rejected')}
                className="btn-secondary text-sm"
              >
                Keep file
              </button>
              <button
                type="button"
                onClick={() => agentSession.stop()}
                className="btn-secondary text-sm"
              >
                Stop agent
              </button>
            </div>
          </div>
        )}

        {showMcp && pendingMcp && (
          <div className="space-y-3">
            <p className="text-sm font-semibold break-all">
              MCP · <span className="text-sky-600 dark:text-sky-400">{pendingMcp.server}.{pendingMcp.tool}</span>
            </p>
            <pre className="text-[11px] max-h-40 overflow-auto rounded-lg bg-surface-50 dark:bg-surface-900 p-2 border border-surface-200 dark:border-surface-800 whitespace-pre-wrap break-words">
              {JSON.stringify(pendingMcp.arguments || {}, null, 2)}
            </pre>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => agentSession.resolveMcp('accepted')}
                className="btn-primary text-sm"
              >
                Allow once
              </button>
              <button
                type="button"
                onClick={() => agentSession.resolveMcp('accepted', true)}
                className="btn-secondary text-sm"
              >
                Always allow this tool
              </button>
              <button
                type="button"
                onClick={() => agentSession.resolveMcp('rejected')}
                className="btn-secondary text-sm"
              >
                Deny
              </button>
              <button
                type="button"
                onClick={() => agentSession.stop()}
                className="btn-secondary text-sm"
              >
                Stop agent
              </button>
            </div>
          </div>
        )}

        {showSandbox && (
          <SandboxPanel
            pending={sandboxPending}
            lastResult={sandboxResult}
            busy={sandboxConfirming}
            onConfirm={() => void agentSession.confirmSandbox()}
            onCancel={() => agentSession.cancelSandbox()}
          />
        )}
      </div>
    </div>
  );
}
