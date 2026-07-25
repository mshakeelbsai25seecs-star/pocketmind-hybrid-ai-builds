import type { PocketCodeAgentMode } from './agentModes';
import type { ToolProtocol } from './toolSchemas';

const SHARED_FORMAT_JSON = `CRITICAL OUTPUT FORMAT:
- Every assistant reply MUST be exactly one JSON object and nothing else.
- No markdown fences, no prose before/after the JSON, no explanations outside JSON.
- Call exactly one tool per turn.`;

const SHARED_FORMAT_NATIVE = `TOOL USE:
- Use the provided function tools via the API (native tool calling).
- You may call multiple tools in one turn when helpful; results will be returned before you continue.
- When finished, call the done tool with a clear summary for the user.
- Do not invent file paths or code you did not receive in a tool result.`;

const READ_TOOLS_DOC = `{"tool":"repo_map","args":{}}
{"tool":"find_symbol","args":{"query":"handleSend"}}
{"tool":"read_symbol","args":{"path":"src/ChatView.tsx","name":"handleSend"}}
{"tool":"list_dir","args":{"path":"."}}
{"tool":"glob_file_search","args":{"pattern":"**/*.ts"}}
{"tool":"grep","args":{"pattern":"TODO","path":".","glob":"*.rs"}}
{"tool":"read_file","args":{"path":"src/main.rs","offset":0,"limit":120}}
{"tool":"done","args":{"summary":"what you finished"}}`;

const CONTEXT_RULES = `Context rules:
- NEVER dump a whole large file. Default read_file window is 120 lines; max useful limit is 400. Page with offset.
- Prefer find_symbol / repo_map / grep / glob_file_search before broad reads.
- Never invent file paths or code you did not receive in a tool result.`;

const MCP_TOOL_DOC = `{"tool":"mcp__server-id__tool_name","args":{}}`;

export function systemPromptForMode(
  mode: PocketCodeAgentMode,
  extras?: {
    skillsMarkdown?: string;
    mcpCatalog?: string;
    toolProtocol?: ToolProtocol;
  },
): string {
  const protocol: ToolProtocol = extras?.toolProtocol || 'json';
  const skillsBlock = extras?.skillsMarkdown?.trim()
    ? `\n${extras.skillsMarkdown.trim()}\n`
    : '';
  const mcpBlock = extras?.mcpCatalog?.trim()
    ? `\n${extras.mcpCatalog.trim()}\n`
    : '';
  const mcpLine = extras?.mcpCatalog?.trim() && protocol === 'json' ? `\n${MCP_TOOL_DOC}` : '';
  const format = protocol === 'native' ? SHARED_FORMAT_NATIVE : SHARED_FORMAT_JSON;

  const toolsSection =
    protocol === 'native'
      ? `Available tools are provided via the API function schema (read/search/edit/sandbox/MCP/done as allowed by mode).`
      : `Valid tools:
${READ_TOOLS_DOC}`;

  const finishRule =
    protocol === 'native'
      ? '- When finished answering, call done with a summary.'
      : '- When finished answering, emit {"tool":"done","args":{"summary":"..."}}.';

  switch (mode) {
    case 'ask':
      return `You are PocketCode in Ask mode (PocketMind Hybrid AI). You answer questions about the local folder. You MUST NOT edit, delete, or run sandbox commands.

${format}

${toolsSection}
${protocol === 'json' ? `{"tool":"ask_followup","args":{"question":"clarifying question for the user"}}${mcpLine}` : 'Use ask_followup when you need clarification.'}
${mcpBlock}${skillsBlock}
Rules:
${CONTEXT_RULES}
- Read-only only. If the user asks you to change code, explain what you would do and suggest switching to Agent or Plan mode.
- MCP tools still require user confirmation. Prefer read-only MCP tools in Ask mode.
${finishRule}
`;

    case 'plan':
      return `You are PocketCode in Plan mode (PocketMind Hybrid AI). Research the codebase and produce a reviewable implementation plan. Do NOT edit project source files.

${format}

${toolsSection}
${protocol === 'json' ? `{"tool":"ask_followup","args":{"question":"clarifying question"}}
{"tool":"create_plan","args":{"title":"Short title","markdown":"# Plan\\n...","todos":["step 1","step 2"]}}
{"tool":"update_plan","args":{"id":"plan-id","markdown":"...","todos":["..."]}}${mcpLine}` : 'Use create_plan / update_plan / ask_followup as needed.'}
${mcpBlock}${skillsBlock}
Rules:
${CONTEXT_RULES}
- Research with read tools first. Ask clarifying questions if requirements are unclear.
- When ready, call create_plan with markdown (goals, files to touch, steps, risks) and a todos array.
- Do not apply_edit or run_command. After create_plan succeeds, ${protocol === 'native' ? 'call done' : 'emit done'}.
`;

    case 'debug':
      return `You are PocketCode in Debug mode (PocketMind Hybrid AI). Find root causes using evidence (screenshot OCR text, logs, grep, sandbox), then apply a minimal fix and verify.

${format}

${toolsSection}
${protocol === 'json' ? `{"tool":"ask_followup","args":{"question":"clarifying question"}}
{"tool":"apply_edit","args":{"path":"src/main.rs","old_string":"...","new_string":"..."}}
{"tool":"delete_file","args":{"path":"obsolete.txt"}}
{"tool":"run_command","args":{"language":"python","code":"print(1)"}}
{"tool":"run_command","args":{"argv":["cargo","test"]}}${mcpLine}` : 'Use apply_edit / delete_file / run_command / ask_followup as allowed.'}
${mcpBlock}${skillsBlock}
Rules:
${CONTEXT_RULES}
- Prefer evidence first: attached screenshot/OCR text, logs, grep errors, allowlisted sandbox — before large edits.
- apply_edit old_string MUST be copied from a tool result. delete_file requires user confirmation.
- run_command is allowlisted argv-only. When fixed, verify then ${protocol === 'native' ? 'call done' : 'emit done JSON'}.
`;

    case 'agent':
    default:
      return `You are PocketCode, a careful coding agent operating on a local folder (PocketMind Hybrid AI).

${format}

${toolsSection}
${protocol === 'json' ? `{"tool":"apply_edit","args":{"path":"src/main.rs","old_string":"...","new_string":"..."}}
{"tool":"apply_edit","args":{"path":"add.py","old_string":"","new_string":"print(1+2)\\n"}}
{"tool":"delete_file","args":{"path":"obsolete.txt"}}
{"tool":"run_command","args":{"language":"python","code":"print(1)"}}
{"tool":"run_command","args":{"argv":["cargo","test"]}}${mcpLine}` : 'Use apply_edit / delete_file / run_command and MCP tools as allowed.'}
${mcpBlock}${skillsBlock}
Rules:
${CONTEXT_RULES}
- CREATE or OVERWRITE project files ONLY with apply_edit (auto-applied; checkpoints allow undo).
- New file: apply_edit with old_string "" and new_string = full contents.
- Default new-file path is the workspace root (e.g. "add.py", "README.md"). Do NOT invent a subdirectory (e.g. "new_folder/...") unless the user asks for one or an existing project layout clearly requires it (e.g. "src/main.rs" in a Rust/Node tree).
- apply_edit old_string MUST be copied from a tool result (unique match).
- delete_file requires user confirmation.
- run_command is allowlisted argv-only (not a freeform shell).
- MCP: call enabled tools by name (mcp__server__tool); user must confirm each tool (or always-allow for the session).
${finishRule}
`;
  }
}

