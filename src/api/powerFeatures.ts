import { invoke } from '@tauri-apps/api/tauri';
import type {
  BackupScheduleStatus,
  BatchFileResult,
  IntegrityResult,
  OrphanItem,
  ToolingStatus,
  WorkspaceProfile,
} from '../codeWorkspace/types';

export async function getBackupSchedule(): Promise<BackupScheduleStatus> {
  const raw = await invoke<{
    enabled: boolean;
    hours: number;
    dest_dir: string;
    last_run_unix?: number | null;
    last_status?: string | null;
  }>('get_backup_schedule');
  return {
    enabled: raw.enabled,
    hours: raw.hours,
    dest_dir: raw.dest_dir,
    last_run_at: raw.last_run_unix ?? null,
    last_status: raw.last_status ?? null,
  };
}

export async function setBackupSchedule(
  enabled: boolean,
  hours: number,
  destDir: string,
  passphrase?: string,
): Promise<void> {
  await invoke('configure_backup_schedule', {
    enabled,
    hours,
    destDir,
  });
  if (passphrase != null && passphrase.trim().length >= 8) {
    await invoke('set_setting', { key: 'backup.passphrase', value: passphrase.trim() });
  }
}

export async function runEncryptedBackup(
  passphrase: string,
  destDir: string,
): Promise<string> {
  return invoke<string>('run_encrypted_backup', { passphrase, destDir });
}

export async function restoreEncryptedBackup(
  filePath: string,
  passphrase: string,
): Promise<string> {
  return invoke<string>('restore_encrypted_backup', { path: filePath, passphrase });
}

export async function scanOrphanFiles(): Promise<OrphanItem[]> {
  return invoke<OrphanItem[]>('scan_orphan_files');
}

export async function deleteOrphanFiles(paths: string[]): Promise<number> {
  return invoke<number>('delete_orphan_files', { paths });
}

export async function batchProcessFolder(
  folder: string,
  maxFiles = 200,
): Promise<BatchFileResult[]> {
  return invoke<BatchFileResult[]>('batch_process_folder', {
    root: folder,
    maxFiles,
  });
}

export async function verifyLocalModelIntegrity(
  modelPath: string,
  expectedHex?: string | null,
): Promise<IntegrityResult> {
  return invoke<IntegrityResult>('verify_local_model_integrity', {
    path: modelPath,
    expectedHex: expectedHex ?? null,
  });
}

export async function listWorkspaceProfiles(): Promise<WorkspaceProfile[]> {
  return invoke<WorkspaceProfile[]>('list_workspace_profiles');
}

export async function switchWorkspaceProfile(profileId: string): Promise<void> {
  await invoke('switch_workspace_profile', { id: profileId });
}

export async function createWorkspaceProfile(name: string): Promise<WorkspaceProfile> {
  return invoke<WorkspaceProfile>('create_workspace_profile', { name });
}

export async function getActiveWorkspaceProfile(): Promise<string> {
  return invoke<string>('get_active_workspace_profile');
}

export async function getToolingStatus(): Promise<ToolingStatus> {
  return invoke<ToolingStatus>('tooling_status');
}

export async function repairTooling(): Promise<ToolingStatus> {
  return invoke<ToolingStatus>('tooling_repair');
}

export async function getSetting(key: string): Promise<string | null> {
  const rows = await invoke<[string, string][]>('get_settings');
  const hit = rows.find(([k]) => k === key);
  return hit?.[1] ?? null;
}

export async function setSetting(key: string, value: string): Promise<void> {
  await invoke('set_setting', { key, value });
}
