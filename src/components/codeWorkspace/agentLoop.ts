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
import type { SandboxGateResult, SandboxPendingRequest } from '../../codeWorkspace/sandboxTypes';
import {
  buildOpenAiToolsForMode,
  toolProtocolForModel,
  type ToolProtocol,
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
import { codebaseSearch } from '../../codeWorkspace/codebaseSearch';
import {
  killTerminalSession,
  refreshTerminalSession,
  startTerminalSession,
  waitForTerminalSession,
} from '../../codeWorkspace/terminalSessions';
import {
  tailLines,
  terminalStatusLabel,
  type TerminalStartRequest,
} from '../../codeWorkspace/terminalTypes';
import { ToolRunCache, type ToolRunMetrics } from '../../codeWorkspace/toolFingerprint';
import { detectProjectCommands, formatProjectCommands } from '../../codeWorkspace/projectCommands';
import { buildWorkspaceBrief, loadProjectRules } from '../../codeWorkspace/workspaceBrief';
import { cwCanUse } from '../../api/codeWorkspace';
import { refreshLocalVisionCapability } from '../../codeWorkspace/visionCapability';
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

/** Soft ceiling to stop retry storms / runaway tool loops without blocking normal edits. */
const MAX_STEPS = 28;
/** How many turns before the ceiling the model is told to wrap up. */
const WRAP_UP_LEAD = 4;
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
        content:
          `[older result trimmed to save context — already used; do not repeat this call]\n`
          + `Preview: ${firstLine}`,
      };
      continue;
    }
    const match = /^Tool result \(([^)]+)\):\n/.exec(m.content);
    const tool = match?.[1] ?? 'tool';
    const firstLine = m.content.split('\n').slice(1, 3).join(' ').slice(0, 160);
    transcript[i] = {
      role: 'user',
      content:
        `Tool result (${tool}): [older result trimmed to save context]\n`
        + `Preview: ${firstLine}\n`
        + `You already used this result — do NOT call the tool again with the same arguments.`,
    };
  }
}

/**
 * JSON protocol only sends user/assistant turns, so tool-role messages collected while native
 * tool calling was active must be folded into the text transcript or their evidence is lost.
 */
