export interface SymbolHit {
  path: string;
  name: string;
  kind: string;
  line_start: number;
  line_end: number;
  signature: string;
}

export interface CheckpointSummary {
  run_id: string;
  created_at: number;
  file_count: number;
}

export interface CheckpointManifest {
  run_id: string;
  created_at: number;
  workspace_root: string;
  files: Array<{
    path: string;
    action: 'write' | 'create' | 'delete';
    existed: boolean;
    snapshot_rel?: string | null;
  }>;
}

export interface CwOcrResult {
  text: string;
  engine: string;
  ok: boolean;
  message: string;
}

export interface CwPdfPageImage {
  page: number;
  mime: string;
  base64: string;
}

export interface CwPdfPrepareItem {
  path: string;
  status: string;
  engine: string;
  chars: number;
  message: string;
}

export interface CwPdfPrepareReport {
  workspace_root: string;
  pdf_count: number;
  ready: number;
  ocr_used: number;
  failed: number;
  skipped: number;
  items: CwPdfPrepareItem[];
  summary: string;
}
