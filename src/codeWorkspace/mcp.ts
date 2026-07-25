import { invoke } from '@tauri-apps/api/tauri';
import { getSetting, setSetting } from '../api/powerFeatures';

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  disabled?: boolean;
}

export interface McpConfigFile {
  mcpServers: Record<string, McpServerConfig>;
}

export interface McpServerStatus {
  id: string;
  command: string;
  disabled: boolean;
  running: boolean;
  tool_count: number;
  last_error: string | null;
}

export interface McpToolInfo {
  server: string;
  name: string;
  description: string;
}

export interface McpCursorBridgeResult {
  imported: string[];
  skipped: string[];
  sources: string[];
  cursor_project_path: string | null;
  ensured_project_config: boolean;
}

const ENABLED_KEY = 'cw.enabled_mcp_servers';
const MAX_CATALOG_CHARS = 4000;

function sanitizeMcpPart(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_');
}

/** Cursor-style first-class tool name: mcp__server__tool */
export function mcpToolName(server: string, tool: string): string {
  return `mcp__${sanitizeMcpPart(server)}__${sanitizeMcpPart(tool)}`;
}

export function isMcpToolName(tool: string): boolean {
  return tool === 'mcp_call' || tool.startsWith('mcp__');
}

export function resolveMcpToolName(
  name: string,
  catalog: McpToolInfo[],
): { server: string; tool: string } | null {
  if (name === 'mcp_call') return null;
  if (!name.startsWith('mcp__')) return null;
  for (const t of catalog) {
    if (mcpToolName(t.server, t.name) === name) {
      return { server: t.server, tool: t.name };
    }
  }
  const rest = name.slice('mcp__'.length);
  const idx = rest.indexOf('__');
  if (idx <= 0) return null;
  return { server: rest.slice(0, idx), tool: rest.slice(idx + 2) };
}

export async function getEnabledMcpServerIds(): Promise<string[]> {
  const raw = await getSetting(ENABLED_KEY).catch(() => null);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map(String).filter(Boolean);
  } catch {
    return [];
  }
}

export async function setEnabledMcpServerIds(ids: string[]): Promise<void> {
  await setSetting(ENABLED_KEY, JSON.stringify([...new Set(ids)]));
}

export async function toggleMcpServerEnabled(id: string, enabled: boolean): Promise<string[]> {
  const cur = await getEnabledMcpServerIds();
  const next = enabled ? [...cur.filter(x => x !== id), id] : cur.filter(x => x !== id);
  await setEnabledMcpServerIds(next);
  return next;
}

export async function mcpListServers(): Promise<McpServerStatus[]> {
  return invoke('mcp_list_servers');
}

export async function mcpGetConfig(): Promise<McpConfigFile> {
  const raw = await invoke<{ mcp_servers?: Record<string, McpServerConfig>; mcpServers?: Record<string, McpServerConfig> }>('mcp_get_config');
  return { mcpServers: raw.mcpServers || raw.mcp_servers || {} };
}

export async function mcpSaveConfig(config: McpConfigFile): Promise<void> {
  await invoke('mcp_save_config', { config: { mcpServers: config.mcpServers } });
}

export async function mcpListTools(enabledIds: string[]): Promise<McpToolInfo[]> {
  if (enabledIds.length === 0) return [];
  return invoke('mcp_list_tools', { enabledIds });
}

export async function mcpCallTool(
  server: string,
  tool: string,
  arguments_: Record<string, unknown>,
): Promise<string> {
  return invoke('mcp_call_tool', {
    server,
    tool,
    arguments: arguments_,
  });
}

export async function mcpTestServer(id: string): Promise<McpToolInfo[]> {
  return invoke('mcp_test_server', { id });
}

export async function mcpConfigPath(): Promise<string> {
  return invoke('mcp_config_path');
}

export async function mcpSetupCursorBridge(workspaceRoot: string): Promise<McpCursorBridgeResult> {
  return invoke('mcp_setup_cursor_bridge', { workspaceRoot });
}

export async function mcpExportToCursor(workspaceRoot: string): Promise<string> {
  return invoke('mcp_export_to_cursor', { workspaceRoot });
}

export async function mcpCursorPaths(workspaceRoot?: string): Promise<string[]> {
  return invoke('mcp_cursor_paths', { workspaceRoot: workspaceRoot || null });
}

/** Short catalog for system prompt — Cursor-style first-class tool names. */
export function formatMcpToolsCatalog(tools: McpToolInfo[]): string {
  if (tools.length === 0) return '';
  let out = 'Available MCP tools (call by tool name, same style as Cursor):\n';
  let exampleTool = '';
  for (const t of tools) {
    const name = mcpToolName(t.server, t.name);
    if (!exampleTool) exampleTool = name;
    const line = `- ${name}: ${(t.description || '').slice(0, 120)}\n`;
    if (out.length + line.length > MAX_CATALOG_CHARS) {
      out += '- … (catalog truncated)\n';
      break;
    }
    out += line;
  }
  if (exampleTool) {
    out += `\nExample: {"tool":"${exampleTool}","args":{}}\n`;
  }
  out += 'Legacy also works: {"tool":"mcp_call","args":{"server":"NAME","tool":"TOOL","arguments":{}}}\n';
  return out;
}
