import { useRef, useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/tauri';
import { open } from '@tauri-apps/api/dialog';
import { Download, Upload, ShieldCheck, AlertTriangle, DatabaseBackup, RefreshCw, Lock, FolderOpen } from 'lucide-react';
import { useAppStore } from '../store';
import { Character, Conversation, LocalModelRecord } from '../types';
import { FEATURE_FLAGS } from '../featureFlags';
import {
  getBackupSchedule,
  restoreEncryptedBackup,
  runEncryptedBackup,
  setBackupSchedule,
  setSetting,
} from '../api/powerFeatures';
import type { BackupScheduleStatus } from '../codeWorkspace/types';

interface BackupData {
  app: string;
  version: number;
  exported_at: string;
  conversations: Conversation[];
  messages: Record<string, any[]>;
  characters: Character[];
  local_models: LocalModelRecord[];
  settings: Record<string, string>;
}

export default function BackupRestore() {
  const store = useAppStore();
  const fileRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [passphrase, setPassphrase] = useState('');
  const [destDir, setDestDir] = useState('');
  const [scheduleEnabled, setScheduleEnabled] = useState(false);
  const [scheduleHours, setScheduleHours] = useState(24);
  const [scheduleInfo, setScheduleInfo] = useState<BackupScheduleStatus | null>(null);

  const refreshSchedule = async () => {
    if (!FEATURE_FLAGS.scheduledBackup) return;
    try {
      const info = await getBackupSchedule();
      setScheduleInfo(info);
      setScheduleEnabled(info.enabled);
      setScheduleHours(info.hours);
      setDestDir(info.dest_dir || '');
    } catch {
      /* backend may not be wired yet */
    }
  };

  useEffect(() => { void refreshSchedule(); }, []);

  const exportBackup = async () => {
    setBusy(true);
    setStatus(null);
    try {
      const backup = await invoke<BackupData>('export_backup');
      const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `nexusai-backup-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setStatus('Backup exported successfully. Keep it somewhere safe.');
    } catch (err) {
      setStatus(`Backup export failed: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const importBackupFile = async (file: File) => {
    setBusy(true);
    setStatus(null);
    try {
      const raw = await file.text();
      const parsed = JSON.parse(raw);
      const result = await invoke<string>('import_backup', { backup: parsed });
      setStatus(result);
      const [convs, chars, models] = await Promise.all([
        invoke<Conversation[]>('get_conversations'),
        invoke<Character[]>('get_characters'),
        invoke<LocalModelRecord[]>('get_local_models'),
      ]);
      store.setConversations(convs);
      store.setCharacters(chars);
      store.setLocalModels(models);
    } catch (err) {
      setStatus(`Backup import failed: ${String(err)}`);
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const pickDestFolder = async () => {
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected === 'string') setDestDir(selected);
  };

  const saveSchedule = async () => {
    setBusy(true);
    try {
      await setBackupSchedule(scheduleEnabled, scheduleHours, destDir, passphrase || undefined);
      await refreshSchedule();
      setStatus('Backup schedule saved.');
    } catch (err) {
      setStatus(String(err));
    } finally {
      setBusy(false);
    }
  };

  const runEncryptedNow = async () => {
    if (!passphrase || passphrase.length < 8) {
      setStatus('Passphrase must be at least 8 characters.');
      return;
    }
    if (!destDir) {
      setStatus('Choose a destination folder first.');
      return;
    }
    setBusy(true);
    try {
      const msg = await runEncryptedBackup(passphrase, destDir);
      try {
        await setSetting('backup.passphrase', passphrase);
        await setBackupSchedule(scheduleEnabled, scheduleHours, destDir, passphrase);
      } catch {
        /* schedule persistence optional */
      }
      setStatus(msg);
      await refreshSchedule();
    } catch (err) {
      setStatus(String(err));
    } finally {
      setBusy(false);
    }
  };

  const restoreEncryptedFile = async () => {
    if (!passphrase) {
      setStatus('Enter the backup passphrase first.');
      return;
    }
    const selected = await open({
      multiple: false,
      filters: [{ name: 'Encrypted backup', extensions: ['pmbk'] }],
    });
    if (typeof selected !== 'string') return;
    setBusy(true);
    try {
      const msg = await restoreEncryptedBackup(selected, passphrase);
      setStatus(msg);
      const [convs, chars, models] = await Promise.all([
        invoke<Conversation[]>('get_conversations'),
        invoke<Character[]>('get_characters'),
        invoke<LocalModelRecord[]>('get_local_models'),
      ]);
      store.setConversations(convs);
      store.setCharacters(chars);
      store.setLocalModels(models);
    } catch (err) {
      setStatus(String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="h-full overflow-y-auto p-8 space-y-8 bg-gradient-to-br from-surface-50 via-white to-primary-50/30 dark:from-surface-950 dark:via-surface-950 dark:to-primary-950/20">
      <section className="rounded-3xl border border-surface-200 dark:border-surface-800 bg-white/80 dark:bg-surface-900/80 backdrop-blur p-8 shadow-soft">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-primary-100 dark:bg-primary-900/30 text-primary-700 dark:text-primary-300 text-sm font-semibold mb-4">
          <DatabaseBackup className="w-4 h-4" /> Backup & Restore
        </div>
        <h1 className="text-4xl font-black tracking-tight">Protect chats and settings</h1>
        <p className="text-surface-600 dark:text-surface-400 mt-2 max-w-3xl">
          Export a local JSON backup of conversations, messages, characters, settings, and model library records. GGUF model files and API keys are intentionally not included.
        </p>
      </section>

      {status && (
        <div className="rounded-2xl border border-primary-200 dark:border-primary-900/60 bg-primary-50 dark:bg-primary-950/20 p-4 text-sm text-primary-800 dark:text-primary-200">
          {status}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <section className="rounded-3xl border border-surface-200 dark:border-surface-800 bg-white dark:bg-surface-900 p-6 shadow-soft">
          <div className="w-12 h-12 rounded-2xl bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300 flex items-center justify-center mb-4">
            <Download className="w-6 h-6" />
          </div>
          <h2 className="text-2xl font-bold">Export backup</h2>
          <p className="text-sm text-surface-600 dark:text-surface-400 mt-2 min-h-16">
            Download a readable JSON backup for migration, release testing, or safety before major changes.
          </p>
          <button disabled={busy} onClick={exportBackup} className="mt-5 inline-flex items-center gap-2 rounded-2xl bg-primary-600 hover:bg-primary-700 text-white px-5 py-3 font-semibold disabled:opacity-50">
            {busy ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />} Export JSON
          </button>
        </section>

        <section className="rounded-3xl border border-surface-200 dark:border-surface-800 bg-white dark:bg-surface-900 p-6 shadow-soft">
          <div className="w-12 h-12 rounded-2xl bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 flex items-center justify-center mb-4">
            <Upload className="w-6 h-6" />
          </div>
          <h2 className="text-2xl font-bold">Import backup</h2>
          <p className="text-sm text-surface-600 dark:text-surface-400 mt-2 min-h-16">
            Import conversations and characters from a PocketMind Hybrid AI backup. Imported items are added as new records and do not overwrite the existing library.
          </p>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) importBackupFile(file);
            }}
          />
          <button disabled={busy} onClick={() => fileRef.current?.click()} className="mt-5 inline-flex items-center gap-2 rounded-2xl bg-surface-900 dark:bg-white text-white dark:text-surface-950 px-5 py-3 font-semibold disabled:opacity-50">
            {busy ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />} Choose backup file
          </button>
        </section>
      </div>

      {FEATURE_FLAGS.encryptedBackup && (
        <section className="rounded-3xl border border-surface-200 dark:border-surface-800 bg-white dark:bg-surface-900 p-6 shadow-soft space-y-4">
          <h2 className="text-2xl font-bold flex items-center gap-2"><Lock className="w-6 h-6 text-primary-500" /> Encrypted backup</h2>
          <p className="text-sm text-surface-600 dark:text-surface-400">
            AES-GCM encrypted `.pmbak` backups with a passphrase. GGUF files are still excluded.
          </p>
          <div className="grid md:grid-cols-2 gap-3">
            <label className="text-sm">Passphrase (min 8 chars)
              <input type="password" value={passphrase} onChange={e => setPassphrase(e.target.value)} className="input-field mt-1 w-full" />
            </label>
            <label className="text-sm">Destination folder
              <div className="flex gap-2 mt-1">
                <input value={destDir} readOnly className="input-field flex-1 text-xs" placeholder="Pick folder…" />
                <button type="button" onClick={() => void pickDestFolder()} className="btn-secondary px-3"><FolderOpen className="w-4 h-4" /></button>
              </div>
            </label>
          </div>
          {FEATURE_FLAGS.scheduledBackup && (
            <div className="rounded-2xl bg-surface-50 dark:bg-surface-950 p-4 space-y-3">
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={scheduleEnabled} onChange={e => setScheduleEnabled(e.target.checked)} />
                Enable scheduled backup
              </label>
              <label className="text-sm block">Every
                <input type="number" min={1} max={168} value={scheduleHours} onChange={e => setScheduleHours(Number(e.target.value))} className="input-field mt-1 w-32" /> hours
              </label>
              <button disabled={busy} onClick={() => void saveSchedule()} className="btn-secondary text-sm">Save schedule</button>
              {scheduleInfo?.last_status && (
                <p className="text-xs text-surface-500">Last run: {scheduleInfo.last_status}{scheduleInfo.last_run_at ? ` · ${new Date(scheduleInfo.last_run_at * 1000).toLocaleString()}` : ''}</p>
              )}
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <button disabled={busy} onClick={() => void runEncryptedNow()} className="btn-primary text-sm flex items-center gap-2">
              {busy ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />} Run encrypted backup now
            </button>
            <button disabled={busy} onClick={() => void restoreEncryptedFile()} className="btn-secondary text-sm flex items-center gap-2">
              <Upload className="w-4 h-4" /> Restore encrypted backup
            </button>
          </div>
        </section>
      )}

      <section className="rounded-3xl border border-surface-200 dark:border-surface-800 bg-white dark:bg-surface-900 p-6 shadow-soft">
        <h2 className="text-xl font-bold flex items-center gap-2"><ShieldCheck className="w-5 h-5 text-green-500" /> Backup contents</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-4 text-sm">
          <div className="rounded-2xl bg-surface-50 dark:bg-surface-950 p-4">Included: conversations, messages, characters, settings, model library records.</div>
          <div className="rounded-2xl bg-surface-50 dark:bg-surface-950 p-4">Not included: GGUF model files, API keys, temporary cache, llama.cpp binaries.</div>
        </div>
      </section>

      <section className="rounded-3xl border border-amber-200 dark:border-amber-900/60 bg-amber-50 dark:bg-amber-950/20 p-5 flex gap-3 text-sm text-amber-800 dark:text-amber-200">
        <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5" />
        <div>
          Keep backups private. They can contain your chat text and file-derived context. API keys are not exported.
        </div>
      </section>
    </div>
  );
}
