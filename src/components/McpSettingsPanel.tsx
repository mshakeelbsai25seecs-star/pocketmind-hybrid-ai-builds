import { useCallback, useEffect, useState } from 'react';
import { Server, Plus, Trash2, RefreshCw, Link2, Upload } from 'lucide-react';
import { getSetting } from '../api/powerFeatures';
import {
  mcpConfigPath,
  mcpGetConfig,
  mcpSaveConfig,
  mcpTestServer,
  mcpSetupCursorBridge,
  mcpExportToCursor,
  setEnabledMcpServerIds,
  getEnabledMcpServerIds,
  type McpConfigFile,
  type McpServerConfig,
} from '../codeWorkspace/mcp';

export default function McpSettingsPanel() {
  const [config, setConfig] = useState<McpConfigFile>({ mcpServers: {} });
  const [path, setPath] = useState('');
  const [workspaceRoot, setWorkspaceRoot] = useState('');
  const [status, setStatus] = useState('');
  const [testing, setTesting] = useState<string | null>(null);
  const [bridging, setBridging] = useState(false);
  const [newId, setNewId] = useState('');

  const reload = useCallback(async () => {
    try {
      const [cfg, p, root] = await Promise.all([
        mcpGetConfig(),
        mcpConfigPath(),
        getSetting('cw.workspace_root').catch(() => null),
      ]);
      setConfig(cfg);
      setPath(p);
      if (root) setWorkspaceRoot(root);
      setStatus('');
    } catch (err) {
      setStatus(String(err));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const save = async (next: McpConfigFile) => {
    setConfig(next);
    try {
      await mcpSaveConfig(next);
      setStatus('Saved.');
    } catch (err) {
      setStatus(String(err));
    }
  };

  const updateServer = (id: string, patch: Partial<McpServerConfig>) => {
    const cur = config.mcpServers[id] || { command: '', args: [], env: {}, disabled: false };
    void save({
      mcpServers: {
        ...config.mcpServers,
        [id]: { ...cur, ...patch },
      },
    });
  };

  const removeServer = (id: string) => {
    const next = { ...config.mcpServers };
    delete next[id];
    void save({ mcpServers: next });
  };

  const addServer = () => {
    const id = newId.trim().replace(/\s+/g, '-');
    if (!id || config.mcpServers[id]) {
      setStatus(id ? 'Server id already exists.' : 'Enter a server id.');
      return;
    }
    setNewId('');
    void save({
      mcpServers: {
        ...config.mcpServers,
        [id]: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-everything'], env: {}, disabled: false },
      },
    });
  };

  const test = async (id: string) => {
    setTesting(id);
    setStatus(`Testing ${id}…`);
    try {
      const tools = await mcpTestServer(id);
      setStatus(`${id}: ok · ${tools.length} tool(s)`);
      await reload();
    } catch (err) {
      setStatus(`${id}: ${String(err)}`);
    } finally {
      setTesting(null);
    }
  };

  const connectCursor = async () => {
    const root = workspaceRoot.trim();
    if (!root) {
      setStatus('Open a folder in PocketCode first (sets cw.workspace_root), then connect Cursor.');
      return;
    }
    setBridging(true);
    setStatus('Connecting Cursor MCP…');
    try {
      const result = await mcpSetupCursorBridge(root);
      const enabled = await getEnabledMcpServerIds();
      const nextEnabled = [...new Set([...enabled, ...result.imported])];
      if (result.imported.length > 0) {
        await setEnabledMcpServerIds(nextEnabled);
      }
      await reload();
      const parts = [
        result.ensured_project_config ? 'Created project .cursor/mcp.json' : 'Project .cursor/mcp.json present',
        result.imported.length ? `Imported: ${result.imported.join(', ')}` : 'No new servers to import',
        result.cursor_project_path ? `Cursor config: ${result.cursor_project_path}` : '',
        result.skipped.length ? `Skipped: ${result.skipped.join('; ')}` : '',
      ].filter(Boolean);
      setStatus(parts.join('\n'));
    } catch (err) {
      setStatus(String(err));
    } finally {
      setBridging(false);
    }
  };

  const syncToCursor = async () => {
    const root = workspaceRoot.trim();
    if (!root) {
      setStatus('Open a folder in PocketCode first, then sync to Cursor.');
      return;
    }
    setBridging(true);
    try {
      const written = await mcpExportToCursor(root);
      setStatus(`Synced PocketCode MCP servers → ${written}`);
    } catch (err) {
      setStatus(String(err));
    } finally {
      setBridging(false);
    }
  };

  const ids = Object.keys(config.mcpServers).sort();

  return (
    <div className="glass-panel rounded-xl p-6 space-y-4">
      <h3 className="font-semibold flex items-center gap-2">
        <Server className="w-5 h-5 text-primary-500" /> PocketCode MCP servers
      </h3>
      <p className="text-xs text-surface-500">
        Stdio MCP servers shared with Cursor via <span className="font-mono">.cursor/mcp.json</span>.
        Enable them from the composer <strong>+</strong> menu. The agent calls tools as{' '}
        <span className="font-mono">mcp__server__tool</span> (Cursor-style). Tool calls require confirmation.
        Config file: <span className="font-mono break-all">{path || '…'}</span>
      </p>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={bridging}
          onClick={() => void connectCursor()}
          className="btn-secondary text-sm flex items-center gap-1.5"
        >
          <Link2 className="w-3.5 h-3.5" />
          {bridging ? 'Working…' : 'Connect Cursor'}
        </button>
        <button
          type="button"
          disabled={bridging}
          onClick={() => void syncToCursor()}
          className="btn-secondary text-sm flex items-center gap-1.5"
        >
          <Upload className="w-3.5 h-3.5" /> Sync to Cursor
        </button>
      </div>
      <p className="text-[11px] text-surface-500">
        Workspace: <span className="font-mono break-all">{workspaceRoot || '(open a folder in PocketCode)'}</span>
      </p>

      <div className="flex flex-wrap gap-2 items-end">
        <div className="flex-1 min-w-[10rem]">
          <label className="text-[11px] text-surface-500">New server id</label>
          <input
            className="input-field text-sm w-full"
            value={newId}
            onChange={e => setNewId(e.target.value)}
            placeholder="e.g. filesystem"
          />
        </div>
        <button type="button" onClick={addServer} className="btn-secondary text-sm flex items-center gap-1.5">
          <Plus className="w-3.5 h-3.5" /> Add
        </button>
        <button type="button" onClick={() => void reload()} className="btn-secondary text-sm flex items-center gap-1.5">
          <RefreshCw className="w-3.5 h-3.5" /> Reload
        </button>
      </div>

      {ids.length === 0 && (
        <p className="text-sm text-surface-500">No MCP servers yet. Click Connect Cursor or add one above.</p>
      )}

      <div className="space-y-4">
        {ids.map(id => {
          const s = config.mcpServers[id];
          return (
            <div key={id} className="rounded-xl border border-surface-200 dark:border-surface-800 p-3 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <p className="font-semibold text-sm">{id}</p>
                <label className="text-xs flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={!!s.disabled}
                    onChange={e => updateServer(id, { disabled: e.target.checked })}
                  />
                  Disabled in config
                </label>
              </div>
              <div>
                <label className="text-[11px] text-surface-500">Command</label>
                <input
                  className="input-field text-sm w-full font-mono"
                  value={s.command}
                  onChange={e => updateServer(id, { command: e.target.value })}
                />
              </div>
              <div>
                <label className="text-[11px] text-surface-500">Args (space-separated)</label>
                <input
                  className="input-field text-sm w-full font-mono"
                  value={(s.args || []).join(' ')}
                  onChange={e => updateServer(id, {
                    args: e.target.value.trim() ? e.target.value.trim().split(/\s+/) : [],
                  })}
                />
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={!!testing || !!s.disabled}
                  onClick={() => void test(id)}
                  className="btn-secondary text-xs"
                >
                  {testing === id ? 'Testing…' : 'Test connection'}
                </button>
                <button
                  type="button"
                  onClick={() => removeServer(id)}
                  className="btn-secondary text-xs text-red-600 flex items-center gap-1"
                >
                  <Trash2 className="w-3 h-3" /> Remove
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {status && <p className="text-xs text-surface-500 whitespace-pre-wrap break-words">{status}</p>}
    </div>
  );
}
