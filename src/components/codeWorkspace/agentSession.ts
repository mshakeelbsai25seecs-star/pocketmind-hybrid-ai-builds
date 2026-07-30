/**
 * Module-level PocketCode agent session.
 * Survives React remounts so permission gates do not die mid-wait.
 */

import { useSyncExternalStore } from 'react';
import { invoke } from '@tauri-apps/api/tauri';
import {
  cwCheckpointBegin,
  cwCheckpointSnapshotDelete,
  cwCheckpointSnapshotWrite,
} from '../../api/codeWorkspace';
import type { SandboxGateResult, SandboxPendingRequest } from '../../codeWorkspace/sandboxTypes';
import {
  describeSandboxRequest,
  sandboxCancelled,
  sandboxFailed,
  sandboxOk,
} from '../../codeWorkspace/sandboxTypes';
import type { PocketCodeAgentMode } from '../../codeWorkspace/agentModes';
import type {
  AgentStep,
  PendingDelete,
  PendingMcpCall,
  PendingPatch,
  PocketCodePlan,
  SandboxRunResult,
} from '../../codeWorkspace/types';
import type { GenerationParams } from '../../types';
import { getSetting } from '../../api/powerFeatures';
import { loadEnabledSkillsMarkdown } from '../../codeWorkspace/skills';
import { formatMcpToolsCatalog, getEnabledMcpServerIds, mcpListTools } from '../../codeWorkspace/mcp';
import { formatInvokeError, runCodeWorkspaceAgent, runSandboxConfirmed, type AgentImagePayload } from './agentLoop';

export type EditDecision = 'accepted' | 'rejected';

type Listener = () => void;

export interface AgentSessionSnapshot {
  running: boolean;
  status: string | null;
  steps: AgentStep[];
  pendingPatch: PendingPatch | null;
  pendingDelete: PendingDelete | null;
  pendingMcp: PendingMcpCall | null;
  sandboxPending: SandboxPendingRequest | null;
  sandboxResult: SandboxRunResult | null;
  waitingFor: 'idle' | 'edit' | 'delete' | 'sandbox' | 'mcp' | 'model';
  autoApproveSandbox: boolean;
  sandboxConfirming: boolean;
  checkpointRunId: string | null;
  lastSummary: string | null;
  mode: PocketCodeAgentMode;
  lastPlan: PocketCodePlan | null;
  followupQuestion: string | null;
  lastError: string | null;
}

class AgentSession {
  private listeners = new Set<Listener>();
  private abort: AbortController | null = null;
  private deleteResolver: ((d: EditDecision) => void) | null = null;
  private sandboxResolver: ((d: SandboxGateResult) => void) | null = null;
  private mcpResolver: ((d: EditDecision) => void) | null = null;
  /** Per-session always-allow keys: `server.tool` */
  private mcpAlwaysAllow = new Set<string>();

  private running = false;
  private status: string | null = null;
  private steps: AgentStep[] = [];
  private pendingPatch: PendingPatch | null = null;
  private pendingDelete: PendingDelete | null = null;
  private pendingMcp: PendingMcpCall | null = null;
  private sandboxPending: SandboxPendingRequest | null = null;
  private sandboxResult: SandboxRunResult | null = null;
  private waitingFor: AgentSessionSnapshot['waitingFor'] = 'idle';
  private autoApproveSandbox = true;
  private sandboxConfirming = false;
  private workspaceRoot = '';
  private checkpointRunId: string | null = null;
  private lastSummary: string | null = null;
  private mode: PocketCodeAgentMode = 'agent';
  private lastPlan: PocketCodePlan | null = null;
  private followupQuestion: string | null = null;
  private lastError: string | null = null;
  /** Stable reference for useSyncExternalStore — must not allocate on every getSnapshot(). */
  private snapshot: AgentSessionSnapshot = {
    running: false,
    status: null,
    steps: [],
    pendingPatch: null,
    pendingDelete: null,
    pendingMcp: null,
    sandboxPending: null,
    sandboxResult: null,
    waitingFor: 'idle',
    autoApproveSandbox: true,
    sandboxConfirming: false,
    checkpointRunId: null,
    lastSummary: null,
    mode: 'agent',
    lastPlan: null,
    followupQuestion: null,
    lastError: null,
  };

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  getSnapshot(): AgentSessionSnapshot {
    return this.snapshot;
  }

