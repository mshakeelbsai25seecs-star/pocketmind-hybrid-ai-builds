import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/tauri';
import DeploymentSettingsPanel from './DeploymentSettingsPanel';
import SecuritySettingsPanel from './SecuritySettingsPanel';
import AuditLogPanel from './AuditLogPanel';
import McpSettingsPanel from './McpSettingsPanel';
import RefreshButton from './RefreshButton';
import { Key, Shield, Cpu, Palette, Globe, Database, ExternalLink, Trash2, CheckCircle, AlertTriangle, Loader2, Flag, Mail } from 'lucide-react';
import { useAppStore } from '../store';
import { CHAT_API_PROVIDERS } from '../apiProviders';
import { validateApiKey, type ApiKeyValidation } from '../apiKeyValidation';
import { onOpenExternal, openExternal } from '../openExternal';
import { fetchDeploymentConfig } from '../deploymentConfig';
import type { RuntimeDiagnostics, SystemInfo } from '../types';
import { AI_CONTENT_REPORT_EMAIL } from '../reportAiContent';
import ReportAiContentModal, { type ReportAiContentTarget } from './ReportAiContentModal';

type SettingsTab = 'general' | 'providers' | 'mcp' | 'deployment' | 'security' | 'audit' | 'advanced';

export default function SettingsPanel() {
  const store = useAppStore();
  const { theme, setTheme, accentColor, setAccentColor, performanceMode, setPerformanceMode } = store;
  const [activeTab, setActiveTab] = useState<SettingsTab>('general');
  const [apiKeys, setApiKeys] = useState<Record<string, string>>({});
  const [showKey, setShowKey] = useState<Record<string, boolean>>({});
  const [validating, setValidating] = useState<Record<string, boolean>>({});
  const [validation, setValidation] = useState<Record<string, ApiKeyValidation | null>>({});
  const [appVersion, setAppVersion] = useState('…');
  const [advancedBusy, setAdvancedBusy] = useState(false);
  const [advancedMessage, setAdvancedMessage] = useState('');
  const [refreshBusy, setRefreshBusy] = useState(false);
  const [reportTarget, setReportTarget] = useState<ReportAiContentTarget | null>(null);

  useEffect(() => {
    try {
      const tab = sessionStorage.getItem('pm.settings.tab') as SettingsTab | null;
      if (tab === 'mcp' || tab === 'general' || tab === 'providers' || tab === 'deployment'
        || tab === 'security' || tab === 'audit' || tab === 'advanced') {
        setActiveTab(tab);
        sessionStorage.removeItem('pm.settings.tab');
      }
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    invoke<SystemInfo>('get_system_info')
      .then(info => setAppVersion(info.app_version || '1.0.0'))
      .catch(() => setAppVersion('1.0.0'));
  }, []);

  const refreshSettings = async () => {
    setRefreshBusy(true);
    try {
      const info = await invoke<SystemInfo>('get_system_info');
      setAppVersion(info.app_version || '1.0.0');
      await fetchDeploymentConfig().then(config => store.setDeploymentConfig(config));
      setAdvancedMessage('Settings refreshed.');
    } catch (err) {
      setAdvancedMessage(String(err));
    } finally {
      setRefreshBusy(false);
    }
  };

  const openDataFolder = async () => {
    setAdvancedBusy(true);
    setAdvancedMessage('');
    try {
      const config = await fetchDeploymentConfig();
      const root = (config.dataRoot || '').trim();
      if (!root) throw new Error('Data root is not configured. Check Settings → Deployment.');
      await openExternal(root);
      setAdvancedMessage(`Opened: ${root}`);
    } catch (err) {
      setAdvancedMessage(String(err));
    } finally {
      setAdvancedBusy(false);
    }
  };

  const generateDebugReport = async () => {
    setAdvancedBusy(true);
    setAdvancedMessage('');
    try {
      const diag = await invoke<RuntimeDiagnostics>('get_runtime_diagnostics', {
        selectedModelPath: store.currentModel || null,
        modelsDir: store.modelsDir,
      });
      const report = [
        'PocketMind Hybrid AI Debug Report',
        `App version: ${diag.app_version}`,
        `Current dir: ${diag.current_dir}`,
        `Executable dir: ${diag.executable_dir}`,
        `llama-server found: ${diag.llama_server_found}`,
        `Runtime path: ${diag.llama_server_path || 'missing'}`,
        `Selected model: ${diag.selected_model_path || 'none'}`,
        `Models folder exists: ${diag.models_dir_exists}`,
        `CPU: ${diag.cpu_brand || 'unknown'}`,
        `GPUs: ${diag.gpu_summary.join(', ') || 'none detected'}`,
        '',
        ...diag.checks.map(c => `[${c.status.toUpperCase()}] ${c.label}: ${c.message}`),
      ].join('\n');
      await navigator.clipboard.writeText(report);
      setAppVersion(diag.app_version || appVersion);
      setAdvancedMessage('Debug report copied to clipboard.');
    } catch (err) {
      setAdvancedMessage(String(err));
    } finally {
      setAdvancedBusy(false);
    }
  };

  const runValidate = async (provider: string, key?: string) => {
    setValidating(prev => ({ ...prev, [provider]: true }));
    try {
      const result = await validateApiKey(provider, key);
      setValidation(prev => ({ ...prev, [provider]: result }));
      return result;
    } catch (err) {
      const fail: ApiKeyValidation = {
        ok: false,
        provider,
        message: String(err),
      };
      setValidation(prev => ({ ...prev, [provider]: fail }));
      return fail;
    } finally {
      setValidating(prev => ({ ...prev, [provider]: false }));
    }
  };

  const handleSaveKey = async (provider: string, key: string) => {
    const trimmed = key.trim();
    if (!trimmed) return;
    const result = await runValidate(provider, trimmed);
    if (!result.ok) return;
    await invoke('store_api_key', { provider, key: trimmed });
    setApiKeys({ ...apiKeys, [provider]: trimmed });
  };

  const handleRemoveKey = async (provider: string) => {
    await invoke('remove_api_key', { provider });
    const newKeys = { ...apiKeys };
    delete newKeys[provider];
    setApiKeys(newKeys);
    setValidation(prev => ({ ...prev, [provider]: null }));
  };

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="max-w-3xl mx-auto space-y-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold mb-1">Settings</h1>
            <p className="text-surface-500">Configure PocketMind Hybrid AI to your preferences</p>
          </div>
          <RefreshButton title="Refresh" onClick={refreshSettings} busy={refreshBusy} />
        </div>

        <div className="flex flex-wrap gap-1 p-1 bg-surface-100 dark:bg-surface-900 rounded-lg w-fit">
          {(['general', 'providers', 'mcp', 'deployment', 'security', 'audit', 'advanced'] as const).map(tab => (
            <button key={tab} onClick={() => setActiveTab(tab)} className={`px-4 py-2 rounded-md text-sm font-medium transition-all ${activeTab === tab ? 'bg-white dark:bg-surface-800 shadow-sm' : 'text-surface-500 hover:text-surface-700 dark:hover:text-surface-300'}`}>
              {tab === 'mcp' ? 'MCP' : tab.charAt(0).toUpperCase() + tab.slice(1)}
            </button>
          ))}
        </div>

        {activeTab === 'general' && (
          <div className="space-y-6">
            <div className="glass-panel rounded-xl p-6 space-y-4">
              <h3 className="font-semibold flex items-center gap-2"><Palette className="w-5 h-5 text-primary-500" />Appearance</h3>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium mb-2">Theme</label>
                  <div className="flex gap-2">
                    {(['light', 'dark', 'system'] as const).map(t => (
                      <button key={t} onClick={() => setTheme(t)} className={`flex-1 py-2 rounded-lg border text-sm capitalize transition-all ${theme === t ? 'border-primary-500 bg-primary-50 dark:bg-primary-900/20 text-primary-700 dark:text-primary-300' : 'border-surface-200 dark:border-surface-700 hover:bg-surface-50 dark:hover:bg-surface-800'}`}>
                        {t}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium mb-2">Accent Color</label>
                  <div className="flex gap-2">
                    {['#4ade80', '#86efac', '#22c55e', '#a3a3a3', '#f5f5f5', '#0a0a0a'].map(color => (
                      <button key={color} onClick={() => setAccentColor(color)} className={`w-8 h-8 rounded-full transition-all ${accentColor === color ? 'ring-2 ring-offset-2 ring-surface-400 scale-110' : ''}`} style={{ backgroundColor: color }} />
                    ))}
                  </div>
                </div>
              </div>
            </div>

            <div className="glass-panel rounded-xl p-6 space-y-4">
              <h3 className="font-semibold flex items-center gap-2"><Cpu className="w-5 h-5 text-primary-500" />Performance</h3>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                {([
                  { id: 'low-ram' as const, label: 'Low RAM', desc: 'Minimize memory' },
                  { id: 'battery-saver' as const, label: 'Battery Saver', desc: 'Reduce power' },
                  { id: 'balanced' as const, label: 'Balanced', desc: 'Default' },
                  { id: 'maximum-speed' as const, label: 'Maximum Speed', desc: 'Fastest' },
                  { id: 'maximum-quality' as const, label: 'Maximum Quality', desc: 'Best quality' },
                ]).map(mode => (
                  <button key={mode.id} onClick={() => setPerformanceMode(mode.id)} className={`p-3 rounded-lg border text-left transition-all ${performanceMode === mode.id ? 'border-primary-500 bg-primary-50 dark:bg-primary-900/20' : 'border-surface-200 dark:border-surface-700 hover:bg-surface-50 dark:hover:bg-surface-800'}`}>
                    <p className="font-medium text-sm">{mode.label}</p>
                    <p className="text-xs text-surface-500">{mode.desc}</p>
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {activeTab === 'providers' && (
          <div className="space-y-4">
            <div className="glass-panel rounded-xl p-6">
              <div className="flex items-center gap-2 mb-4"><Shield className="w-5 h-5 text-primary-500" /><h3 className="font-semibold">API Key Management</h3></div>
              <p className="text-sm text-surface-500 mb-6">
                Your API keys are encrypted locally using AES-256-GCM. Never sent to our servers.
                After saving a key, select a model from that provider in Models (OpenAI, DeepSeek, Mistral, Anthropic, Gemini, OpenRouter, Groq, Cerebras, Together).
              </p>
              <div className="space-y-4">
                {CHAT_API_PROVIDERS.map(provider => (
                  <div key={provider.id} className="border border-surface-200 dark:border-surface-800 rounded-lg p-4">
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-3">
                        <Globe className="w-5 h-5 text-surface-400" />
                        <div>
                          <p className="font-medium">{provider.name}</p>
                          {provider.freeModels && <span className="text-xs text-green-600 dark:text-green-400 flex items-center gap-1"><CheckCircle className="w-3 h-3" />Free-tier models available</span>}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={onOpenExternal(provider.url)}
                        className="text-xs text-primary-600 dark:text-primary-400 flex items-center gap-1 hover:underline"
                      >
                        Get key <ExternalLink className="w-3 h-3" />
                      </button>
                    </div>
                    <div className="flex gap-2">
                      <input
                        type={showKey[provider.id] ? 'text' : 'password'}
                        value={apiKeys[provider.id] || ''}
                        onChange={e => {
                          setApiKeys({ ...apiKeys, [provider.id]: e.target.value });
                          setValidation(prev => ({ ...prev, [provider.id]: null }));
                        }}
                        placeholder="Paste API key"
                        className="input-field text-sm"
                      />
                      <button onClick={() => setShowKey({...showKey, [provider.id]: !showKey[provider.id]})} className="p-2 rounded-lg hover:bg-surface-100 dark:hover:bg-surface-800 transition-colors"><Key className="w-4 h-4 text-surface-500" /></button>
                      <button
                        type="button"
                        disabled={!!validating[provider.id]}
                        onClick={() => void runValidate(provider.id, apiKeys[provider.id])}
                        className="btn-secondary px-3 text-sm disabled:opacity-50"
                        title="Test pasted key, or the saved key if the field is empty"
                      >
                        {validating[provider.id] ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Test'}
                      </button>
                      {apiKeys[provider.id] && (
                        <>
                          <button
                            type="button"
                            disabled={!!validating[provider.id]}
                            onClick={() => void handleSaveKey(provider.id, apiKeys[provider.id])}
                            className="btn-primary px-3 disabled:opacity-50"
                          >
                            Save
                          </button>
                          <button onClick={() => handleRemoveKey(provider.id)} className="p-2 rounded-lg hover:bg-red-100 dark:hover:bg-red-900/30 text-red-600 transition-colors"><Trash2 className="w-4 h-4" /></button>
                        </>
                      )}
                    </div>
                    {validation[provider.id] && (
                      <p className={`mt-2 text-xs flex items-start gap-1.5 ${validation[provider.id]!.ok ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                        {validation[provider.id]!.ok
                          ? <CheckCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                          : <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />}
                        <span className="break-words">{validation[provider.id]!.message}</span>
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {activeTab === 'mcp' && <McpSettingsPanel />}

        {activeTab === 'deployment' && <DeploymentSettingsPanel />}

        {activeTab === 'security' && <SecuritySettingsPanel />}

        {activeTab === 'audit' && <AuditLogPanel />}

        {activeTab === 'advanced' && (
          <div className="space-y-6">
            <div className="glass-panel rounded-xl p-6 space-y-4">
              <h3 className="font-semibold flex items-center gap-2"><Database className="w-5 h-5 text-primary-500" />Local Data</h3>
              <div className="space-y-3">
                <div className="flex items-center justify-between p-3 rounded-lg bg-surface-50 dark:bg-surface-900 gap-3">
                  <div><p className="font-medium text-sm">Database</p><p className="text-xs text-surface-500">SQLite with WAL mode — opens the configured data root</p></div>
                  <button type="button" onClick={() => void openDataFolder()} disabled={advancedBusy} className="btn-secondary text-sm disabled:opacity-50">Open Folder</button>
                </div>
                <div className="flex items-center justify-between p-3 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 gap-3">
                  <div><p className="font-medium text-sm text-red-700 dark:text-red-300">Reset Application</p><p className="text-xs text-red-600 dark:text-red-400">Factory wipe is not shipped — delete/relocate the data root manually after Backup</p></div>
                  <button
                    type="button"
                    className="px-3 py-1.5 rounded-lg bg-red-600/50 text-white text-sm cursor-not-allowed"
                    title="Factory reset is not implemented in 1.0.0"
                    onClick={() => window.alert('Factory reset is not implemented. Export a backup first, then remove or relocate your data root folder (see Settings → Deployment).')}
                  >
                    Reset
                  </button>
                </div>
              </div>
            </div>
            <div className="glass-panel rounded-xl p-6">
              <h3 className="font-semibold flex items-center gap-2 mb-4"><AlertTriangle className="w-5 h-5 text-yellow-500" />Diagnostics</h3>
              <div className="space-y-2 text-sm text-surface-500">
                <p>App Version: {appVersion}</p>
                <p>Database: SQLite (encrypted at rest)</p>
                <p>Telemetry: Disabled (privacy-first)</p>
                <button type="button" onClick={() => void generateDebugReport()} disabled={advancedBusy} className="btn-secondary text-sm mt-2 disabled:opacity-50">Generate Debug Report</button>
                {advancedMessage && <p className="text-xs text-surface-600 dark:text-surface-300 mt-2 break-words">{advancedMessage}</p>}
              </div>
            </div>
            <div className="glass-panel rounded-xl p-6">
              <h3 className="font-semibold flex items-center gap-2 mb-4"><Flag className="w-5 h-5 text-amber-500" />Report AI content</h3>
              <div className="space-y-3 text-sm text-surface-500">
                <p>
                  PocketMind uses live generative AI. If an AI response is inappropriate, harmful, or otherwise concerning, report it to the publisher.
                </p>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    className="btn-primary text-sm inline-flex items-center gap-2"
                    onClick={() => setReportTarget({
                      contentExcerpt: '(General report — user did not attach a specific AI output.)',
                      sourceLabel: 'Settings → Advanced',
                      contentKind: 'other',
                    })}
                  >
                    <Flag className="w-4 h-4" /> Report an issue
                  </button>
                  <button
                    type="button"
                    className="btn-secondary text-sm inline-flex items-center gap-2"
                    onClick={onOpenExternal(`mailto:${AI_CONTENT_REPORT_EMAIL}`)}
                  >
                    <Mail className="w-4 h-4" /> Email support
                  </button>
                </div>
                <p className="text-xs">{AI_CONTENT_REPORT_EMAIL}</p>
              </div>
            </div>
          </div>
        )}
      </div>

      <ReportAiContentModal
        open={Boolean(reportTarget)}
        target={reportTarget}
        onClose={() => setReportTarget(null)}
      />
    </div>
  );
}