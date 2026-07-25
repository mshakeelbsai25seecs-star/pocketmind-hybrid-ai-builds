import { invoke } from '@tauri-apps/api/tauri';
import { listen } from '@tauri-apps/api/event';
import {
  cwApplyEditPreview,
  cwDeleteFile,
  cwFindSymbol,
  cwGlobFileSearch,
  cwGrep,
  cwListDir,
  cwPlanWrite,
  cwReadFile,
  cwReadSymbol,
  cwRepoMap,
  cwRunSandbox,
} from '../../api/codeWorkspace';
import { modeAllowsTool, type PocketCodeAgentMode } from '../../codeWorkspace/agentModes';
import {
  NATIVE_TOOL_REPAIR_PROMPT,
  TOOL_REPAIR_PROMPT,
  parseToolCall,
  systemPromptForMode,
} from '../../codeWorkspace/prompts';
import type { SandboxPendingRequest } from '../../codeWorkspace/sandboxTypes';
import {
  buildOpenAiToolsForMode,
  toolProtocolForModel,
} from '../../codeWorkspace/toolSchemas';
import type {
  AgentStep,
  CodeWorkspaceToolName,
  PendingDelete,
  PendingMcpCall,
  PendingPatch,
  PocketCodePlan,
  SandboxRunResult,
} from '../../codeWorkspace/types';
import { mcpCallTool, resolveMcpToolName, type McpToolInfo } from '../../codeWorkspace/mcp';
import { canUseCodeWorkspaceAgent } from '../../modelCapability';
import type { ChatMessage, GenerationChunk, GenerationParams, ToolCall } from '../../types';

export interface AgentImagePayload {
  mime: string;
  base64: string;
}

async function runMcpWithPermission(
  server: string,
  mcpTool: string,
  arguments_: Record<string, unknown>,
  callbacks: AgentLoopCallbacks,
): Promise<string> {
  const req = {
    id: `${Date.now()}-mcp-${server}-${mcpTool}`,
    server,
    tool: mcpTool,
    arguments: arguments_,
    status: 'pending' as const,
  };
  callbacks.onStatus?.(`Waiting for MCP permission: ${server}.${mcpTool}`);
  const decision = await callbacks.onMcpRequest(req);
  if (decision !== 'accepted') {
    return `MCP call REJECTED by user for ${server}.${mcpTool}. Continue without it, or emit done.`;
  }
  try {
    const result = await mcpCallTool(server, mcpTool, arguments_);
    return result || '(empty MCP result)';
  } catch (err) {
    return `MCP call failed (${server}.${mcpTool}): ${String(err)}`;
  }
}

const MAX_STEPS = 200;
/** Grep / maps may be larger; reads stay tight. */
const TOOL_RESULT_MAX_DEFAULT = 48_000;
const TOOL_RESULT_MAX_READ = 32_000;
/** Keep the last N tool results in full; older ones collapse to stubs. */
const FULL_TOOL_RESULTS_KEEP = 6;
const MAX_REPAIRS = 1;
const MAX_RATE_LIMIT_RETRIES = 3;

function toolResultCap(tool: string): number {
  if (tool === 'read_file' || tool === 'read_symbol') return TOOL_RESULT_MAX_READ;
  if (tool === 'repo_map') return 24_000;
  return TOOL_RESULT_MAX_DEFAULT;
}

function clipToolResult(tool: string, toolResult: string): string {
  const max = toolResultCap(tool);
  if (toolResult.length <= max) return toolResult;
  return `${toolResult.slice(0, max)}\n…[truncated tool result]`;
}