  private rebuildSnapshot() {
    this.snapshot = {
      running: this.running,
      status: this.status,
      steps: this.steps,
      pendingPatch: this.pendingPatch,
      pendingDelete: this.pendingDelete,
      pendingMcp: this.pendingMcp,
      sandboxPending: this.sandboxPending,
      sandboxResult: this.sandboxResult,
      waitingFor: this.waitingFor,
      autoApproveSandbox: this.autoApproveSandbox,
      sandboxConfirming: this.sandboxConfirming,
      checkpointRunId: this.checkpointRunId,
      lastSummary: this.lastSummary,
      mode: this.mode,
      lastPlan: this.lastPlan,
      followupQuestion: this.followupQuestion,
      lastError: this.lastError,
    };
  }

  private emit() {
    this.rebuildSnapshot();
    for (const fn of [...this.listeners]) fn();
  }

  private setPartial(patch: Partial<AgentSessionSnapshot> & { status?: string | null }) {
    if (patch.running !== undefined) this.running = patch.running;
    if (patch.status !== undefined) this.status = patch.status;
    if (patch.steps !== undefined) this.steps = patch.steps;
    if (patch.pendingPatch !== undefined) this.pendingPatch = patch.pendingPatch;
    if (patch.pendingDelete !== undefined) this.pendingDelete = patch.pendingDelete;
    if (patch.pendingMcp !== undefined) this.pendingMcp = patch.pendingMcp;
    if (patch.sandboxPending !== undefined) this.sandboxPending = patch.sandboxPending;
    if (patch.sandboxResult !== undefined) this.sandboxResult = patch.sandboxResult;
    if (patch.waitingFor !== undefined) this.waitingFor = patch.waitingFor;
    if (patch.autoApproveSandbox !== undefined) this.autoApproveSandbox = patch.autoApproveSandbox;
    if (patch.sandboxConfirming !== undefined) this.sandboxConfirming = patch.sandboxConfirming;
    if (patch.checkpointRunId !== undefined) this.checkpointRunId = patch.checkpointRunId;
    if (patch.lastSummary !== undefined) this.lastSummary = patch.lastSummary;
    if (patch.mode !== undefined) this.mode = patch.mode;
    if (patch.lastPlan !== undefined) this.lastPlan = patch.lastPlan;
    if (patch.followupQuestion !== undefined) this.followupQuestion = patch.followupQuestion;
    if (patch.lastError !== undefined) this.lastError = patch.lastError;
    this.emit();
  }

  clearFollowup() {
    this.setPartial({ followupQuestion: null });
  }

  setLastPlan(plan: PocketCodePlan | null) {
    this.setPartial({ lastPlan: plan });
  }

  setAutoApproveSandbox(v: boolean) {
    this.autoApproveSandbox = v;
    this.emit();
  }

  /** Block until Confirm/Cancel delete. */
  waitForDeleteDecision(req: PendingDelete): Promise<EditDecision> {
    this.deleteResolver?.('rejected');
    this.deleteResolver = null;
    this.setPartial({
      pendingDelete: { ...req, status: 'pending' },
      waitingFor: 'delete',
      status: `Confirm delete: ${req.path}`,
    });
    return new Promise<EditDecision>((resolve) => {
      this.deleteResolver = resolve;
    });
  }

  resolveDelete(decision: EditDecision) {
    if (!this.deleteResolver) return;
    const resolve = this.deleteResolver;
    this.deleteResolver = null;
    this.setPartial({
      pendingDelete: null,
      waitingFor: this.running ? 'model' : 'idle',
      status:
        decision === 'accepted'
          ? 'Delete confirmed — agent continuing…'
          : 'Delete rejected — agent continuing…',
    });
    resolve(decision);
  }

