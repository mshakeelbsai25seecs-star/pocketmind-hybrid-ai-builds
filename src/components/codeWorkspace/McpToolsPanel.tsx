import { useEffect, useState } from 'react';
import { Plug } from 'lucide-react';
import {
  getEnabledMcpServerIds,
  mcpGetConfig,
  mcpListTools,
  type McpToolInfo,
} from '../../codeWorkspace/mcp';

export default function McpToolsPanel() {
  const [tools, setTools] = useState<McpToolInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [serverCount, setServerCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cfg = await mcpGetConfig();
        const enabled = await getEnabledMcpServerIds();
        const ids = enabled.length
          ? enabled
          : Object.keys(cfg.mcpServers || {}).filter(id => !cfg.mcpServers[id]?.disabled);
        setServerCount(ids.length);
        const listed = ids.length ? await mcpListTools(ids) : [];
        if (!cancelled) {
          setTools(listed);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(String(err));
      }
    })();
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="rounded-xl border border-white/10 p-2.5 space-y-2">
      <div className="flex items-center justify-between text-[11px]">
        <span className="font-semibold uppercase tracking-wider text-surface-400 flex items-center gap-1">
          <Plug className="w-3.5 h-3.5" /> MCP Tools
        </span>
        <span className="text-surface-500">{serverCount} connected</span>
      </div>
      {error && <p className="text-[11px] text-amber-300">{error}</p>}
      {tools.length === 0 && !error && (
        <p className="text-[11px] text-surface-500">No MCP servers enabled. Add them in Control Center → Settings → MCP.</p>
      )}
      <ul className="space-y-1">
        {tools.slice(0, 12).map(t => (
          <li key={`${t.server}.${t.name}`} className="flex items-start gap-2 text-[11px]">
            <span className="w-1.5 h-1.5 mt-1.5 rounded-full bg-primary-400 shrink-0" />
            <div className="min-w-0">
              <p className="truncate text-surface-100">{t.server}</p>
              <p className="truncate text-surface-500">{t.name}{t.description ? ` · ${t.description}` : ''}</p>
            </div>
            <span className="ml-auto text-primary-300">✓</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