/** Collapse older tool bodies so the model context does not explode. */
function compactTranscript(transcript: ChatMessage[]): void {
  const toolIdx: number[] = [];
  for (let i = 0; i < transcript.length; i += 1) {
    const m = transcript[i];
    if (m.role === 'user' && m.content.startsWith('Tool result (')) {
      toolIdx.push(i);
    } else if (m.role === 'tool') {
      toolIdx.push(i);
    }
  }
  if (toolIdx.length <= FULL_TOOL_RESULTS_KEEP) return;
  const drop = toolIdx.slice(0, toolIdx.length - FULL_TOOL_RESULTS_KEEP);
  for (const i of drop) {
    const m = transcript[i];
    if (m.role === 'tool') {
      const firstLine = m.content.split('\n').slice(0, 2).join(' ').slice(0, 160);
      transcript[i] = {
        ...m,
        content: `[omitted for context]\nPreview: ${firstLine}`,
      };
      continue;
    }
    const match = /^Tool result \(([^)]+)\):\n/.exec(m.content);
    const tool = match?.[1] ?? 'tool';
    const firstLine = m.content.split('\n').slice(1, 3).join(' ').slice(0, 160);
    transcript[i] = {
      role: 'user',
      content:
        `Tool result (${tool}): [omitted for context — earlier ${tool} result]\n`
        + `Preview: ${firstLine}\n`
        + `Re-call the tool if you need the full content again.`,
    };
  }
}