  waitForMcpDecision(req: PendingMcpCall): Promise<EditDecision> {
    const key = `${req.server}.${req.tool}`;
    if (this.mcpAlwaysAllow.has(key)) {
      return Promise.resolve('accepted');
    }
    this.mcpResolver?.('rejected');
    this.mcpResolver = null;
    this.setPartial({
      pendingMcp: { ...req, status: 'pending' },
      waitingFor: 'mcp',
      status: `Confirm MCP: ${key}`,
    });
    return new Promise<EditDecision>((resolve) => {
      this.mcpResolver = resolve;
    });
  }

  resolveMcp(decision: EditDecision, alwaysAllow = false) {
    if (!this.mcpResolver) return;
    const resolve = this.mcpResolver;
    this.mcpResolver = null;
    if (alwaysAllow && decision === 'accepted' && this.pendingMcp) {
      this.mcpAlwaysAllow.add(`${this.pendingMcp.server}.${this.pendingMcp.tool}`);
    }
    this.setPartial({
      pendingMcp: null,
      waitingFor: this.running ? 'model' : 'idle',
      status:
        decision === 'accepted'
          ? 'MCP allowed — agent continuing…'
          : 'MCP rejected — agent continuing…',
    });
    resolve(decision);
  }

  /**
   * Block until user confirms/cancels sandbox, or auto-approve runs it.
   * Failures are never reported as user cancel.
   */
  async waitForSandbox(payload: SandboxPendingRequest): Promise<SandboxGateResult> {
    // One sandbox at a time — do not resolve a prior waiter as "cancelled".
    if (this.waitingFor === 'sandbox' && this.sandboxResolver) {
      return sandboxFailed(
        'Another sandbox request is already waiting for permission. Finish or cancel it first.',
      );
    }
    if (this.sandboxConfirming) {
      return sandboxFailed('A sandbox run is already in progress.');
    }

    const label = describeSandboxRequest(payload);
    this.setPartial({
      sandboxPending: payload,
      waitingFor: 'sandbox',
      status: this.autoApproveSandbox
        ? `Auto-running sandbox (${label})…`
        : `Waiting for sandbox permission (${label})…`,
    });

    if (this.autoApproveSandbox) {
      return this.runSandboxNow(payload);
    }

    return new Promise<SandboxGateResult>((resolve) => {
      this.sandboxResolver = resolve;
    });
  }

  async confirmSandbox(): Promise<void> {
    if (
      !this.sandboxPending
      || !this.workspaceRoot
      || !this.sandboxResolver
      || this.sandboxConfirming
    ) {
      return;
    }
    const request = this.sandboxPending;
    const resolve = this.sandboxResolver;
    this.sandboxResolver = null;
    this.setPartial({ sandboxConfirming: true, status: 'Running sandbox…' });
    try {
      const result = await runSandboxConfirmed(this.workspaceRoot, request, {
        signal: this.abort?.signal,
        onStatus: msg => this.setPartial({ status: msg }),
      });
      this.sandboxResolver = resolve;
      this.finishSandbox(sandboxOk(result));
    } catch (err) {
      this.sandboxResolver = resolve;
      const gate = sandboxFailed(formatInvokeError(err));
      this.setPartial({ status: gate.message });
      this.finishSandbox(gate);
    }
  }

  cancelSandbox() {
    this.finishSandbox(sandboxCancelled());
  }

  private finishSandbox(gate: SandboxGateResult) {
    const resolve = this.sandboxResolver;
    this.sandboxResolver = null;
    let status = this.status;
    if (gate.ok) {
      status = 'Sandbox finished — agent continuing…';
    } else if (this.running) {
      status = gate.reason === 'cancelled'
        ? 'Sandbox cancelled — agent continuing…'
        : `${gate.message} — agent continuing…`;
    }
    this.setPartial({
      sandboxPending: null,
      sandboxResult: gate.ok ? gate.result : null,
      sandboxConfirming: false,
      waitingFor: this.running ? 'model' : 'idle',
      status,
    });
    resolve?.(gate);
  }

