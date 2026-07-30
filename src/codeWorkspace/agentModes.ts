import type { CodeWorkspaceToolName } from './types';

export type PocketCodeAgentMode = 'agent' | 'ask' | 'plan' | 'debug';

export const POCKETCODE_MODES: PocketCodeAgentMode[] = ['agent', 'ask', 'plan', 'debug'];

export const MODE_LABELS: Record<PocketCodeAgentMode, string> = {
  agent: 'Agent',
  ask: 'Ask',
  plan: 'Plan',
  debug: 'Debug',
};

export const MODE_PLACEHOLDERS: Record<PocketCodeAgentMode, string> = {
  agent: 'Describe a coding task…',
  ask: 'Ask about this codebase…',
  plan: 'Describe what to plan…',
  debug: 'Describe the bug or paste an error…',
};

const READ_TOOLS: CodeWorkspaceToolName[] = [
  'list_dir',
  'glob_file_search',
  'grep',
  'codebase_search',
  'repo_map',
  'find_symbol',
  'read_symbol',
  'read_file',
  'ask_followup',
  'mcp_call',
  'done',
];

export const MODE_TOOLS: Record<PocketCodeAgentMode, readonly CodeWorkspaceToolName[]> = {
  ask: READ_TOOLS,
  plan: [...READ_TOOLS, 'create_plan', 'update_plan'],
  agent: [
    ...READ_TOOLS.filter(t => t !== 'ask_followup'),
    'apply_edit',
    'delete_file',
    'run_command',
    'read_terminal',
    'kill_terminal',
  ],
  debug: [
    ...READ_TOOLS,
    'apply_edit',
    'delete_file',
    'run_command',
    'read_terminal',
    'kill_terminal',
  ],
};

export function modeAllowsTool(mode: PocketCodeAgentMode, tool: string): boolean {
  // Cursor-style MCP tools: mcp__server__tool (and legacy mcp_call)
  if (tool === 'mcp_call' || tool.startsWith('mcp__')) {
    return (MODE_TOOLS[mode] as readonly string[]).includes('mcp_call');
  }
  return (MODE_TOOLS[mode] as readonly string[]).includes(tool);
}

export function cycleMode(current: PocketCodeAgentMode): PocketCodeAgentMode {
  const i = POCKETCODE_MODES.indexOf(current);
  return POCKETCODE_MODES[(i + 1) % POCKETCODE_MODES.length];
}

export function parseAgentMode(raw: string | null | undefined): PocketCodeAgentMode {
  const v = (raw || '').trim().toLowerCase();
  if (v === 'ask' || v === 'plan' || v === 'debug' || v === 'agent') return v;
  return 'agent';
}