function parseToolArgs(raw: string): Record<string, unknown> {
  if (!raw || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

/** Tauri/JS errors are often objects — never show "[object Object]". */
function formatInvokeError(err: unknown): string {
  if (err == null) return 'Unknown error';
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.message || String(err);
  if (typeof err === 'object') {
    const o = err as Record<string, unknown>;
    for (const key of ['message', 'error', 'msg', 'reason']) {
      if (typeof o[key] === 'string' && o[key]) return o[key] as string;
    }
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  }
  return String(err);
}

function isRateLimitError(msg: string): boolean {
  return /429|rate[_ ]?limit|too many requests|tokens per minute|TPM/i.test(msg);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Agent cancelled.'));
      return;
    }
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new Error('Agent cancelled.'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export interface AgentLoopCallbacks {
  onStep: (step: AgentStep) => void;
  /**
   * Auto-apply path: write immediately after preview (no Accept dialog).
   * Still called so the host can checkpoint + write.
   */
  onApplyEdit: (patch: PendingPatch) => Promise<void>;
  /** Must resolve only after the user Confirms or Cancels delete. */
  onPendingDelete: (req: PendingDelete) => Promise<'accepted' | 'rejected'>;
  onSandboxRequest: (payload: SandboxPendingRequest) => Promise<SandboxRunResult | null>;
  /** MCP tool calls require user confirm (or session always-allow). */
  onMcpRequest: (req: PendingMcpCall) => Promise<'accepted' | 'rejected'>;
  onStatus?: (message: string) => void;
  /** Plan mode: surface created/updated plan to the UI. */
  onPlan?: (plan: PocketCodePlan) => void;
  /** Ask/Plan clarifying question for the user. */
  onFollowup?: (question: string) => void;
}

export interface AgentLoopInput {
  workspaceRoot: string;
  task: string;
  modelPath: string;
  params: GenerationParams;
  callbacks: AgentLoopCallbacks;
  signal?: AbortSignal;
  mode?: PocketCodeAgentMode;
  /** Vision images for first user turn (org/online vision models). */
  images?: AgentImagePayload[];
  skillsMarkdown?: string;
  mcpCatalog?: string;
  /** Enabled MCP tools for resolving Cursor-style mcp__server__tool names. */
  mcpTools?: McpToolInfo[];
}

/** Mirror ChatView: stream chunks are deltas; finish_reason may send a full cleaned string. */
function appendStreamChunk(current: string, piece: string): string {
  if (!piece) return current;
  if (!current) return piece;
  if (piece.startsWith(current)) return piece;
  if (current.endsWith(piece)) return current;
  const max = Math.min(current.length, piece.length);
  for (let len = max; len > 0; len -= 1) {
    if (current.endsWith(piece.slice(0, len))) {
      return current + piece.slice(len);
    }
  }
  return current + piece;
}

function toolParams(base: GenerationParams, modelPath: string): GenerationParams {
  const enterpriseOrRemote =
    modelPath.startsWith('enterprise:') || modelPath.startsWith('remote:');
  const maxFloor = enterpriseOrRemote ? 8192 : 384;
  return {
    ...base,
    temperature: Math.min(Number(base.temperature ?? 0.2), 0.15),
    top_p: Math.min(Number(base.top_p ?? 0.9), 0.85),
    max_tokens: Math.max(Number(base.max_tokens ?? 512), maxFloor),
    repetition_penalty: Math.max(Number(base.repetition_penalty ?? 1.1), 1.08),
  };
}

function backendFor(modelPath: string): 'enterprise' | 'remote' | 'llama.cpp' {
  if (modelPath.startsWith('enterprise:')) return 'enterprise';
  if (modelPath.startsWith('remote:')) return 'remote';
  return 'llama.cpp';
}

interface AssistantTurnResult {
  text: string;
  toolCalls: ToolCall[];
  finishReason?: string | null;
}

type PromptExtras = {
  skillsMarkdown?: string;
  mcpCatalog?: string;
  toolProtocol?: 'native' | 'json';
  tools?: ReturnType<typeof buildOpenAiToolsForMode>;
};

async function generateAssistantTurnOnce(
  transcript: ChatMessage[],
  modelPath: string,
  params: GenerationParams,
  mode: PocketCodeAgentMode,
  images: AgentImagePayload[] | undefined,
  signal: AbortSignal | undefined,
  promptExtras?: PromptExtras,
): Promise<AssistantTurnResult> {
  let assistantText = '';
  let toolCalls: ToolCall[] = [];
  let finishReason: string | null | undefined;
  const unlisten = await listen<GenerationChunk>(
    'generation-chunk',
    (event) => {
      if (signal?.aborted) return;
      const payload = event.payload;
      const chunkText = payload?.text || '';
      const fr = payload?.finish_reason;
      if (fr) finishReason = fr;
      if (payload?.tool_calls && payload.tool_calls.length > 0) {
        toolCalls = payload.tool_calls;
      }
      if (!chunkText) return;
      if (fr && fr !== 'tool_calls' && chunkText.length >= assistantText.length) {
        assistantText = chunkText;
      } else {
        assistantText = appendStreamChunk(assistantText, chunkText);
      }
    },
  );

  const onAbort = () => {
    void invoke('stop_generation').catch(() => undefined);
  };
  if (signal?.aborted) {
    unlisten();
    onAbort();
    return { text: '', toolCalls: [] };
  }
  signal?.addEventListener('abort', onAbort, { once: true });

  const protocol = promptExtras?.toolProtocol || toolProtocolForModel(modelPath);
  try {
    const lastUser =
      [...transcript].reverse().find(m => m.role === 'user')?.content
      ?? transcript[transcript.length - 1]?.content
      ?? '';
    const messages =
      protocol === 'native'
        ? transcript.filter(m => m.role === 'user' || m.role === 'assistant' || m.role === 'tool')
        : transcript.filter(m => m.role === 'user' || m.role === 'assistant');
    await invoke('stream_generate', {
      request: {
        prompt: lastUser,
        messages,
        system_prompt: systemPromptForMode(mode, {
          skillsMarkdown: promptExtras?.skillsMarkdown,
          mcpCatalog: promptExtras?.mcpCatalog,
          toolProtocol: protocol,
        }),
        params: toolParams(params, modelPath),
        model_path: modelPath,
        backend: backendFor(modelPath),
        images: images && images.length > 0 ? images : [],
        tools: protocol === 'native' ? (promptExtras?.tools || []) : [],
        tool_choice: protocol === 'native' ? 'auto' : null,
      },
    });
  } finally {
    signal?.removeEventListener('abort', onAbort);
    unlisten();
  }

  if (signal?.aborted) return { text: '', toolCalls: [] };
  return {
    text: assistantText.trim(),
    toolCalls,
    finishReason,
  };
}

async function generateAssistantTurn(
  transcript: ChatMessage[],
  modelPath: string,
  params: GenerationParams,
  mode: PocketCodeAgentMode,
  images: AgentImagePayload[] | undefined,
  signal: AbortSignal | undefined,
  onStatus: ((message: string) => void) | undefined,
  promptExtras?: PromptExtras,
): Promise<AssistantTurnResult> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt += 1) {
    try {
      const attachImages = transcript.length <= 1 ? images : undefined;
      return await generateAssistantTurnOnce(
        transcript,
        modelPath,
        params,
        mode,
        attachImages,
        signal,
        promptExtras,
      );
    } catch (err) {
      lastErr = err;
      const msg = formatInvokeError(err);
      if (!isRateLimitError(msg) || attempt >= MAX_RATE_LIMIT_RETRIES) {
        throw new Error(msg);
      }
      const waitMs = 4000 * (attempt + 1);
      onStatus?.(`Rate limited — retrying in ${Math.ceil(waitMs / 1000)}s (attempt ${attempt + 1}/${MAX_RATE_LIMIT_RETRIES})…`);
      await sleep(waitMs, signal);
    }
  }
  throw new Error(formatInvokeError(lastErr));
}

async function executeTool(
  workspaceRoot: string,
  tool: string,
  args: Record<string, unknown>,
  callbacks: AgentLoopCallbacks,
  mode: PocketCodeAgentMode,
  mcpCatalog: McpToolInfo[] = [],
): Promise<string> {
  if (!modeAllowsTool(mode, tool)) {
    return `Tool "${tool}" is not available in ${mode} mode. Switch mode or use an allowed tool.`;
  }
  if (tool.startsWith('mcp__')) {
    const resolved = resolveMcpToolName(tool, mcpCatalog);
    if (!resolved) {
      return `Unknown MCP tool "${tool}". Use a name from the MCP catalog.`;
    }
    return runMcpWithPermission(resolved.server, resolved.tool, args, callbacks);
  }
  switch (tool as CodeWorkspaceToolName) {
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
    case 'repo_map': {
      callbacks.onStatus?.('Building / refreshing symbol index…');
      return cwRepoMap(workspaceRoot);
    }
    case 'find_symbol': {
      const query = String(args.query ?? args.name ?? '').trim();
      if (!query) return 'find_symbol requires args.query.';
      callbacks.onStatus?.(`Finding symbol: ${query}`);
      const hits = await cwFindSymbol(workspaceRoot, query);
      if (hits.length === 0) return `(no symbols matching "${query}")`;
      return JSON.stringify(hits, null, 2);
    }
    case 'read_symbol': {
      const path = String(args.path ?? '').trim();
      const name = String(args.name ?? args.query ?? '').trim();
      if (!path || !name) return 'read_symbol requires args.path and args.name.';
      const lineStart =
        args.line_start != null && Number.isFinite(Number(args.line_start))
          ? Number(args.line_start)
          : null;
      callbacks.onStatus?.(`Reading symbol ${name} in ${path}`);
      return cwReadSymbol(workspaceRoot, path, name, lineStart);
    }
    case 'read_file': {
      let limit = Number(args.limit ?? 120);
      if (!Number.isFinite(limit) || limit <= 0) limit = 120;
      limit = Math.min(400, Math.max(1, Math.floor(limit)));
      const offset = Math.max(0, Math.floor(Number(args.offset ?? 0) || 0));
      return cwReadFile(
        workspaceRoot,
        String(args.path ?? ''),
        offset,
        limit,
      );
    }
    case 'apply_edit': {
      const path = String(args.path ?? '');
      // Empty old_string = create new file (see apply_edit_preview).
      const oldString = args.old_string == null ? '' : String(args.old_string);
      const newString = String(args.new_string ?? args.content ?? '');
      const preview = await cwApplyEditPreview(workspaceRoot, path, oldString, newString);
      const patch: PendingPatch = {
        id: `${Date.now()}-${path}`,
        path,
        original: preview.original,
        modified: preview.modified,
        status: 'accepted',
      };
      callbacks.onStatus?.(`Auto-editing ${path}…`);
      await callbacks.onApplyEdit(patch);
      // Summarize — do not re-paste huge diffs into the transcript.
      const origLen = preview.original.length;
      const modLen = preview.modified.length;
      return `Edit written to ${path} (was ${origLen} chars → ${modLen} chars). Continue with the next tool JSON, or emit {"tool":"done","args":{"summary":"..."}}.`;
    }
    case 'delete_file': {
      const path = String(args.path ?? '').trim();
      if (!path) return 'delete_file requires args.path.';
      const req: PendingDelete = {
        id: `${Date.now()}-del-${path}`,
        path,
        status: 'pending',
      };
      callbacks.onStatus?.(`Waiting for delete confirmation: ${path}`);
      const decision = await callbacks.onPendingDelete(req);
      if (decision !== 'accepted') {
        return `Delete REJECTED by user for ${path}. Continue without deleting, or emit {"tool":"done","args":{"summary":"..."}}.`;
      }
      await cwDeleteFile(workspaceRoot, path);
      return `Deleted ${path}. Continue with the next tool JSON, or emit {"tool":"done","args":{"summary":"..."}}.`;
    }
    case 'run_command': {
      const argvRaw = args.argv;
      let request: SandboxPendingRequest;
      if (Array.isArray(argvRaw) && argvRaw.length > 0) {
        request = {
          mode: 'cli',
          argv: argvRaw.map(v => String(v)),
        };
      } else {
        const language = String(args.language ?? '').trim().toLowerCase();
        const code = String(args.code ?? args.script ?? '');
        if (!language || !code) {
          return 'run_command requires either {"argv":["cargo","test"]} or {"language":"python","code":"..."}.';
        }
        const extra = Array.isArray(args.args) ? args.args.map(v => String(v)) : undefined;
        request = { mode: 'script', language, code, args: extra };
      }
      callbacks.onStatus?.(
        request.mode === 'cli'
          ? `Waiting for sandbox permission: ${request.argv.join(' ')}`
          : `Waiting for sandbox permission: ${request.language}`,
      );
      const result = await callbacks.onSandboxRequest(request);
      if (!result) return 'Sandbox run cancelled by user.';
      return JSON.stringify(result, null, 2);
    }
    case 'ask_followup': {
      const q = String(args.question ?? args.prompt ?? '').trim();
      if (!q) return 'ask_followup requires args.question.';
      callbacks.onFollowup?.(q);
      return `Clarifying question shown to user: ${q}. Wait for their next message, or continue researching if you can.`;
    }
    case 'create_plan': {
      const title = String(args.title ?? 'Implementation plan').trim() || 'Implementation plan';
      const markdown = String(args.markdown ?? args.content ?? '').trim();
      if (!markdown) return 'create_plan requires args.markdown.';
      const todos = Array.isArray(args.todos)
        ? args.todos.map(t => String(t))
        : [];
      callbacks.onStatus?.('Saving plan…');
      const plan = await cwPlanWrite(workspaceRoot, null, title, markdown, todos, 'draft');
      callbacks.onPlan?.(plan);
      return `Plan created id=${plan.id}. User can review and click Build. Emit {"tool":"done","args":{"summary":"Plan ready for review"}}.`;
    }
    case 'update_plan': {
      const id = String(args.id ?? '').trim();
      const markdown = String(args.markdown ?? args.content ?? '').trim();
      if (!id || !markdown) return 'update_plan requires args.id and args.markdown.';
      const todos = Array.isArray(args.todos) ? args.todos.map(t => String(t)) : [];
      const plan = await cwPlanWrite(workspaceRoot, id, String(args.title ?? 'Plan'), markdown, todos, 'draft');
      callbacks.onPlan?.(plan);
      return `Plan updated id=${plan.id}.`;
    }
    case 'mcp_call': {
      const server = String(args.server ?? '').trim();
      const mcpTool = String(args.tool ?? args.name ?? '').trim();
      if (!server || !mcpTool) {
        return 'mcp_call requires args.server and args.tool.';
      }
      const arguments_ =
        args.arguments && typeof args.arguments === 'object' && !Array.isArray(args.arguments)
          ? (args.arguments as Record<string, unknown>)
          : {};
      return runMcpWithPermission(server, mcpTool, arguments_, callbacks);
    }
    case 'done':
      return String(args.summary ?? 'Done.');
    default:
      return `Unknown tool: ${tool}`;
  }
}

export async function runCodeWorkspaceAgent(
  input: AgentLoopInput,
): Promise<{ summary: string; steps: AgentStep[]; planId?: string | null }> {
  const gate = canUseCodeWorkspaceAgent(input.modelPath);
  if (!gate.allowed) {
    throw new Error(gate.reason);
  }

  const mode = input.mode || 'agent';
  const protocol = toolProtocolForModel(input.modelPath);
  const steps: AgentStep[] = [];
  const transcript: ChatMessage[] = [
    { role: 'user', content: input.task },
  ];
  const mcpTools = input.mcpTools || [];
  const tools = protocol === 'native' ? buildOpenAiToolsForMode(mode, mcpTools) : [];
  const promptExtras: PromptExtras = {
    skillsMarkdown: input.skillsMarkdown,
    mcpCatalog: input.mcpCatalog,
    toolProtocol: protocol,
    tools,
  };

  let summary = 'Agent stopped (step limit).';
  let repairsUsed = 0;
  let lastPlanId: string | null = null;

  const execCallbacks = {
    ...input.callbacks,
    onPlan: (plan: PocketCodePlan) => {
      lastPlanId = plan.id;
      input.callbacks.onPlan?.(plan);
    },
  };

  for (let step = 0; step < MAX_STEPS; step += 1) {
    if (input.signal?.aborted) {
      summary = 'Agent cancelled.';
      break;
    }

    const protoLabel = protocol === 'native' ? 'native tools' : 'JSON tools';
    input.callbacks.onStatus?.(
      `${mode} · ${protoLabel} · Thinking (step ${step + 1}/${MAX_STEPS})…`,
    );

    let turn: AssistantTurnResult;
    try {
      turn = await generateAssistantTurn(
        transcript,
        input.modelPath,
        input.params,
        mode,
        input.images,
        input.signal,
        input.callbacks.onStatus,
        promptExtras,
      );
    } catch (err) {
      const msg = formatInvokeError(err);
      const errStep: AgentStep = { step: step + 1, kind: 'error', content: msg };
      steps.push(errStep);
      input.callbacks.onStep(errStep);
      summary = `Generation failed: ${msg}`;
      break;
    }

    const assistantText = turn.text;
    const nativeCalls = turn.toolCalls || [];

    const assistantStep: AgentStep = {
      step: step + 1,
      kind: 'assistant',
      content:
        nativeCalls.length > 0
          ? (assistantText || `(${nativeCalls.length} tool call(s))`)
          : (assistantText || '(empty model response)'),
    };
    steps.push(assistantStep);
    input.callbacks.onStep(assistantStep);

    // —— Native tool-calling path ——
    if (protocol === 'native') {
      if (nativeCalls.length === 0) {
        if (!assistantText) {
          if (repairsUsed < MAX_REPAIRS) {
            repairsUsed += 1;
            transcript.push({ role: 'user', content: NATIVE_TOOL_REPAIR_PROMPT });
            continue;
          }
          summary = 'Agent stopped: model returned empty responses.';
          break;
        }
        // Prose-only reply: treat as final answer when no tools were called.
        summary = assistantText;
        const doneStep: AgentStep = { step: step + 1, kind: 'done', content: summary };
        steps.push(doneStep);
        input.callbacks.onStep(doneStep);
        break;
      }

      repairsUsed = 0;
      transcript.push({
        role: 'assistant',
        content: assistantText || '',
        tool_calls: nativeCalls,
      });

      let finished = false;
      for (const tc of nativeCalls) {
        const toolName = tc.function?.name || '';
        const args = parseToolArgs(tc.function?.arguments || '');
        if (toolName === 'done') {
          summary = String(args.summary ?? 'Task complete.');
          const doneStep: AgentStep = { step: step + 1, kind: 'done', content: summary };
          steps.push(doneStep);
          input.callbacks.onStep(doneStep);
          finished = true;
          break;
        }
        try {
          const toolResult = await executeTool(
            input.workspaceRoot,
            toolName,
            args,
            execCallbacks,
            mode,
            mcpTools,
          );
          const clipped = clipToolResult(toolName, toolResult);
          const toolStep: AgentStep = {
            step: step + 1,
            kind: 'tool',
            content: `Tool ${toolName}`,
            tool: toolName,
            toolResult: clipped,
          };
          steps.push(toolStep);
          input.callbacks.onStep(toolStep);
          transcript.push({
            role: 'tool',
            content: clipped,
            tool_call_id: tc.id || `call_${toolName}`,
            name: toolName,
          });
        } catch (err) {
          const msg = formatInvokeError(err);
          const errStep: AgentStep = {
            step: step + 1,
            kind: 'error',
            content: msg,
            tool: toolName,
          };
          steps.push(errStep);
          input.callbacks.onStep(errStep);
          transcript.push({
            role: 'tool',
            content: `Error: ${msg}`,
            tool_call_id: tc.id || `call_${toolName}`,
            name: toolName,
          });
        }
      }
      if (finished) break;
      compactTranscript(transcript);
      continue;
    }

    // —— JSON text protocol fallback ——
    if (!assistantText) {
      if (repairsUsed < MAX_REPAIRS) {
        repairsUsed += 1;
        transcript.push({ role: 'user', content: TOOL_REPAIR_PROMPT });
        continue;
      }
      summary = 'Agent stopped: model returned empty responses.';
      break;
    }

    transcript.push({ role: 'assistant', content: assistantText });

    const call = parseToolCall(assistantText);
    if (!call) {
      if (repairsUsed < MAX_REPAIRS) {
        repairsUsed += 1;
        transcript.push({ role: 'user', content: TOOL_REPAIR_PROMPT });
        continue;
      }
      summary =
        'Agent stopped: model did not emit valid tool JSON. Try a larger/better-instruction model, or rephrase the task.';
      const errStep: AgentStep = {
        step: step + 1,
        kind: 'error',
        content: summary,
      };
      steps.push(errStep);
      input.callbacks.onStep(errStep);
      break;
    }

    repairsUsed = 0;

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
        call.tool,
        call.args,
        execCallbacks,
        mode,
        mcpTools,
      );
      const clipped = clipToolResult(call.tool, toolResult);
      const toolStep: AgentStep = {
        step: step + 1,
        kind: 'tool',
        content: `Tool ${call.tool}`,
        tool: call.tool,
        toolResult: clipped,
      };
      steps.push(toolStep);
      input.callbacks.onStep(toolStep);
      transcript.push({
        role: 'user',
        content: `Tool result (${call.tool}):\n${clipped}\n\nRespond with the next tool JSON only.`,
      });
      compactTranscript(transcript);
      const approxChars = transcript.reduce((n, m) => n + m.content.length, 0);
      if (approxChars > 80_000) {
        input.callbacks.onStatus?.(
          `Thinking (step ${step + 1}/${MAX_STEPS})… · context ~${Math.round(approxChars / 1000)}k chars (older tool bodies collapsed)`,
        );
      }
    } catch (err) {
      const msg = formatInvokeError(err);
      const errStep: AgentStep = {
        step: step + 1,
        kind: 'error',
        content: msg,
        tool: call.tool,
      };
      steps.push(errStep);
      input.callbacks.onStep(errStep);
      transcript.push({
        role: 'user',
        content: `Tool error (${call.tool}): ${msg}\n\nRespond with the next tool JSON only, or {"tool":"done","args":{"summary":"..."}}.`,
      });
    }
  }

  return { summary, steps, planId: lastPlanId };
}

/** Direct sandbox invoke when user confirms in SandboxPanel. */
export async function runSandboxConfirmed(
  workspaceRoot: string,
  request: SandboxPendingRequest,
): Promise<SandboxRunResult> {
  return cwRunSandbox(workspaceRoot, request);
}