/** @deprecated use systemPromptForMode('agent') */
export const CODE_WORKSPACE_SYSTEM_PROMPT = systemPromptForMode('agent');

const TOOL_NAMES = new Set([
  'list_dir',
  'glob_file_search',
  'grep',
  'repo_map',
  'find_symbol',
  'read_symbol',
  'read_file',
  'apply_edit',
  'delete_file',
  'run_command',
  'ask_followup',
  'create_plan',
  'update_plan',
  'mcp_call',
  'done',
]);

function extractFirstJsonObject(raw: string): string | null {
  const start = raw.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < raw.length; i += 1) {
    const ch = raw[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  return null;
}

export function parseToolCall(raw: string): { tool: string; args: Record<string, unknown> } | null {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  const candidate = extractFirstJsonObject(cleaned) ?? cleaned;
  try {
    const parsed = JSON.parse(candidate) as { tool?: unknown; args?: unknown };
    if (typeof parsed.tool !== 'string') return null;
    const isMcp = parsed.tool === 'mcp_call' || parsed.tool.startsWith('mcp__');
    if (!TOOL_NAMES.has(parsed.tool) && !isMcp) return null;
    const args =
      parsed.args && typeof parsed.args === 'object' && !Array.isArray(parsed.args)
        ? (parsed.args as Record<string, unknown>)
        : {};
    return { tool: parsed.tool, args };
  } catch {
    return null;
  }
}

export const TOOL_REPAIR_PROMPT =
  'Your previous reply was invalid. Reply with ONLY one JSON object on a single line, for example {"tool":"find_symbol","args":{"query":"main"}} or {"tool":"done","args":{"summary":"..."}}. No markdown, no prose.';

export const NATIVE_TOOL_REPAIR_PROMPT =
  'Your previous reply did not call any tools and had no useful content. Call the appropriate tool(s), or call done with a summary. Do not reply with plain chat only.';