  private async runSandboxNow(request: SandboxPendingRequest): Promise<SandboxGateResult> {
    if (!this.workspaceRoot) {
      const gate = sandboxFailed('no workspace root.');
      this.setPartial({
        sandboxPending: null,
        waitingFor: 'model',
        status: gate.message,
      });
      return gate;
    }
    this.setPartial({ sandboxConfirming: true });
    try {
      const result = await runSandboxConfirmed(this.workspaceRoot, request, {
        signal: this.abort?.signal,
        // Live command status ("Running npm run test · 12s") while the process streams.
        onStatus: msg => this.setPartial({ status: msg, sandboxConfirming: true }),
      });
      this.setPartial({
        sandboxPending: null,
        sandboxResult: result,
        sandboxConfirming: false,
        waitingFor: 'model',
        status: result.still_running
          ? `Background process running (${result.command || result.language}) — agent continuing…`
          : 'Command finished — agent continuing…',
      });
      return sandboxOk(result);
    } catch (err) {
      const gate = sandboxFailed(formatInvokeError(err));
      this.setPartial({
        sandboxPending: null,
        sandboxConfirming: false,
        waitingFor: 'model',
        status: gate.message,
      });
      return gate;
    }
  }

  stop() {
    this.abort?.abort();
    this.abort = null;
    void invoke('stop_generation').catch(() => undefined);
    this.deleteResolver?.('rejected');
    this.deleteResolver = null;
    this.sandboxResolver?.(sandboxCancelled('Sandbox run cancelled because the agent was stopped.'));
    this.sandboxResolver = null;
    this.mcpResolver?.('rejected');
    this.mcpResolver = null;
    this.setPartial({
      running: false,
      waitingFor: 'idle',
      pendingPatch: null,
      pendingDelete: null,
      pendingMcp: null,
      sandboxPending: null,
      sandboxConfirming: false,
      status: 'Agent stopped.',
    });
  }

