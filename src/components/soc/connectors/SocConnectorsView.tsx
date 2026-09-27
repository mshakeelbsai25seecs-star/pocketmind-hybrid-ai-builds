import { useEffect, useState } from 'react';
import {
  liveConnectorUnavailableMessage,
  loadConnectorsConfig,
  saveConnectorsConfig,
  SOC_CONNECTORS,
} from '../../../soc/connectors/registry';
import { useSocActiveCase } from '../SocActiveCaseContext';

export default function SocConnectorsView() {
  const { setNav, setStatus, busy, setBusy } = useSocActiveCase();
  const [config, setConfig] = useState<Record<string, unknown>>({});
  const [selectedLive, setSelectedLive] = useState('fortisiem_live');
  const [endpoint, setEndpoint] = useState('');

  useEffect(() => {
    void loadConnectorsConfig()
      .then(cfg => {
        setConfig(cfg);
        const live = (cfg[selectedLive] || {}) as Record<string, unknown>;
        if (typeof live.endpoint === 'string') setEndpoint(live.endpoint);
      })
      .catch(err => setStatus(String(err)));
  }, [selectedLive, setStatus]);

  const savePrefs = async () => {
    setBusy(true);
    try {
      const next = {
        ...config,
        [selectedLive]: {
          ...((config[selectedLive] as object) || {}),
          endpoint: endpoint.trim(),
          updatedAt: Date.now(),
        },
      };
      const saved = await saveConnectorsConfig(next);
      setConfig(saved);
      setStatus('Connector preferences saved. Live APIs remain disabled in this build.');
    } catch (err) {
      setStatus(String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-4 sm:p-5 space-y-4">
      <div className="rounded-2xl border border-surface-200 dark:border-surface-800 overflow-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wide text-surface-500">
            <tr>
              <th className="px-3 py-2">Connector</th>
              <th className="px-3 py-2">Modes</th>
              <th className="px-3 py-2">Capabilities</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            {SOC_CONNECTORS.map(conn => (
              <tr key={conn.id} className="border-t border-surface-100 dark:border-surface-800">
                <td className="px-3 py-2 font-medium">{conn.label}</td>
                <td className="px-3 py-2">{conn.modes.join(', ')}</td>
                <td className="px-3 py-2">{conn.capabilities.join(', ')}</td>
                <td className="px-3 py-2">{conn.status}</td>
                <td className="px-3 py-2">
                  {conn.id === 'offline_import' ? (
                    <button type="button" className="btn-secondary text-xs" onClick={() => setNav('import')}>
                      Open Import
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="btn-secondary text-xs"
                      onClick={() => {
                        setSelectedLive(conn.id);
                        setStatus(liveConnectorUnavailableMessage());
                      }}
                    >
                      Configure
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <section className="rounded-2xl border border-surface-200 dark:border-surface-800 p-4 space-y-2 max-w-xl">
        <h3 className="font-semibold text-sm">Live connector preferences (disabled)</h3>
        <label className="block">
          <span className="text-xs font-bold uppercase tracking-wide text-surface-500">Connector</span>
          <select
            className="input-field mt-1 text-sm"
            value={selectedLive}
            onChange={e => setSelectedLive(e.target.value)}
          >
            {SOC_CONNECTORS.filter(c => c.modes.includes('live_api')).map(c => (
              <option key={c.id} value={c.id}>{c.label}</option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="text-xs font-bold uppercase tracking-wide text-surface-500">Endpoint URL</span>
          <input
            className="input-field mt-1 text-sm"
            value={endpoint}
            onChange={e => setEndpoint(e.target.value)}
            placeholder="https://…"
          />
        </label>
        <button type="button" className="btn-secondary text-sm" disabled={busy} onClick={() => void savePrefs()}>
          Save preferences
        </button>
        <p className="text-xs text-surface-500">{liveConnectorUnavailableMessage()}</p>
      </section>
    </div>
  );
}
