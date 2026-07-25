import type { PocketCodeAgentMode } from './agentModes';
import { MODE_TOOLS } from './agentModes';
import { mcpToolName, type McpToolInfo } from './mcp';
import type { CodeWorkspaceToolName } from './types';

/** OpenAI chat-completions function tool. */
export interface OpenAiFunctionTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

const props = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

const str = (description: string) => ({ type: 'string', description });
const int = (description: string) => ({ type: 'integer', description });
const arrStr = (description: string) => ({
  type: 'array',
  items: { type: 'string' },
  description,
});

const BUILTIN_SCHEMAS: Record<CodeWorkspaceToolName, OpenAiFunctionTool> = {
  list_dir: {
    type: 'function',
    function: {
      name: 'list_dir',
      description: 'List files and folders under a relative path in the workspace.',
      parameters: props({ path: str('Relative directory path, default "."') }),
    },
  },
  glob_file_search: {
    type: 'function',
    function: {
      name: 'glob_file_search',
      description: 'Find files by glob pattern (e.g. **/auth_service.rs).',
      parameters: props({ pattern: str('Glob pattern') }, ['pattern']),
    },
  },
  grep: {
    type: 'function',
    function: {
      name: 'grep',
      description: 'Search file contents with a regex/pattern.',
      parameters: props({
        pattern: str('Search pattern'),
        path: str('Relative path to search under'),
        glob: str('Optional file glob filter'),
      }, ['pattern']),
    },
  },
  repo_map: {
    type: 'function',
    function: {
      name: 'repo_map',
      description: 'Get a compact map of the repository structure and symbols.',
      parameters: props({}),
    },
  },
  find_symbol: {
    type: 'function',
    function: {
      name: 'find_symbol',
      description: 'Find symbols (functions, types, etc.) by name query.',
      parameters: props({ query: str('Symbol name or query') }, ['query']),
    },
  },
  read_symbol: {
    type: 'function',
    function: {
      name: 'read_symbol',
      description: 'Read a specific symbol definition from a file.',
      parameters: props({
        path: str('Relative file path'),
        name: str('Symbol name'),
      }, ['path', 'name']),
    },
  },
  read_file: {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a window of lines from a file (prefer small windows).',
      parameters: props({
        path: str('Relative file path'),
        offset: int('0-based line offset'),
        limit: int('Number of lines (default ~120, max ~400)'),
      }, ['path']),
    },
  },
  apply_edit: {
    type: 'function',
    function: {
      name: 'apply_edit',
      description:
        'Apply a unique string replacement to a file, or create a new file with empty old_string. Prefer workspace-root paths (e.g. add.py) unless the user or existing layout requires a subdirectory.',
      parameters: props({
        path: str('Relative file path (prefer root: "add.py", not "new_folder/add.py")'),
        old_string: str('Exact text to replace (empty to create/overwrite)'),
        new_string: str('Replacement text'),
      }, ['path', 'old_string', 'new_string']),
    },
  },
  delete_file: {
    type: 'function',
    function: {
      name: 'delete_file',
      description: 'Delete a file (requires user confirmation).',
      parameters: props({ path: str('Relative file path') }, ['path']),
    },
  },
  run_command: {
    type: 'function',
    function: {
      name: 'run_command',
      description: 'Run an allowlisted sandbox command (argv) or a short script.',
      parameters: props({
        argv: arrStr('Argv-only command, e.g. ["cargo","test"]'),
        language: str('Script language when using code mode'),
        code: str('Script source when using code mode'),
        args: arrStr('Extra args for script mode'),
      }),
    },
  },
  ask_followup: {
    type: 'function',
    function: {
      name: 'ask_followup',
      description: 'Ask the user a clarifying question.',
      parameters: props({ question: str('Question for the user') }, ['question']),
    },
  },
  create_plan: {
    type: 'function',
    function: {
      name: 'create_plan',
      description: 'Create a reviewable implementation plan (Plan mode).',
      parameters: props({
        title: str('Short plan title'),
        markdown: str('Plan markdown'),
        todos: arrStr('Todo checklist items'),
      }, ['markdown']),
    },
  },
  update_plan: {
    type: 'function',
    function: {
      name: 'update_plan',
      description: 'Update an existing plan by id.',
      parameters: props({
        id: str('Plan id'),
        title: str('Optional title'),
        markdown: str('Updated plan markdown'),
        todos: arrStr('Updated todos'),
      }, ['id', 'markdown']),
    },
  },
  mcp_call: {
    type: 'function',
    function: {
      name: 'mcp_call',
      description: 'Legacy MCP call wrapper. Prefer mcp__server__tool names when listed.',
      parameters: props({
        server: str('MCP server id'),
        tool: str('Tool name on that server'),
        arguments: { type: 'object', description: 'Tool arguments', additionalProperties: true },
      }, ['server', 'tool']),
    },
  },
  done: {
    type: 'function',
    function: {
      name: 'done',
      description: 'Finish the task and provide a final summary for the user.',
      parameters: props({ summary: str('Final answer / summary for the user') }, ['summary']),
    },
  },
};

export function buildOpenAiToolsForMode(
  mode: PocketCodeAgentMode,
  mcpTools: McpToolInfo[] = [],
): OpenAiFunctionTool[] {
  const names = MODE_TOOLS[mode] || MODE_TOOLS.agent;
  const out: OpenAiFunctionTool[] = [];
  for (const name of names) {
    // Prefer first-class mcp__* tools; keep mcp_call as fallback.
    if (name === 'mcp_call' && mcpTools.length > 0) {
      continue;
    }
    const schema = BUILTIN_SCHEMAS[name];
    if (schema) out.push(schema);
  }
  if ((names as readonly string[]).includes('mcp_call') && mcpTools.length > 0) {
    for (const t of mcpTools) {
      const name = mcpToolName(t.server, t.name);
      out.push({
        type: 'function',
        function: {
          name,
          description: (t.description || `${t.server}.${t.name}`).slice(0, 300),
          parameters: {
            type: 'object',
            properties: {},
            additionalProperties: true,
          },
        },
      });
    }
  }
  return out;
}

/** Providers with native tool calling (OpenAI-compat + Anthropic Messages + Gemini). */
const NATIVE_TOOL_PROVIDERS = new Set([
  'openai',
  'groq',
  'cerebras',
  'openrouter',
  'deepseek',
  'mistral',
  'together',
  'anthropic',
  'gemini',
]);

export function supportsNativeTools(modelPath: string): boolean {
  if (modelPath.startsWith('enterprise:')) return true;
  if (!modelPath.startsWith('remote:')) return false;
  const rest = modelPath.slice('remote:'.length);
  const slash = rest.indexOf('/');
  const provider = (slash >= 0 ? rest.slice(0, slash) : rest).toLowerCase();
  return NATIVE_TOOL_PROVIDERS.has(provider);
}

export type ToolProtocol = 'native' | 'json';

export function toolProtocolForModel(modelPath: string): ToolProtocol {
  return supportsNativeTools(modelPath) ? 'native' : 'json';
}