function foldToolMessagesIntoText(transcript: ChatMessage[]): void {
  for (let i = 0; i < transcript.length; i += 1) {
    const m = transcript[i];
    if (m.role === 'tool') {
      transcript[i] = {
        role: 'user',
        content: `Tool result (${m.name || 'tool'}):\n${m.content}`,
      };
      continue;
    }
    if (m.role === 'assistant' && !m.content && m.tool_calls?.length) {
      const names = m.tool_calls.map(tc => tc.function?.name || 'tool').join(', ');
      transcript[i] = { role: 'assistant', content: `(called ${names})` };
    }
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

/**
 * Command output the model can actually read: a status line plus the tail of the log, instead of
 * a JSON blob with escaped newlines.
 */
function formatCommandResult(result: SandboxRunResult): string {
  const secs = Math.max(0, Math.round(result.duration_ms / 100) / 10);
  const body = [result.stdout, result.stderr].filter(s => s && s.trim()).join('\n');
  if (result.still_running && result.session_id) {
    return [
      `Started ${result.command || result.language} in the background (terminal id ${result.session_id}).`,
      body.trim() ? `First output:\n${tailLines(body, 40)}` : 'No output yet.',
      `Use read_terminal {"id":"${result.session_id}"} for more output, kill_terminal to stop it.`,
    ].join('\n');
  }
  const status = result.timed_out
    ? 'TIMED OUT'
    : result.killed
      ? 'KILLED'
      : result.exit_code === 0
        ? 'exit 0 (success)'
        : `exit ${result.exit_code ?? '?'} (failed)`;
  const head = `${result.command || result.language} — ${status} in ${secs}s`;
  if (!body.trim()) return `${head}\n(no output)`;
  return `${head}\n${tailLines(body, 200)}`;
}

/** Tauri/JS errors are often objects — never show "[object Object]". */
export function formatInvokeError(err: unknown): string {
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
  onApplyEdit: (patch: PendingPatch) => Promise<'accepted' | 'rejected'>;
  /** Must resolve only after the user Confirms or Cancels delete. */
  onPendingDelete: (req: PendingDelete) => Promise<'accepted' | 'rejected'>;
  /** After a delete is confirmed and removed from disk — refresh file tree / close preview. */
  onFileDeleted?: (path: string) => Promise<void>;
  onSandboxRequest: (payload: SandboxPendingRequest) => Promise<SandboxGateResult>;
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
  workspaceBrief?: string;
  projectRules?: string;
  projectCommands?: string;
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
  let reasoningText = '';
  let toolCalls: ToolCall[] = [];
  let finishReason: string | null | undefined;
  const unlisten = await listen<GenerationChunk>(
    'generation-chunk',
    (event) => {
      if (signal?.aborted) return;
      const payload = event.payload;
      const chunkText = payload?.text || '';
      const fr = payload?.finish_reason;
      // DeepSeek V4 reasoning progress — not part of the assistant answer,
      // but keep it as a fallback when the model puts the real reply only in reasoning_content.
      if (fr === 'reasoning' || payload?.reasoning) {
        if (payload?.reasoning) reasoningText += payload.reasoning;
        return;
      }
      if (fr) finishReason = fr;
      if (payload?.tool_calls && payload.tool_calls.length > 0) {
        toolCalls = payload.tool_calls;
      }
      if (!chunkText) return;
      if (fr && fr !== 'tool_calls' && fr !== 'error' && chunkText.length >= assistantText.length) {
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
          workspaceBrief: promptExtras?.workspaceBrief,
          projectRules: promptExtras?.projectRules,
          projectCommands: promptExtras?.projectCommands,
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
  const answer = assistantText.trim();
  const reasoning = reasoningText.trim();
  // If the model left content empty/thin but wrote a full Markdown reply into reasoning, use it.
  const useReasoningFallback = !toolCalls.length
    && reasoning.length > answer.length + 80
    && (/^#{1,6}\s/m.test(reasoning) || /\n##\s/.test(reasoning) || reasoning.split('\n').length > 8);
  return {
    text: useReasoningFallback ? reasoning : answer,
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

/** Wraps tool execution with the per-run duplicate guard (see toolFingerprint.ts). */
async function executeTool(
  workspaceRoot: string,
  tool: string,
  args: Record<string, unknown>,
  callbacks: AgentLoopCallbacks,
  mode: PocketCodeAgentMode,
  mcpCatalog: McpToolInfo[] = [],
  protocol: ToolProtocol = 'json',
  cache?: ToolRunCache,
  step = 0,
): Promise<string> {
  if (cache) {
    const replay = cache.check(tool, args, step);
    if (replay) {
      callbacks.onStatus?.(`Skipped duplicate ${tool} call`);
      return replay;
    }
  }
  const result = await executeToolRaw(
    workspaceRoot,
    tool,
    args,
    callbacks,
    mode,
    mcpCatalog,
    protocol,
  );
  cache?.record(tool, args, step, result);
  return result;
}

async function executeToolRaw(
  workspaceRoot: string,
  tool: string,
  args: Record<string, unknown>,
  callbacks: AgentLoopCallbacks,
  mode: PocketCodeAgentMode,
  mcpCatalog: McpToolInfo[] = [],
  protocol: ToolProtocol = 'json',
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
  const continueHint = protocol === 'native'
    ? 'If the task is complete, call done; otherwise continue with tools.'
    : 'Continue with the next tool JSON, or emit {"tool":"done","args":{"summary":"..."}}.';
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
    case 'codebase_search': {
      const query = String(args.query ?? args.pattern ?? '').trim();
      if (!query) return 'codebase_search requires args.query.';
      callbacks.onStatus?.(`Searching codebase: ${query.slice(0, 60)}`);
      return codebaseSearch(
        workspaceRoot,
        query,
        args.glob != null ? String(args.glob) : null,
      );
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
        status: 'pending',
      };
      callbacks.onStatus?.(`Waiting for file-write approval: ${path}`);
      const decision = await callbacks.onApplyEdit(patch);
      if (decision !== 'accepted') {
        return `Edit DENIED by user for ${path}. Do not retry the same write unless the user asks. Continue with another approach, or call done.`;
      }
      const origLen = preview.original.length;
      const modLen = preview.modified.length;
      return `Edit written to ${path} (was ${origLen} chars → ${modLen} chars). ${continueHint}`;
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
        return `Delete REJECTED by user for ${path}. Continue without deleting, or call done.`;
      }
      await cwDeleteFile(workspaceRoot, path);
      try {
        await callbacks.onFileDeleted?.(path);
      } catch (err) {
        console.warn('onFileDeleted UI refresh failed:', err);
      }
      return `Deleted ${path}. ${continueHint}`;
    }
    case 'run_command': {
      const argvRaw = args.argv;
      const background = args.background === true || args.background === 'true'
        || args.is_background === true;
      let request: SandboxPendingRequest;
      if (Array.isArray(argvRaw) && argvRaw.length > 0) {
        request = {
          mode: 'cli',
          argv: argvRaw.map(v => String(v)),
          background,
        };
      } else {
        const language = String(args.language ?? '').trim().toLowerCase();
        const code = String(args.code ?? args.script ?? '');
        if (!language || !code) {
          return 'run_command requires either {"argv":["cargo","test"]} or {"language":"python","code":"..."}.';
        }
        const extra = Array.isArray(args.args) ? args.args.map(v => String(v)) : undefined;
        request = { mode: 'script', language, code, args: extra, background };
      }
      callbacks.onStatus?.(
        request.mode === 'cli'
          ? `Waiting for sandbox permission: ${request.argv.join(' ')}`
          : `Waiting for sandbox permission: ${request.language}`,
      );
      const gate = await callbacks.onSandboxRequest(request);
      if (!gate.ok) return gate.message;
      return formatCommandResult(gate.result);
    }
    case 'read_terminal': {
      const id = String(args.id ?? args.session_id ?? '').trim();
      if (!id) return 'read_terminal requires args.id (the terminal id from run_command).';
      try {
        const snap = await refreshTerminalSession(id);
        const lines = Number(args.lines ?? 0) || 120;
        return [
          `${snap.command} — ${terminalStatusLabel(snap)} · ${Math.round(snap.duration_ms / 1000)}s`,
          tailLines(snap.output || '(no output yet)', lines),
          snap.running
            ? 'Still running. Read again later, or kill_terminal to stop it.'
            : '',
        ].filter(Boolean).join('\n');
      } catch (err) {
        return `read_terminal failed: ${formatInvokeError(err)}`;
      }
    }
    case 'kill_terminal': {
      const id = String(args.id ?? args.session_id ?? '').trim();
      if (!id) return 'kill_terminal requires args.id.';
      try {
        const snap = await killTerminalSession(id);
        return `Kill requested for ${snap.command} (${snap.id}). ${continueHint}`;
      } catch (err) {
        return `kill_terminal failed: ${formatInvokeError(err)}`;
      }
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
): Promise<{
  summary: string;
  steps: AgentStep[];
  planId?: string | null;
  toolMetrics?: ToolRunMetrics;
}> {
  // Rust gate includes mmproj-on-disk for offline VL; FE also accepts probed vision.
  const visionReady = await refreshLocalVisionCapability(input.modelPath);
  const rustGate = await cwCanUse(input.modelPath);
  const gate = canUseCodeWorkspaceAgent(input.modelPath, { localVisionReady: visionReady });
  if (!rustGate.allowed && !gate.allowed) {
    throw new Error(rustGate.reason || gate.reason);
  }

  const mode = input.mode || 'agent';
  // Self-hosted / offline servers advertise an OpenAI-compatible API but may ignore the tool
  // schema; activeProtocol can drop to JSON mid-run when that happens.
  const protocol = toolProtocolForModel(input.modelPath);
  let activeProtocol: ToolProtocol = protocol;
  let jsonFallbackUsed = false;
  const steps: AgentStep[] = [];
  const transcript: ChatMessage[] = [
    { role: 'user', content: input.task },
  ];
  const mcpTools = input.mcpTools || [];
  const tools = protocol === 'native' ? buildOpenAiToolsForMode(mode, mcpTools) : [];
  // Hand the model the layout up front so it does not spend turns rediscovering it.
  input.callbacks.onStatus?.('Reading workspace layout…');
  const canRunCommands = modeAllowsTool(mode, 'run_command');
  const [workspaceBrief, projectRules, projectCommandList] = await Promise.all([
    buildWorkspaceBrief(input.workspaceRoot).catch(() => ''),
    loadProjectRules(input.workspaceRoot).catch(() => ''),
    canRunCommands
      ? detectProjectCommands(input.workspaceRoot).catch(() => [])
      : Promise.resolve([]),
  ]);
  const promptExtras: PromptExtras = {
    skillsMarkdown: input.skillsMarkdown,
    mcpCatalog: input.mcpCatalog,
    workspaceBrief,
    projectRules,
    projectCommands: formatProjectCommands(projectCommandList),
    toolProtocol: protocol,
    tools,
  };
  const toolCache = new ToolRunCache();

  const stepLimitSummary =
    `Agent stopped after ${MAX_STEPS} steps (turn limit). Narrow the task or send a follow-up to continue.`;
  let summary = stepLimitSummary;
  let lastAssistantText = '';
  let repairsUsed = 0;
  let lastPlanId: string | null = null;
  let thrashNudged = false;

  /** One firm reminder when the model starts looping on identical tool calls. */
  const nudgeIfThrashing = () => {
    if (thrashNudged) return;
    const { duplicates, refused } = toolCache.metrics;
    if (duplicates < 2 && refused === 0) return;
    thrashNudged = true;
    transcript.push({
      role: 'user',
      content:
        'You are repeating tool calls that return identical results. Stop searching now and answer '
        + 'the original request from the results you already have: finish with a clean Markdown '
        + 'summary (concrete paths, lines, values). If something is genuinely missing, say what and why.',
    });
  };

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

    const protoLabel = activeProtocol === 'native' ? 'native tools' : 'JSON tools';
    input.callbacks.onStatus?.(
      `${mode} · ${protoLabel} · Thinking (step ${step + 1}/${MAX_STEPS})…`,
    );

    // Land a real answer instead of getting cut off mid-exploration at the hard limit.
    if (step === MAX_STEPS - WRAP_UP_LEAD && step > 0) {
      transcript.push({
        role: 'user',
        content:
          `Only ${WRAP_UP_LEAD} tool turns remain. Stop exploring now and finish with your best answer `
          + 'from the results you already have — concrete paths, lines and values, plus anything still missing.',
      });
    }

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
    if (assistantText.trim()) lastAssistantText = assistantText.trim();

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

    // Self-hosted servers (offline 100B+ models behind an OpenAI-compatible API) sometimes
    // ignore the tool schema and answer with tool JSON in the content instead. Continue the
    // run in JSON protocol rather than mistaking that JSON for a final answer.
    if (
      activeProtocol === 'native'
      && nativeCalls.length === 0
      && assistantText
      && parseToolCall(assistantText)
    ) {
      activeProtocol = 'json';
      promptExtras.toolProtocol = 'json';
      promptExtras.tools = [];
      foldToolMessagesIntoText(transcript);
      input.callbacks.onStatus?.('Server ignored native tools — continuing with JSON tool calls.');
    }

    // —— Native tool-calling path ——
    if (activeProtocol === 'native') {
      if (nativeCalls.length === 0) {
        if (!assistantText) {
          if (repairsUsed < MAX_REPAIRS) {
            repairsUsed += 1;
            transcript.push({ role: 'user', content: NATIVE_TOOL_REPAIR_PROMPT });
            continue;
          }
          if (!jsonFallbackUsed) {
            // Last resort before giving up: ask for JSON tool calls instead of native ones.
            jsonFallbackUsed = true;
            repairsUsed = 0;
            activeProtocol = 'json';
            promptExtras.toolProtocol = 'json';
            promptExtras.tools = [];
            foldToolMessagesIntoText(transcript);
            transcript.push({ role: 'user', content: TOOL_REPAIR_PROMPT });
            input.callbacks.onStatus?.('No native tool calls — retrying with JSON tool calls.');
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
            activeProtocol,
            toolCache,
            step + 1,
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
      nudgeIfThrashing();
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
        activeProtocol,
        toolCache,
        step + 1,
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
      nudgeIfThrashing();
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

  // Hitting the ceiling should still show the model's best prose rather than only a stop notice.
  if (summary === stepLimitSummary && lastAssistantText.length > 80) {
    summary = `${lastAssistantText}\n\n_Stopped at the ${MAX_STEPS}-step limit — send a follow-up to continue._`;
  }
  console.info(
    `[pocketcode agent] ${mode} · ${protocol}`
    + `${activeProtocol !== protocol ? ` → ${activeProtocol}` : ''} · ${toolCache.summary()}`,
  );
  return { summary, steps, planId: lastPlanId, toolMetrics: toolCache.metrics };
}

/** Direct sandbox invoke when user confirms in SandboxPanel. */
/**
 * Execute an approved command. Runs as a terminal session so output streams into the terminal
 * panel while it works; background requests return as soon as the process is up. Transports
 * without session support (older agent-host builds) fall back to the one-shot sandbox.
 */
export async function runSandboxConfirmed(
  workspaceRoot: string,
  request: SandboxPendingRequest,
  opts: { signal?: AbortSignal; onStatus?: (msg: string) => void } = {},
): Promise<SandboxRunResult> {
  const startRequest: TerminalStartRequest = request.mode === 'cli'
    ? { argv: request.argv, background: request.background }
    : {
      language: request.language,
      code: request.code,
      args: request.args,
      background: request.background,
    };

  let info: Awaited<ReturnType<typeof startTerminalSession>>;
  try {
    info = await startTerminalSession(workspaceRoot, startRequest);
  } catch (err) {
    const msg = String(err);
    if (/unknown tool|not found|unknown command|is not a function/i.test(msg)) {
      return cwRunSandbox(workspaceRoot, request);
    }
    throw err;
  }

  if (request.background) {
    // Let it print a little before reporting back, then leave it running.
    await new Promise(resolve => setTimeout(resolve, 1_500));
    const snap = await refreshTerminalSession(info.id).catch(() => null);
    return {
      ok: true,
      language: info.label,
      exit_code: snap?.exit_code ?? null,
      stdout: snap?.output ?? '',
      stderr: '',
      timed_out: false,
      duration_ms: snap?.duration_ms ?? 0,
      session_id: info.id,
      command: info.command,
      still_running: snap ? snap.running : true,
      truncated: snap?.truncated,
    };
  }

  opts.onStatus?.(`Running ${info.command}…`);
  const final = await waitForTerminalSession(info.id, {
    signal: opts.signal,
    onUpdate: snap => {
      if (snap.running) {
        opts.onStatus?.(`Running ${snap.command} · ${Math.round(snap.duration_ms / 1000)}s`);
      }
    },
  });
  return {
    ok: final.exit_code === 0 && !final.timed_out && !final.killed,
    language: final.label,
    exit_code: final.exit_code,
    stdout: final.output,
    stderr: '',
    timed_out: final.timed_out,
    duration_ms: final.duration_ms,
    session_id: final.id,
    command: final.command,
    still_running: final.running,
    killed: final.killed,
    truncated: final.truncated,
  };
}
