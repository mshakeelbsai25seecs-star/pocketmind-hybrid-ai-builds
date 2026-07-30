import { useCallback, useEffect, useState } from 'react';
import { Cloud, HardDrive, Server } from 'lucide-react';
import {
  RUNTIME_PRESETS,
  applyPreset,
  loadRuntimeProfile,
  profileBannerLabel,
  saveRuntimeProfile,
  type PocketCodeRuntimeProfile,
  type RuntimePresetId,
  type WorkspaceProvision,
} from '../../codeWorkspace/runtimeProfile';
import {
  buildProvisionContext,
  listRemoteWorkspaces,
  runProvision,
} from '../../codeWorkspace/provisioning';
import {
  invalidateRuntimeProfileCache,
  remoteWorkspaceRootToken,
} from '../../api/codeWorkspace';

const PRESET_IDS = Object.keys(RUNTIME_PRESETS) as RuntimePresetId[];

export default function RuntimeProfileBar({
  onWorkspaceRootChange,
  thinClient,
}: {
  onWorkspaceRootChange?: (root: string) => void;
  thinClient?: boolean;
}) {
  const [profile, setProfile] = useState<PocketCodeRuntimeProfile | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [serverPath, setServerPath] = useState('');
  const [gitUrl, setGitUrl] = useState('');
  const [gitRef, setGitRef] = useState('main');
  const [remoteList, setRemoteList] = useState<
    Array<{ id: string; root_path: string; provision: string; read_only: boolean }>
  >([]);

  const reload = useCallback(async () => {
    const p = await loadRuntimeProfile();
    setProfile(p);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const persist = async (next: PocketCodeRuntimeProfile) => {
    await saveRuntimeProfile(next);
    invalidateRuntimeProfileCache();
    setProfile(next);
    if (next.workspaceHost === 'remote' && next.remote?.workspaceId) {
      onWorkspaceRootChange?.(remoteWorkspaceRootToken(next.remote.workspaceId));
    } else if (next.workspaceHost === 'local') {
      // Notify parent so thin/remote UI flags refresh even without a root token change.
      onWorkspaceRootChange?.('');
    }
  };

  const selectPreset = async (id: RuntimePresetId) => {
    setErr(null);
    const next = applyPreset(id, profile || undefined);
    await persist(next);
    setMsg(`Preset: ${RUNTIME_PRESETS[id].label}`);
  };

  const updateRemote = async (patch: Partial<NonNullable<PocketCodeRuntimeProfile['remote']>>) => {
    if (!profile) return;
    const next: PocketCodeRuntimeProfile = {
      ...profile,
      remote: {
        baseUrl: profile.remote?.baseUrl || '',
        workspaceId: profile.remote?.workspaceId || '',
        sessionId: profile.remote?.sessionId,
        ...patch,
      },
    };
    await persist(next);
  };

  const refreshRemoteList = async () => {
    if (!profile || profile.workspaceHost !== 'remote') return;
    setBusy(true);
    setErr(null);
    try {
      const ctx = await buildProvisionContext(profile);
      setRemoteList(await listRemoteWorkspaces(ctx));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const provision = async (mode: WorkspaceProvision) => {
    if (!profile) return;
    if (!confirm(`Provision workspace via ${mode}? This runs on the agent-host server.`)) return;
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const payload: Record<string, unknown> = {};
      if (mode === 'preloaded') payload.serverPath = serverPath.trim();
      if (mode === 'git_clone') {
        payload.url = gitUrl.trim();
        payload.ref = gitRef.trim() || 'main';
      }
      if (mode === 'client_sync') {
        throw new Error('Use “Sync local folder…” — client_sync needs an archive from the folder picker.');
      }
      const result = await runProvision(profile, mode, payload);
      await updateRemote({ workspaceId: result.workspaceId });
      onWorkspaceRootChange?.(remoteWorkspaceRootToken(result.workspaceId));
      setMsg(result.message || `Workspace ${result.workspaceId} ready`);
      await refreshRemoteList();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const syncLocalFolder = async () => {
    if (!profile || profile.provision !== 'client_sync') return;
    if (!confirm('Upload/sync a local folder archive to the agent-host?')) return;
    setBusy(true);
    setErr(null);
    try {
      const { open } = await import('@tauri-apps/api/dialog');
      const selected = await open({ directory: true, multiple: false });
      if (typeof selected !== 'string' || !selected) {
        setBusy(false);
        return;
      }
      // Build a simple zip via Tauri-side helper if available; else send a manifest JSON as zip fallback error.
      const { invoke } = await import('@tauri-apps/api/tauri');
      let archiveBase64: string;
      try {
        archiveBase64 = await invoke<string>('cw_archive_workspace_zip_base64', {
          workspaceRoot: selected,
        });
      } catch {
        // Fallback: ask agent-host to accept a tiny placeholder is wrong — surface clear error.
        throw new Error(
          'Client sync requires the desktop archive helper (cw_archive_workspace_zip_base64). Rebuild the app or use git_clone / preloaded.',
        );
      }
      const result = await runProvision(profile, 'client_sync', {
        archiveBase64,
        format: 'zip',
        projectName: selected.replace(/[\\/]+$/, '').split(/[/\\]/).pop(),
      });
      await updateRemote({ workspaceId: result.workspaceId });
      onWorkspaceRootChange?.(remoteWorkspaceRootToken(result.workspaceId));
      setMsg(result.message || `Synced as ${result.workspaceId}`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!profile) return null;

  const remote = profile.workspaceHost === 'remote';
  const Icon = remote ? Server : HardDrive;

  return (
    <div className="border-b border-surface-200/80 dark:border-surface-800 px-3 py-1.5 bg-surface-50/80 dark:bg-surface-950/40">
      <div className="flex items-center gap-2 min-w-0">
        <Icon className="w-3.5 h-3.5 shrink-0 text-surface-500" />
        <button
          type="button"
          onClick={() => setOpen(v => !v)}
          className="text-[11px] font-medium text-surface-700 dark:text-surface-200 truncate hover:underline"
          title="Runtime profile"
        >
          {profileBannerLabel(profile)}
          {thinClient || profile.uiShell === 'thin_client' ? '' : ''}
        </button>
        <Cloud className="w-3 h-3 shrink-0 text-surface-400 ml-auto opacity-70" />
        <button
          type="button"
          className="text-[10px] uppercase tracking-wide text-primary-600 dark:text-primary-300 shrink-0"
          onClick={() => setOpen(v => !v)}
        >
          {open ? 'Hide' : 'Profile'}
        </button>
      </div>

      {open && (
        <div className="mt-2 space-y-2 text-xs pb-1">
          <label className="block">
            <span className="text-[10px] uppercase text-surface-400">Preset</span>
            <select
              className="mt-0.5 w-full rounded border border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-900 px-2 py-1"
              value={
                PRESET_IDS.find(id => {
                  const p = RUNTIME_PRESETS[id].profile;
                  return (
                    p.workspaceHost === profile.workspaceHost
                    && p.provision === profile.provision
                    && p.uiShell === profile.uiShell
                    && p.inferenceHost === profile.inferenceHost
                  );
                }) || 'LocalClassic'
              }
              onChange={e => void selectPreset(e.target.value as RuntimePresetId)}
            >
              {PRESET_IDS.map(id => (
                <option key={id} value={id}>{RUNTIME_PRESETS[id].label}</option>
              ))}
            </select>
          </label>

          {remote && (
            <>
              <label className="block">
                <span className="text-[10px] uppercase text-surface-400">Agent-host URL</span>
                <input
                  className="mt-0.5 w-full rounded border border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-900 px-2 py-1"
                  value={profile.remote?.baseUrl || ''}
                  placeholder="http://org-host:8788"
                  onChange={e => void updateRemote({ baseUrl: e.target.value })}
                />
              </label>
              <label className="block">
                <span className="text-[10px] uppercase text-surface-400">Workspace ID</span>
                <input
                  className="mt-0.5 w-full rounded border border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-900 px-2 py-1 font-mono"
                  value={profile.remote?.workspaceId || ''}
                  placeholder="ws_…"
                  onChange={e => {
                    const workspaceId = e.target.value;
                    void updateRemote({ workspaceId }).then(() => {
                      if (workspaceId.trim()) {
                        onWorkspaceRootChange?.(remoteWorkspaceRootToken(workspaceId.trim()));
                      }
                    });
                  }}
                />
              </label>

              <div className="flex flex-wrap gap-1.5">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void refreshRemoteList()}
                  className="px-2 py-1 rounded border border-surface-200 dark:border-surface-700 hover:bg-surface-100 dark:hover:bg-surface-800"
                >
                  List workspaces
                </button>
                {profile.provision === 'preloaded' && (
                  <button
                    type="button"
                    disabled={busy || !serverPath.trim()}
                    onClick={() => void provision('preloaded')}
                    className="px-2 py-1 rounded bg-primary-600 text-white disabled:opacity-50"
                  >
                    Bind preloaded path
                  </button>
                )}
                {profile.provision === 'git_clone' && (
                  <button
                    type="button"
                    disabled={busy || !gitUrl.trim()}
                    onClick={() => void provision('git_clone')}
                    className="px-2 py-1 rounded bg-primary-600 text-white disabled:opacity-50"
                  >
                    Clone on server
                  </button>
                )}
                {profile.provision === 'client_sync' && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void syncLocalFolder()}
                    className="px-2 py-1 rounded bg-primary-600 text-white disabled:opacity-50"
                  >
                    Sync local folder…
                  </button>
                )}
              </div>

              {profile.provision === 'preloaded' && (
                <input
                  className="w-full rounded border border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-900 px-2 py-1 font-mono"
                  placeholder="Server path e.g. /workspaces/acme"
                  value={serverPath}
                  onChange={e => setServerPath(e.target.value)}
                />
              )}
              {profile.provision === 'git_clone' && (
                <div className="flex gap-1">
                  <input
                    className="flex-1 rounded border border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-900 px-2 py-1"
                    placeholder="https://git.example.com/org/repo.git"
                    value={gitUrl}
                    onChange={e => setGitUrl(e.target.value)}
                  />
                  <input
                    className="w-24 rounded border border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-900 px-2 py-1"
                    placeholder="ref"
                    value={gitRef}
                    onChange={e => setGitRef(e.target.value)}
                  />
                </div>
              )}

              {remoteList.length > 0 && (
                <ul className="max-h-28 overflow-y-auto rounded border border-surface-200 dark:border-surface-800 divide-y divide-surface-100 dark:divide-surface-800">
                  {remoteList.map(w => (
                    <li key={w.id}>
                      <button
                        type="button"
                        className="w-full text-left px-2 py-1 hover:bg-surface-100 dark:hover:bg-surface-800 font-mono text-[11px]"
                        onClick={() => {
                          void updateRemote({ workspaceId: w.id });
                          onWorkspaceRootChange?.(remoteWorkspaceRootToken(w.id));
                        }}
                      >
                        {w.id} · {w.provision}{w.read_only ? ' · ro' : ''}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}

          {msg && <p className="text-emerald-700 dark:text-emerald-300 text-[11px]">{msg}</p>}
          {err && <p className="text-red-600 dark:text-red-300 text-[11px]">{err}</p>}
        </div>
      )}
    </div>
  );
}
