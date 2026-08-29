import { useEffect } from 'react';
import { invoke } from '@tauri-apps/api/tauri';
import { Cpu, HardDrive, MemoryStick, Zap, Activity, CheckCircle, AlertTriangle } from 'lucide-react';
import { useAppStore } from '../store';
import { SystemInfo } from '../types';

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

export default function HardwareMonitor() {
  const systemInfo = useAppStore(s => s.systemInfo);
  const recommendations = useAppStore(s => s.recommendations);
  const setSystemInfo = useAppStore(s => s.setSystemInfo);

  useEffect(() => {
    let cancelled = false;

    const refresh = async () => {
      if (document.visibilityState === 'hidden') return;
      try {
        const info = await invoke<SystemInfo>('get_system_info');
        if (!cancelled) setSystemInfo(info);
      } catch {
        // Ignore transient polling failures.
      }
    };

    refresh();
    const interval = window.setInterval(refresh, 8000);
    const onVisible = () => { if (document.visibilityState === 'visible') refresh(); };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [setSystemInfo]);

  if (!systemInfo) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-surface-500">Scanning hardware...</div>
      </div>
    );
  }

  const ramPercent = (systemInfo.memory.used_bytes / systemInfo.memory.total_bytes) * 100;
  const vramInfo = systemInfo.gpus[0];

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="max-w-5xl mx-auto space-y-6">
        <div>
          <h1 className="text-2xl font-bold mb-1">System Monitor</h1>
          <p className="text-surface-500">Hardware status and model recommendations</p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <StatCard icon={MemoryStick} label="Total RAM" value={formatBytes(systemInfo.memory.total_bytes)} subtext={`${formatBytes(systemInfo.memory.free_bytes)} free`} color="blue" />
          <StatCard icon={Cpu} label="CPU" value={`${systemInfo.cpu.cores_physical} cores / ${systemInfo.cpu.cores_logical} threads`} subtext={systemInfo.cpu.brand} color="purple" />
          <StatCard icon={Zap} label="GPU" value={vramInfo?.name || 'No GPU detected'} subtext={vramInfo ? `${formatBytes(vramInfo.vram_total_bytes)} VRAM` : 'CPU fallback active'} color="green" />
          <StatCard icon={HardDrive} label="Storage" value={formatBytes(systemInfo.storage.free_bytes)} subtext={`of ${formatBytes(systemInfo.storage.total_bytes)}`} color="orange" />
        </div>

        <div className="glass-panel rounded-xl p-6 space-y-4">
          <h3 className="font-semibold flex items-center gap-2">
            <Activity className="w-5 h-5 text-primary-500" />
            Resource Usage
          </h3>
          <div className="space-y-3">
            <ResourceBar label="RAM Usage" percent={ramPercent} color={ramPercent > 90 ? 'bg-red-500' : ramPercent > 70 ? 'bg-yellow-500' : 'bg-primary-500'} />
            {vramInfo && <ResourceBar label="VRAM Usage" percent={(vramInfo.vram_used_bytes / vramInfo.vram_total_bytes) * 100} color="bg-green-500" />}
            <ResourceBar label="CPU Load" percent={systemInfo.cpu.usage_percent} color="bg-purple-500" />
          </div>
        </div>

        <div className="glass-panel rounded-xl p-6">
          <h3 className="font-semibold flex items-center gap-2 mb-4">
            <Zap className="w-5 h-5 text-yellow-500" />
            Recommended Models
          </h3>
          <div className="space-y-3">
            {recommendations.map((rec, idx) => (
              <div key={idx} className={`flex items-center justify-between p-4 rounded-lg border ${rec.confidence === 'comfortable' ? 'border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-900/10' : rec.confidence === 'maximum-speed' ? 'border-primary-200 dark:border-primary-800 bg-primary-50 dark:bg-primary-900/10' : 'border-yellow-200 dark:border-yellow-800 bg-yellow-50 dark:bg-yellow-900/10'}`}>
                <div className="flex items-center gap-3">
                  {rec.confidence === 'comfortable' ? <CheckCircle className="w-5 h-5 text-green-500" /> : rec.confidence === 'maximum-speed' ? <Zap className="w-5 h-5 text-primary-500" /> : <AlertTriangle className="w-5 h-5 text-yellow-500" />}
                  <div>
                    <p className="font-medium">{rec.name}</p>
                    <p className="text-sm text-surface-500">{rec.params_billions}B params • {rec.quant} • {rec.size_gb}GB</p>
                  </div>
                </div>
                <div className="text-right">
                  <p className="font-semibold">{rec.estimated_tok_sec.toFixed(1)} tok/s</p>
                  <p className="text-xs text-surface-500 capitalize">{rec.confidence.replace('-', ' ')}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function StatCard({ icon: Icon, label, value, subtext, color }: any) {
  const colors: Record<string, string> = {
    blue: 'bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400',
    purple: 'bg-purple-100 dark:bg-purple-900/30 text-purple-600 dark:text-purple-400',
    green: 'bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400',
    orange: 'bg-orange-100 dark:bg-orange-900/30 text-orange-600 dark:text-orange-400',
  };
  
  return (
    <div className="glass-panel rounded-xl p-4">
      <div className={`w-10 h-10 rounded-lg ${colors[color]} flex items-center justify-center mb-3`}>
        <Icon className="w-5 h-5" />
      </div>
      <p className="text-sm text-surface-500 mb-1">{label}</p>
      <p className="font-semibold text-lg truncate">{value}</p>
      <p className="text-xs text-surface-400 truncate">{subtext}</p>
    </div>
  );
}

function ResourceBar({ label, percent, color }: { label: string; percent: number; color: string }) {
  return (
    <div>
      <div className="flex justify-between text-sm mb-1">
        <span>{label}</span>
        <span className="text-surface-500">{percent.toFixed(1)}%</span>
      </div>
      <div className="h-2 bg-surface-200 dark:bg-surface-700 rounded-full overflow-hidden">
        <div className={`h-full rounded-full transition-[width] duration-300 ${color}`} style={{ width: `${Math.min(percent, 100)}%` }} />
      </div>
    </div>
  );
}
