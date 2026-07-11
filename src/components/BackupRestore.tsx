import { useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/tauri';
import { Download, Upload, ShieldCheck, AlertTriangle, DatabaseBackup, RefreshCw } from 'lucide-react';
import { useAppStore } from '../store';
import { Character, Conversation, LocalModelRecord } from '../types';

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
            Import conversations and characters from a NexusAI backup. Imported items are added as new records and do not overwrite the existing library.
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
