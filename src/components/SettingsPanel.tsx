import { useState } from 'react';
import { invoke } from '@tauri-apps/api/tauri';
import DeploymentSettingsPanel from './DeploymentSettingsPanel';
import SecuritySettingsPanel from './SecuritySettingsPanel';
import AuditLogPanel from './AuditLogPanel';
import { Key, Shield, Cpu, Palette, Globe, Database, ExternalLink, Trash2, CheckCircle, AlertTriangle } from 'lucide-react';
import { useAppStore } from '../store';

const PROVIDERS = [
  { id: 'groq', name: 'Groq', url: 'https://console.groq.com/keys', freeModels: true },
  { id: 'openrouter', name: 'OpenRouter', url: 'https://openrouter.ai/keys', freeModels: true },
  { id: 'openai', name: 'OpenAI', url: 'https://platform.openai.com/api-keys', freeModels: false },
  { id: 'anthropic', name: 'Anthropic', url: 'https://console.anthropic.com/settings/keys', freeModels: false },
  { id: 'deepseek', name: 'DeepSeek', url: 'https://platform.deepseek.com/api_keys', freeModels: true },
  { id: 'mistral', name: 'Mistral AI', url: 'https://console.mistral.ai/api-keys/', freeModels: false },
  { id: 'together', name: 'Together AI', url: 'https://api.together.xyz/settings/api-keys', freeModels: false },
  { id: 'gemini', name: 'Google Gemini', url: 'https://aistudio.google.com/app/apikey', freeModels: true },
];

export default function SettingsPanel() {
  const store = useAppStore();
  const { theme, setTheme, accentColor, setAccentColor, performanceMode, setPerformanceMode } = store;
  const [activeTab, setActiveTab] = useState<'general' | 'providers' | 'deployment' | 'security' | 'audit' | 'advanced'>('general');
  const [apiKeys, setApiKeys] = useState<Record<string, string>>({});
  const [showKey, setShowKey] = useState<Record<string, boolean>>({});

  const handleSaveKey = async (provider: string, key: string) => {
    await invoke('store_api_key', { provider, key });
    setApiKeys({ ...apiKeys, [provider]: key });
  };

  const handleRemoveKey = async (provider: string) => {
    await invoke('remove_api_key', { provider });
    const newKeys = { ...apiKeys };
    delete newKeys[provider];
    setApiKeys(newKeys);
  };

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="max-w-3xl mx-auto space-y-6">
        <div>
          <h1 className="text-2xl font-bold mb-1">Settings</h1>
          <p className="text-surface-500">Configure NexusAI to your preferences</p>
        </div>

        <div className="flex gap-1 p-1 bg-surface-100 dark:bg-surface-900 rounded-lg w-fit">
          {(['general', 'providers', 'deployment', 'security', 'audit', 'advanced'] as const).map(tab => (
            <button key={tab} onClick={() => setActiveTab(tab)} className={`px-4 py-2 rounded-md text-sm font-medium transition-all ${activeTab === tab ? 'bg-white dark:bg-surface-800 shadow-sm' : 'text-surface-500 hover:text-surface-700 dark:hover:text-surface-300'}`}>
              {tab.charAt(0).toUpperCase() + tab.slice(1)}
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
                    {['#0ea5e9', '#8b5cf6', '#ec4899', '#10b981', '#f59e0b'].map(color => (
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
              <p className="text-sm text-surface-500 mb-6">Your API keys are encrypted locally using AES-256-GCM. Never sent to our servers.</p>
              <div className="space-y-4">
                {PROVIDERS.map(provider => (
                  <div key={provider.id} className="border border-surface-200 dark:border-surface-800 rounded-lg p-4">
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-3">
                        <Globe className="w-5 h-5 text-surface-400" />
                        <div>
                          <p className="font-medium">{provider.name}</p>
                          {provider.freeModels && <span className="text-xs text-green-600 dark:text-green-400 flex items-center gap-1"><CheckCircle className="w-3 h-3" />Free-tier models available</span>}
                        </div>
                      </div>
                      <a href={provider.url} target="_blank" rel="noopener noreferrer" className="text-xs text-primary-600 dark:text-primary-400 flex items-center gap-1 hover:underline">Get key <ExternalLink className="w-3 h-3" /></a>
                    </div>
                    <div className="flex gap-2">
                      <input type={showKey[provider.id] ? 'text' : 'password'} value={apiKeys[provider.id] || ''} onChange={e => setApiKeys({...apiKeys, [provider.id]: e.target.value})} placeholder="Paste API key" className="input-field text-sm" />
                      <button onClick={() => setShowKey({...showKey, [provider.id]: !showKey[provider.id]})} className="p-2 rounded-lg hover:bg-surface-100 dark:hover:bg-surface-800 transition-colors"><Key className="w-4 h-4 text-surface-500" /></button>
                      {apiKeys[provider.id] && (
                        <>
                          <button onClick={() => handleSaveKey(provider.id, apiKeys[provider.id])} className="btn-primary px-3">Save</button>
                          <button onClick={() => handleRemoveKey(provider.id)} className="p-2 rounded-lg hover:bg-red-100 dark:hover:bg-red-900/30 text-red-600 transition-colors"><Trash2 className="w-4 h-4" /></button>
                        </>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {activeTab === 'deployment' && <DeploymentSettingsPanel />}

        {activeTab === 'security' && <SecuritySettingsPanel />}

        {activeTab === 'audit' && <AuditLogPanel />}

        {activeTab === 'advanced' && (
          <div className="space-y-6">
            <div className="glass-panel rounded-xl p-6 space-y-4">
              <h3 className="font-semibold flex items-center gap-2"><Database className="w-5 h-5 text-primary-500" />Local Data</h3>
              <div className="space-y-3">
                <div className="flex items-center justify-between p-3 rounded-lg bg-surface-50 dark:bg-surface-900">
                  <div><p className="font-medium text-sm">Database</p><p className="text-xs text-surface-500">SQLite with WAL mode</p></div>
                  <button className="btn-secondary text-sm">Open Folder</button>
                </div>
                <div className="flex items-center justify-between p-3 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800">
                  <div><p className="font-medium text-sm text-red-700 dark:text-red-300">Reset Application</p><p className="text-xs text-red-600 dark:text-red-400">Clear all data</p></div>
                  <button className="px-3 py-1.5 rounded-lg bg-red-600 hover:bg-red-500 text-white text-sm transition-colors">Reset</button>
                </div>
              </div>
            </div>
            <div className="glass-panel rounded-xl p-6">
              <h3 className="font-semibold flex items-center gap-2 mb-4"><AlertTriangle className="w-5 h-5 text-yellow-500" />Diagnostics</h3>
              <div className="space-y-2 text-sm text-surface-500">
                <p>App Version: 0.1.0</p>
                <p>Database: SQLite (encrypted at rest)</p>
                <p>Telemetry: Disabled (privacy-first)</p>
                <button className="btn-secondary text-sm mt-2">Generate Debug Report</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}