  async start(input: {
    workspaceRoot: string;
    task: string;
    modelPath: string;
    params: GenerationParams;
    mode?: PocketCodeAgentMode;
    images?: AgentImagePayload[];
    onApplyWrite: (path: string, content: string) => Promise<void>;
    /** Refresh explorer / close preview after a confirmed delete. */
    onFileDeleted?: (path: string) => Promise<void>;
    onAfterDone?: (summary: string, steps: AgentStep[], checkpointRunId: string | null) => Promise<void>;
  }): Promise<void> {
    if (this.running) this.stop();

    this.workspaceRoot = input.workspaceRoot;
    this.abort = new AbortController();
    const mode = input.mode || 'agent';

    // Load sandbox auto-run preference (default on).
    try {
      const v = await getSetting('cw.auto_sandbox');
      if (v === '0' || v === 'false') this.autoApproveSandbox = false;
      else this.autoApproveSandbox = true;
    } catch {
      this.autoApproveSandbox = true;
    }

    let runId: string | null = null;
    // Checkpoints only for modes that can mutate project files.
    if (mode === 'agent' || mode === 'debug') {
      try {
        runId = await cwCheckpointBegin(input.workspaceRoot);
      } catch (err) {
        console.warn('Checkpoint begin failed:', err);
      }
    }

    this.mcpAlwaysAllow.clear();

    this.setPartial({
      running: true,
      steps: [],
      status: runId ? `${mode} running… · Checkpoint ${runId}` : `${mode} running…`,
      pendingPatch: null,
      pendingDelete: null,
      pendingMcp: null,
      sandboxPending: null,
      sandboxResult: null,
      sandboxConfirming: false,
      waitingFor: 'model',
      checkpointRunId: runId,
      lastSummary: null,
      autoApproveSandbox: this.autoApproveSandbox,
      mode,
      followupQuestion: null,
      lastError: null,
    });

    const [skillsMarkdown, mcpBundle] = await Promise.all([
      loadEnabledSkillsMarkdown(input.workspaceRoot).catch(() => ''),
      (async () => {
        try {
          const ids = await getEnabledMcpServerIds();
          const tools = await mcpListTools(ids);
          return { tools, catalog: formatMcpToolsCatalog(tools) };
        } catch {
          return { tools: [] as Awaited<ReturnType<typeof mcpListTools>>, catalog: '' };
        }
      })(),
    ]);
    const mcpTools = mcpBundle.tools;
    const mcpCatalog = mcpBundle.catalog;

    try {
      const { summary, steps } = await runCodeWorkspaceAgent({
        workspaceRoot: input.workspaceRoot,
        task: input.task,
        modelPath: input.modelPath,
        params: input.params,
        mode,
        images: input.images,
        skillsMarkdown,
        mcpCatalog,
        mcpTools,
        signal: this.abort.signal,
        callbacks: {
          onStep: (step) => {
            this.steps = [...this.steps, step];
            if (step.kind === 'error') {
              this.lastError = step.content;
            }
            this.emit();
          },
          onApplyEdit: async (patch) => {
            if (runId) {
              try {
                await cwCheckpointSnapshotWrite(input.workspaceRoot, runId, patch.path);
              } catch (err) {
                console.warn('Checkpoint snapshot failed:', err);
              }
            }
            await input.onApplyWrite(patch.path, patch.modified);
            this.setPartial({
              status: runId
                ? `Auto-edited ${patch.path} · Checkpoint ${runId}`
                : `Auto-edited ${patch.path}`,
              waitingFor: 'model',
            });
          },
          onPendingDelete: async (req) => {
            const decision = await this.waitForDeleteDecision(req);
            if (decision === 'accepted' && runId) {
              try {
                await cwCheckpointSnapshotDelete(input.workspaceRoot, runId, req.path);
              } catch (err) {
                console.warn('Checkpoint delete snapshot failed:', err);
              }
            }
            return decision;
          },
          onFileDeleted: input.onFileDeleted,
          onSandboxRequest: (payload) => this.waitForSandbox(payload),
          onMcpRequest: (req) => this.waitForMcpDecision(req),
          onStatus: (msg) => {
            if (this.waitingFor === 'delete' || this.waitingFor === 'sandbox' || this.waitingFor === 'mcp') return;
            this.setPartial({ status: msg, waitingFor: 'model' });
          },
          onPlan: (plan) => {
            this.setPartial({ lastPlan: plan });
          },
          onFollowup: (question) => {
            this.setPartial({ followupQuestion: question });
          },
        },
      });
      if (!this.abort?.signal.aborted) {
        this.setPartial({
          status: summary,
          waitingFor: 'idle',
          lastSummary: summary,
        });
        if (input.onAfterDone) {
          await input.onAfterDone(summary, steps, runId);
        }
      }
    } catch (err) {
      const msg = String(err);
      this.setPartial({ status: msg, waitingFor: 'idle', lastError: msg });
    } finally {
      this.running = false;
      this.abort = null;
      this.deleteResolver?.('rejected');
      this.deleteResolver = null;
      this.sandboxResolver?.(sandboxCancelled('Sandbox run cancelled because the agent ended.'));
      this.sandboxResolver = null;
      this.mcpResolver?.('rejected');
      this.mcpResolver = null;
      this.setPartial({
        running: false,
        waitingFor: 'idle',
        pendingPatch: null,
        pendingDelete: null,
        pendingMcp: null,
        sandboxPending: null,
        sandboxConfirming: false,
      });
    }
  }
}

export const agentSession = new AgentSession();

const subscribeAgentSession = (cb: Listener) => agentSession.subscribe(cb);
const getAgentSessionSnapshot = () => agentSession.getSnapshot();

/** React hook bridge — re-renders on session changes. */
export function useAgentSession(): AgentSessionSnapshot {
  return useSyncExternalStore(
    subscribeAgentSession,
    getAgentSessionSnapshot,
    getAgentSessionSnapshot,
  );
}
