import { invoke } from '@tauri-apps/api/tauri';
import { save } from '@tauri-apps/api/dialog';
import { useAppStore } from './store';
import type { GenerationParams } from './types';

export type DocFormatId = 'docx' | 'pptx' | 'pdf';

export interface DocSpecResult {
  ok: boolean;
  format: string;
  spec: Record<string, unknown>;
  preview_markdown: string;
  message: string;
}

export interface DocExportResult {
  ok: boolean;
  path: string;
  format: string;
  title: string;
  message: string;
}

export interface DocExportProbe {
  worker_found: boolean;
  worker_path?: string | null;
  python_found: boolean;
  packages: Record<string, boolean>;
  ready: boolean;
}

export interface GenerateDocumentArgs {
  brief: string;
  format: DocFormatId;
  backend: string;
  modelPath?: string | null;
  params?: GenerationParams;
  sourceMarkdown?: string | null;
}

function defaultExportPath(fileName: string): string {
  const exportDir = useAppStore.getState().deploymentConfig?.exportDir
    || useAppStore.getState().deploymentConfig?.dataRoot
    || '';
  if (!exportDir) return fileName;
  const sep = exportDir.includes('/') ? '/' : '\\';
  return `${exportDir.replace(/[\\/]+$/, '')}${sep}${fileName}`;
}

function safeName(title: string, format: DocFormatId): string {
  const base = (title || 'document')
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '-')
    .replace(/\s+/g, '-')
    .slice(0, 80) || 'document';
  return base.toLowerCase().endsWith(`.${format}`) ? base : `${base}.${format}`;
}

export async function probeDocExport(): Promise<DocExportProbe> {
  return invoke<DocExportProbe>('probe_doc_export');
}

export async function installDocExportSupport(): Promise<DocExportProbe> {
  return invoke<DocExportProbe>('install_doc_export_support');
}

export async function generateDocumentSpec(args: GenerateDocumentArgs): Promise<DocSpecResult> {
  return invoke<DocSpecResult>('generate_document_spec', {
    request: {
      brief: args.brief,
      format: args.format,
      backend: args.backend,
      model_path: args.modelPath ?? null,
      params: args.params ?? null,
      source_markdown: args.sourceMarkdown ?? null,
    },
  });
}

export async function exportDocument(
  spec: Record<string, unknown>,
  format: DocFormatId,
  outputPath: string,
): Promise<DocExportResult> {
  return invoke<DocExportResult>('export_document', {
    request: {
      spec,
      format,
      output_path: outputPath,
    },
  });
}

export async function generateAndExportDocument(
  args: GenerateDocumentArgs & { outputPath: string },
): Promise<DocExportResult> {
  return invoke<DocExportResult>('generate_and_export_document', {
    request: {
      brief: args.brief,
      format: args.format,
      output_path: args.outputPath,
      backend: args.backend,
      model_path: args.modelPath ?? null,
      params: args.params ?? null,
      source_markdown: args.sourceMarkdown ?? null,
    },
  });
}

/** Prompt for save path, then export a DocSpec (or generate+export from markdown). */
export async function exportContentAsDocument(opts: {
  format: DocFormatId;
  brief?: string;
  sourceMarkdown: string;
  backend: string;
  modelPath?: string | null;
  params?: GenerationParams;
  defaultTitle?: string;
}): Promise<DocExportResult> {
  const title = opts.defaultTitle || 'export';
  const selected = await save({
    title: `Export as ${opts.format.toUpperCase()}`,
    defaultPath: defaultExportPath(safeName(title, opts.format)),
    filters: [
      { name: opts.format.toUpperCase(), extensions: [opts.format] },
    ],
  });
  if (!selected) {
    return { ok: false, path: '', format: opts.format, title: '', message: 'Export cancelled.' };
  }
  return generateAndExportDocument({
    brief: opts.brief || `Export as polished ${opts.format.toUpperCase()}`,
    format: opts.format,
    outputPath: selected,
    backend: opts.backend,
    modelPath: opts.modelPath,
    params: opts.params,
    sourceMarkdown: opts.sourceMarkdown,
  });
}

export function pickChatBackend(modelPath: string | null | undefined): { backend: string; modelPath: string | null } {
  const path = (modelPath || '').trim();
  if (!path) return { backend: 'llama.cpp', modelPath: null };
  if (path.startsWith('enterprise:')) return { backend: 'enterprise', modelPath: path };
  if (path.startsWith('remote:')) return { backend: 'remote', modelPath: path };
  return { backend: 'llama.cpp', modelPath: path };
}
