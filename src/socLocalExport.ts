import { save } from '@tauri-apps/api/dialog';
import { invoke } from '@tauri-apps/api/tauri';
import { useAppStore } from './store';

export type SocExportKind = 'md' | 'txt' | 'json' | 'xml';

export interface SocExportRequest {
  defaultFileName: string;
  contents: string;
  kind?: SocExportKind;
  title?: string;
}

export interface SocExportResult {
  ok: boolean;
  message: string;
  path?: string;
}

const EXTENSION_LABELS: Record<SocExportKind, string> = {
  md: 'Markdown',
  txt: 'Text',
  json: 'JSON',
  xml: 'XML',
};

function cleanFileName(value: string, extension: SocExportKind): string {
  const base = value
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 96) || 'nexus-soc-export';

  return base.toLowerCase().endsWith(`.${extension}`) ? base : `${base}.${extension}`;
}

function defaultExportPath(fileName: string): string {
  const exportDir = useAppStore.getState().deploymentConfig?.exportDir
    || useAppStore.getState().deploymentConfig?.dataRoot
    || '';
  if (!exportDir) return fileName;
  const sep = exportDir.includes('/') ? '/' : '\\';
  return `${exportDir.replace(/[\\/]+$/, '')}${sep}${fileName}`;
}

export function buildSocExportStatusMessage(path: string): string {
  return `Saved local offline export to ${path}`;
}

export async function exportSocTextFile(request: SocExportRequest): Promise<SocExportResult> {
  const kind = request.kind || 'md';
  const contents = request.contents || '';

  if (!contents.trim()) {
    return { ok: false, message: 'Nothing to export yet. Generate or select SOC content first.' };
  }

  const safeFileName = cleanFileName(request.defaultFileName, kind);
  try {
    const selectedPath = await save({
      title: request.title || 'Export SOC file',
      defaultPath: defaultExportPath(safeFileName),
      filters: [
        { name: EXTENSION_LABELS[kind], extensions: [kind] },
        { name: 'Text-compatible files', extensions: ['md', 'txt', 'json', 'xml'] },
      ],
    });

    if (!selectedPath) {
      return { ok: false, message: 'Export cancelled. No file was written.' };
    }

    const path = await invoke<string>('write_soc_text_export', {
      path: selectedPath,
      contents,
      overwrite: false,
    });
    return { ok: true, path, message: buildSocExportStatusMessage(path) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err || 'Export failed');
    return { ok: false, message };
  }
}
