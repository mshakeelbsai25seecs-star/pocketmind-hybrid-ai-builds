import { invoke } from '@tauri-apps/api/tauri';
import { listen } from '@tauri-apps/api/event';
import {
  cwApplyEditPreview,
  cwGlobFileSearch,
  cwGrep,
  cwListDir,
  cwReadFile,
  cwRunSandbox,
} from '../../api/codeWorkspace';
import { parseToolCall, CODE_WORKSPACE_SYSTEM_PROMPT } from '../../codeWorkspace/prompts';
import type { AgentStep, CodeWorkspaceToolName, PendingPatch, SandboxRunResult } from '../../codeWorkspace/types';
import { canUseCodeWorkspaceAgent } from '../../modelCapability';
import type { GenerationParams } from '../../types';

const MAX_STEPS = 32;

export interface AgentLoopCallbacks {
  onStep: (step: AgentStep) => void;
  onPendingPatch: (patch: PendingPatch) => void;
  onSandboxRequest: (payload: { language: 'python' | 'javascript'; code: string }) => Promise<SandboxRunResult | null>;
}

export interface AgentLoopInput {
  workspaceRoot: string;
  task: string;
  modelPath: string;
  params: GenerationParams;
  callbacks: AgentLoopCallbacks;
  signal?: AbortSignal;
}

async function executeTool(
  workspaceRoot: string,
  tool: CodeWorkspaceToolName,
  args: Record<string, unknown>,
  callbacks: AgentLoopCallbacks,
): Promise<string> {
  switch (tool) {
    case 'list_dir': {
      const entries = await cwListDir(workspaceRoot, String(args.path ?? '.'));
      return JSON.stringify(entries, null, 2);
    }
    case 'glob_file_search': {
      const hits = await cwGlobFileSearch(workspaceRoot, String(args.pattern ?? '**/*'));
      return hits.join('\n') || '(no matches)';
    }
    case 'grep': {
      const out = await cwGrep(
        workspaceRoot,
        String(args.pattern ?? ''),
        args.path != null ? String(args.path) : null,
        args.glob != null ? String(args.glob) : null,
        Boolean(args.case_insensitive),
      );
      return out || '(no matches)';
    }
    case 'read_file': {
      const text = await cwReadFile(
        workspaceRoot,
        String(args.path ?? ''),
        Number(args.offset ?? 0),
        Number(args.limit ?? 200),
      );
      return text;
    }
    case 'apply_edit': {
      const path = String(args.path ?? '');
      const oldString = String(args.old_string ?? '');
      const newString = String(args.new_string ?? '');
      const preview = await cwApplyEditPreview(workspaceRoot, path, oldString, newString);
      const patch: PendingPatch = {
        id: `${Date.now()}-${path}`,
        path,
        original: preview.original,
        modified: preview.modified,
        status: 'pending',
      };
      callbacks.onPendingPatch(patch);
      return `Edit preview ready for ${path}. Waiting for user accept/reject in UI.`;
    }
    case 'run_command': {
      const language = String(args.language ?? 'python').toLowerCase();
      const code = String(args.code ?? '');
      const lang = language === 'js' || language === 'javascript' ? 'javascript' : 'python';
      const result = await callbacks.onSandboxRequest({ language: lang, code });
      if (!result) return 'Sandbox run cancelled by user.';
      return JSON.stringify(result, null, 2);
    }
    case 'done':
      return String(args.summary ?? 'Done.');
    default:
      return `Unknown tool: ${tool}`;
  }
}

export async function runCodeWorkspaceAgent(input: AgentLoopInput): Promise<{ summary: string; steps: AgentStep[] }> {
  const gate = canUseCodeWorkspaceAgent(input.modelPath);
  if (!gate.allowed) {
    throw new Error(gate.reason);
  }

  const steps: AgentStep[] = [];
  const transcript: { role: string; content: string }[] = [
    { role: 'system', content: CODE_WORKSPACE_SYSTEM_PROMPT },
    { role: 'user', content: input.task },
  ];

  let summary = 'Agent stopped (step limit).';

  for (let step = 0; step < MAX_STEPS; step += 1) {
    if (input.signal?.aborted) {
      summary = 'Agent cancelled.';
      break;
    }

    let assistantText = '';
    const unlisten = await listen<{ text?: string }>('generation-chunk', (event) => {
      if (event.payload?.text) assistantText = event.payload.text;
    });

    try {
      await invoke('stream_generate', {
        request: {
          prompt: transcript[transcript.length - 1]?.content ?? input.task,
          messages: transcript.filter(m => m.role !== 'system'),
          system_prompt: CODE_WORKSPACE_SYSTEM_PROMPT,
          params: input.params,
          model_path: input.modelPath,
          backend: input.modelPath.startsWith('enterprise:')
            ? 'enterprise'
            : input.modelPath.startsWith('remote:')
              ? 'remote'
              : 'llama.cpp',
        },
      });
    } finally {
      unlisten();
    }

    const assistantStep: AgentStep = { step: step + 1, kind: 'assistant', content: assistantText };
    steps.push(assistantStep);
    input.callbacks.onStep(assistantStep);
    transcript.push({ role: 'assistant', content: assistantText });

    const call = parseToolCall(assistantText);
    if (!call) {
      continue;
    }

    if (call.tool === 'done') {
      summary = String(call.args.summary ?? 'Task complete.');
      const doneStep: AgentStep = { step: step + 1, kind: 'done', content: summary };
      steps.push(doneStep);
      input.callbacks.onStep(doneStep);
      break;
    }

    try {
      const toolResult = await executeTool(
        input.workspaceRoot,
        call.tool as CodeWorkspaceToolName,
        call.args,
        input.callbacks,
      );
      const toolStep: AgentStep = {
        step: step + 1,
        kind: 'tool',
        content: `Tool ${call.tool}`,
        tool: call.tool,
        toolResult,
      };
      steps.push(toolStep);
      input.callbacks.onStep(toolStep);
      transcript.push({ role: 'user', content: `Tool result (${call.tool}):\n${toolResult}` });
    } catch (err) {
      const msg = String(err);
      const errStep: AgentStep = { step: step + 1, kind: 'error', content: msg, tool: call.tool };
      steps.push(errStep);
      input.callbacks.onStep(errStep);
      transcript.push({ role: 'user', content: `Tool error (${call.tool}): ${msg}` });
    }
  }

  return { summary, steps };
}

/** Direct sandbox invoke when user confirms in SandboxPanel. */
export async function runSandboxConfirmed(
  workspaceRoot: string,
  language: 'python' | 'javascript',
  code: string,
): Promise<SandboxRunResult> {
  return cwRunSandbox(workspaceRoot, language, code);
}
