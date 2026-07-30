import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/tauri';
import { ChevronDown, Plus } from 'lucide-react';
import { useAppStore } from '../../store';
import { ONLINE_CHAT_MODELS } from '../../modelCatalog';
import { answerModelLabel, remoteModelPath } from '../../answerModel';
import {
  MODE_LABELS,
  POCKETCODE_MODES,
  type PocketCodeAgentMode,
} from '../../codeWorkspace/agentModes';
import { canUseCodeWorkspaceAgent } from '../../modelCapability';
import type { EnterpriseServerConfig, LocalModelRecord } from '../../types';
import {
  getEnabledSkillIds,
  getSkillsDirs,
  listAllSkills,
  toggleSkillEnabled,
  type SkillInfo,
} from '../../codeWorkspace/skills';
import {
  getEnabledMcpServerIds,
  mcpListServers,
  toggleMcpServerEnabled,
  type McpServerStatus,
} from '../../codeWorkspace/mcp';

export default function ComposerModelBar({
  mode,
  disabled,
  onModeChange,
  workspaceRoot,
  thinClient = false,
}: {
  mode: PocketCodeAgentMode;
  disabled?: boolean;
  onModeChange: (mode: PocketCodeAgentMode) => void;
  workspaceRoot?: string;
  /** thin_client: hide local GGUF picks; org/cloud only. */
  thinClient?: boolean;
}) {
  const currentModel = useAppStore(s => s.currentModel);
  const setCurrentModel = useAppStore(s => s.setCurrentModel);
  const localModels = useAppStore(s => s.localModels);
  const lastEnterpriseModel = useAppStore(s => s.lastEnterpriseModel);
  const setActiveView = useAppStore(s => s.setActiveView);

  const [plusOpen, setPlusOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [enterpriseId, setEnterpriseId] = useState<string | null>(null);
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [enabledSkills, setEnabledSkills] = useState<string[]>([]);
  const [mcpServers, setMcpServers] = useState<McpServerStatus[]>([]);
  const [enabledMcp, setEnabledMcp] = useState<string[]>([]);
  const rootRef = useRef<HTMLDivElement>(null);

  const refreshExtras = useCallback(async () => {
    const [sk, enSk, servers, enMcp] = await Promise.all([
      listAllSkills(workspaceRoot).catch(() => [] as SkillInfo[]),
      getEnabledSkillIds().catch(() => [] as string[]),
      mcpListServers().catch(() => [] as McpServerStatus[]),
      getEnabledMcpServerIds().catch(() => [] as string[]),
    ]);
    setSkills(sk);
    setEnabledSkills(enSk);
    setMcpServers(servers);
    setEnabledMcp(enMcp);
  }, [workspaceRoot]);

  useEffect(() => {
    void invoke<EnterpriseServerConfig>('get_enterprise_server_config')
      .then(cfg => setEnterpriseId(cfg.selected_model?.trim() || null))
      .catch(() => setEnterpriseId(null));
  }, [modelOpen]);

  useEffect(() => {
    if (plusOpen) void refreshExtras();
  }, [plusOpen, refreshExtras]);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) {
        setPlusOpen(false);
        setModelOpen(false);
      }
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const modelLabel = useMemo(
    () => answerModelLabel(currentModel, localModels),
    [currentModel, localModels],
  );

  const localEligible = useMemo(() => {
    return localModels.filter(m => canUseCodeWorkspaceAgent(m.path, { sizeBytes: m.size_bytes }).allowed
      || /\b(20|22|24|27|30|32|34|70|72|405|671)\s*b\b/i.test(m.name)
      || parseFloat((m.name.match(/(\d+(?:\.\d+)?)\s*B/i) || [])[1] || '0') >= 20
      || (m.size_bytes || 0) >= 18 * 1024 * 1024 * 1024
      || (m.metadata || '').toLowerCase().includes('vision')
      || /\b(vl|llava|vision|mmproj)\b/i.test(m.name + m.path));
  }, [localModels]);

  const onlineEligible = useMemo(() => ONLINE_CHAT_MODELS, []);

  const pickLocal = (m: LocalModelRecord) => {
    setCurrentModel(m.path);
    setModelOpen(false);
  };

  const pickOnline = (path: string) => {
    setCurrentModel(path);
    setModelOpen(false);
  };

  const openSkillsFolder = async () => {
    try {
      const dirs = await getSkillsDirs(workspaceRoot);
      const target = dirs.workspace || dirs.user;
      if (target) {
        const { open } = await import('@tauri-apps/api/shell');
        await open(target);
      }
    } catch {
      /* ignore */
    }
  };

  return (
    <div ref={rootRef} className="flex items-center gap-1 min-w-0 flex-1">
      <div className="relative shrink-0">
        <button
          type="button"
          disabled={disabled}
          onClick={() => { setPlusOpen(v => !v); setModelOpen(false); }}
          className="h-7 w-7 rounded-full border border-surface-300/80 dark:border-surface-700 bg-transparent flex items-center justify-center hover:bg-surface-100 dark:hover:bg-surface-800 disabled:opacity-50"
          title="Mode, Skills, MCP"
          aria-label="PocketCode extras"
        >
          <Plus className="w-3.5 h-3.5 text-surface-600 dark:text-surface-300" />
        </button>
        {plusOpen && (
          <div className="absolute bottom-full left-0 mb-1 z-40 w-60 max-h-80 overflow-y-auto rounded-lg border border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-950 shadow-lg py-1">
            <p className="px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-surface-400">Mode</p>
            {POCKETCODE_MODES.map(m => (
              <button
                key={m}
                type="button"
                onClick={() => { onModeChange(m); setPlusOpen(false); }}
                className={`w-full text-left px-3 py-1.5 text-xs ${
                  mode === m
                    ? 'bg-primary-50 dark:bg-primary-950/40 text-primary-800 dark:text-primary-200 font-semibold'
                    : 'hover:bg-surface-50 dark:hover:bg-surface-900 text-surface-700 dark:text-surface-200'
                }`}
              >
                {MODE_LABELS[m]}
              </button>
            ))}

            <p className="px-3 pt-2 pb-1 text-[10px] font-bold uppercase tracking-wider text-surface-400 border-t border-surface-100 dark:border-surface-800 mt-1">
              Skills
            </p>
            {skills.length === 0 && (
              <p className="px-3 py-1.5 text-[11px] text-surface-400">No skills found.</p>
            )}
            {skills.map(s => {
              const on = enabledSkills.includes(s.id);
              return (
                <label
                  key={s.id}
                  className="flex items-start gap-2 px-3 py-1.5 text-xs hover:bg-surface-50 dark:hover:bg-surface-900 cursor-pointer"
                  title={s.description || s.name}
                >
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={on}
                    onChange={() => {
                      void toggleSkillEnabled(s.id, !on).then(setEnabledSkills);
                    }}
                  />
                  <span className="min-w-0">
                    <span className="font-medium block truncate">{s.name}</span>
                    <span className="text-[10px] text-surface-400">{s.source}</span>
                  </span>
                </label>
              );
            })}
            <button
              type="button"
              onClick={() => void openSkillsFolder()}
              className="w-full text-left px-3 py-1.5 text-[11px] text-sky-700 dark:text-sky-300 hover:bg-surface-50 dark:hover:bg-surface-900"
            >
              Open skills folder…
            </button>

            <p className="px-3 pt-2 pb-1 text-[10px] font-bold uppercase tracking-wider text-surface-400 border-t border-surface-100 dark:border-surface-800 mt-1">
              MCP
            </p>
            {mcpServers.length === 0 && (
              <p className="px-3 py-1.5 text-[11px] text-surface-400">No servers configured.</p>
            )}
            {mcpServers.map(s => {
              const on = enabledMcp.includes(s.id) && !s.disabled;
              return (
                <label
                  key={s.id}
                  className="flex items-start gap-2 px-3 py-1.5 text-xs hover:bg-surface-50 dark:hover:bg-surface-900 cursor-pointer"
                >
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={on}
                    disabled={s.disabled}
                    onChange={() => {
                      void toggleMcpServerEnabled(s.id, !on).then(setEnabledMcp);
                    }}
                  />
                  <span className="min-w-0">
                    <span className="font-medium block truncate">{s.id}</span>
                    <span className="text-[10px] text-surface-400 truncate block">
                      {s.disabled ? 'disabled in config'
                        : s.running ? `${s.tool_count} tools · running`
                          : s.command}
                    </span>
                  </span>
                </label>
              );
            })}
            <button
              type="button"
              onClick={() => {
                setPlusOpen(false);
                setActiveView('settings');
                try {
                  sessionStorage.setItem('pm.settings.tab', 'mcp');
                } catch {
                  /* ignore */
                }
              }}
              className="w-full text-left px-3 py-1.5 text-[11px] text-sky-700 dark:text-sky-300 hover:bg-surface-50 dark:hover:bg-surface-900"
            >
              Manage MCP…
            </button>
          </div>
        )}
      </div>

      <div className="relative min-w-0 flex-1">
        <button
          type="button"
          disabled={disabled}
          onClick={() => { setModelOpen(v => !v); setPlusOpen(false); }}
          className="w-full flex items-center gap-1 min-w-0 px-1 py-0.5 rounded-md hover:bg-surface-100 dark:hover:bg-surface-900 disabled:opacity-50 text-left"
          title={currentModel || 'Select model'}
        >
          <span className="text-[9px] font-semibold uppercase tracking-wide text-surface-400 shrink-0">{MODE_LABELS[mode]}</span>
          <span className="text-[12px] text-surface-700 dark:text-surface-200 truncate">
            {modelLabel}
          </span>
          <ChevronDown className="w-3 h-3 text-surface-400 shrink-0 ml-auto" />
        </button>
        {modelOpen && (
          <div className="absolute bottom-full left-0 right-0 mb-1 z-40 max-h-64 overflow-y-auto rounded-lg border border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-950 shadow-lg py-1">
            {(enterpriseId || lastEnterpriseModel) && (
              <>
                <p className="px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-surface-400">Org server</p>
                <button
                  type="button"
                  onClick={() => pickOnline(
                    lastEnterpriseModel
                      || (enterpriseId ? `enterprise:${enterpriseId}` : ''),
                  )}
                  className="w-full text-left px-3 py-1.5 text-xs hover:bg-surface-50 dark:hover:bg-surface-900 truncate"
                >
                  {lastEnterpriseModel || `enterprise:${enterpriseId}`}
                </button>
              </>
            )}
            {!thinClient && (
              <>
                <p className="px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-surface-400">Local</p>
                {localEligible.length === 0 && (
                  <p className="px-3 py-1.5 text-[11px] text-surface-400">
                    {localModels.length > 0
                      ? `${localModels.length} local model(s) available for Chat — open Models → Use in Chat. PocketCode lists ≥20B / VL locals here.`
                      : 'No ≥20B / VL local models. Import in Models.'}
                  </p>
                )}
                {localEligible.map(m => (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => pickLocal(m)}
                    className={`w-full text-left px-3 py-1.5 text-xs truncate ${
                      currentModel === m.path
                        ? 'bg-primary-50 dark:bg-primary-950/40 font-semibold'
                        : 'hover:bg-surface-50 dark:hover:bg-surface-900'
                    }`}
                  >
                    {m.name}
                  </button>
                ))}
              </>
            )}
            {thinClient && (
              <p className="px-3 py-1.5 text-[11px] text-amber-700 dark:text-amber-300">
                Thin client: local GGUF models are disabled. Use org or online models.
              </p>
            )}
            <p className="px-3 py-1 mt-1 text-[10px] font-bold uppercase tracking-wider text-surface-400">Online</p>
            {onlineEligible.slice(0, 40).map(m => {
              const path = remoteModelPath(m);
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => pickOnline(path)}
                  className={`w-full text-left px-3 py-1.5 text-xs truncate ${
                    currentModel === path
                      ? 'bg-primary-50 dark:bg-primary-950/40 font-semibold'
                      : 'hover:bg-surface-50 dark:hover:bg-surface-900'
                  }`}
                >
                  {m.name}
                  {m.categories.includes('vision') && (
                    <span className="ml-1 text-[9px] uppercase text-sky-600">Vision</span>
                  )}
                  <span className="text-surface-400"> · {m.providerName}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
